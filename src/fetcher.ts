/**
 * Chunked event fetcher
 * Handles automatic detection, fetching, and reassembly of chunked content
 */

import type { Event, Filter } from 'nostr-tools';
import {
  parseChunkFromEvent,
  reassembleChunks,
  validateChunks,
  hasMigrationMarker,
  getCompressionType,
  sortChunks,
} from './reassembler';
import { getChunkDTag, getSingleEventDTag } from './chunker';
import { tryDecompress } from './compression';
import { RelayPool } from './relay';
import { TAGS } from './constants';
import type { FetcherOptions, FetchOptions, FetchResult, ProbeResult, ChunkData } from './types';

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
    };
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
    const relayUrls = options.relayUrls ?? this.options.defaultRelays ?? [];

    if (relayUrls.length === 0) {
      return {
        success: false,
        content: null,
        chunked: false,
        chunkCount: 0,
        events: [],
        compressed: false,
        error: 'No relay URLs provided',
      };
    }

    const pool = new RelayPool(relayUrls, {
      timeout: options.timeout ?? this.options.timeout,
      authHandler: this.options.authHandler,
    });

    try {
      const author = options.author ?? pubkey;

      // Strategy: Try chunked format first (query for chunk-0)
      const chunk0DTag = getChunkDTag(options.dTagPrefix, 0);
      const chunk0Filter: Filter = {
        kinds: [options.kind],
        authors: [author],
        '#d': [chunk0DTag],
        limit: 1,
      };

      const chunk0Events = await pool.query(chunk0Filter);

      if (chunk0Events.length > 0) {
        // Found chunked data - fetch all chunks
        return await this.fetchChunkedData(pool, author, options, chunk0Events[0]);
      }

      // No chunked data found - try single event format
      const stateDTag = getSingleEventDTag(options.dTagPrefix);
      const stateFilter: Filter = {
        kinds: [options.kind],
        authors: [author],
        '#d': [stateDTag],
        limit: 1,
      };

      const stateEvents = await pool.query(stateFilter);

      if (stateEvents.length === 0) {
        return {
          success: false,
          content: null,
          chunked: false,
          chunkCount: 0,
          events: [],
          compressed: false,
          error: 'No data found',
        };
      }

      const stateEvent = stateEvents[0];

      // Check for migration marker
      if (hasMigrationMarker(stateEvent)) {
        return {
          success: false,
          content: null,
          chunked: false,
          chunkCount: 0,
          events: [stateEvent],
          compressed: false,
          error: 'Data migrated to chunks but chunks not found',
        };
      }

      // Single event - check for compression and return
      const compressionType = getCompressionType(stateEvent);
      const isCompressed = compressionType !== null;
      const content = tryDecompress(stateEvent.content, isCompressed);

      return {
        success: true,
        content,
        chunked: false,
        chunkCount: 1,
        events: [stateEvent],
        compressed: isCompressed,
      };
    } catch (error) {
      return {
        success: false,
        content: null,
        chunked: false,
        chunkCount: 0,
        events: [],
        compressed: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    } finally {
      pool.close();
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
    } catch (error) {
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
    const relayUrls = options.relayUrls ?? this.options.defaultRelays ?? [];

    if (relayUrls.length === 0) {
      return { exists: false, chunked: false, chunkCount: 0 };
    }

    const pool = new RelayPool(relayUrls, {
      timeout: options.timeout ?? this.options.timeout,
      authHandler: this.options.authHandler,
    });

    try {
      const author = options.author ?? pubkey;

      // Check for chunk-0
      const chunk0DTag = getChunkDTag(options.dTagPrefix, 0);
      const chunk0Filter: Filter = {
        kinds: [options.kind],
        authors: [author],
        '#d': [chunk0DTag],
        limit: 1,
      };

      const chunk0Events = await pool.query(chunk0Filter);

      if (chunk0Events.length > 0) {
        const chunkData = parseChunkFromEvent(chunk0Events[0]);
        return {
          exists: true,
          chunked: true,
          chunkCount: chunkData?.total ?? 1,
        };
      }

      // Check for single event
      const stateDTag = getSingleEventDTag(options.dTagPrefix);
      const stateFilter: Filter = {
        kinds: [options.kind],
        authors: [author],
        '#d': [stateDTag],
        limit: 1,
      };

      const stateEvents = await pool.query(stateFilter);

      if (stateEvents.length > 0) {
        const stateEvent = stateEvents[0];
        if (hasMigrationMarker(stateEvent)) {
          return { exists: false, chunked: false, chunkCount: 0 };
        }
        return { exists: true, chunked: false, chunkCount: 1 };
      }

      return { exists: false, chunked: false, chunkCount: 0 };
    } finally {
      pool.close();
    }
  }

  /**
   * Fetch all chunks and reassemble
   */
  private async fetchChunkedData(
    pool: RelayPool,
    author: string,
    options: FetchOptions,
    chunk0Event: Event
  ): Promise<FetchResult> {
    const chunk0Data = parseChunkFromEvent(chunk0Event);

    if (!chunk0Data) {
      return {
        success: false,
        content: null,
        chunked: true,
        chunkCount: 0,
        events: [chunk0Event],
        compressed: false,
        error: 'Invalid chunk-0 event',
      };
    }

    const totalChunks = chunk0Data.total;
    const allEvents: Event[] = [chunk0Event];
    const allChunks: ChunkData[] = [chunk0Data];

    // Fetch remaining chunks in parallel
    if (totalChunks > 1) {
      const fetchPromises: Promise<Event[]>[] = [];

      for (let i = 1; i < totalChunks; i++) {
        const chunkDTag = getChunkDTag(options.dTagPrefix, i);
        const filter: Filter = {
          kinds: [options.kind],
          authors: [author],
          '#d': [chunkDTag],
          limit: 1,
        };
        fetchPromises.push(pool.query(filter));
      }

      const results = await Promise.all(fetchPromises);

      for (const events of results) {
        if (events.length > 0) {
          const event = events[0];
          allEvents.push(event);

          const chunkData = parseChunkFromEvent(event);
          if (chunkData) {
            allChunks.push(chunkData);
          }
        }
      }
    }

    // Validate chunks
    const validation = validateChunks(allChunks);

    if (!validation.valid) {
      return {
        success: false,
        content: null,
        chunked: true,
        chunkCount: allChunks.length,
        events: allEvents,
        compressed: false,
        error: validation.missing.length > 0
          ? `Missing chunks: ${validation.missing.join(', ')}`
          : `Duplicate chunks: ${validation.duplicates.join(', ')}`,
      };
    }

    // Reassemble
    try {
      const reassembled = reassembleChunks(allChunks);

      // Check for compression (use chunk-0 as reference)
      const compressionType = getCompressionType(chunk0Event);
      const isCompressed = compressionType !== null;
      const content = tryDecompress(reassembled, isCompressed);

      return {
        success: true,
        content,
        chunked: true,
        chunkCount: totalChunks,
        events: allEvents,
        compressed: isCompressed,
      };
    } catch (error) {
      return {
        success: false,
        content: null,
        chunked: true,
        chunkCount: allChunks.length,
        events: allEvents,
        compressed: false,
        error: error instanceof Error ? error.message : 'Reassembly failed',
      };
    }
  }
}
