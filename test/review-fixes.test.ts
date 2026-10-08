/**
 * Regression tests for the adversarial review of PR #1 (findings M1-M5, L1-L4).
 * Each describe block names the finding it covers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import pako from 'pako';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import type { Event, Filter, UnsignedEvent } from 'nostr-tools';
import * as lib from '../src/index';
import { SimplePool } from 'nostr-tools';
import { RelayPool } from '../src/relay';

afterEach(() => vi.restoreAllMocks());

const SK = generateSecretKey();
const AUTHOR = getPublicKey(SK);
const EVIL_SK = generateSecretKey();

function sign(tags: string[][], content: string, o: { kind?: number; created_at?: number; sk?: Uint8Array } = {}): Event {
  return finalizeEvent({ kind: o.kind ?? 30078, created_at: o.created_at ?? 100, tags, content }, o.sk ?? SK);
}

function legacy(index: number, total: number, data: string, o: { created_at?: number; sk?: Uint8Array; extra?: string[][] } = {}): Event {
  return sign([['d', lib.getChunkDTag('data', index)], ['chunk', String(index), String(total)], ...(o.extra ?? [])], data, o);
}

function snapshotEvents(
  payload: string,
  opts: { chunkSize?: number; kind?: number; created_at?: number; sk?: Uint8Array; snapshotId?: string; recordId?: string; dTagPrefix?: string } = {},
): Event[] {
  const s = lib.createSnapshotChunks(payload, {
    chunkSize: opts.chunkSize ?? 4,
    snapshotId: opts.snapshotId,
    recordId: opts.recordId,
    dTagPrefix: opts.dTagPrefix,
  });
  return s.chunks.map((c) => sign(c.tags, c.data, { kind: opts.kind ?? 7375, created_at: opts.created_at, sk: opts.sk }));
}

/** A query source that applies the kinds and #d parts of a filter, like a relay would. */
function source(events: Event[]) {
  return async (f: Filter): Promise<Event[]> => events.filter((e) =>
    (!f.kinds || f.kinds.includes(e.kind))
    && (!f['#d'] || f['#d'].includes(e.tags.find((t) => t[0] === 'd')?.[1] ?? '')),
  );
}

function gzipBase64(bytes: Uint8Array): string {
  const gz = pako.gzip(bytes);
  let bin = '';
  for (let i = 0; i < gz.length; i += 0x8000) bin += String.fromCharCode(...gz.subarray(i, i + 0x8000));
  return btoa(bin);
}

describe('M1: decompressed-size cap', () => {
  // The reviewer's bomb: 60 MiB of zeros gzips to under 120 KB of base64.
  const bomb = gzipBase64(new Uint8Array(60 * 1024 * 1024));

  it('the bomb is small on the wire', () => {
    expect(bomb.length).toBeLessThan(120_000);
  });

  it('decompress() refuses output above maxSize before inflating it all', () => {
    expect(() => lib.decompress(bomb, { maxSize: 1024 * 1024 })).toThrow(/exceeds/);
  });

  it('decompress() defaults to an 8 MiB cap (configurable)', () => {
    expect(lib.config.maxDecompressedSize).toBe(8 * 1024 * 1024);
    expect(() => lib.decompress(bomb)).toThrow(/exceeds 8388608/);
    expect(lib.decompress(gzipBase64(new TextEncoder().encode('hello')))).toBe('hello');
  });

  it('fetch refuses the bomb instead of returning 60 MiB', async () => {
    const event = legacy(0, 1, bomb, { extra: [['compressed', 'gzip']] });
    const fetcher = new lib.ChunkedFetcher({ queryEvents: source([event]) });
    const r = await fetcher.fetch(AUTHOR, { kind: 30078, dTagPrefix: 'data' });
    expect(r.success).toBe(false);
    expect(r.content).toBeNull();
    expect(r.error).toMatch(/exceeds/);
  });

  it('fetch takes a per-call maxDecompressedSize', async () => {
    const small = gzipBase64(new TextEncoder().encode('x'.repeat(2000)));
    const event = legacy(0, 1, small, { extra: [['compressed', 'gzip']] });
    const fetcher = new lib.ChunkedFetcher({ queryEvents: source([event]) });
    expect((await fetcher.fetch(AUTHOR, { kind: 30078, dTagPrefix: 'data' })).content).toBe('x'.repeat(2000));
    const capped = await fetcher.fetch(AUTHOR, { kind: 30078, dTagPrefix: 'data', maxDecompressedSize: 1000 });
    expect(capped.success).toBe(false);
  });
});

describe('M2: record id for regular kinds', () => {
  it('createSnapshotChunks writes a record_id tag on every chunk', () => {
    const s = lib.createSnapshotChunks('payload-abc', { chunkSize: 4, recordId: 'coupon-1' });
    expect(s.chunks.every((c) => c.tags.some(([n, v]) => n === 'record_id' && v === 'coupon-1'))).toBe(true);
    expect(lib.TAGS.RECORD_ID).toBe('record_id');
  });

  it('recordIdOf reads record_id, else the d tag without -chunk-n (same rule as imani-wallet#206)', () => {
    const [withTag] = snapshotEvents('abcdefgh', { recordId: 'r1', dTagPrefix: 'other' });
    expect(lib.recordIdOf(withTag)).toBe('r1');
    const [dOnly] = snapshotEvents('abcdefgh', { dTagPrefix: 'r2' });
    expect(lib.recordIdOf(dOnly)).toBe('r2');
    const [none] = snapshotEvents('abcdefgh');
    expect(lib.recordIdOf(none)).toBeUndefined();
  });

  it('selectBestSnapshot with recordId returns that record, not the newest unrelated one', async () => {
    const a = snapshotEvents('{"record":"A"}', { created_at: 100, recordId: 'A' });
    const b = snapshotEvents('{"record":"B"}', { created_at: 200, recordId: 'B' });
    const sel = await lib.selectBestSnapshot([...a, ...b], { expectedAuthor: AUTHOR, recordId: 'A' });
    expect(sel.selected?.chunks.map((c) => c.data).join('')).toBe('{"record":"A"}');
    expect(sel.rejected).toHaveLength(0);
  });

  it('two records sharing one snapshot_id are still separate candidates', () => {
    const a = snapshotEvents('AAAAAAAA', { created_at: 100, recordId: 'A', snapshotId: 's' });
    const b = snapshotEvents('BBBBBBBB', { created_at: 200, recordId: 'B', snapshotId: 's' });
    const groups = lib.groupChunksBySnapshot([...a, ...b], { expectedAuthor: AUTHOR });
    expect(groups.map((g) => g.recordId).sort()).toEqual(['A', 'B']);
  });

  it('validateSnapshot flags chunks of another record as wrong_record', async () => {
    const b = snapshotEvents('BBBBBBBB', { recordId: 'B' }).map((e) => lib.parseChunkEvent(e)!);
    const v = await lib.validateSnapshot(b, { expectedAuthor: AUTHOR, recordId: 'A' });
    expect(v.valid).toBe(false);
    expect(v.issues.map((i) => i.code)).toContain('wrong_record');
  });

  it('a candidate mixing two records is rejected', async () => {
    const a = snapshotEvents('AAAAAAAA', { recordId: 'A', snapshotId: 's' });
    const b = snapshotEvents('AAAAAAAA', { recordId: 'B', snapshotId: 's' });
    const v = await lib.validateSnapshot([a[0], b[1]].map((e) => lib.parseChunkEvent(e)!), { expectedAuthor: AUTHOR });
    expect(v.issues.map((i) => i.code)).toContain('wrong_record');
  });

  it('strict fetch and publisher carry the record id', async () => {
    const a = snapshotEvents('AAAAAAAA', { kind: 30078, dTagPrefix: 'data', recordId: 'A', created_at: 100 });
    const fetcher = new lib.ChunkedFetcher({ queryEvents: source(a) });
    const ok = await fetcher.fetch(AUTHOR, { kind: 30078, dTagPrefix: 'data', snapshotSelection: { recordId: 'A' } });
    expect(ok.content).toBe('AAAAAAAA');
    const other = await fetcher.fetch(AUTHOR, { kind: 30078, dTagPrefix: 'data', snapshotSelection: { recordId: 'B' } });
    expect(other.success).toBe(false);

    const published: Event[] = [];
    vi.spyOn(RelayPool.prototype, 'publish').mockImplementation(async (e: Event) => { published.push(e); return [{ success: true, relay: 'r' }]; });
    vi.spyOn(RelayPool.prototype, 'close').mockImplementation(() => {});
    const signer = { getPublicKey: async () => AUTHOR, signEvent: async (u: UnsignedEvent) => finalizeEvent(u, SK) };
    await new lib.ChunkedPublisher(signer, { defaultRelays: ['wss://r'] })
      .publish('y'.repeat(100), { kind: 30078, dTagPrefix: 'p', chunkSize: 40, maxSingleEventSize: 40, snapshot: { recordId: 'rec' } });
    expect(published.length).toBe(3);
    expect(published.every((e) => lib.recordIdOf(e) === 'rec')).toBe(true);
  });
});

describe('M3: per-call maxSingleEventSize still chunks', () => {
  it('maxSingleEventSize alone splits into chunks no larger than it', async () => {
    const published: Event[] = [];
    vi.spyOn(RelayPool.prototype, 'publish').mockImplementation(async (e: Event) => { published.push(e); return [{ success: true, relay: 'r' }]; });
    vi.spyOn(RelayPool.prototype, 'close').mockImplementation(() => {});
    const signer = { getPublicKey: async () => AUTHOR, signEvent: async (u: UnsignedEvent) => finalizeEvent(u, SK) };
    const res = await new lib.ChunkedPublisher(signer, { defaultRelays: ['wss://r'] })
      .publish('x'.repeat(100_000), { kind: 30078, dTagPrefix: 'p', maxSingleEventSize: 30_000, chunkSize: 300_000, maxEventSize: 1_000_000 });
    expect(res.success).toBe(true);
    expect(res.chunkCount).toBe(4);
    expect(published.every((e) => e.content.length <= 30_000)).toBe(true);
    expect(published.some((e) => e.tags.some(([n, v]) => n === 'd' && v === 'p-state'))).toBe(false);
  });

  it('refuses locally to send an event whose serialized size exceeds maxEventSize', async () => {
    const publish = vi.spyOn(RelayPool.prototype, 'publish').mockImplementation(async () => [{ success: true, relay: 'r' }]);
    vi.spyOn(RelayPool.prototype, 'close').mockImplementation(() => {});
    const signer = { getPublicKey: async () => AUTHOR, signEvent: async (u: UnsignedEvent) => finalizeEvent(u, SK) };
    // Every '"' doubles when serialized, so a 40,000-byte chunk becomes 80,000+.
    const res = await new lib.ChunkedPublisher(signer, { defaultRelays: ['wss://r'] })
      .publish('"'.repeat(60_000), { kind: 30078, dTagPrefix: 'p', chunkSize: 40_000, maxSingleEventSize: 40_000, maxEventSize: 65_536 });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/maxEventSize/);
    expect(publish).not.toHaveBeenCalled();
  });
});

describe('M4: signature verification on queryEvents results', () => {
  it('rejects a forged event that claims the author pubkey', async () => {
    const real = legacy(0, 1, 'REAL');
    const forged: Event = { ...real, content: 'FORGED', created_at: 999 }; // id/sig no longer match
    const fetcher = new lib.ChunkedFetcher({ queryEvents: source([forged]) });
    const r = await fetcher.fetch(AUTHOR, { kind: 30078, dTagPrefix: 'data' });
    expect(r.success).toBe(false);
    expect(r.content).toBeNull();
  });

  it('rejects an evil-signed event relabelled with the victim pubkey', async () => {
    const evil = legacy(0, 1, 'EVIL', { sk: EVIL_SK });
    const relabelled: Event = { ...evil, pubkey: AUTHOR };
    const good = legacy(0, 1, 'GOOD', { created_at: 50 });
    const fetcher = new lib.ChunkedFetcher({ queryEvents: source([relabelled, good]) });
    const r = await fetcher.fetch(AUTHOR, { kind: 30078, dTagPrefix: 'data' });
    expect(r.content).toBe('GOOD');
  });

  it('accepts the forged event only when the caller opts out with verifySignatures: false', async () => {
    const forged: Event = { ...legacy(0, 1, 'REAL'), content: 'FORGED' };
    const fetcher = new lib.ChunkedFetcher({ queryEvents: source([forged]), verifySignatures: false });
    expect((await fetcher.fetch(AUTHOR, { kind: 30078, dTagPrefix: 'data' })).content).toBe('FORGED');
  });
});

describe('M5: strfry-safe defaults', () => {
  it('defaults keep every event under strfry 65,536 even with worst-case JSON escaping', () => {
    expect(lib.config.maxEventSize).toBe(lib.STRFRY_DEFAULT_MAX_EVENT_SIZE);
    expect(lib.config.chunkSize).toBeLessThanOrEqual(32_000);
    expect(lib.config.maxSingleEventSize).toBeLessThanOrEqual(32_000);
    // Worst case for common text: every byte serializes to two bytes.
    const content = '"'.repeat(lib.config.chunkSize);
    const [chunk] = lib.createChunks(content + content, { dTagPrefix: 'p' });
    const event = sign([['d', chunk.dTag], ['chunk', '0', '2'], ['v', '1'], ['client', 'nostr-chunked-events']], chunk.data);
    expect(lib.serializedEventSize(event)).toBeLessThan(lib.STRFRY_DEFAULT_MAX_EVENT_SIZE);
  });
});

describe('L1: checks that had no isolated test', () => {
  it('strict fetch rejects a tampered chunk (payload hash)', async () => {
    const s = lib.createSnapshotChunks('good-payload-here', { chunkSize: 4, snapshotId: 's', dTagPrefix: 'data' });
    const events = s.chunks.map((c, i) => sign(c.tags, i === 1 ? 'XXXX' : c.data));
    const r = await new lib.ChunkedFetcher({ queryEvents: source(events) })
      .fetch(AUTHOR, { kind: 30078, dTagPrefix: 'data', snapshotSelection: {} });
    expect(r.success).toBe(false);
    expect(r.rejectedSnapshots?.[0].issues.map((i) => i.code)).toContain('payload_hash_mismatch');
  });

  const anyHash = (_alg: string, content: string) => lib.sha256Hex(content);
  const withAlg = (alg: (i: number) => string) => snapshotEvents('abcdefgh').map((e, i) => lib.parseChunkEvent({
    ...e, tags: e.tags.map((t) => (t[0] === 'hash_alg' ? ['hash_alg', alg(i)] : t)),
  })!);

  it('a non-sha256 hash_alg is rejected even with a permissive hashFn', async () => {
    const v = await lib.validateSnapshot(withAlg(() => 'md5'), { expectedAuthor: AUTHOR, verifyPayloadHash: true, hashFn: anyHash });
    expect(v.valid).toBe(false);
    expect(v.issues.map((i) => i.code)).toContain('unsupported_hash_alg');
    const off = await lib.validateSnapshot(withAlg(() => 'none'), { expectedAuthor: AUTHOR, verifyPayloadHash: false });
    expect(off.issues.map((i) => i.code)).toContain('unsupported_hash_alg');
  });

  it('mixed hash_alg values are rejected even with a permissive hashFn', async () => {
    const v = await lib.validateSnapshot(withAlg((i) => (i === 0 ? 'sha256' : 'SHA-256x')), {
      expectedAuthor: AUTHOR, verifyPayloadHash: false, hashFn: anyHash,
    });
    expect(v.issues.map((i) => i.message)).toContain('Candidate contains multiple hash_alg values');
  });

  it('validateChunks / reassembleChunks enforce maxChunks on their own', () => {
    // A complete, otherwise valid set that is merely above the limit.
    const three = [{ index: 0, total: 3, data: 'a' }, { index: 1, total: 3, data: 'b' }, { index: 2, total: 3, data: 'c' }];
    expect(lib.validateChunks(three, { maxChunks: 3 }).valid).toBe(true);
    expect(lib.validateChunks(three, { maxChunks: 2 }).valid).toBe(false);
    expect(() => lib.reassembleChunks(three, { maxChunks: 2 })).toThrow(/maxChunks/);
    // Default limit (1,000): 1,001 complete chunks are refused.
    const many = Array.from({ length: 1_001 }, (_, index) => ({ index, total: 1_001, data: 'x' }));
    expect(lib.validateChunks(many).valid).toBe(false);
    // A hostile total of 1e9 is covered in chunksize-guard.test.ts, in a
    // worker, because without the bound it exhausts memory.
  });

  it('strict range query drops other-author events before they reach the result', async () => {
    const mine = snapshotEvents('abcdefgh', { kind: 30078, dTagPrefix: 'data', snapshotId: 'm' }).slice(0, 1); // incomplete
    const theirs = snapshotEvents('ijklmnop', { kind: 30078, dTagPrefix: 'data', snapshotId: 't', sk: EVIL_SK });
    const r = await new lib.ChunkedFetcher({ queryEvents: source([...mine, ...theirs]) })
      .fetch(AUTHOR, { kind: 30078, dTagPrefix: 'data', snapshotSelection: {} });
    expect(r.success).toBe(false);
    expect(r.events.every((e) => e.pubkey === AUTHOR)).toBe(true);
  });

  it('selectBestSnapshot with expectedAuthor never turns foreign events into candidates', async () => {
    const mine = snapshotEvents('mine-payload', { created_at: 100, snapshotId: 'M' });
    const theirs = snapshotEvents('evil-payload', { created_at: 999, snapshotId: 'E', sk: EVIL_SK });
    const sel = await lib.selectBestSnapshot([...mine, ...theirs], { expectedAuthor: AUTHOR });
    expect(sel.selected?.snapshotId).toBe('M');
    expect(sel.rejected).toHaveLength(0);
    expect(lib.groupChunksBySnapshot([...mine, ...theirs], { expectedAuthor: AUTHOR })).toHaveLength(1);
  });

  it('a foreign chunk-0 never displaces the author\'s own (chunk-0 author filter)', async () => {
    const own = legacy(0, 1, 'OWN', { created_at: 100 });
    const foreign = legacy(0, 1, 'FOREIGN', { created_at: 999, sk: EVIL_SK });
    // A source that ignores `authors` (as a misbehaving backend might) and returns the newer foreign event too.
    const r = await new lib.ChunkedFetcher({ queryEvents: source([foreign, own]) })
      .fetch(AUTHOR, { kind: 30078, dTagPrefix: 'data' });
    expect(r.content).toBe('OWN');
  });
});

describe('L2: safe validateSnapshot / selectBestSnapshot defaults', () => {
  it('validateSnapshot verifies payload_hash by default', async () => {
    const events = snapshotEvents('abcdefgh');
    const tampered = events.map((e, i) => lib.parseChunkEvent(i === 1 ? { ...e, content: 'XXXX' } : e)!);
    const v = await lib.validateSnapshot(tampered);
    expect(v.valid).toBe(false);
    expect(v.issues.map((i) => i.code)).toContain('payload_hash_mismatch');
  });

  it('validateSnapshot rejects a candidate signed by more than one author even without expectedAuthor', async () => {
    const s = lib.createSnapshotChunks('abcdefgh', { chunkSize: 4, snapshotId: 's' });
    const parsed = s.chunks.map((c, i) => lib.parseChunkEvent(sign(c.tags, c.data, { sk: i === 0 ? SK : EVIL_SK }))!);
    const v = await lib.validateSnapshot(parsed);
    expect(v.issues.map((i) => i.code)).toContain('wrong_author');
  });

  it('selectBestSnapshot without expectedAuthor refuses to choose among several authors', async () => {
    const mine = snapshotEvents('mine-payload', { created_at: 100, snapshotId: 'm' });
    const theirs = snapshotEvents('evil-payload', { created_at: 999, snapshotId: 'x', sk: EVIL_SK });
    const sel = await lib.selectBestSnapshot([...mine, ...theirs]);
    expect(sel.selected).toBeNull();
    expect(sel.rejected.flatMap((r) => r.validation.issues.map((i) => i.code))).toContain('wrong_author');
  });
});

describe('L3: default fetch prefers the newest chunk-0', () => {
  it('a stale relay listed first does not win', async () => {
    const stale = legacy(0, 1, 'OLD', { created_at: 100 });
    const fresh = legacy(0, 1, 'NEW', { created_at: 200 });
    vi.spyOn(RelayPool.prototype, 'close').mockImplementation(() => {});
    // querySync concatenates per-relay results; limit applies per relay.
    vi.spyOn(RelayPool.prototype, 'query').mockImplementation(async (f: Filter) =>
      [[stale], [fresh]].flatMap((relay) => relay.filter((e) => f['#d']?.includes(e.tags[0][1])).slice(0, f.limit)));
    const r = await new lib.ChunkedFetcher({ defaultRelays: ['wss://stale', 'wss://fresh'] })
      .fetch(AUTHOR, { kind: 30078, dTagPrefix: 'data' });
    expect(r.content).toBe('NEW');
  });
});

describe('L4: network failure is not "No data found"', () => {
  it('a throwing queryEvents source is reported as unreachable', async () => {
    const r = await new lib.ChunkedFetcher({ queryEvents: async () => { throw new Error('backend down'); } })
      .fetch(AUTHOR, { kind: 30078, dTagPrefix: 'data' });
    expect(r.success).toBe(false);
    expect(r.unreachable).toBe(true);
    expect(r.error).not.toBe('No data found');
  });

  it('every relay unreachable is reported as unreachable', async () => {
    vi.spyOn(RelayPool.prototype, 'close').mockImplementation(() => {});
    vi.spyOn(RelayPool.prototype, 'query').mockRejectedValue(new lib.RelaysUnreachableError(['wss://a']));
    const r = await new lib.ChunkedFetcher({ defaultRelays: ['wss://a'] }).fetch(AUTHOR, { kind: 30078, dTagPrefix: 'data' });
    expect(r.unreachable).toBe(true);
    expect(r.error).toMatch(/unreachable/i);
  });

  it('RelayPool.query throws RelaysUnreachableError when no relay connects', async () => {
    vi.spyOn(SimplePool.prototype, 'ensureRelay').mockRejectedValue(new Error('connection refused'));
    const querySync = vi.spyOn(SimplePool.prototype, 'querySync');
    const pool = new RelayPool(['wss://a.test', 'wss://b.test'], { timeout: 500 });
    await expect(pool.query({ kinds: [1] })).rejects.toBeInstanceOf(lib.RelaysUnreachableError);
    expect(querySync).not.toHaveBeenCalled();
  });

  it('RelayPool.query queries only the reachable relays and returns [] for no events', async () => {
    vi.spyOn(SimplePool.prototype, 'ensureRelay').mockImplementation(async (url: string) => {
      if (url.includes('down')) throw new Error('connection refused');
      return {} as never;
    });
    const querySync = vi.spyOn(SimplePool.prototype, 'querySync').mockResolvedValue([]);
    const pool = new RelayPool(['wss://down.test', 'wss://up.test'], { timeout: 500 });
    expect(await pool.query({ kinds: [1] })).toEqual([]);
    expect(querySync.mock.calls[0][0]).toEqual(['wss://up.test']);
  });

  it('a reachable source with no events is still "No data found", not unreachable', async () => {
    const r = await new lib.ChunkedFetcher({ queryEvents: async () => [] }).fetch(AUTHOR, { kind: 30078, dTagPrefix: 'data' });
    expect(r.error).toBe('No data found');
    expect(r.unreachable).toBeFalsy();
  });
});
