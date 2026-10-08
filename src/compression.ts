/**
 * Compression utilities using gzip (pako)
 */

import pako from 'pako';
import { config } from './constants';
import type { CompressionResult } from './types';

/**
 * Compress content using gzip
 *
 * @param content - The string content to compress
 * @returns Compression result with base64-encoded data and stats
 *
 * @example
 * ```ts
 * const result = compress(largeJsonString);
 * console.log(`Compressed from ${result.originalSize} to ${result.compressedSize} bytes`);
 * console.log(`Ratio: ${(result.ratio * 100).toFixed(1)}%`);
 * ```
 */
export function compress(content: string): CompressionResult {
  // Convert string to Uint8Array
  const encoder = new TextEncoder();
  const inputBytes = encoder.encode(content);
  const originalSize = inputBytes.length;

  // Compress with gzip
  const compressed = pako.gzip(inputBytes);
  const compressedSize = compressed.length;

  // Encode to base64 for safe transport
  const base64 = uint8ArrayToBase64(compressed);

  return {
    data: base64,
    originalSize,
    compressedSize,
    ratio: compressedSize / originalSize,
  };
}

/** Options for {@link decompress} */
export interface DecompressOptions {
  /**
   * Largest decompressed output accepted, in bytes (default:
   * config.maxDecompressedSize = 8 MiB). Inflation stops as soon as the output
   * passes it, so a gzip bomb never allocates more than about this much.
   */
  maxSize?: number;
}

/** Output block size for streaming inflation */
const INFLATE_CHUNK_SIZE = 64 * 1024;

/**
 * Decompress gzip-compressed content
 *
 * Inflates in streaming mode and aborts once the output exceeds `maxSize`, so
 * a small payload that expands to gigabytes (a gzip bomb) is refused.
 *
 * @param compressedBase64 - Base64-encoded gzip data
 * @param options - Size limit
 * @returns Original decompressed string
 * @throws Error if decompression fails or the output exceeds `maxSize`
 */
export function decompress(compressedBase64: string, options: DecompressOptions = {}): string {
  const maxSize = options.maxSize ?? config.maxDecompressedSize;
  const compressed = base64ToUint8Array(compressedBase64);

  const blocks: Uint8Array[] = [];
  let total = 0;
  const inflator = new pako.Inflate({ chunkSize: INFLATE_CHUNK_SIZE });
  inflator.onData = (block: Uint8Array) => {
    total += block.length;
    if (total > maxSize) {
      throw new DecompressedSizeError(maxSize);
    }
    blocks.push(block);
  };
  inflator.push(compressed, true);
  if (inflator.err) {
    throw new Error(inflator.msg || `inflate error ${inflator.err}`);
  }
  // `ended` exists at runtime (pako 2) but is missing from @types/pako.
  if (!(inflator as unknown as { ended: boolean }).ended) {
    throw new Error('Truncated gzip data');
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    output.set(block, offset);
    offset += block.length;
  }
  return new TextDecoder().decode(output);
}

/** Thrown by {@link decompress} when the output would exceed the size limit */
export class DecompressedSizeError extends Error {
  constructor(public readonly maxSize: number) {
    super(`Decompressed size exceeds ${maxSize} bytes (maxDecompressedSize)`);
    this.name = 'DecompressedSizeError';
  }
}

/**
 * Check if content appears to be gzip-compressed (base64-encoded)
 *
 * This checks for the gzip magic bytes (1f 8b) at the start of the decoded data.
 *
 * @param data - The data to check (should be base64-encoded if compressed)
 * @returns true if data appears to be gzip-compressed
 */
export function isCompressed(data: string): boolean {
  try {
    // Try to decode as base64 and check for gzip magic bytes
    const bytes = base64ToUint8Array(data);
    // Gzip magic bytes: 0x1f 0x8b
    return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  } catch {
    return false;
  }
}

/**
 * Try to decompress content, returning original if not compressed
 *
 * @param content - Content that may or may not be compressed
 * @param isMarkedCompressed - Whether the content is marked as compressed (from tags)
 * @returns Decompressed content or original if not compressed
 */
export function tryDecompress(content: string, isMarkedCompressed: boolean): string {
  if (!isMarkedCompressed) {
    return content;
  }

  try {
    return decompress(content);
  } catch (error) {
    // Never fall back to the raw content for a bomb; that is not an edge case.
    if (error instanceof DecompressedSizeError) throw error;
    // If decompression fails, return original content
    // This handles edge cases where tag says compressed but content isn't
    return content;
  }
}

/**
 * Convert Uint8Array to base64 string using only browser/standard APIs
 * (btoa exists in browsers and Node >= 16).
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

/**
 * Convert base64 string to Uint8Array using only browser/standard APIs
 * (atob exists in browsers and Node >= 16).
 */
function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
