/**
 * Features added while reconciling: regular (non-replaceable) kinds,
 * per-call size thresholds, opt-in snapshot publishing and size budgeting.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey, nip44 } from 'nostr-tools';
import type { Event, UnsignedEvent } from 'nostr-tools';
import {
  ChunkedPublisher,
  createSnapshotChunks,
  maxNip44PlaintextSize,
  nip44CiphertextSize,
  parseChunkEvent,
  RelayPool,
  selectBestSnapshot,
  sha256Hex,
  STRFRY_DEFAULT_MAX_EVENT_SIZE,
  validateSnapshot,
  config,
} from '../src/index';
import type { RelayPublishResponse } from '../src/index';

afterEach(() => {
  vi.restoreAllMocks();
});

function toEvents(chunks: { tags: string[][]; data: string }[], kind: number, pubkey = 'p', createdAt = 1): Event[] {
  return chunks.map((chunk, i) => ({
    id: `${createdAt}-${i}`,
    pubkey,
    created_at: createdAt,
    kind,
    tags: chunk.tags,
    content: chunk.data,
    sig: 's',
  }));
}

describe('createSnapshotChunks', () => {
  it('produces chunks for a regular kind (7375) with no d tag', async () => {
    const payload = JSON.stringify({ token: 'cashuB'.padEnd(5000, 'x') });
    const snapshot = createSnapshotChunks(payload, { chunkSize: 1200, snapshotId: 'coupon-1' });

    expect(snapshot.totalChunks).toBe(Math.ceil(payload.length / 1200));
    expect(snapshot.payloadHash).toBe(sha256Hex(payload));
    for (const chunk of snapshot.chunks) {
      expect(chunk.dTag).toBeUndefined();
      expect(chunk.tags.find((t) => t[0] === 'd')).toBeUndefined();
      expect(chunk.tags).toContainEqual(['snapshot_id', 'coupon-1']);
      expect(chunk.tags).toContainEqual(['total_chunks', String(snapshot.totalChunks)]);
    }

    const parsed = toEvents(snapshot.chunks, 7375).map((e) => parseChunkEvent(e)!);
    const result = await validateSnapshot(parsed.reverse(), {
      verifyPayloadHash: true,
      requireSnapshotId: true,
      requirePayloadHash: true,
    });
    expect(result.valid).toBe(true);
    expect(result.payloadHashVerified).toBe(true);
  });

  it('adds d tags only when dTagPrefix is set', () => {
    const snapshot = createSnapshotChunks('abcdefgh', { chunkSize: 4, dTagPrefix: 'wallet', snapshotId: 's' });
    expect(snapshot.chunks.map((c) => c.dTag)).toEqual(['wallet-chunk-0', 'wallet-chunk-1']);
    expect(snapshot.chunks[1].tags[0]).toEqual(['d', 'wallet-chunk-1']);
  });

  it('emits a single fully-tagged chunk for a small payload', () => {
    const snapshot = createSnapshotChunks('small', { snapshotId: 's' });
    expect(snapshot.totalChunks).toBe(1);
    expect(snapshot.chunks[0].tags).toContainEqual(['chunk', '0', '1']);
  });

  it('writes genesis and merge ancestry tags', async () => {
    const genesis = createSnapshotChunks('g', { snapshotId: 'g', parents: [] });
    const merge = createSnapshotChunks('m', {
      snapshotId: 'm',
      parents: [
        { snapshotId: 'a', contentHash: 'ha' },
        { snapshotId: 'b', contentHash: 'hb' },
      ],
    });
    const g = parseChunkEvent(toEvents(genesis.chunks, 7375)[0])!;
    const m = parseChunkEvent(toEvents(merge.chunks, 7375)[0])!;
    expect(g.parents).toEqual([]);
    expect(m.parents).toEqual([
      { snapshotId: 'a', contentHash: 'ha' },
      { snapshotId: 'b', contentHash: 'hb' },
    ]);
    expect((await validateSnapshot([m])).valid).toBe(true);
  });

  it('generates a random snapshot id by default', () => {
    expect(createSnapshotChunks('x').snapshotId).not.toBe(createSnapshotChunks('x').snapshotId);
  });

  it('rejects an empty payload and more than two parents', () => {
    expect(() => createSnapshotChunks('')).toThrow(RangeError);
    expect(() => createSnapshotChunks('x', {
      parents: [1, 2, 3].map((n) => ({ snapshotId: `${n}`, contentHash: `${n}` })),
    })).toThrow(RangeError);
  });

  it('validates a NIP-44 encrypted snapshot after decrypting each chunk', async () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const key = nip44.v2.utils.getConversationKey(sk, pk);
    const payload = JSON.stringify({ proofs: Array.from({ length: 300 }, (_, i) => ({ id: i, secret: `s${i}` })) });
    const snapshot = createSnapshotChunks(payload, { chunkSize: 2000 });

    const events = snapshot.chunks.map((chunk) => finalizeEvent({
      kind: 7375,
      created_at: 1,
      tags: chunk.tags,
      content: nip44.v2.encrypt(chunk.data, key),
    }, sk));

    const decrypted = events.map((event) => ({ ...parseChunkEvent(event)!, data: nip44.v2.decrypt(event.content, key) }));
    const result = await validateSnapshot(decrypted, { expectedAuthor: pk, verifyPayloadHash: true, requirePayloadHash: true });
    expect(result.valid).toBe(true);
    expect(result.chunks.map((c) => c.data).join('')).toBe(payload);
  });
});

describe('validateSnapshot hardening', () => {
  it('flags a chunk index beyond total_chunks as index_out_of_range', async () => {
    const snapshot = createSnapshotChunks('abcdefgh', { chunkSize: 4, snapshotId: 's' });
    const events = toEvents(snapshot.chunks, 7375);
    const extra: Event = {
      ...events[1],
      id: 'extra',
      tags: events[1].tags.map((t) => (t[0] === 'chunk' ? ['chunk', '2', '2'] : t)),
    };
    const result = await validateSnapshot([...events, extra].map((e) => parseChunkEvent(e)!));
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('index_out_of_range');
  });

  it('flags a total above maxChunks as too_many_chunks', async () => {
    const snapshot = createSnapshotChunks('abcdefghijkl', { chunkSize: 4, snapshotId: 's' });
    const parsed = toEvents(snapshot.chunks, 7375).map((e) => parseChunkEvent(e)!);
    const result = await validateSnapshot(parsed, { maxChunks: 2 });
    expect(result.issues.map((i) => i.code)).toContain('too_many_chunks');
  });

  it('rejects chunk tags with non-decimal numbers that parseInt would accept', () => {
    const base = toEvents(createSnapshotChunks('abcd', { snapshotId: 's' }).chunks, 7375)[0];
    for (const bad of [['chunk', '0x1', '2'], ['chunk', '1abc', '2'], ['chunk', '0', '2.5'], ['chunk', '-0', '1']]) {
      expect(parseChunkEvent({ ...base, tags: [bad] })).toBeNull();
    }
  });

  it('rejects identical duplicates by default and accepts them when allowIdenticalDuplicates is set', async () => {
    const snapshot = createSnapshotChunks('abcdefgh', { chunkSize: 4, snapshotId: 's' });
    const events = toEvents(snapshot.chunks, 7375);
    const retry = { ...events[0], id: 'retry-of-0', created_at: 2 };
    const parsed = [...events, retry].map((e) => parseChunkEvent(e)!);

    const strict = await validateSnapshot(parsed, { verifyPayloadHash: true });
    expect(strict.issues.map((i) => i.code)).toContain('duplicate_index');

    const lenient = await validateSnapshot(parsed, { verifyPayloadHash: true, allowIdenticalDuplicates: true });
    expect(lenient.valid).toBe(true);

    const conflicting = { ...retry, content: 'ZZZZ' };
    const bad = await validateSnapshot(
      [...events, conflicting].map((e) => parseChunkEvent(e)!),
      { allowIdenticalDuplicates: true },
    );
    expect(bad.issues.map((i) => i.code)).toContain('duplicate_index');
  });

  it('uses a pure-JS SHA-256 when crypto.subtle is unavailable', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    try {
      const snapshot = createSnapshotChunks('payload', { snapshotId: 's' });
      const result = await validateSnapshot(toEvents(snapshot.chunks, 7375).map((e) => parseChunkEvent(e)!), {
        verifyPayloadHash: true,
      });
      expect(result.payloadHashVerified).toBe(true);
    } finally {
      if (original) Object.defineProperty(globalThis, 'crypto', original);
    }
  });

  it('selects the newest valid snapshot among regular-kind events', async () => {
    const older = createSnapshotChunks('older-payload', { chunkSize: 5, snapshotId: 'old' });
    const newer = createSnapshotChunks('newer-payload', { chunkSize: 5, snapshotId: 'new' });
    const events = [
      ...toEvents(older.chunks, 7375, 'p', 10),
      ...toEvents(newer.chunks, 7375, 'p', 20).slice(1), // newer is missing chunk 0
    ];
    const result = await selectBestSnapshot(events, { expectedAuthor: 'p', verifyPayloadHash: true });
    expect(result.selected?.snapshotId).toBe('old');
    expect(result.rejected[0].candidate.snapshotId).toBe('new');
  });
});

describe('size budgeting', () => {
  it('matches nostr-tools NIP-44 ciphertext length', () => {
    const key = nip44.v2.utils.getConversationKey(generateSecretKey(), getPublicKey(generateSecretKey()));
    for (const len of [1, 32, 33, 100, 1000, 4096, 40_000, 40_961, 65_535]) {
      expect(nip44CiphertextSize(len), String(len)).toBe(nip44.v2.encrypt('a'.repeat(len), key).length);
    }
  });

  it('explains the imani-wallet#203 overflow: a 40,961-byte plaintext no longer fits strfry', () => {
    expect(STRFRY_DEFAULT_MAX_EVENT_SIZE).toBe(65_536);
    expect(nip44CiphertextSize(40_960)).toBeLessThan(STRFRY_DEFAULT_MAX_EVENT_SIZE - 1_000);
    expect(nip44CiphertextSize(40_961)).toBeGreaterThan(STRFRY_DEFAULT_MAX_EVENT_SIZE);
    expect(maxNip44PlaintextSize(STRFRY_DEFAULT_MAX_EVENT_SIZE - 1_536)).toBe(40_960);
    expect(nip44CiphertextSize(maxNip44PlaintextSize(10_000))).toBeLessThanOrEqual(10_000);
    expect(maxNip44PlaintextSize(10)).toBe(0);
  });
});

describe('ChunkedPublisher per-call thresholds and snapshot tags', () => {
  const sk = generateSecretKey();
  const signer = {
    getPublicKey: async () => getPublicKey(sk),
    signEvent: async (event: UnsignedEvent) => finalizeEvent(event, sk),
  };

  function capturePublishes(respond: (event: Event) => RelayPublishResponse[] = (e) => [{ success: true, relay: 'wss://r', message: e.id }]) {
    const published: Event[] = [];
    vi.spyOn(RelayPool.prototype, 'close').mockImplementation(() => {});
    vi.spyOn(RelayPool.prototype, 'publish').mockImplementation(async (event: Event) => {
      published.push(event);
      return respond(event);
    });
    return published;
  }

  it('chunks with per-call maxSingleEventSize and chunkSize, leaving global config untouched', async () => {
    const published = capturePublishes();
    const content = 'x'.repeat(10_000);
    const result = await new ChunkedPublisher(signer, { defaultRelays: ['wss://r'] }).publish(content, {
      kind: 30078,
      dTagPrefix: 'backup',
      maxSingleEventSize: 4_000,
      chunkSize: 3_000,
    });
    expect(result.success).toBe(true);
    expect(result.chunkCount).toBe(4);
    expect(published.map((e) => e.content.length)).toEqual([3000, 3000, 3000, 1000]);
    expect(config.maxSingleEventSize).toBe(350_000);
    expect(config.chunkSize).toBe(300_000);
  });

  it('adds snapshot integrity tags when snapshot is enabled', async () => {
    const published = capturePublishes();
    const content = 'y'.repeat(9_000);
    const result = await new ChunkedPublisher(signer, { defaultRelays: ['wss://r'] }).publish(content, {
      kind: 37375,
      dTagPrefix: 'wallet',
      maxSingleEventSize: 4_000,
      chunkSize: 4_000,
      snapshot: { snapshotId: 'snap-x' },
    });
    expect(result.snapshotId).toBe('snap-x');
    expect(published).toHaveLength(3);
    for (const [i, event] of published.entries()) {
      expect(event.tags.filter((t) => t[0] === 'd')).toEqual([['d', `wallet-chunk-${i}`]]);
      expect(event.tags.filter((t) => t[0] === 'chunk')).toEqual([['chunk', String(i), '3']]);
      expect(event.tags).toContainEqual(['payload_hash', sha256Hex(content)]);
    }
    const validation = await validateSnapshot(published.map((e) => parseChunkEvent(e)!), {
      expectedAuthor: getPublicKey(sk),
      verifyPayloadHash: true,
      requirePayloadHash: true,
    });
    expect(validation.valid).toBe(true);
  });

  it('surfaces the relay rejection reason per chunk', async () => {
    capturePublishes(() => [{ success: false, relay: 'wss://r', message: 'invalid: event too large: 66031' }]);
    const result = await new ChunkedPublisher(signer, { defaultRelays: ['wss://r'] }).publish('z'.repeat(100), {
      kind: 30078,
      dTagPrefix: 'd',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('event too large');
    expect(result.chunkResults?.[0].rejectedBy).toEqual([
      { relay: 'wss://r', message: 'invalid: event too large: 66031' },
    ]);
  });
});
