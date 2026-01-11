import { describe, it, expect } from 'vitest';
import {
  createChunks,
  needsChunking,
  calculateSize,
  estimateChunkCount,
  getSingleEventDTag,
  getChunkDTag,
  parseDTag,
} from '../src/chunker';
import { configure } from '../src/constants';

describe('chunker', () => {
  describe('needsChunking', () => {
    it('should return false for small content', () => {
      const smallContent = 'Hello, World!';
      expect(needsChunking(smallContent)).toBe(false);
    });

    it('should return true for large content', () => {
      const largeContent = 'x'.repeat(400_000);
      expect(needsChunking(largeContent)).toBe(true);
    });

    it('should respect custom threshold', () => {
      const content = 'x'.repeat(1000);
      expect(needsChunking(content, 500)).toBe(true);
      expect(needsChunking(content, 2000)).toBe(false);
    });
  });

  describe('calculateSize', () => {
    it('should calculate correct byte size for ASCII', () => {
      expect(calculateSize('hello')).toBe(5);
    });

    it('should calculate correct byte size for UTF-8', () => {
      // Each emoji is 4 bytes in UTF-8
      expect(calculateSize('😀')).toBe(4);
      expect(calculateSize('hello 😀')).toBe(10);
    });
  });

  describe('estimateChunkCount', () => {
    it('should estimate chunk count correctly', () => {
      expect(estimateChunkCount(300_000, 300_000)).toBe(1);
      expect(estimateChunkCount(600_000, 300_000)).toBe(2);
      expect(estimateChunkCount(650_000, 300_000)).toBe(3);
    });
  });

  describe('createChunks', () => {
    it('should create single chunk for small content', () => {
      const content = 'Hello, World!';
      const chunks = createChunks(content, { dTagPrefix: 'test' });

      expect(chunks).toHaveLength(1);
      expect(chunks[0].index).toBe(0);
      expect(chunks[0].total).toBe(1);
      expect(chunks[0].data).toBe(content);
      expect(chunks[0].dTag).toBe('test-state');
    });

    it('should create multiple chunks for large content', () => {
      const content = 'x'.repeat(500_000);
      const chunks = createChunks(content, {
        chunkSize: 100_000,
        dTagPrefix: 'test',
      });

      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks[0].dTag).toBe('test-chunk-0');
      expect(chunks[1].dTag).toBe('test-chunk-1');

      // All chunks should have same total
      const total = chunks[0].total;
      expect(chunks.every((c) => c.total === total)).toBe(true);

      // Indices should be sequential
      chunks.forEach((chunk, i) => {
        expect(chunk.index).toBe(i);
      });
    });

    it('should preserve data integrity after chunking', () => {
      const original = JSON.stringify({ data: 'test'.repeat(50_000) });
      const chunks = createChunks(original, { chunkSize: 100_000 });

      // Reassemble
      const reassembled = chunks.map((c) => c.data).join('');
      expect(reassembled).toBe(original);
    });

    it('should handle UTF-8 boundaries correctly', () => {
      // Create content with emojis at chunk boundaries
      const emoji = '😀'; // 4 bytes
      const content = emoji.repeat(100_000); // Many emojis

      const chunks = createChunks(content, { chunkSize: 1000 });

      // Reassemble and verify no corruption
      const reassembled = chunks.map((c) => c.data).join('');
      expect(reassembled).toBe(content);
    });

    it('should use default prefix if not specified', () => {
      const content = 'Hello';
      const chunks = createChunks(content);

      expect(chunks[0].dTag).toBe('data-state');
    });
  });

  describe('getSingleEventDTag', () => {
    it('should generate correct single event d-tag', () => {
      expect(getSingleEventDTag('wallet')).toBe('wallet-state');
      expect(getSingleEventDTag('myapp-data')).toBe('myapp-data-state');
    });
  });

  describe('getChunkDTag', () => {
    it('should generate correct chunk d-tag', () => {
      expect(getChunkDTag('wallet', 0)).toBe('wallet-chunk-0');
      expect(getChunkDTag('wallet', 5)).toBe('wallet-chunk-5');
    });
  });

  describe('parseDTag', () => {
    it('should parse single event d-tag', () => {
      const result = parseDTag('wallet-state');
      expect(result.prefix).toBe('wallet');
      expect(result.chunkIndex).toBeNull();
    });

    it('should parse chunk d-tag', () => {
      const result = parseDTag('wallet-chunk-3');
      expect(result.prefix).toBe('wallet');
      expect(result.chunkIndex).toBe(3);
    });

    it('should handle unknown format', () => {
      const result = parseDTag('unknown-format');
      expect(result.prefix).toBe('unknown-format');
      expect(result.chunkIndex).toBeNull();
    });

    it('should handle complex prefixes', () => {
      const result = parseDTag('my-app-data-chunk-10');
      expect(result.prefix).toBe('my-app-data');
      expect(result.chunkIndex).toBe(10);
    });
  });
});
