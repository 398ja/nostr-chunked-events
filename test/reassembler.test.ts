import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  parseChunkFromEvent,
  parseChunkEvent,
  isChunkEvent,
  hasMigrationMarker,
  sortChunks,
  validateChunks,
  validateSnapshot,
  selectBestSnapshot,
  reassembleChunks,
  getTotalChunks,
  getEventVersion,
  getCompressionType,
} from '../src/reassembler';
import type { Event } from 'nostr-tools';
import type { ChunkData } from '../src/types';

// Helper to create mock events
function createMockEvent(tags: string[][], content: string, overrides: Partial<Event> = {}): Event {
  return {
    id: overrides.id ?? 'test-id',
    pubkey: overrides.pubkey ?? 'test-pubkey',
    created_at: overrides.created_at ?? Math.floor(Date.now() / 1000),
    kind: overrides.kind ?? 30078,
    tags: overrides.tags ?? tags,
    content: overrides.content ?? content,
    sig: overrides.sig ?? 'test-sig',
  };
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
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

  describe('parseChunkEvent', () => {
    it('should parse snapshot metadata from event tags', () => {
      const event = createMockEvent(
        [
          ['d', 'wallet-chunk-0'],
          ['chunk', '0', '2'],
          ['snapshot_id', 'snapshot-a'],
          ['payload_hash', 'hash-a'],
          ['hash_alg', 'sha256'],
          ['total_chunks', '2'],
        ],
        'chunk data',
        {
          id: 'event-a',
          created_at: 123,
        },
      );

      const result = parseChunkEvent(event);
      expect(result).not.toBeNull();
      expect(result?.snapshotId).toBe('snapshot-a');
      expect(result?.payloadHash).toBe('hash-a');
      expect(result?.hashAlg).toBe('sha256');
      expect(result?.totalChunksTag).toBe(2);
      expect(result?.eventId).toBe('event-a');
      expect(result?.createdAt).toBe(123);
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

  describe('validateSnapshot', () => {
    it('should validate a strict snapshot and verify payload hash', async () => {
      const payload = '{"tokens":[1,2]}';
      const payloadHash = sha256(payload);
      const chunks = [
        parseChunkEvent(createMockEvent(
          [
            ['d', 'wallet-chunk-0'],
            ['chunk', '0', '2'],
            ['snapshot_id', 'snapshot-a'],
            ['payload_hash', payloadHash],
            ['hash_alg', 'sha256'],
            ['total_chunks', '2'],
          ],
          payload.slice(0, 8),
          { id: 'chunk-a0', created_at: 10 },
        )),
        parseChunkEvent(createMockEvent(
          [
            ['d', 'wallet-chunk-1'],
            ['chunk', '1', '2'],
            ['snapshot_id', 'snapshot-a'],
            ['payload_hash', payloadHash],
            ['hash_alg', 'sha256'],
            ['total_chunks', '2'],
          ],
          payload.slice(8),
          { id: 'chunk-a1', created_at: 10 },
        )),
      ].filter((chunk): chunk is NonNullable<typeof chunk> => chunk !== null);

      const result = await validateSnapshot(chunks, {
        expectedAuthor: 'test-pubkey',
        verifyPayloadHash: true,
      });

      expect(result.valid).toBe(true);
      expect(result.snapshotId).toBe('snapshot-a');
      expect(result.totalChunks).toBe(2);
      expect(result.payloadHashVerified).toBe(true);
    });

    it('should reject duplicate chunk indices within one snapshot', async () => {
      const payload = 'abcdef';
      const payloadHash = sha256(payload);
      const chunks = [
        parseChunkEvent(createMockEvent(
          [
            ['d', 'wallet-chunk-0'],
            ['chunk', '0', '2'],
            ['snapshot_id', 'snapshot-a'],
            ['payload_hash', payloadHash],
            ['hash_alg', 'sha256'],
            ['total_chunks', '2'],
          ],
          'abc',
          { id: 'chunk-a0-old', created_at: 10 },
        )),
        parseChunkEvent(createMockEvent(
          [
            ['d', 'wallet-chunk-0'],
            ['chunk', '0', '2'],
            ['snapshot_id', 'snapshot-a'],
            ['payload_hash', payloadHash],
            ['hash_alg', 'sha256'],
            ['total_chunks', '2'],
          ],
          'abc',
          { id: 'chunk-a0-new', created_at: 11 },
        )),
        parseChunkEvent(createMockEvent(
          [
            ['d', 'wallet-chunk-1'],
            ['chunk', '1', '2'],
            ['snapshot_id', 'snapshot-a'],
            ['payload_hash', payloadHash],
            ['hash_alg', 'sha256'],
            ['total_chunks', '2'],
          ],
          'def',
          { id: 'chunk-a1', created_at: 11 },
        )),
      ].filter((chunk): chunk is NonNullable<typeof chunk> => chunk !== null);

      const result = await validateSnapshot(chunks, {
        expectedAuthor: 'test-pubkey',
        verifyPayloadHash: true,
      });

      expect(result.valid).toBe(false);
      expect(result.issues.map((issue) => issue.code)).toContain('duplicate_index');
    });

    it('should reject wrong-author chunks', async () => {
      const payload = 'abcdef';
      const payloadHash = sha256(payload);
      const chunks = [
        parseChunkEvent(createMockEvent(
          [
            ['d', 'wallet-chunk-0'],
            ['chunk', '0', '1'],
            ['snapshot_id', 'snapshot-a'],
            ['payload_hash', payloadHash],
            ['hash_alg', 'sha256'],
            ['total_chunks', '1'],
          ],
          payload,
          {
            id: 'chunk-a0',
            pubkey: 'wrong-pubkey',
            created_at: 10,
          },
        )),
      ].filter((chunk): chunk is NonNullable<typeof chunk> => chunk !== null);

      const result = await validateSnapshot(chunks, {
        expectedAuthor: 'test-pubkey',
        verifyPayloadHash: true,
      });

      expect(result.valid).toBe(false);
      expect(result.issues.map((issue) => issue.code)).toContain('wrong_author');
    });
  });

  describe('selectBestSnapshot', () => {
    it('should select the newest valid snapshot instead of an incomplete newer snapshot', async () => {
      const olderPayload = 'older-valid-payload';
      const olderHash = sha256(olderPayload);
      const newerPayload = 'newer-incomplete-payload';
      const newerHash = sha256(newerPayload);
      const events = [
        createMockEvent(
          [
            ['d', 'wallet-chunk-0'],
            ['chunk', '0', '3'],
            ['snapshot_id', 'snapshot-new'],
            ['payload_hash', newerHash],
            ['hash_alg', 'sha256'],
            ['total_chunks', '3'],
          ],
          newerPayload.slice(0, 8),
          { id: 'new-0', created_at: 20 },
        ),
        createMockEvent(
          [
            ['d', 'wallet-chunk-0'],
            ['chunk', '0', '2'],
            ['snapshot_id', 'snapshot-old'],
            ['payload_hash', olderHash],
            ['hash_alg', 'sha256'],
            ['total_chunks', '2'],
          ],
          olderPayload.slice(0, 8),
          { id: 'old-0', created_at: 10 },
        ),
        createMockEvent(
          [
            ['d', 'wallet-chunk-1'],
            ['chunk', '1', '2'],
            ['snapshot_id', 'snapshot-old'],
            ['payload_hash', olderHash],
            ['hash_alg', 'sha256'],
            ['total_chunks', '2'],
          ],
          olderPayload.slice(8),
          { id: 'old-1', created_at: 10 },
        ),
      ];

      const result = await selectBestSnapshot(events, {
        strategy: 'newest-valid',
        expectedAuthor: 'test-pubkey',
        verifyPayloadHash: true,
      });

      expect(result.selected?.snapshotId).toBe('snapshot-old');
      expect(result.validation?.valid).toBe(true);
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0].candidate.snapshotId).toBe('snapshot-new');
      expect(result.rejected[0].validation.issues.map((issue) => issue.code)).toContain('inconsistent_total');
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
