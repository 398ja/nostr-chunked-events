/**
 * Chunk reassembly logic - pure functions for reconstructing content from chunks
 */

import type { Event } from 'nostr-tools';
import { config, HASH_ALG_SHA256, TAGS } from './constants';
import { sha256Hex } from './hash';
import { parseDTag } from './chunker';
import type {
  AncestrySnapshotLike,
  ChunkData,
  ChunkEventData,
  ChunkValidationOptions,
  SnapshotParentReference,
  SnapshotCandidate,
  SnapshotSelectionOptions,
  SnapshotSelectionResult,
  SnapshotValidationIssue,
  SnapshotValidationOptions,
  SnapshotValidationResult,
  ValidationResult,
} from './types';

/**
 * Strict non-negative integer parse. Rejects "1abc", "1.5", " 2", "-1" and
 * values beyond Number.MAX_SAFE_INTEGER, which parseInt() would accept or
 * silently truncate.
 */
function parseInteger(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function getTagValue(event: Event, tagName: string): string | undefined {
  return event.tags.find((tag) => tag[0] === tagName)?.[1];
}

function getTagValues(event: Event, tagName: string): string[] {
  return event.tags
    .filter((tag) => tag[0] === tagName)
    .map((tag) => tag[1] ?? '');
}

function normalizeHashAlgorithm(hashAlg: string | undefined): string | null {
  if (!hashAlg) return null;
  return hashAlg.toLowerCase().replace(/-/g, '');
}

function defaultHashContent(algorithm: string, content: string): string {
  const normalized = normalizeHashAlgorithm(algorithm);
  if (normalized !== HASH_ALG_SHA256) {
    throw new Error(`Unsupported hash algorithm: ${algorithm}`);
  }
  return sha256Hex(content);
}

function dedupeChunksByIndex(chunks: ChunkEventData[]): ChunkEventData[] {
  const byIndex = new Map<number, ChunkEventData>();

  for (const chunk of chunks) {
    const existing = byIndex.get(chunk.index);
    if (!existing || (chunk.createdAt ?? 0) >= (existing.createdAt ?? 0)) {
      byIndex.set(chunk.index, chunk);
    }
  }

  return Array.from(byIndex.values()).sort((a, b) => a.index - b.index);
}

function dedupeChunksByEventId(chunks: ChunkEventData[]): ChunkEventData[] {
  const seenEventIds = new Set<string>();
  const deduped: ChunkEventData[] = [];

  for (const chunk of chunks) {
    if (chunk.eventId) {
      if (seenEventIds.has(chunk.eventId)) {
        continue;
      }
      seenEventIds.add(chunk.eventId);
    }
    deduped.push(chunk);
  }

  return deduped;
}

function parseParentReferences(event: Event): SnapshotParentReference[] | undefined {
  const parentSnapshotIds = getTagValues(event, TAGS.PARENT_SNAPSHOT_ID);
  const parentContentHashes = getTagValues(event, TAGS.PARENT_CONTENT_HASH);

  if (parentSnapshotIds.length === 0 && parentContentHashes.length === 0) {
    return undefined;
  }

  const pairCount = Math.max(parentSnapshotIds.length, parentContentHashes.length);
  const parents = Array.from({ length: pairCount }, (_, index) => ({
    snapshotId: parentSnapshotIds[index] ?? '',
    contentHash: parentContentHashes[index] ?? '',
  }));

  const isGenesis = parents.length > 0
    && parents.every((parent) => parent.snapshotId === '' && parent.contentHash === '');

  return isGenesis ? [] : parents;
}

function serializeParents(parents: SnapshotParentReference[] | undefined): string {
  if (typeof parents === 'undefined') {
    return '__legacy__';
  }
  return JSON.stringify(parents.map((parent) => ({
    snapshotId: parent.snapshotId ?? '',
    contentHash: parent.contentHash ?? '',
  })));
}

function hasMalformedParents(parents: SnapshotParentReference[] | undefined): boolean {
  if (typeof parents === 'undefined') {
    return false;
  }

  if (!Array.isArray(parents) || parents.length > 2) {
    return true;
  }

  return parents.some((parent) => {
    if (!parent || typeof parent.snapshotId !== 'string' || typeof parent.contentHash !== 'string') {
      return true;
    }

    const hasSnapshotId = parent.snapshotId !== '';
    const hasContentHash = parent.contentHash !== '';
    return hasSnapshotId !== hasContentHash;
  });
}

function buildValidationResult(
  chunks: ChunkEventData[],
  issues: SnapshotValidationIssue[],
  snapshotId: string | null,
  totalChunks: number,
  legacyFormat: boolean,
  payloadHashVerified: boolean,
): SnapshotValidationResult {
  return {
    valid: issues.length === 0,
    snapshotId,
    chunks,
    totalChunks,
    issues,
    legacyFormat,
    payloadHashVerified,
  };
}

/**
 * Parse chunk metadata from a Nostr event
 *
 * @param event - The Nostr event to parse
 * @returns ChunkData if event is a chunk, null otherwise
 */
export function parseChunkFromEvent(event: Event): ChunkData | null {
  const parsed = parseChunkEvent(event);
  if (!parsed) {
    return null;
  }

  return {
    index: parsed.index,
    total: parsed.total,
    data: parsed.data,
  };
}

/**
 * Parse chunk metadata and integrity tags from a Nostr event
 *
 * @param event - The Nostr event to parse
 * @returns ChunkEventData if event is a chunk, null otherwise
 */
export function parseChunkEvent(event: Event): ChunkEventData | null {
  const chunkTag = event.tags.find((tag) => tag[0] === TAGS.CHUNK);
  if (!chunkTag || chunkTag.length < 3) {
    return null;
  }

  const index = parseInteger(chunkTag[1]);
  const total = parseInteger(chunkTag[2]);

  if (index === null || total === null || total <= 0) {
    return null;
  }

  return {
    index,
    total,
    data: event.content,
    snapshotId: getTagValue(event, TAGS.SNAPSHOT_ID),
    payloadHash: getTagValue(event, TAGS.PAYLOAD_HASH),
    hashAlg: getTagValue(event, TAGS.HASH_ALG),
    totalChunksTag: parseInteger(getTagValue(event, TAGS.TOTAL_CHUNKS)) ?? undefined,
    author: event.pubkey,
    createdAt: event.created_at,
    eventId: event.id,
    dTag: getTagValue(event, TAGS.D_TAG),
    recordId: recordIdOf(event),
    parents: parseParentReferences(event),
    rawEvent: event,
  };
}

/**
 * The logical record an event belongs to: its `record_id` tag, else (for a
 * chunk) its d-tag without `-chunk-<n>`, else (for a non-chunk) its d-tag.
 * The same rule as imani-wallet's `recordIdOf`, so chunks written before the
 * `record_id` tag existed still resolve to their record.
 */
export function recordIdOf(event: Pick<Event, 'tags'>): string | undefined {
  const d = event.tags.find((tag) => tag[0] === TAGS.D_TAG)?.[1];
  const isChunk = event.tags.some((tag) => tag[0] === TAGS.CHUNK);
  if (!isChunk) return d || undefined;
  const explicit = event.tags.find((tag) => tag[0] === TAGS.RECORD_ID)?.[1];
  if (explicit) return explicit;
  if (!d) return undefined;
  const parsed = parseDTag(d);
  return parsed.chunkIndex === null ? undefined : parsed.prefix;
}

/**
 * Check whether a parsed snapshot is the genesis ancestry node.
 */
export function isGenesis(snapshot: Pick<AncestrySnapshotLike, 'parents'>): boolean {
  return Array.isArray(snapshot.parents) && snapshot.parents.length === 0;
}

/**
 * Check whether a parsed snapshot is a merge snapshot.
 */
export function isMergeSnapshot(snapshot: Pick<AncestrySnapshotLike, 'parents'>): boolean {
  return Array.isArray(snapshot.parents) && snapshot.parents.length > 1;
}

/**
 * Check whether a parsed snapshot predates ancestry tags.
 */
export function isLegacyPreAncestry(snapshot: Pick<AncestrySnapshotLike, 'parents'>): boolean {
  return typeof snapshot.parents === 'undefined';
}

/**
 * Filter events to one exact author
 *
 * @param events - Events to filter
 * @param expectedAuthor - Required author pubkey
 * @returns Events matching the expected author
 */
export function filterEventsByAuthor(events: Event[], expectedAuthor: string): Event[] {
  return events.filter((event) => event.pubkey === expectedAuthor);
}

/**
 * Check if an event is a chunk (has chunk tag)
 *
 * @param event - The Nostr event to check
 * @returns true if event is a chunk
 */
export function isChunkEvent(event: Event): boolean {
  return event.tags.some((tag) => tag[0] === TAGS.CHUNK);
}

/**
 * Check if an event has a migration marker (indicates data moved to chunks)
 *
 * @param event - The Nostr event to check
 * @returns true if event has migration marker
 */
export function hasMigrationMarker(event: Event): boolean {
  return event.tags.some((tag) => tag[0] === TAGS.MIGRATED);
}

/**
 * Sort chunks by index
 *
 * @param chunks - Array of chunks to sort
 * @returns New sorted array
 */
export function sortChunks<T extends ChunkData>(chunks: T[]): T[] {
  return [...chunks].sort((a, b) => a.index - b.index);
}

/**
 * Validate that all chunks are present and consistent
 *
 * @param chunks - Array of chunks to validate
 * @returns Validation result with details about any issues
 */
export function validateChunks(chunks: ChunkData[], options: ChunkValidationOptions = {}): ValidationResult {
  if (chunks.length === 0) {
    return {
      valid: false,
      missing: [],
      duplicates: [],
      outOfRange: [],
      inconsistentTotal: false,
    };
  }

  const expectedTotal = chunks[0].total;
  const inconsistentTotal = chunks.some((chunk) => chunk.total !== expectedTotal);
  if (inconsistentTotal) {
    return {
      valid: false,
      missing: [],
      duplicates: [],
      outOfRange: [],
      inconsistentTotal: true,
    };
  }

  const maxChunks = options.maxChunks ?? config.maxChunks;
  const outOfRange = Array.from(new Set(
    chunks
      .map((chunk) => chunk.index)
      .filter((index) => !Number.isSafeInteger(index) || index < 0 || index >= expectedTotal),
  )).sort((a, b) => a - b);

  if (!Number.isSafeInteger(expectedTotal) || expectedTotal <= 0 || expectedTotal > maxChunks) {
    // Refuse before allocating per-index bookkeeping for a hostile total.
    return {
      valid: false,
      missing: [],
      duplicates: [],
      outOfRange,
      inconsistentTotal: false,
    };
  }

  const indexCounts = new Map<number, number>();
  for (const chunk of chunks) {
    const count = indexCounts.get(chunk.index) || 0;
    indexCounts.set(chunk.index, count + 1);
  }

  const missing: number[] = [];
  const duplicates: number[] = [];

  for (let i = 0; i < expectedTotal; i++) {
    const count = indexCounts.get(i) || 0;
    if (count === 0) {
      missing.push(i);
    } else if (count > 1) {
      duplicates.push(i);
    }
  }

  return {
    valid: missing.length === 0 && duplicates.length === 0 && outOfRange.length === 0,
    missing,
    duplicates,
    outOfRange,
    inconsistentTotal: false,
  };
}

/**
 * Group chunk events by snapshot_id
 *
 * @param events - Events to group
 * @param options - Optional grouping options
 * @returns Candidate snapshots built from chunk events
 */
export function groupChunksBySnapshot(
  events: Event[],
  options: { expectedAuthor?: string; recordId?: string } = {},
): SnapshotCandidate[] {
  const filteredEvents = options.expectedAuthor
    ? filterEventsByAuthor(events, options.expectedAuthor)
    : events;

  const seenEventIds = new Set<string>();
  const parsedChunks = filteredEvents
    .filter((event) => {
      if (!event.id) {
        return true;
      }
      if (seenEventIds.has(event.id)) {
        return false;
      }
      seenEventIds.add(event.id);
      return true;
    })
    .map((event) => parseChunkEvent(event))
    .filter((chunk): chunk is ChunkEventData => chunk !== null)
    .filter((chunk) => options.recordId === undefined || chunk.recordId === options.recordId);

  const groups = new Map<string, ChunkEventData[]>();

  for (const chunk of parsedChunks) {
    // One candidate per (record, snapshot): two records never compete, even
    // if they happen to share a snapshot_id.
    const key = JSON.stringify([chunk.recordId ?? null, chunk.snapshotId ?? null]);
    const existing = groups.get(key);
    if (existing) {
      existing.push(chunk);
    } else {
      groups.set(key, [chunk]);
    }
  }

  return Array.from(groups.values()).map((chunks) => ({
    snapshotId: chunks[0].snapshotId ?? null,
    recordId: chunks[0].recordId,
    newestCreatedAt: chunks.reduce((max, chunk) => Math.max(max, chunk.createdAt ?? 0), 0),
    chunks,
  }));
}

/**
 * Validate a candidate snapshot with metadata-aware rules
 *
 * @param chunks - Candidate chunk set
 * @param options - Validation options
 * @returns Detailed validation result
 */
export async function validateSnapshot(
  chunks: ChunkEventData[],
  options: SnapshotValidationOptions = {},
): Promise<SnapshotValidationResult> {
  const issues: SnapshotValidationIssue[] = [];
  const requireConsistentMetadata = options.requireConsistentMetadata !== false;
  const allowLegacy = options.allowLegacy !== false;

  if (chunks.length === 0) {
    issues.push({ code: 'empty', message: 'Snapshot has no chunks' });
    return buildValidationResult([], issues, null, 0, true, false);
  }

  if (options.expectedAuthor) {
    for (const chunk of chunks) {
      if (chunk.author && chunk.author !== options.expectedAuthor) {
        issues.push({
          code: 'wrong_author',
          message: `Chunk author mismatch: expected ${options.expectedAuthor}, got ${chunk.author}`,
          chunkIndex: chunk.index,
          eventId: chunk.eventId,
        });
      }
    }
  }

  const authors = new Set(chunks.map((chunk) => chunk.author).filter((value): value is string => Boolean(value)));
  if (!options.expectedAuthor && authors.size > 1) {
    issues.push({
      code: 'wrong_author',
      message: `Candidate mixes chunks from ${authors.size} authors; pass expectedAuthor`,
    });
  }

  const recordIds = new Set(chunks.map((chunk) => chunk.recordId));
  if (options.recordId !== undefined) {
    for (const chunk of chunks) {
      if (chunk.recordId !== options.recordId) {
        issues.push({
          code: 'wrong_record',
          message: `Chunk record mismatch: expected ${options.recordId}, got ${chunk.recordId ?? '(none)'}`,
          chunkIndex: chunk.index,
          eventId: chunk.eventId,
        });
      }
    }
  } else if (recordIds.size > 1) {
    issues.push({
      code: 'wrong_record',
      message: 'Candidate mixes chunks from more than one record_id',
    });
  }

  const uniqueChunks = dedupeChunksByEventId(chunks);
  const byIndex = new Map<number, ChunkEventData[]>();
  for (const chunk of uniqueChunks) {
    const list = byIndex.get(chunk.index);
    if (list) {
      list.push(chunk);
    } else {
      byIndex.set(chunk.index, [chunk]);
    }
  }

  for (const [index, list] of byIndex.entries()) {
    const benign = options.allowIdenticalDuplicates === true
      && list.every((chunk) => chunk.data === list[0].data);
    if (list.length > 1 && !benign) {
      issues.push({
        code: 'duplicate_index',
        message: `Multiple chunk events found for index ${index}`,
        chunkIndex: index,
      });
    }
  }

  const dedupedChunks = dedupeChunksByIndex(uniqueChunks);
  const sortedChunks = sortChunks(dedupedChunks);
  const maxChunks = options.maxChunks ?? config.maxChunks;
  const chunkValidation = validateChunks(sortedChunks, { maxChunks });
  const declaredTotal = sortedChunks[0]?.total ?? 0;

  if (!chunkValidation.inconsistentTotal && declaredTotal > maxChunks) {
    issues.push({
      code: 'too_many_chunks',
      message: `Snapshot declares ${declaredTotal} chunks, above maxChunks ${maxChunks}`,
    });
  }

  for (const missingIndex of chunkValidation.missing) {
    issues.push({
      code: 'missing_index',
      message: `Missing chunk index ${missingIndex}`,
      chunkIndex: missingIndex,
    });
  }

  for (const index of chunkValidation.outOfRange ?? []) {
    issues.push({
      code: 'index_out_of_range',
      message: `Chunk index ${index} is outside 0..${declaredTotal - 1}`,
      chunkIndex: index,
    });
  }

  if (chunkValidation.inconsistentTotal) {
    issues.push({
      code: 'inconsistent_total',
      message: 'Chunk totals are inconsistent across the candidate set',
    });
  }

  const snapshotIds = new Set(sortedChunks.map((chunk) => chunk.snapshotId).filter((value): value is string => Boolean(value)));
  const payloadHashes = new Set(sortedChunks.map((chunk) => chunk.payloadHash).filter((value): value is string => Boolean(value)));
  const totalChunksTags = new Set(sortedChunks.map((chunk) => chunk.totalChunksTag).filter((value): value is number => typeof value === 'number'));
  const hashAlgorithms = new Set(
    sortedChunks
      .map((chunk) => normalizeHashAlgorithm(chunk.hashAlg ?? (chunk.payloadHash ? 'sha256' : undefined)))
      .filter((value): value is string => Boolean(value)),
  );

  const hasAnySnapshotId = sortedChunks.some((chunk) => Boolean(chunk.snapshotId));
  const hasAnyPayloadHash = sortedChunks.some((chunk) => Boolean(chunk.payloadHash));
  const hasAnyTotalChunksTag = sortedChunks.some((chunk) => typeof chunk.totalChunksTag === 'number');
  const hasAnyParents = sortedChunks.some((chunk) => typeof chunk.parents !== 'undefined');

  const legacyFormat = !hasAnySnapshotId && !hasAnyPayloadHash && !hasAnyTotalChunksTag;
  const requireSnapshotId = options.requireSnapshotId ?? (requireConsistentMetadata && !allowLegacy);
  const requirePayloadHash = options.requirePayloadHash ?? (requireConsistentMetadata && !allowLegacy);

  if (snapshotIds.size > 1) {
    issues.push({
      code: 'mixed_snapshot',
      message: 'Candidate contains multiple snapshot_id values',
    });
  }

  if (requireConsistentMetadata && hasAnySnapshotId && snapshotIds.size === 1) {
    const missingSnapshotId = sortedChunks.some((chunk) => !chunk.snapshotId);
    if (missingSnapshotId) {
      issues.push({
        code: 'missing_snapshot_id',
        message: 'One or more chunks are missing snapshot_id',
      });
    }
  }

  if (requireSnapshotId && snapshotIds.size === 0) {
    issues.push({
      code: 'missing_snapshot_id',
      message: 'snapshot_id is required for strict validation',
    });
  }

  if (payloadHashes.size > 1) {
    issues.push({
      code: 'inconsistent_payload_hash',
      message: 'Candidate contains multiple payload_hash values',
    });
  }

  if (requireConsistentMetadata && hasAnyPayloadHash && payloadHashes.size === 1) {
    const missingPayloadHash = sortedChunks.some((chunk) => !chunk.payloadHash);
    if (missingPayloadHash) {
      issues.push({
        code: 'missing_payload_hash',
        message: 'One or more chunks are missing payload_hash',
      });
    }
  }

  if (requirePayloadHash && payloadHashes.size === 0) {
    issues.push({
      code: 'missing_payload_hash',
      message: 'payload_hash is required for strict validation',
    });
  }

  if (totalChunksTags.size > 1) {
    issues.push({
      code: 'inconsistent_total',
      message: 'Candidate contains multiple total_chunks values',
    });
  }

  if (requireConsistentMetadata && hasAnyTotalChunksTag && totalChunksTags.size === 1) {
    const missingTotalChunksTag = sortedChunks.some((chunk) => typeof chunk.totalChunksTag !== 'number');
    if (missingTotalChunksTag) {
      issues.push({
        code: 'inconsistent_total',
        message: 'One or more chunks are missing total_chunks',
      });
    }
  }

  const totalChunks = totalChunksTags.size === 1
    ? Array.from(totalChunksTags)[0]
    : (sortedChunks[0]?.total ?? 0);

  if (totalChunks > 0 && sortedChunks.length !== totalChunks) {
    issues.push({
      code: 'inconsistent_total',
      message: `Chunk count mismatch: expected ${totalChunks}, got ${sortedChunks.length}`,
    });
  }

  if (hashAlgorithms.size > 1) {
    issues.push({
      code: 'unsupported_hash_alg',
      message: 'Candidate contains multiple hash_alg values',
    });
  }

  const normalizedHashAlg = hashAlgorithms.size === 1 ? Array.from(hashAlgorithms)[0] : null;
  if (normalizedHashAlg && normalizedHashAlg !== 'sha256') {
    issues.push({
      code: 'unsupported_hash_alg',
      message: `Unsupported hash algorithm: ${normalizedHashAlg}`,
    });
  }

  if (hasAnyParents) {
    const parentSignatures = new Set(sortedChunks.map((chunk) => serializeParents(chunk.parents)));
    if (parentSignatures.size > 1) {
      issues.push({
        code: 'inconsistent_parents',
        message: 'Candidate contains inconsistent parent ancestry tags',
      });
    } else if (hasMalformedParents(sortedChunks.find((chunk) => typeof chunk.parents !== 'undefined')?.parents)) {
      issues.push({
        code: 'inconsistent_parents',
        message: 'Candidate contains malformed parent ancestry tags',
      });
    }
  }

  let payloadHashVerified = false;
  if (issues.length === 0 && options.verifyPayloadHash !== false && payloadHashes.size === 1) {
    const expectedPayloadHash = Array.from(payloadHashes)[0];
    const algorithm = normalizedHashAlg ?? 'sha256';
    const reassembled = sortedChunks.map((chunk) => chunk.data).join('');
    const hashFn = options.hashFn ?? defaultHashContent;

    try {
      const actualPayloadHash = await hashFn(algorithm, reassembled);
      if (actualPayloadHash.toLowerCase() !== expectedPayloadHash.toLowerCase()) {
        issues.push({
          code: 'payload_hash_mismatch',
          message: `Payload hash mismatch: expected ${expectedPayloadHash}, got ${actualPayloadHash}`,
        });
      } else {
        payloadHashVerified = true;
      }
    } catch (error) {
      issues.push({
        code: 'unsupported_hash_alg',
        message: error instanceof Error ? error.message : 'Failed to verify payload hash',
      });
    }
  }

  return buildValidationResult(
    sortedChunks,
    issues,
    snapshotIds.size === 1 ? Array.from(snapshotIds)[0] : null,
    totalChunks,
    legacyFormat,
    payloadHashVerified,
  );
}

/**
 * Select the best snapshot from a set of chunk events
 *
 * @param events - Events to evaluate
 * @param options - Snapshot selection options
 * @returns Selected snapshot and rejected candidates
 */
export async function selectBestSnapshot(
  events: Event[],
  options: SnapshotSelectionOptions = {},
): Promise<SnapshotSelectionResult> {
  const strategy = options.strategy ?? 'newest-valid';
  const candidates = groupChunksBySnapshot(events, { expectedAuthor: options.expectedAuthor, recordId: options.recordId })
    .sort((a, b) => b.newestCreatedAt - a.newestCreatedAt);

  // Without expectedAuthor, "newest" across several authors would let anyone
  // who can publish a newer snapshot win. Refuse to choose instead.
  const authors = new Set(candidates.flatMap((candidate) => candidate.chunks.map((chunk) => chunk.author)));
  const ambiguousAuthor: SnapshotValidationIssue | null = !options.expectedAuthor && authors.size > 1
    ? { code: 'wrong_author', message: `Events come from ${authors.size} authors; pass expectedAuthor to choose` }
    : null;
  const validate = async (chunks: ChunkEventData[]): Promise<SnapshotValidationResult> => {
    const validation = await validateSnapshot(chunks, options);
    return ambiguousAuthor
      ? { ...validation, valid: false, payloadHashVerified: false, issues: [...validation.issues, ambiguousAuthor] }
      : validation;
  };

  const rejected: SnapshotSelectionResult['rejected'] = [];

  if (strategy === 'newest-seen') {
    const newest = candidates[0];
    if (!newest) {
      return {
        selected: null,
        validation: null,
        rejected,
      };
    }

    const validation = await validate(newest.chunks);
    const normalizedCandidate: SnapshotCandidate = {
      ...newest,
      snapshotId: validation.snapshotId,
      chunks: validation.chunks,
    };

    if (validation.valid) {
      return {
        selected: normalizedCandidate,
        validation,
        rejected,
      };
    }

    rejected.push({
      candidate: normalizedCandidate,
      validation,
    });

    return {
      selected: null,
      validation: null,
      rejected,
    };
  }

  for (const candidate of candidates) {
    const validation = await validate(candidate.chunks);
    const normalizedCandidate: SnapshotCandidate = {
      ...candidate,
      snapshotId: validation.snapshotId,
      chunks: validation.chunks,
    };

    if (validation.valid) {
      return {
        selected: normalizedCandidate,
        validation,
        rejected,
      };
    }

    rejected.push({
      candidate: normalizedCandidate,
      validation,
    });
  }

  return {
    selected: null,
    validation: null,
    rejected,
  };
}

/**
 * Reassemble and validate a strict snapshot
 *
 * @param chunks - Chunk set to reassemble
 * @param options - Validation options
 * @returns Reassembled content and validation result
 */
export async function reassembleSnapshot(
  chunks: ChunkEventData[],
  options: SnapshotValidationOptions = {},
): Promise<{ content: string; validation: SnapshotValidationResult }> {
  const validation = await validateSnapshot(chunks, options);
  if (!validation.valid) {
    const firstIssue = validation.issues[0];
    throw new Error(firstIssue?.message || 'Invalid snapshot');
  }

  return {
    content: validation.chunks.map((chunk) => chunk.data).join(''),
    validation,
  };
}

/**
 * Reassemble chunks into original content
 *
 * @param chunks - Array of chunks to reassemble
 * @returns Reassembled content string
 * @throws Error if chunks are invalid or incomplete
 */
export function reassembleChunks(chunks: ChunkData[], options: ChunkValidationOptions = {}): string {
  const validation = validateChunks(chunks, options);
  if (!validation.valid) {
    throw new Error(describeChunkValidationFailure(validation, options));
  }

  const sorted = sortChunks(chunks);
  return sorted.map((chunk) => chunk.data).join('');
}

/**
 * Human-readable reason for a failed {@link validateChunks} result.
 * Message prefixes ("Missing chunks: ", "Duplicate chunks: ") match v0.1.0.
 */
export function describeChunkValidationFailure(
  validation: ValidationResult,
  options: ChunkValidationOptions = {},
): string {
  if (validation.inconsistentTotal) {
    return 'Inconsistent chunk totals';
  }
  if (validation.outOfRange && validation.outOfRange.length > 0) {
    return `Chunk index out of range: ${validation.outOfRange.join(', ')}`;
  }
  if (validation.missing.length > 0) {
    return `Missing chunks: ${validation.missing.join(', ')}`;
  }
  if (validation.duplicates.length > 0) {
    return `Duplicate chunks: ${validation.duplicates.join(', ')}`;
  }
  return `Invalid chunks (total must be 1..${options.maxChunks ?? config.maxChunks}, see maxChunks)`;
}

/**
 * Get the total number of chunks from a chunk or array of chunks
 *
 * @param chunks - A single chunk or array of chunks
 * @returns Total number of expected chunks, or 0 if empty/invalid
 */
export function getTotalChunks(chunks: ChunkData | ChunkData[]): number {
  if (Array.isArray(chunks)) {
    return chunks.length > 0 ? chunks[0].total : 0;
  }
  return chunks.total;
}

/**
 * Extract version from event tags
 *
 * @param event - The Nostr event
 * @returns Version string or null if not found
 */
export function getEventVersion(event: Event): string | null {
  const versionTag = event.tags.find((tag) => tag[0] === TAGS.VERSION);
  return versionTag ? versionTag[1] : null;
}

/**
 * Check if event content is compressed
 *
 * @param event - The Nostr event
 * @returns Compression type string or null if not compressed
 */
export function getCompressionType(event: Event): string | null {
  const compressedTag = event.tags.find((tag) => tag[0] === TAGS.COMPRESSED);
  return compressedTag ? compressedTag[1] : null;
}
