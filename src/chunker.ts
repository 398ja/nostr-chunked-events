/**
 * Core chunking logic - pure functions for splitting content into chunks
 */

import { config, D_TAG_SUFFIXES } from './constants';
import type { Chunk, ChunkOptions } from './types';

/**
 * Check if content needs to be chunked based on size
 *
 * @param content - The content to check
 * @param threshold - Size threshold in bytes (default: config.maxSingleEventSize)
 * @returns true if content exceeds threshold and needs chunking
 */
export function needsChunking(content: string, threshold?: number): boolean {
  const limit = threshold ?? config.maxSingleEventSize;
  return Buffer.byteLength(content, 'utf8') > limit;
}

/**
 * Calculate the byte size of content
 *
 * @param content - The content to measure
 * @returns Size in bytes
 */
export function calculateSize(content: string): number {
  return Buffer.byteLength(content, 'utf8');
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
 * Split content into chunks
 *
 * @param content - The content to split
 * @param options - Chunking options
 * @returns Array of chunks with metadata
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

  const contentBytes = Buffer.from(content, 'utf8');
  const totalBytes = contentBytes.length;

  // If content fits in a single chunk, return it as-is with state suffix
  if (totalBytes <= chunkSize) {
    return [{
      index: 0,
      total: 1,
      data: content,
      dTag: `${dTagPrefix}${D_TAG_SUFFIXES.STATE}`,
    }];
  }

  // Split into chunks
  // We need to be careful with UTF-8 boundaries - we can't split in the middle of a multi-byte character
  const chunks: Chunk[] = [];
  let offset = 0;

  while (offset < totalBytes) {
    // Calculate end position for this chunk
    let endOffset = Math.min(offset + chunkSize, totalBytes);

    // Adjust end offset to not split a multi-byte UTF-8 character
    // UTF-8 continuation bytes start with 10xxxxxx (0x80-0xBF)
    while (endOffset < totalBytes && endOffset > offset) {
      const byte = contentBytes[endOffset];
      // If this is a continuation byte, move back
      if ((byte & 0xC0) === 0x80) {
        endOffset--;
      } else {
        break;
      }
    }

    // Extract chunk data
    const chunkData = contentBytes.slice(offset, endOffset).toString('utf8');

    chunks.push({
      index: chunks.length,
      total: 0, // Will be set after all chunks are created
      data: chunkData,
      dTag: `${dTagPrefix}${D_TAG_SUFFIXES.CHUNK}${chunks.length}`,
    });

    offset = endOffset;
  }

  // Set total count on all chunks
  const total = chunks.length;
  for (const chunk of chunks) {
    chunk.total = total;
  }

  return chunks;
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
