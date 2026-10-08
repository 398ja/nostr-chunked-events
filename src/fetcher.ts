/**
 * Chunked event fetcher
 * Handles automatic detection, fetching, and reassembly of chunked content
 *
 * Every query result is filtered to the exact requested author before use,
 * whatever the source (relays or a custom `queryEvents` function).
 */

import { verifyEvent } from 'nostr-tools';
import type { Event, Filter } from 'nostr-tools';
import {
  describeChunkValidationFailure,
  filterEventsByAuthor,
  getCompressionType,
  hasMigrationMarker,
  parseChunkEvent,
  parseChunkFromEvent,
  reassembleChunks,
  reassembleSnapshot,
  selectBestSnapshot,
  validateChunks,
  validateSnapshot,
} from './reassembler';
import { getChunkDTag, getSingleEventDTag } from './chunker';
import { decompress } from './compression';
import { RelayPool, RelaysUnreachableError } from './relay';
import { config } from './constants';
import type {
  ChunkData,
  ChunkEventData,
  FetcherOptions,
  FetchOptions,
  FetchResult,
  ProbeResult,
  QueryEventsFn,
} from './types';

/** How many competing chunk-0 events strict mode looks at */
const STRICT_CHUNK0_LIMIT = 10;

/** d-tags per query when fetching many chunks, to stay under relay filter limits */
const D_TAG_BATCH_SIZE = 100;

/** A `queryEvents` source threw: the data may exist, we just could not ask. */
class SourceUnreachableError extends Error {
  constructor(cause: unknown) {
    super(`Query source unreachable: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'SourceUnreachableError';
  }
}

function isUnreachable(error: unknown): error is Error {
  return error instanceof SourceUnreachableError || error instanceof RelaysUnreachableError;
}

interface QuerySource {
  query: QueryEventsFn;
  close: () => void;
}

function failure(partial: Partial<FetchResult> & { error: string }): FetchResult {
  return {
    success: false,
    content: null,
    chunked: false,
    chunkCount: 0,
    events: [],
    compressed: false,
    ...partial,
  };
}

/**
 * Decode content according to its `compressed` tag. Unlike `tryDecompress`,
 * a payload that claims to be compressed but does not decompress is an error,
 * not silently returned as-is.
 */
function decodeContent(
  content: string,
  event: Event,
  maxSize: number,
): { content: string; compressed: boolean } {
  const compressed = getCompressionType(event) !== null;
  if (!compressed) {
    return { content, compressed };
  }
  try {
    return { content: decompress(content, { maxSize }), compressed };
  } catch (error) {
    throw new Error(`Content is tagged compressed but failed to decompress: ${
      error instanceof Error ? error.message : String(error)
    }`);
  }
}

/** Newest first, so a stale relay's copy never beats a fresh one. */
function newestFirst(events: Event[]): Event[] {
  return [...events].sort((a, b) => b.created_at - a.created_at);
}

/**
 * Check id and signature on a copy holding only the event fields. nostr-tools
 * caches a verification result on the event object under a symbol, which an
 * object spread would carry over to a tampered copy.
 */
function hasValidSignature(event: Event): boolean {
  try {
    return verifyEvent({
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at,
      kind: event.kind,
      tags: event.tags,
      content: event.content,
      sig: event.sig,
    });
  } catch {
    return false;
  }
}

/**
 * Fetcher for chunked events
 *
 * Automatically handles:
 * - Detection of chunked vs single events
 * - Fetching all chunks
 * - Reassembly and validation
 * - Decompression
 *
 * @example
 * ```ts
 * const fetcher = new ChunkedFetcher({
 *   defaultRelays: ['wss://relay.example.com']
 * });
 *
 * const result = await fetcher.fetch(pubkey, {
 *   kind: 30078,
 *   dTagPrefix: 'myapp-data'
 * });
 *
 * if (result.success) {
 *   console.log('Content:', result.content);
 * }
 * ```
 */
export class ChunkedFetcher {
  private options: FetcherOptions;

  constructor(options?: FetcherOptions) {
    this.options = {
      defaultRelays: options?.defaultRelays ?? [],
      authHandler: options?.authHandler,
      timeout: options?.timeout,
      queryEvents: options?.queryEvents,
      maxChunks: options?.maxChunks,
      verifySignatures: options?.verifySignatures,
      maxDecompressedSize: options?.maxDecompressedSize,
    };
  }

  private openSource(options: FetchOptions): QuerySource | null {
    const queryEvents = this.options.queryEvents;
    if (queryEvents) {
      const verify = this.options.verifySignatures !== false;
      return {
        query: async (filter) => {
          let events: Event[];
          try {
            events = await queryEvents(filter);
          } catch (error) {
            throw new SourceUnreachableError(error);
          }
          return verify ? events.filter(hasValidSignature) : events;
        },
        close: () => {},
      };
    }

    const relayUrls = options.relayUrls ?? this.options.defaultRelays ?? [];
    if (relayUrls.length === 0) {
      return null;
    }

    const pool = new RelayPool(relayUrls, {
      timeout: options.timeout ?? this.options.timeout,
      authHandler: this.options.authHandler,
    });
    return { query: (filter) => pool.query(filter), close: () => pool.close() };
  }

  private maxDecompressedSize(options: FetchOptions): number {
    return options.maxDecompressedSize ?? this.options.maxDecompressedSize ?? config.maxDecompressedSize;
  }

  private maxChunks(options: FetchOptions): number {
    return options.maxChunks ?? options.snapshotSelection?.maxChunks ?? this.options.maxChunks ?? config.maxChunks;
  }

  /**
   * Fetch and reassemble content from relays
   *
   * Automatically detects chunked vs single event format.
   *
   * @param pubkey - Author's public key in hex
   * @param options - Fetch options
   * @returns Fetch result with reassembled content
   */
  async fetch(pubkey: string, options: FetchOptions): Promise<FetchResult> {
    const source = this.openSource(options);
    if (!source) {
      return failure({ error: 'No relay URLs provided' });
    }

    try {
      const author = options.author ?? pubkey;
      const useStrictSelection = Boolean(options.snapshotSelection);

      // Strategy: Try chunked format first (query for chunk-0)
      const chunk0Filter: Filter = {
        kinds: [options.kind],
        authors: [author],
        '#d': [getChunkDTag(options.dTagPrefix, 0)],
        limit: useStrictSelection ? STRICT_CHUNK0_LIMIT : 1,
      };

      const chunk0Events = newestFirst(filterEventsByAuthor(await source.query(chunk0Filter), author));

      if (chunk0Events.length > 0) {
        return useStrictSelection
          ? await this.fetchStrict(source, author, options, chunk0Events)
          : await this.fetchChunkedData(source, author, options, chunk0Events[0]);
      }

      // No chunked data found - try single event format
      const stateEvents = newestFirst(filterEventsByAuthor(await source.query({
        kinds: [options.kind],
        authors: [author],
        '#d': [getSingleEventDTag(options.dTagPrefix)],
        limit: 1,
      }), author));

      if (stateEvents.length === 0) {
        return failure({ error: 'No data found' });
      }

      const stateEvent = stateEvents[0];

      if (hasMigrationMarker(stateEvent)) {
        return failure({ events: [stateEvent], error: 'Data migrated to chunks but chunks not found' });
      }

      const decoded = decodeContent(stateEvent.content, stateEvent, this.maxDecompressedSize(options));
      return {
        success: true,
        content: decoded.content,
        chunked: false,
        chunkCount: 1,
        events: [stateEvent],
        compressed: decoded.compressed,
        snapshotId: null,
      };
    } catch (error) {
      if (isUnreachable(error)) {
        return failure({ unreachable: true, error: error.message });
      }
      return failure({ error: error instanceof Error ? error.message : 'Unknown error' });
    } finally {
      source.close();
    }
  }

  /**
   * Fetch and parse content as JSON
   *
   * @param pubkey - Author's public key in hex
   * @param options - Fetch options
   * @returns Fetch result with parsed JSON data
   */
  async fetchJSON<T>(
    pubkey: string,
    options: FetchOptions
  ): Promise<FetchResult & { data: T | null }> {
    const result = await this.fetch(pubkey, options);

    if (!result.success || !result.content) {
      return { ...result, data: null };
    }

    try {
      const data = JSON.parse(result.content) as T;
      return { ...result, data };
    } catch {
      return {
        ...result,
        success: false,
        data: null,
        error: 'Failed to parse JSON',
      };
    }
  }

  /**
   * Probe for existence of chunked data without fetching all content
   *
   * @param pubkey - Author's public key in hex
   * @param options - Fetch options
   * @returns Probe result with existence and chunk info
   */
  async probe(pubkey: string, options: FetchOptions): Promise<ProbeResult> {
    const source = this.openSource(options);
    if (!source) {
      return { exists: false, chunked: false, chunkCount: 0 };
    }

    try {
      const author = options.author ?? pubkey;

      const chunk0Events = filterEventsByAuthor(await source.query({
        kinds: [options.kind],
        authors: [author],
        '#d': [getChunkDTag(options.dTagPrefix, 0)],
        limit: 1,
      }), author);

      if (chunk0Events.length > 0) {
        const chunkData = parseChunkFromEvent(chunk0Events[0]);
        return {
          exists: true,
          chunked: true,
          chunkCount: chunkData?.total ?? 1,
        };
      }

      const stateEvents = filterEventsByAuthor(await source.query({
        kinds: [options.kind],
        authors: [author],
        '#d': [getSingleEventDTag(options.dTagPrefix)],
        limit: 1,
      }), author);

      if (stateEvents.length > 0) {
        if (hasMigrationMarker(stateEvents[0])) {
          return { exists: false, chunked: false, chunkCount: 0 };
        }
        return { exists: true, chunked: false, chunkCount: 1 };
      }

      return { exists: false, chunked: false, chunkCount: 0 };
    } finally {
      source.close();
    }
  }

  /**
   * Query every chunk d-tag up to `total`, in batches so a single filter
   * never lists more d-tags than relays commonly accept.
   */
  private async queryChunkRange(
    source: QuerySource,
    author: string,
    options: FetchOptions,
    total: number,
  ): Promise<Event[]> {
    const batches: Promise<Event[]>[] = [];
    for (let start = 0; start < total; start += D_TAG_BATCH_SIZE) {
      const dTags = Array.from(
        { length: Math.min(D_TAG_BATCH_SIZE, total - start) },
        (_value, offset) => getChunkDTag(options.dTagPrefix, start + offset),
      );
      batches.push(source.query({ kinds: [options.kind], authors: [author], '#d': dTags }));
    }
    const seen = new Set<string>();
    return filterEventsByAuthor((await Promise.all(batches)).flat(), author).filter((event) => {
      if (seen.has(event.id)) return false;
      seen.add(event.id);
      return true;
    });
  }

  /**
   * Strict mode: group every candidate snapshot, validate each one and return
   * the newest valid one (or the newest seen, per `strategy`).
   */
  private async fetchStrict(
    source: QuerySource,
    author: string,
    options: FetchOptions,
    chunk0Events: Event[],
  ): Promise<FetchResult> {
    const maxChunks = this.maxChunks(options);
    const totals = chunk0Events
      .map((event) => parseChunkEvent(event)?.total ?? 0)
      .filter((total) => total > 0 && total <= maxChunks);

    if (totals.length === 0) {
      return failure({
        chunked: true,
        events: chunk0Events,
        error: `No usable chunk-0 event (invalid chunk tag or total above maxChunks ${maxChunks})`,
      });
    }

    const allEvents = await this.queryChunkRange(source, author, options, Math.max(...totals));
    const validationOptions = {
      expectedAuthor: author,
      allowLegacy: true,
      verifyPayloadHash: true,
      maxChunks,
      ...options.snapshotSelection,
    };
    const selection = await selectBestSnapshot(allEvents, {
      strategy: 'newest-valid',
      ...validationOptions,
    });
    const rejectedSnapshots = selection.rejected.map(({ candidate, validation }) => ({
      snapshotId: candidate.snapshotId,
      issues: validation.issues,
    }));

    if (!selection.selected || !selection.validation) {
      const firstRejected = selection.rejected[0]?.validation.issues[0];
      return failure({
        chunked: true,
        events: allEvents,
        rejectedSnapshots,
        error: firstRejected?.message || 'No valid chunk snapshot found',
      });
    }

    try {
      const { content: reassembled, validation } = await reassembleSnapshot(
        selection.selected.chunks,
        validationOptions,
      );
      const firstEvent = selection.selected.chunks[0]?.rawEvent ?? chunk0Events[0];
      const decoded = decodeContent(reassembled, firstEvent, this.maxDecompressedSize(options));

      return {
        success: true,
        content: decoded.content,
        chunked: true,
        chunkCount: validation.totalChunks,
        events: selection.selected.chunks
          .map((chunk) => chunk.rawEvent)
          .filter((event): event is Event => Boolean(event)),
        compressed: decoded.compressed,
        snapshotId: validation.snapshotId,
        validation,
        rejectedSnapshots,
      };
    } catch (error) {
      return failure({
        chunked: true,
        chunkCount: selection.validation.totalChunks,
        events: allEvents,
        snapshotId: selection.validation.snapshotId,
        validation: selection.validation,
        rejectedSnapshots,
        error: error instanceof Error ? error.message : 'Reassembly failed',
      });
    }
  }

  /**
   * Default mode: chunk-0 decides the chunk count, fetch the rest, reassemble.
   * Rejects totals above maxChunks, foreign-author events, and chunk sets whose
   * snapshot metadata (when present) disagrees or fails its payload hash.
   */
  private async fetchChunkedData(
    source: QuerySource,
    author: string,
    options: FetchOptions,
    chunk0Event: Event
  ): Promise<FetchResult> {
    const chunk0Data = parseChunkEvent(chunk0Event);

    if (!chunk0Data) {
      return failure({ chunked: true, events: [chunk0Event], error: 'Invalid chunk-0 event' });
    }

    const maxChunks = this.maxChunks(options);
    const totalChunks = chunk0Data.total;
    if (totalChunks > maxChunks) {
      return failure({
        chunked: true,
        events: [chunk0Event],
        error: `chunk-0 declares ${totalChunks} chunks, above maxChunks ${maxChunks}`,
      });
    }

    const allEvents: Event[] = [chunk0Event];
    const allChunks: ChunkEventData[] = [chunk0Data];

    if (totalChunks > 1) {
      const results = await Promise.all(
        Array.from({ length: totalChunks - 1 }, (_value, offset) => source.query({
          kinds: [options.kind],
          authors: [author],
          '#d': [getChunkDTag(options.dTagPrefix, offset + 1)],
          limit: 1,
        })),
      );

      for (const events of results) {
        const [event] = newestFirst(filterEventsByAuthor(events, author));
        if (!event) {
          continue;
        }
        allEvents.push(event);
        const chunkData = parseChunkEvent(event);
        if (chunkData) {
          allChunks.push(chunkData);
        }
      }
    }

    try {
      const chunkValidation = validateChunks(allChunks as ChunkData[], { maxChunks });
      if (!chunkValidation.valid) {
        throw new Error(describeChunkValidationFailure(chunkValidation, { maxChunks }));
      }

      // Chunks that carry snapshot metadata must agree on it, and the payload
      // hash must match. Legacy chunks without metadata pass unchanged.
      const snapshotValidation = await validateSnapshot(allChunks, {
        expectedAuthor: author,
        allowLegacy: true,
        verifyPayloadHash: options.verifyPayloadHash !== false,
        maxChunks,
      });
      if (!snapshotValidation.valid) {
        throw new Error(snapshotValidation.issues[0]?.message ?? 'Invalid snapshot');
      }

      const reassembled = reassembleChunks(allChunks, { maxChunks });
      const decoded = decodeContent(reassembled, chunk0Event, this.maxDecompressedSize(options));

      return {
        success: true,
        content: decoded.content,
        chunked: true,
        chunkCount: totalChunks,
        events: allEvents,
        compressed: decoded.compressed,
        snapshotId: snapshotValidation.snapshotId,
      };
    } catch (error) {
      return failure({
        chunked: true,
        chunkCount: allChunks.length,
        events: allEvents,
        error: error instanceof Error ? error.message : 'Reassembly failed',
      });
    }
  }
}
