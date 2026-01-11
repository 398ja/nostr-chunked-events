import { describe, it, expect } from 'vitest';
import {
  parseChunkFromEvent,
  isChunkEvent,
  hasMigrationMarker,
  sortChunks,
  validateChunks,
  reassembleChunks,
  getTotalChunks,
  getEventVersion,
  getCompressionType,
} from '../src/reassembler';
import type { Event } from 'nostr-tools';
import type { ChunkData } from '../src/types';

// Helper to create mock events
function createMockEvent(tags: string[][], content: string): Event {
  return {
    id: 'test-id',
    pubkey: 'test-pubkey',
    created_at: Math.floor(Date.now() / 1000),
    kind: 30078,
    tags,
    content,
    sig: 'test-sig',
  };
}

describe('reassembler', () => {
  describe('parseChunkFromEvent', () => {
    it('should parse chunk metadata from event', () => {
      const event = createMockEvent(
        [
          ['d', 'test-chunk-0'],
          ['chunk', '0', '3'],
        ],
        'chunk data'
      );

      const result = parseChunkFromEvent(event);
      expect(result).not.toBeNull();
      expect(result?.index).toBe(0);
      expect(result?.total).toBe(3);
      expect(result?.data).toBe('chunk data');
    });

    it('should return null for non-chunk events', () => {
      const event = createMockEvent([['d', 'test-state']], 'state data');

      const result = parseChunkFromEvent(event);
      expect(result).toBeNull();
    });

    it('should return null for invalid chunk tags', () => {
      const event = createMockEvent([['chunk', 'invalid']], 'data');
      expect(parseChunkFromEvent(event)).toBeNull();
    });
  });

  describe('isChunkEvent', () => {
    it('should return true for chunk events', () => {
      const event = createMockEvent(
        [['chunk', '0', '3']],
        'data'
      );
      expect(isChunkEvent(event)).toBe(true);
    });

    it('should return false for non-chunk events', () => {
      const event = createMockEvent([['d', 'test']], 'data');
      expect(isChunkEvent(event)).toBe(false);
    });
  });

  describe('hasMigrationMarker', () => {
    it('should detect migration marker', () => {
      const event = createMockEvent(
        [['migrated', 'chunked']],
        ''
      );
      expect(hasMigrationMarker(event)).toBe(true);
    });

    it('should return false when no migration marker', () => {
      const event = createMockEvent([['d', 'test']], 'data');
      expect(hasMigrationMarker(event)).toBe(false);
    });
  });

  describe('sortChunks', () => {
    it('should sort chunks by index', () => {
      const chunks: ChunkData[] = [
        { index: 2, total: 3, data: 'c' },
        { index: 0, total: 3, data: 'a' },
        { index: 1, total: 3, data: 'b' },
      ];

      const sorted = sortChunks(chunks);
      expect(sorted[0].index).toBe(0);
      expect(sorted[1].index).toBe(1);
      expect(sorted[2].index).toBe(2);
    });

    it('should not mutate original array', () => {
      const chunks: ChunkData[] = [
        { index: 1, total: 2, data: 'b' },
        { index: 0, total: 2, data: 'a' },
      ];

      sortChunks(chunks);
      expect(chunks[0].index).toBe(1); // Original unchanged
    });
  });

  describe('validateChunks', () => {
    it('should validate complete chunk set', () => {
      const chunks: ChunkData[] = [
        { index: 0, total: 3, data: 'a' },
        { index: 1, total: 3, data: 'b' },
        { index: 2, total: 3, data: 'c' },
      ];

      const result = validateChunks(chunks);
      expect(result.valid).toBe(true);
      expect(result.missing).toHaveLength(0);
      expect(result.duplicates).toHaveLength(0);
    });

    it('should detect missing chunks', () => {
      const chunks: ChunkData[] = [
        { index: 0, total: 3, data: 'a' },
        { index: 2, total: 3, data: 'c' },
      ];

      const result = validateChunks(chunks);
      expect(result.valid).toBe(false);
      expect(result.missing).toContain(1);
    });

    it('should detect duplicate chunks', () => {
      const chunks: ChunkData[] = [
        { index: 0, total: 2, data: 'a' },
        { index: 0, total: 2, data: 'a2' },
        { index: 1, total: 2, data: 'b' },
      ];

      const result = validateChunks(chunks);
      expect(result.valid).toBe(false);
      expect(result.duplicates).toContain(0);
    });

    it('should return invalid for empty array', () => {
      const result = validateChunks([]);
      expect(result.valid).toBe(false);
    });
  });

  describe('reassembleChunks', () => {
    it('should reassemble chunks in correct order', () => {
      const chunks: ChunkData[] = [
        { index: 2, total: 3, data: 'c' },
        { index: 0, total: 3, data: 'a' },
        { index: 1, total: 3, data: 'b' },
      ];

      const result = reassembleChunks(chunks);
      expect(result).toBe('abc');
    });

    it('should throw for missing chunks', () => {
      const chunks: ChunkData[] = [
        { index: 0, total: 3, data: 'a' },
        { index: 2, total: 3, data: 'c' },
      ];

      expect(() => reassembleChunks(chunks)).toThrow('Missing chunks');
    });

    it('should throw for duplicate chunks', () => {
      const chunks: ChunkData[] = [
        { index: 0, total: 2, data: 'a' },
        { index: 0, total: 2, data: 'a2' },
        { index: 1, total: 2, data: 'b' },
      ];

      expect(() => reassembleChunks(chunks)).toThrow('Duplicate chunks');
    });
  });

  describe('getTotalChunks', () => {
    it('should get total from single chunk', () => {
      const chunk: ChunkData = { index: 0, total: 5, data: 'test' };
      expect(getTotalChunks(chunk)).toBe(5);
    });

    it('should get total from chunk array', () => {
      const chunks: ChunkData[] = [
        { index: 0, total: 3, data: 'a' },
        { index: 1, total: 3, data: 'b' },
      ];
      expect(getTotalChunks(chunks)).toBe(3);
    });

    it('should return 0 for empty array', () => {
      expect(getTotalChunks([])).toBe(0);
    });
  });

  describe('getEventVersion', () => {
    it('should extract version from event', () => {
      const event = createMockEvent([['v', '1']], 'data');
      expect(getEventVersion(event)).toBe('1');
    });

    it('should return null if no version tag', () => {
      const event = createMockEvent([['d', 'test']], 'data');
      expect(getEventVersion(event)).toBeNull();
    });
  });

  describe('getCompressionType', () => {
    it('should extract compression type', () => {
      const event = createMockEvent([['compressed', 'gzip']], 'data');
      expect(getCompressionType(event)).toBe('gzip');
    });

    it('should return null if not compressed', () => {
      const event = createMockEvent([['d', 'test']], 'data');
      expect(getCompressionType(event)).toBeNull();
    });
  });
});
