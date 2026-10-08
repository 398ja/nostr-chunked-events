/**
 * Chunked event publisher
 * Handles automatic chunking and publishing of large content
 */

import type { Event, UnsignedEvent } from 'nostr-tools';
import {
  createChunks,
  createSnapshotChunks,
  needsChunking,
  calculateSize,
  getSingleEventDTag,
  serializedEventSize,
} from './chunker';
import { compress } from './compression';
import { RelayPool } from './relay';
import { TAGS, LIBRARY_VERSION, CLIENT_TAG, COMPRESSION, config } from './constants';
import type {
  Signer,
  PublisherOptions,
  PublishOptions,
  PublishResult,
  ChunkPublishResult,
  RelayPublishResponse,
} from './types';

function toChunkResult(index: number, eventId: string, responses: RelayPublishResponse[]): ChunkPublishResult {
  return {
    index,
    eventId,
    acceptedBy: responses.filter((r) => r.success).map((r) => r.relay),
    rejectedBy: responses.filter((r) => !r.success).map((r) => ({ relay: r.relay, message: r.message })),
  };
}

function firstRejection(results: ChunkPublishResult[]): string | undefined {
  for (const result of results) {
    const rejection = result.rejectedBy.find((r) => r.message);
    if (rejection) return `${rejection.relay}: ${rejection.message}`;
  }
  return undefined;
}

/**
 * Publisher for chunked events
 *
 * Automatically handles:
 * - Size detection and chunking
 * - Optional gzip compression
 * - Event signing and publishing
 * - Progress callbacks
 *
 * @example
 * ```ts
 * const publisher = new ChunkedPublisher(signer, {
 *   defaultRelays: ['wss://relay.example.com'],
 *   compression: true
 * });
 *
 * const result = await publisher.publish(largeContent, {
 *   kind: 30078,
 *   dTagPrefix: 'myapp-data'
 * });
 * ```
 */
export class ChunkedPublisher {
  private signer: Signer;
  private options: PublisherOptions;

  constructor(signer: Signer, options?: PublisherOptions) {
    this.signer = signer;
    this.options = {
      defaultRelays: options?.defaultRelays ?? [],
      compression: options?.compression ?? false,
      deleteOrphanedChunks: options?.deleteOrphanedChunks ?? false,
      authHandler: options?.authHandler,
      timeout: options?.timeout,
    };
  }

  /**
   * Publish content to relays
   *
   * Automatically chunks if content exceeds size threshold.
   * Optionally compresses content before chunking.
   *
   * @param content - Content to publish
   * @param options - Publish options
   * @returns Publish result
   */
  async publish(content: string, options: PublishOptions): Promise<PublishResult> {
    const startTime = Date.now();
    const originalSize = calculateSize(content);
    const relayUrls = options.relayUrls ?? this.options.defaultRelays ?? [];

    if (relayUrls.length === 0) {
      return {
        success: false,
        chunked: false,
        compressed: false,
        chunkCount: 0,
        eventIds: [],
        publishedAt: startTime,
        originalSize,
        finalSize: originalSize,
        error: 'No relay URLs provided',
      };
    }

    try {
      // Get pubkey from signer
      const pubkey = await this.signer.getPublicKey();

      // Optionally compress
      let processedContent = content;
      let isCompressed = false;

      if (this.options.compression) {
        const compressed = compress(content);
        // Only use compression if it actually reduces size
        if (compressed.ratio < 0.9) {
          processedContent = compressed.data;
          isCompressed = true;
        }
      }

      // Readers refuse gzip output above maxDecompressedSize (a bomb guard
      // that must not follow the writer), so never write what they refuse.
      const maxDecompressedSize = options.maxDecompressedSize ?? config.maxDecompressedSize;
      if (isCompressed && originalSize > maxDecompressedSize) {
        throw new Error(
          `Payload is ${originalSize} bytes uncompressed, over maxDecompressedSize ${maxDecompressedSize}; ` +
          'readers with the same limit would refuse it, so nothing was published. ' +
          'Raise maxDecompressedSize on both publisher and fetcher, or publish uncompressed.',
        );
      }

      const finalSize = calculateSize(processedContent);

      // Check if chunking is needed (per-call threshold, then global default)
      if (!needsChunking(processedContent, options.maxSingleEventSize ?? config.maxSingleEventSize)) {
        // Single event
        return await this.publishSingleEvent(
          processedContent,
          pubkey,
          options,
          relayUrls,
          isCompressed,
          originalSize,
          finalSize
        );
      }

      // Chunked events
      return await this.publishChunkedEvents(
        processedContent,
        pubkey,
        options,
        relayUrls,
        isCompressed,
        originalSize,
        finalSize
      );
    } catch (error) {
      return {
        success: false,
        chunked: false,
        compressed: false,
        chunkCount: 0,
        eventIds: [],
        publishedAt: startTime,
        originalSize,
        finalSize: originalSize,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Publish and clean up old chunks if count changed
   *
   * This is useful when content size decreases and fewer chunks are needed.
   * Only works if deleteOrphanedChunks is enabled.
   */
  async publishWithCleanup(
    content: string,
    options: PublishOptions
  ): Promise<PublishResult> {
    // TODO: Implement cleanup of orphaned chunks
    // For now, just publish
    return this.publish(content, options);
  }

  /**
   * Delete all chunks for a given prefix
   */
  async deleteChunks(
    _kind: number,
    _dTagPrefix: string,
    _relayUrls?: string[]
  ): Promise<{ success: boolean; deleted: number }> {
    // TODO: Implement NIP-09 deletion events
    return { success: false, deleted: 0 };
  }

  /**
   * Publish a single (non-chunked) event
   */
  private async publishSingleEvent(
    content: string,
    pubkey: string,
    options: PublishOptions,
    relayUrls: string[],
    isCompressed: boolean,
    originalSize: number,
    finalSize: number
  ): Promise<PublishResult> {
    const dTag = getSingleEventDTag(options.dTagPrefix);
    const tags = this.buildTags(dTag, null, null, isCompressed, options.additionalTags);

    const unsignedEvent: UnsignedEvent = {
      kind: options.kind,
      pubkey,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content,
    };

    const signedEvent = await this.signer.signEvent(unsignedEvent);
    assertEventSize(signedEvent, 0, options);

    const pool = new RelayPool(relayUrls, {
      timeout: this.options.timeout,
      authHandler: this.options.authHandler,
    });

    try {
      const responses = await pool.publish(signedEvent);
      const successCount = responses.filter((r) => r.success).length;
      const chunkResults = [toChunkResult(0, signedEvent.id, responses)];

      options.onProgress?.(1, 1);

      return {
        success: successCount > 0,
        chunked: false,
        compressed: isCompressed,
        chunkCount: 1,
        eventIds: [signedEvent.id],
        publishedAt: signedEvent.created_at * 1000,
        originalSize,
        finalSize,
        chunkResults,
        error: successCount === 0
          ? `All relays failed${firstRejection(chunkResults) ? ` (${firstRejection(chunkResults)})` : ''}`
          : undefined,
      };
    } finally {
      pool.close();
    }
  }

  /**
   * Publish chunked events
   */
  private async publishChunkedEvents(
    content: string,
    pubkey: string,
    options: PublishOptions,
    relayUrls: string[],
    isCompressed: boolean,
    originalSize: number,
    finalSize: number
  ): Promise<PublishResult> {
    // Per-call chunk size, then global default, never above the single-event
    // threshold: a payload chunked because it is over maxSingleEventSize must
    // not then be published as one chunk of the same size.
    const chunkSize = Math.min(
      options.chunkSize ?? config.chunkSize,
      options.maxSingleEventSize ?? config.maxSingleEventSize,
    );
    const snapshotOptions = options.snapshot === true ? {} : options.snapshot || null;
    const snapshot = snapshotOptions
      ? createSnapshotChunks(content, {
          chunkSize,
          dTagPrefix: options.dTagPrefix,
          snapshotId: snapshotOptions.snapshotId,
          parents: snapshotOptions.parents,
          recordId: snapshotOptions.recordId,
        })
      : null;
    const chunks = snapshot
      ? snapshot.chunks.map((chunk) => ({ ...chunk, dTag: chunk.dTag as string }))
      : createChunks(content, { chunkSize, dTagPrefix: options.dTagPrefix });
    // Sign and size-check every chunk before sending any, so an oversized
    // chunk never leaves a partial snapshot on the relays.
    const signedEvents: Event[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const tags = this.buildTags(
        chunk.dTag,
        chunk.index,
        chunk.total,
        isCompressed,
        options.additionalTags,
        snapshot ? snapshot.chunks[i].tags : undefined,
      );

      const unsignedEvent: UnsignedEvent = {
        kind: options.kind,
        pubkey,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: chunk.data,
      };

      const signedEvent = await this.signer.signEvent(unsignedEvent);
      assertEventSize(signedEvent, chunk.index, options);
      signedEvents.push(signedEvent);
    }

    const eventIds = signedEvents.map((event) => event.id);
    const chunkResults: ChunkPublishResult[] = [];
    let successCount = 0;

    const pool = new RelayPool(relayUrls, {
      timeout: this.options.timeout,
      authHandler: this.options.authHandler,
    });

    try {
      for (let i = 0; i < signedEvents.length; i++) {
        const signedEvent = signedEvents[i];
        const responses = await pool.publish(signedEvent);
        chunkResults.push(toChunkResult(chunks[i].index, signedEvent.id, responses));
        if (responses.some((r) => r.success)) {
          successCount++;
        }

        options.onProgress?.(i + 1, chunks.length);
      }

      const rejection = firstRejection(chunkResults);
      return {
        success: successCount === chunks.length,
        chunked: true,
        compressed: isCompressed,
        chunkCount: chunks.length,
        eventIds,
        publishedAt: Date.now(),
        originalSize,
        finalSize,
        snapshotId: snapshot?.snapshotId,
        chunkResults,
        error: successCount < chunks.length
          ? `Only ${successCount}/${chunks.length} chunks published${rejection ? ` (${rejection})` : ''}`
          : undefined,
      };
    } finally {
      pool.close();
    }
  }

  /**
   * Build event tags
   */
  private buildTags(
    dTag: string,
    chunkIndex: number | null,
    chunkTotal: number | null,
    isCompressed: boolean,
    additionalTags?: string[][],
    snapshotTags?: string[][],
  ): string[][] {
    const tags: string[][] = [
      [TAGS.D_TAG, dTag],
      [TAGS.VERSION, LIBRARY_VERSION],
      [TAGS.CLIENT, CLIENT_TAG],
    ];

    if (snapshotTags) {
      // chunk, snapshot_id, payload_hash, hash_alg, total_chunks, parents (d is already set)
      tags.push(...snapshotTags.filter((tag) => tag[0] !== TAGS.D_TAG));
    } else if (chunkIndex !== null && chunkTotal !== null) {
      tags.push([TAGS.CHUNK, chunkIndex.toString(), chunkTotal.toString()]);
    }

    // Add compression tag if compressed
    if (isCompressed) {
      tags.push([TAGS.COMPRESSED, COMPRESSION.GZIP]);
    }

    // Add any additional tags
    if (additionalTags) {
      tags.push(...additionalTags);
    }

    return tags;
  }
}

/**
 * Throw when a signed event is larger, serialized, than the relay will take.
 * Caught by `publish()` and returned as `{ success: false, error }`.
 */
function assertEventSize(event: Event, index: number, options: PublishOptions): void {
  const limit = options.maxEventSize ?? config.maxEventSize;
  const size = serializedEventSize(event);
  if (size > limit) {
    throw new Error(
      `Event ${index} is ${size} bytes serialized, over maxEventSize ${limit}; nothing was published. ` +
      'Lower chunkSize / maxSingleEventSize (JSON escaping can double the content size).',
    );
  }
}

/**
 * Create a migration marker event
 *
 * This replaces the old single-event when migrating to chunked format,
 * preventing the fetcher from using stale data.
 */
export function createMigrationMarker(
  kind: number,
  dTagPrefix: string,
  pubkey: string
): UnsignedEvent {
  return {
    kind,
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      [TAGS.D_TAG, getSingleEventDTag(dTagPrefix)],
      [TAGS.MIGRATED, 'chunked'],
      [TAGS.VERSION, LIBRARY_VERSION],
      [TAGS.CLIENT, CLIENT_TAG],
    ],
    content: '',
  };
}
