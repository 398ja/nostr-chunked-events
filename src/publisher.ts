/**
 * Chunked event publisher
 * Handles automatic chunking and publishing of large content
 */

import type { Event, UnsignedEvent } from 'nostr-tools';
import { createChunks, needsChunking, calculateSize, getChunkDTag, getSingleEventDTag } from './chunker';
import { compress } from './compression';
import { RelayPool } from './relay';
import { TAGS, LIBRARY_VERSION, CLIENT_TAG, COMPRESSION } from './constants';
import type {
  Signer,
  PublisherOptions,
  PublishOptions,
  PublishResult,
  Chunk,
} from './types';

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

      const finalSize = calculateSize(processedContent);

      // Check if chunking is needed
      if (!needsChunking(processedContent)) {
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
    kind: number,
    dTagPrefix: string,
    relayUrls?: string[]
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

    const pool = new RelayPool(relayUrls, {
      timeout: this.options.timeout,
      authHandler: this.options.authHandler,
    });

    try {
      const responses = await pool.publish(signedEvent);
      const successCount = responses.filter((r) => r.success).length;

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
        error: successCount === 0 ? 'All relays failed' : undefined,
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
    // Create chunks
    const chunks = createChunks(content, { dTagPrefix: options.dTagPrefix });
    const eventIds: string[] = [];
    let successCount = 0;

    const pool = new RelayPool(relayUrls, {
      timeout: this.options.timeout,
      authHandler: this.options.authHandler,
    });

    try {
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const tags = this.buildTags(
          chunk.dTag,
          chunk.index,
          chunk.total,
          isCompressed,
          options.additionalTags
        );

        const unsignedEvent: UnsignedEvent = {
          kind: options.kind,
          pubkey,
          created_at: Math.floor(Date.now() / 1000),
          tags,
          content: chunk.data,
        };

        const signedEvent = await this.signer.signEvent(unsignedEvent);
        eventIds.push(signedEvent.id);

        const responses = await pool.publish(signedEvent);
        if (responses.some((r) => r.success)) {
          successCount++;
        }

        options.onProgress?.(i + 1, chunks.length);
      }

      return {
        success: successCount === chunks.length,
        chunked: true,
        compressed: isCompressed,
        chunkCount: chunks.length,
        eventIds,
        publishedAt: Date.now(),
        originalSize,
        finalSize,
        error: successCount < chunks.length ? `Only ${successCount}/${chunks.length} chunks published` : undefined,
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
    additionalTags?: string[][]
  ): string[][] {
    const tags: string[][] = [
      [TAGS.D_TAG, dTag],
      [TAGS.VERSION, LIBRARY_VERSION],
      [TAGS.CLIENT, CLIENT_TAG],
    ];

    // Add chunk tag if this is a chunk
    if (chunkIndex !== null && chunkTotal !== null) {
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
