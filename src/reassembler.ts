/**
 * Chunk reassembly logic - pure functions for reconstructing content from chunks
 */

import type { Event } from 'nostr-tools';
import { TAGS } from './constants';
import type { ChunkData, ValidationResult } from './types';

/**
 * Parse chunk metadata from a Nostr event
 *
 * @param event - The Nostr event to parse
 * @returns ChunkData if event is a chunk, null otherwise
 */
export function parseChunkFromEvent(event: Event): ChunkData | null {
  // Find the chunk tag
  const chunkTag = event.tags.find(t => t[0] === TAGS.CHUNK);
  if (!chunkTag || chunkTag.length < 3) {
    return null;
  }

  const index = parseInt(chunkTag[1], 10);
  const total = parseInt(chunkTag[2], 10);

  if (isNaN(index) || isNaN(total) || index < 0 || total <= 0) {
    return null;
  }

  return {
    index,
    total,
    data: event.content,
  };
}

/**
 * Check if an event is a chunk (has chunk tag)
 *
 * @param event - The Nostr event to check
 * @returns true if event is a chunk
 */
export function isChunkEvent(event: Event): boolean {
  return event.tags.some(t => t[0] === TAGS.CHUNK);
}

/**
 * Check if an event has a migration marker (indicates data moved to chunks)
 *
 * @param event - The Nostr event to check
 * @returns true if event has migration marker
 */
export function hasMigrationMarker(event: Event): boolean {
  return event.tags.some(t => t[0] === TAGS.MIGRATED);
}

/**
 * Sort chunks by index
 *
 * @param chunks - Array of chunks to sort
 * @returns New sorted array
 */
export function sortChunks(chunks: ChunkData[]): ChunkData[] {
  return [...chunks].sort((a, b) => a.index - b.index);
}

/**
 * Validate that all chunks are present and consistent
 *
 * @param chunks - Array of chunks to validate
 * @returns Validation result with details about any issues
 */
export function validateChunks(chunks: ChunkData[]): ValidationResult {
  if (chunks.length === 0) {
    return {
      valid: false,
      missing: [],
      duplicates: [],
    };
  }

  // Get expected total from first chunk
  const expectedTotal = chunks[0].total;

  // Check all chunks have same total
  const inconsistentTotal = chunks.some(c => c.total !== expectedTotal);
  if (inconsistentTotal) {
    return {
      valid: false,
      missing: [],
      duplicates: [],
    };
  }

  // Find missing and duplicate indices
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
    valid: missing.length === 0 && duplicates.length === 0,
    missing,
    duplicates,
  };
}

/**
 * Reassemble chunks into original content
 *
 * @param chunks - Array of chunks to reassemble
 * @returns Reassembled content string
 * @throws Error if chunks are invalid or incomplete
 *
 * @example
 * ```ts
 * const chunks = events.map(e => parseChunkFromEvent(e)).filter(Boolean);
 * const validation = validateChunks(chunks);
 * if (validation.valid) {
 *   const content = reassembleChunks(chunks);
 * }
 * ```
 */
export function reassembleChunks(chunks: ChunkData[]): string {
  const validation = validateChunks(chunks);
  if (!validation.valid) {
    if (validation.missing.length > 0) {
      throw new Error(`Missing chunks: ${validation.missing.join(', ')}`);
    }
    if (validation.duplicates.length > 0) {
      throw new Error(`Duplicate chunks: ${validation.duplicates.join(', ')}`);
    }
    throw new Error('Invalid chunks');
  }

  // Sort and concatenate
  const sorted = sortChunks(chunks);
  return sorted.map(c => c.data).join('');
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
  const versionTag = event.tags.find(t => t[0] === TAGS.VERSION);
  return versionTag ? versionTag[1] : null;
}

/**
 * Check if event content is compressed
 *
 * @param event - The Nostr event
 * @returns Compression type string or null if not compressed
 */
export function getCompressionType(event: Event): string | null {
  const compressedTag = event.tags.find(t => t[0] === TAGS.COMPRESSED);
  return compressedTag ? compressedTag[1] : null;
}
