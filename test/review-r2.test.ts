/**
 * Regression tests for the round-2 review of PR #1 (N-L1 to N-L4).
 * Each describe block names the finding it covers; N-L4 tests name the mutant.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import pako from 'pako';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import type { Event, Filter, UnsignedEvent } from 'nostr-tools';
import * as lib from '../src/index';
import { RelayPool } from '../src/relay';

const SK = generateSecretKey();
const AUTHOR = getPublicKey(SK);
const signer = { getPublicKey: async () => AUTHOR, signEvent: async (u: UnsignedEvent) => finalizeEvent(u, SK) };
const saved = { ...lib.config };

afterEach(() => {
  vi.restoreAllMocks();
  lib.configure(saved);
});

function sign(tags: string[][], content: string, created_at = 100): Event {
  return finalizeEvent({ kind: 30078, created_at, tags, content }, SK);
}

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

/** Capture what would go to relays, without opening sockets. */
function capturePublishes(): Event[] {
  const published: Event[] = [];
  vi.spyOn(RelayPool.prototype, 'publish').mockImplementation(async (e: Event) => {
    published.push(e);
    return [{ success: true, relay: 'r' }];
  });
  vi.spyOn(RelayPool.prototype, 'close').mockImplementation(() => {});
  return published;
}

const publisher = (compression = false) => new lib.ChunkedPublisher(signer, { defaultRelays: ['wss://r'], compression });

describe('N-L1: every event failing signature verification is its own error', () => {
  const stripSig = (e: Event): Event => ({ ...e, sig: '' });

  it('fetch reports unverified, not "No data found"', async () => {
    const events = [sign([['d', 'data-state']], 'REAL')].map(stripSig);
    const r = await new lib.ChunkedFetcher({ queryEvents: source(events) }).fetch(AUTHOR, { kind: 30078, dTagPrefix: 'data' });
    expect(r.success).toBe(false);
    expect(r.unverified).toBe(true);
    expect(r.error).not.toBe('No data found');
    expect(r.error).toMatch(/signature/i);
    expect(r.unreachable).toBeFalsy();
  });

  it('strict fetch with only unsigned chunks reports unverified', async () => {
    const s = lib.createSnapshotChunks('payload!', { chunkSize: 4, dTagPrefix: 'data' });
    const events = s.chunks.map((c) => stripSig(sign(c.tags, c.data)));
    const r = await new lib.ChunkedFetcher({ queryEvents: source(events) })
      .fetch(AUTHOR, { kind: 30078, dTagPrefix: 'data', snapshotSelection: {} });
    expect(r.unverified).toBe(true);
    expect(r.error).toMatch(/signature/i);
  });

  it('probe rejects with the exported SignatureVerificationError', async () => {
    const events = [sign([['d', 'data-state']], 'REAL')].map(stripSig);
    const p = new lib.ChunkedFetcher({ queryEvents: source(events) }).probe(AUTHOR, { kind: 30078, dTagPrefix: 'data' });
    await expect(p).rejects.toBeInstanceOf(lib.SignatureVerificationError);
  });

  it('one bad event among good ones is still dropped silently', async () => {
    const good = sign([['d', 'data-state']], 'GOOD', 50);
    const bad = stripSig(sign([['d', 'data-state']], 'BAD', 99));
    const r = await new lib.ChunkedFetcher({ queryEvents: source([bad, good]) }).fetch(AUTHOR, { kind: 30078, dTagPrefix: 'data' });
    expect(r.content).toBe('GOOD');
    expect(r.unverified).toBeFalsy();
  });

  it('unsigned events from another author do not count (the author filter drops them anyway)', async () => {
    const foreign = { ...sign([['d', 'data-state']], 'X'), pubkey: 'b'.repeat(64), sig: '' };
    const r = await new lib.ChunkedFetcher({ queryEvents: source([foreign]) }).fetch(AUTHOR, { kind: 30078, dTagPrefix: 'data' });
    expect(r.error).toBe('No data found');
    expect(r.unverified).toBeFalsy();
  });

  it('an empty answer is still "No data found"', async () => {
    const r = await new lib.ChunkedFetcher({ queryEvents: async () => [] }).fetch(AUTHOR, { kind: 30078, dTagPrefix: 'data' });
    expect(r.error).toBe('No data found');
    expect(r.unverified).toBeFalsy();
  });
});

describe('N-L2: probe() rejects with exported error types when unreachable', () => {
  it('a throwing queryEvents source rejects with SourceUnreachableError', async () => {
    const p = new lib.ChunkedFetcher({ queryEvents: async () => { throw new Error('backend down'); } })
      .probe(AUTHOR, { kind: 30078, dTagPrefix: 'data' });
    await expect(p).rejects.toBeInstanceOf(lib.SourceUnreachableError);
  });

  it('every relay down rejects with RelaysUnreachableError', async () => {
    vi.spyOn(RelayPool.prototype, 'close').mockImplementation(() => {});
    vi.spyOn(RelayPool.prototype, 'query').mockRejectedValue(new lib.RelaysUnreachableError(['wss://a']));
    const p = new lib.ChunkedFetcher({ defaultRelays: ['wss://a'] }).probe(AUTHOR, { kind: 30078, dTagPrefix: 'data' });
    await expect(p).rejects.toBeInstanceOf(lib.RelaysUnreachableError);
  });
});

describe('N-L3: publish refuses compressed payloads the default reader would refuse', () => {
  // Random hex compresses to about 55%, so it stays compressed and still chunks.
  const hex = (n: number) => Array.from({ length: n }, (_, i) => ((i * 2654435761) >>> 0 & 15).toString(16)).join('');

  it('refuses before sending when the decompressed size is above maxDecompressedSize', async () => {
    const published = capturePublishes();
    const res = await publisher(true).publish(hex(20_000), { kind: 30078, dTagPrefix: 'p', maxDecompressedSize: 10_000 });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/maxDecompressedSize/);
    expect(published).toHaveLength(0);
  });

  it('follows configure({ maxDecompressedSize })', async () => {
    const published = capturePublishes();
    lib.configure({ maxDecompressedSize: 10_000 });
    const res = await publisher(true).publish(hex(20_000), { kind: 30078, dTagPrefix: 'p' });
    expect(res.success).toBe(false);
    expect(published).toHaveLength(0);
  });

  it('a payload at the limit publishes and reads back with default fetch settings', async () => {
    const published = capturePublishes();
    const content = 'a'.repeat(10_000);
    const res = await publisher(true).publish(content, { kind: 30078, dTagPrefix: 'p', maxDecompressedSize: 10_000 });
    expect(res.success).toBe(true);
    expect(res.compressed).toBe(true);
    const r = await new lib.ChunkedFetcher({ queryEvents: source(published), maxDecompressedSize: 10_000 })
      .fetch(AUTHOR, { kind: 30078, dTagPrefix: 'p' });
    expect(r.content).toBe(content);
  });

  it('uncompressed payloads are not capped (the reader caps only gzip)', async () => {
    capturePublishes();
    const res = await publisher(false).publish('x'.repeat(20_000), { kind: 30078, dTagPrefix: 'p', maxDecompressedSize: 10_000 });
    expect(res.success).toBe(true);
  });
});

describe('N-L4: checks that no test covered (round-2 surviving mutants)', () => {
  it('N21: a single (unchunked) event is size-checked before sending', async () => {
    const published = capturePublishes();
    // 30,000 control characters: under the 32,000 chunking threshold, but
    // each serializes as \u0001 (six bytes), about 180 KB.
    const res = await publisher().publish('\u0001'.repeat(30_000), { kind: 30078, dTagPrefix: 'p' });
    expect(res.chunked).toBe(false);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/maxEventSize 65536/);
    expect(published).toHaveLength(0);
  });

  it('N22: per-call maxEventSize below the default refuses', async () => {
    const published = capturePublishes();
    const res = await publisher().publish('x'.repeat(5_000), { kind: 30078, dTagPrefix: 'p', maxEventSize: 2_000 });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/maxEventSize 2000/);
    expect(published).toHaveLength(0);
  });

  it('N22: per-call maxEventSize above the default allows a larger event', async () => {
    const published = capturePublishes();
    const res = await publisher().publish('\u0001'.repeat(30_000), { kind: 30078, dTagPrefix: 'p', maxEventSize: 1_000_000 });
    expect(res.success).toBe(true);
    expect(published).toHaveLength(1);
  });

  it('N29: configure({ maxEventSize }) is the default limit', async () => {
    const published = capturePublishes();
    lib.configure({ maxEventSize: 2_000 });
    const res = await publisher().publish('x'.repeat(5_000), { kind: 30078, dTagPrefix: 'p' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/maxEventSize 2000/);
    expect(published).toHaveLength(0);
  });

  it('N3: decompress refuses truncated gzip (pako itself reports no error)', () => {
    const full = gzipBase64(new TextEncoder().encode('hello world '.repeat(1000)));
    const bytes = Uint8Array.from(atob(full), (c) => c.charCodeAt(0));
    const truncated = btoa(String.fromCharCode(...bytes.subarray(0, Math.floor(bytes.length / 2))));
    expect(() => lib.decompress(truncated)).toThrow(/Truncated/);
  });

  it('N3: fetch fails on a truncated compressed payload instead of returning partial content', async () => {
    const full = gzipBase64(new TextEncoder().encode('hello world '.repeat(1000)));
    const bytes = Uint8Array.from(atob(full), (c) => c.charCodeAt(0));
    const truncated = btoa(String.fromCharCode(...bytes.subarray(0, Math.floor(bytes.length / 2))));
    const ev = sign([['d', 'data-state'], ['compressed', 'gzip']], truncated);
    const r = await new lib.ChunkedFetcher({ queryEvents: source([ev]) }).fetch(AUTHOR, { kind: 30078, dTagPrefix: 'data' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Truncated/);
  });

  it('N2: tryDecompress re-throws the size cap instead of returning the raw bomb', () => {
    const bomb = gzipBase64(new Uint8Array(1024 * 1024));
    lib.configure({ maxDecompressedSize: 1024 });
    expect(() => lib.tryDecompress(bomb, true)).toThrow(lib.DecompressedSizeError);
    // Non-cap failures still fall back to the raw content.
    expect(lib.tryDecompress('not-gzip', true)).toBe('not-gzip');
  });

  it('N30: configure({ maxDecompressedSize }) is the default cap', () => {
    lib.configure({ maxDecompressedSize: 100 });
    expect(() => lib.decompress(gzipBase64(new Uint8Array(1000)))).toThrow(lib.DecompressedSizeError);
  });

  it('N27: serializedEventSize of an unsigned event equals its signed size', () => {
    const unsigned = { kind: 30078, created_at: 100, tags: [['d', 'x']], content: 'hello "world"' };
    expect(lib.serializedEventSize(unsigned)).toBe(lib.serializedEventSize(finalizeEvent(unsigned, SK)));
  });

  it('N17: an empty recordId is refused', () => {
    expect(() => lib.createSnapshotChunks('abc', { recordId: '' })).toThrow(RangeError);
  });
});
