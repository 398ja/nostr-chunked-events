/**
 * Chunking logic - pure functions for splitting content into chunks
 *
 * Browser-safe: uses TextEncoder/TextDecoder and Uint8Array only.
 */

import { config, D_TAG_SUFFIXES, HASH_ALG_SHA256, TAGS } from './constants';
import { sha256Hex } from './hash';
import type {
  Chunk,
  ChunkOptions,
  SnapshotChunk,
  SnapshotChunkOptions,
  SnapshotChunks,
} from './types';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

/** UTF-8 encodes a code point in at most 4 bytes */
const MIN_CHUNK_SIZE = 4;

function assertChunkSize(chunkSize: number): void {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < MIN_CHUNK_SIZE) {
    throw new RangeError(
      `chunkSize must be an integer >= ${MIN_CHUNK_SIZE} bytes (one UTF-8 code point), got ${chunkSize}`,
    );
  }
}

/**
 * Check if content needs to be chunked based on size
 *
 * @param content - The content to check
 * @param threshold - Size threshold in bytes (default: config.maxSingleEventSize)
 * @returns true if content exceeds threshold
 */
export function needsChunking(content: string, threshold?: number): boolean {
  const limit = threshold ?? config.maxSingleEventSize;
  return encoder.encode(content).length > limit;
}

/**
 * Calculate the size of content in bytes (UTF-8 encoded)
 *
 * @param content - The content to measure
 * @returns Size in bytes
 */
export function calculateSize(content: string): number {
  return encoder.encode(content).length;
}

/**
 * Estimate the number of chunks needed for content
 *
 * @param contentSize - Size of content in bytes
 * @param chunkSize - Size of each chunk in bytes (default: config.chunkSize)
 * @returns Estimated number of chunks
 */
export function estimateChunkCount(contentSize: number, chunkSize?: number): number {
  const size = chunkSize ?? config.chunkSize;
  return Math.ceil(contentSize / size);
}

/**
 * Split UTF-8 bytes into pieces of at most `chunkSize` bytes without cutting
 * a multi-byte character.
 */
function splitUtf8(contentBytes: Uint8Array, chunkSize: number): string[] {
  const pieces: string[] = [];
  const totalBytes = contentBytes.length;
  let offset = 0;

  while (offset < totalBytes) {
    let endOffset = Math.min(offset + chunkSize, totalBytes);

    // UTF-8 continuation bytes are 10xxxxxx; never end a chunk in front of one.
    // chunkSize >= 4 guarantees endOffset stays > offset.
    while (endOffset < totalBytes && (contentBytes[endOffset] & 0xc0) === 0x80) {
      endOffset--;
    }

    pieces.push(decoder.decode(contentBytes.subarray(offset, endOffset)));
    offset = endOffset;
  }

  return pieces;
}

/**
 * Split content into chunks
 *
 * @param content - The content to split
 * @param options - Chunking options
 * @returns Array of chunks with metadata
 * @throws RangeError if chunkSize is not an integer >= 4
 *
 * @example
 * ```ts
 * const chunks = createChunks(largeContent, {
 *   chunkSize: 250_000,
 *   dTagPrefix: 'myapp-data'
 * });
 * // chunks = [
 * //   { index: 0, total: 3, data: "...", dTag: "myapp-data-chunk-0" },
 * //   { index: 1, total: 3, data: "...", dTag: "myapp-data-chunk-1" },
 * //   { index: 2, total: 3, data: "...", dTag: "myapp-data-chunk-2" }
 * // ]
 * ```
 */
export function createChunks(content: string, options?: ChunkOptions): Chunk[] {
  const chunkSize = options?.chunkSize ?? config.chunkSize;
  const dTagPrefix = options?.dTagPrefix ?? 'data';
  assertChunkSize(chunkSize);

  const contentBytes = encoder.encode(content);

  // If content fits in a single chunk, return it as-is with state suffix
  if (contentBytes.length <= chunkSize) {
    return [{
      index: 0,
      total: 1,
      data: content,
      dTag: `${dTagPrefix}${D_TAG_SUFFIXES.STATE}`,
    }];
  }

  const pieces = splitUtf8(contentBytes, chunkSize);
  return pieces.map((data, index) => ({
    index,
    total: pieces.length,
    data,
    dTag: `${dTagPrefix}${D_TAG_SUFFIXES.CHUNK}${index}`,
  }));
}

function randomSnapshotId(): string {
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    const bytes = cryptoObj.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  throw new Error('No secure random source available; pass snapshotId explicitly');
}

/**
 * Split a payload into a self-describing snapshot: every chunk carries the
 * integrity tags `validateSnapshot()` checks (`chunk`, `snapshot_id`,
 * `payload_hash`, `hash_alg`, `total_chunks`, and optional ancestry tags).
 *
 * Works for any event kind. A `d` tag is only added when `dTagPrefix` is set,
 * so the result suits regular kinds (e.g. NIP-60 kind 7375) as well as
 * addressable kinds (30000-39999).
 *
 * Unlike `createChunks`, a payload that fits in one chunk still yields one
 * chunk with full metadata (total 1), so readers handle every size the same way.
 *
 * `payload_hash` is SHA-256 over the UTF-8 payload passed in. If you encrypt
 * each chunk before publishing, decrypt `chunk.data` back to plaintext before
 * calling `validateSnapshot()`.
 *
 * @throws RangeError if chunkSize is not an integer >= 4, or the payload is empty
 */
export function createSnapshotChunks(content: string, options?: SnapshotChunkOptions): SnapshotChunks {
  const chunkSize = options?.chunkSize ?? config.chunkSize;
  assertChunkSize(chunkSize);
  if (content.length === 0) {
    throw new RangeError('Cannot create a snapshot from an empty payload');
  }

  const snapshotId = options?.snapshotId ?? randomSnapshotId();
  const payloadHash = sha256Hex(content);
  const pieces = splitUtf8(encoder.encode(content), chunkSize);
  const total = pieces.length;

  const parentTags: string[][] = [];
  if (options?.parents !== undefined) {
    if (options.parents.length > 2) {
      throw new RangeError('A snapshot has at most two parents');
    }
    if (options.parents.length === 0) {
      // Explicit genesis marker
      parentTags.push([TAGS.PARENT_SNAPSHOT_ID, ''], [TAGS.PARENT_CONTENT_HASH, '']);
    }
    for (const parent of options.parents) {
      parentTags.push(
        [TAGS.PARENT_SNAPSHOT_ID, parent.snapshotId],
        [TAGS.PARENT_CONTENT_HASH, parent.contentHash],
      );
    }
  }

  const chunks: SnapshotChunk[] = pieces.map((data, index) => {
    const tags: string[][] = [];
    const dTag = options?.dTagPrefix !== undefined
      ? `${options.dTagPrefix}${D_TAG_SUFFIXES.CHUNK}${index}`
      : undefined;
    if (dTag !== undefined) {
      tags.push([TAGS.D_TAG, dTag]);
    }
    tags.push(
      [TAGS.CHUNK, String(index), String(total)],
      [TAGS.SNAPSHOT_ID, snapshotId],
      [TAGS.PAYLOAD_HASH, payloadHash],
      [TAGS.HASH_ALG, HASH_ALG_SHA256],
      [TAGS.TOTAL_CHUNKS, String(total)],
      ...parentTags,
    );
    return { index, total, data, dTag, tags };
  });

  return { snapshotId, payloadHash, hashAlg: HASH_ALG_SHA256, totalChunks: total, chunks };
}

/**
 * Generate the d-tag for a single (non-chunked) event
 *
 * @param prefix - The d-tag prefix
 * @returns d-tag string (e.g., "myapp-data-state")
 */
export function getSingleEventDTag(prefix: string): string {
  return `${prefix}${D_TAG_SUFFIXES.STATE}`;
}

/**
 * Generate the d-tag for a chunk
 *
 * @param prefix - The d-tag prefix
 * @param index - The chunk index
 * @returns d-tag string (e.g., "myapp-data-chunk-0")
 */
export function getChunkDTag(prefix: string, index: number): string {
  return `${prefix}${D_TAG_SUFFIXES.CHUNK}${index}`;
}

/**
 * Parse a d-tag to extract prefix and chunk info
 *
 * @param dTag - The d-tag to parse
 * @returns Object with prefix and chunk index (or null if single event)
 */
export function parseDTag(dTag: string): { prefix: string; chunkIndex: number | null } {
  // Check for chunk pattern first
  const chunkMatch = dTag.match(/^(.+)-chunk-(\d+)$/);
  if (chunkMatch) {
    return {
      prefix: chunkMatch[1],
      chunkIndex: parseInt(chunkMatch[2], 10),
    };
  }

  // Check for state pattern
  const stateMatch = dTag.match(/^(.+)-state$/);
  if (stateMatch) {
    return {
      prefix: stateMatch[1],
      chunkIndex: null,
    };
  }

  // Unknown format - return as prefix with no chunk
  return {
    prefix: dTag,
    chunkIndex: null,
  };
}
