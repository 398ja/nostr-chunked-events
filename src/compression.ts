/**
 * Compression utilities using gzip (pako)
 */

import pako from 'pako';
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

/**
 * Decompress gzip-compressed content
 *
 * @param compressedBase64 - Base64-encoded gzip data
 * @returns Original decompressed string
 * @throws Error if decompression fails
 */
export function decompress(compressedBase64: string): string {
  // Decode base64 to Uint8Array
  const compressed = base64ToUint8Array(compressedBase64);

  // Decompress
  const decompressed = pako.ungzip(compressed);

  // Convert back to string
  const decoder = new TextDecoder();
  return decoder.decode(decompressed);
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
  } catch {
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
