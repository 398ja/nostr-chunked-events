/**
 * Regression tests for defects found while reconciling the imani-apps fork
 * (v0.2.0) with the standalone library (v0.1.0). Each test was red on v0.1.0.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SimplePool } from 'nostr-tools';
import type { Event, Filter } from 'nostr-tools';
import { createChunks, getChunkDTag } from '../src/chunker';
import { reassembleChunks, validateChunks } from '../src/reassembler';
import { RelayPool } from '../src/relay';
import { ChunkedFetcher } from '../src/fetcher';
import { sha256Hex } from '../src/hash';

const AUTHOR = 'a'.repeat(64);

function chunkEvent(index: number, total: number, data: string, extraTags: string[][] = [], overrides: Partial<Event> = {}): Event {
  return {
    id: overrides.id ?? `evt-${index}-${data}`,
    pubkey: overrides.pubkey ?? AUTHOR,
    created_at: overrides.created_at ?? 100,
    kind: overrides.kind ?? 30078,
    tags: [
      ['d', getChunkDTag('data', index)],
      ['chunk', String(index), String(total)],
      ...extraTags,
    ],
    content: data,
    sig: 'sig',
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createChunks input validation', () => {
  it('rejects a chunkSize smaller than one UTF-8 code point instead of looping forever', () => {
    // v0.1.0: the boundary walk-back reaches `offset`, emits an empty chunk and never advances.
    expect(() => createChunks('😀😀', { chunkSize: 2 })).toThrow(RangeError);
  });

  it('rejects non-positive and non-integer chunk sizes', () => {
    expect(() => createChunks('abc', { chunkSize: 0 })).toThrow(RangeError);
    expect(() => createChunks('abcdef', { chunkSize: Number.NaN })).toThrow(RangeError);
    expect(() => createChunks('abcdef', { chunkSize: 2.5 })).toThrow(RangeError);
  });
});

describe('validateChunks index bounds', () => {
  it('rejects an index outside 0..total-1 instead of concatenating it', () => {
    const chunks = [
      { index: 0, total: 2, data: 'a' },
      { index: 1, total: 2, data: 'b' },
      { index: 2, total: 2, data: 'INJECTED' },
    ];
    const result = validateChunks(chunks);
    expect(result.valid).toBe(false);
    expect(result.outOfRange).toEqual([2]);
    expect(() => reassembleChunks(chunks)).toThrow(/out of range/i);
  });
});

describe('RelayPool.publish', () => {
  it('reports a relay OK=false rejection as a failure', async () => {
    vi.spyOn(SimplePool.prototype, 'publish').mockImplementation(() => [
      Promise.reject(new Error('invalid: event too large: 66031')),
    ]);
    const pool = new RelayPool(['wss://relay.example.com'], { timeout: 1000 });
    const responses = await pool.publish({} as Event);
    pool.close();
    expect(responses).toEqual([
      { success: false, relay: 'wss://relay.example.com', message: 'invalid: event too large: 66031' },
    ]);
  });

  it('reports success only after the relay acknowledges', async () => {
    vi.spyOn(SimplePool.prototype, 'publish').mockImplementation(() => [Promise.resolve('')]);
    const pool = new RelayPool(['wss://relay.example.com'], { timeout: 1000 });
    const responses = await pool.publish({} as Event);
    pool.close();
    expect(responses).toEqual([{ success: true, relay: 'wss://relay.example.com', message: '' }]);
  });
});

describe('ChunkedFetcher default (non-strict) mode', () => {
  function mockQuery(events: Event[]) {
    vi.spyOn(RelayPool.prototype, 'close').mockImplementation(() => {});
    return vi.spyOn(RelayPool.prototype, 'query').mockImplementation(async (filter: Filter) => {
      const dTags = filter['#d'] ?? [];
      return events.filter((event) => dTags.includes(event.tags.find((t) => t[0] === 'd')![1]));
    });
  }

  it('refuses to splice chunks that carry different snapshot_id values', async () => {
    // Snapshot S2 overwrote chunk-0 only; chunk-1 is still from S1.
    mockQuery([
      chunkEvent(0, 2, 'NEW-', [['snapshot_id', 's2']]),
      chunkEvent(1, 2, 'old', [['snapshot_id', 's1']]),
    ]);
    const result = await new ChunkedFetcher({ defaultRelays: ['wss://r'] }).fetch(AUTHOR, {
      kind: 30078,
      dTagPrefix: 'data',
    });
    expect(result.success).toBe(false);
    expect(result.content).toBeNull();
  });

  it('ignores chunk events signed by another author', async () => {
    mockQuery([
      chunkEvent(0, 2, 'mine-'),
      chunkEvent(1, 2, 'theirs', [], { pubkey: 'b'.repeat(64) }),
    ]);
    const result = await new ChunkedFetcher({ defaultRelays: ['wss://r'] }).fetch(AUTHOR, {
      kind: 30078,
      dTagPrefix: 'data',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Missing chunks: 1/);
  });

  it('caps the chunk count announced by chunk-0 instead of issuing one query per claimed chunk', async () => {
    const query = mockQuery([chunkEvent(0, 200_000, 'x')]);
    const result = await new ChunkedFetcher({ defaultRelays: ['wss://r'] }).fetch(AUTHOR, {
      kind: 30078,
      dTagPrefix: 'data',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/maxChunks/);
    expect(query.mock.calls.length).toBeLessThan(10);
  });

  it('verifies payload_hash in default mode, with an opt-out', async () => {
    const tags = [['snapshot_id', 's'], ['payload_hash', sha256Hex('good-payload')], ['total_chunks', '2']];
    mockQuery([chunkEvent(0, 2, 'evil-', tags), chunkEvent(1, 2, 'payload', tags)]);
    const fetcher = new ChunkedFetcher({ defaultRelays: ['wss://r'] });

    const checked = await fetcher.fetch(AUTHOR, { kind: 30078, dTagPrefix: 'data' });
    expect(checked.success).toBe(false);
    expect(checked.error).toMatch(/Payload hash mismatch/);

    const unchecked = await fetcher.fetch(AUTHOR, { kind: 30078, dTagPrefix: 'data', verifyPayloadHash: false });
    expect(unchecked.success).toBe(true);
    expect(unchecked.content).toBe('evil-payload');
    expect(unchecked.snapshotId).toBe('s');
  });

  it('still reassembles legacy v0.1.0 chunks that carry no snapshot metadata', async () => {
    mockQuery([chunkEvent(1, 2, 'world'), chunkEvent(0, 2, 'hello ')]);
    const result = await new ChunkedFetcher({ defaultRelays: ['wss://r'] }).fetch(AUTHOR, {
      kind: 30078,
      dTagPrefix: 'data',
    });
    expect(result.success).toBe(true);
    expect(result.content).toBe('hello world');
    expect(result.snapshotId).toBeNull();
  });

  it('fails loudly when content tagged compressed does not decompress', async () => {
    mockQuery([chunkEvent(0, 1, 'not-gzip', [['compressed', 'gzip']])]);
    const result = await new ChunkedFetcher({ defaultRelays: ['wss://r'] }).fetch(AUTHOR, {
      kind: 30078,
      dTagPrefix: 'data',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/failed to decompress/);
  });
});
