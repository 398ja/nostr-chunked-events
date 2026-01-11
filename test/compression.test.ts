import { describe, it, expect } from 'vitest';
import {
  compress,
  decompress,
  isCompressed,
  tryDecompress,
} from '../src/compression';

describe('compression', () => {
  describe('compress', () => {
    it('should compress content', () => {
      const content = 'Hello, World!'.repeat(100);
      const result = compress(content);

      expect(result.originalSize).toBeGreaterThan(0);
      expect(result.compressedSize).toBeGreaterThan(0);
      expect(result.ratio).toBeLessThan(1);
      expect(result.data).toBeTruthy();
    });

    it('should achieve good compression for repetitive content', () => {
      const content = 'x'.repeat(10000);
      const result = compress(content);

      // Highly repetitive content should compress very well
      expect(result.ratio).toBeLessThan(0.1);
    });

    it('should handle empty content', () => {
      const result = compress('');
      expect(result.originalSize).toBe(0);
      // Gzip has minimum overhead, so compressed size > 0
      expect(result.compressedSize).toBeGreaterThan(0);
    });

    it('should handle UTF-8 content', () => {
      const content = '你好世界'.repeat(100);
      const result = compress(content);

      expect(result.originalSize).toBeGreaterThan(0);
      expect(result.data).toBeTruthy();
    });
  });

  describe('decompress', () => {
    it('should decompress content correctly', () => {
      const original = 'Hello, World!'.repeat(100);
      const compressed = compress(original);
      const decompressed = decompress(compressed.data);

      expect(decompressed).toBe(original);
    });

    it('should handle large content', () => {
      const original = JSON.stringify({
        data: 'test'.repeat(10000),
        array: Array(1000).fill({ key: 'value' }),
      });

      const compressed = compress(original);
      const decompressed = decompress(compressed.data);

      expect(decompressed).toBe(original);
    });

    it('should handle UTF-8 content', () => {
      const original = '你好世界 🌍 émojis'.repeat(100);
      const compressed = compress(original);
      const decompressed = decompress(compressed.data);

      expect(decompressed).toBe(original);
    });

    it('should throw for invalid compressed data', () => {
      expect(() => decompress('not-valid-base64-gzip')).toThrow();
    });
  });

  describe('isCompressed', () => {
    it('should detect compressed data', () => {
      const compressed = compress('Hello, World!');
      expect(isCompressed(compressed.data)).toBe(true);
    });

    it('should return false for uncompressed data', () => {
      expect(isCompressed('Hello, World!')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isCompressed('')).toBe(false);
    });

    it('should return false for random base64', () => {
      // This is valid base64 but not gzip
      expect(isCompressed('SGVsbG8sIFdvcmxkIQ==')).toBe(false);
    });
  });

  describe('tryDecompress', () => {
    it('should decompress when marked as compressed', () => {
      const original = 'Hello, World!';
      const compressed = compress(original);

      const result = tryDecompress(compressed.data, true);
      expect(result).toBe(original);
    });

    it('should return original when not marked as compressed', () => {
      const content = 'Hello, World!';
      const result = tryDecompress(content, false);
      expect(result).toBe(content);
    });

    it('should return original if decompression fails', () => {
      const content = 'not-compressed-data';
      // Marked as compressed but isn't
      const result = tryDecompress(content, true);
      expect(result).toBe(content);
    });
  });

  describe('roundtrip', () => {
    it('should preserve JSON data through compression roundtrip', () => {
      const original = {
        string: 'hello',
        number: 42,
        boolean: true,
        array: [1, 2, 3],
        nested: { a: 'b' },
        unicode: '日本語 🎉',
      };

      const json = JSON.stringify(original);
      const compressed = compress(json);
      const decompressed = decompress(compressed.data);
      const parsed = JSON.parse(decompressed);

      expect(parsed).toEqual(original);
    });
  });
});
