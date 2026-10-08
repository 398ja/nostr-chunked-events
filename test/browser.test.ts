// @vitest-environment happy-dom
/**
 * The low-level API must work in a browser, where Node's Buffer does not exist.
 * happy-dom still runs on Node, so Buffer is removed from the global scope.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Event } from 'nostr-tools';
import * as lib from '../src/index';

// Read sources before Buffer is removed (node:fs needs it).
const srcDir = join(__dirname, '..', 'src');
const sources = readdirSync(srcDir).map((file) => [
  file,
  // strip comments, so prose like "no Buffer" does not count
  readFileSync(join(srcDir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''),
] as const);

const g = globalThis as { Buffer?: unknown };
let savedBuffer: unknown;

describe('browser-like environment without Buffer', () => {
  // Only these tests run without Buffer (vitest's own matchers use it).
  beforeAll(() => {
    savedBuffer = g.Buffer;
    delete g.Buffer;
  });

  afterAll(() => {
    g.Buffer = savedBuffer;
  });

  it('really has no Buffer global', () => {
    expect(typeof (globalThis as { Buffer?: unknown }).Buffer).toBe('undefined');
    expect(typeof window).toBe('object');
  });

  it('calculateSize / needsChunking / createChunks work', () => {
    const content = 'é😀a'.repeat(1000);
    expect(lib.calculateSize('é😀a')).toBe(7);
    expect(lib.needsChunking(content, 100)).toBe(true);
    const chunks = lib.createChunks(content, { chunkSize: 100, dTagPrefix: 'x' });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.data).join('')).toBe(content);
  });

  it('compress / decompress round-trip', () => {
    const content = JSON.stringify({ proofs: Array.from({ length: 50 }, (_, i) => ({ i, s: 'secret' })) });
    const compressed = lib.compress(content);
    expect(compressed.ratio).toBeLessThan(1);
    expect(lib.isCompressed(compressed.data)).toBe(true);
    expect(lib.decompress(compressed.data)).toBe(content);
  });

  it('parseChunkEvent + validateSnapshot with verifyPayloadHash, on a regular kind (7375)', async () => {
    const payload = 'coupon-backup-'.repeat(500);
    const snapshot = lib.createSnapshotChunks(payload, { chunkSize: 1000, snapshotId: 'snap-1' });
    expect(lib.sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const events: Event[] = snapshot.chunks.map((chunk, i) => ({
      id: `e${i}`,
      pubkey: 'p',
      created_at: 1,
      kind: 7375,
      tags: chunk.tags,
      content: chunk.data,
      sig: 's',
    }));
    const parsed = events.map((e) => lib.parseChunkEvent(e)!);
    const validation = await lib.validateSnapshot(parsed, {
      expectedAuthor: 'p',
      verifyPayloadHash: true,
      requirePayloadHash: true,
    });
    expect(validation.issues).toEqual([]);
    expect(validation.valid).toBe(true);
    expect(validation.payloadHashVerified).toBe(true);
  });
});

describe('source has no Node-only APIs', () => {
  it('src/ does not reference Buffer, process, require or node: modules', () => {
    expect(sources.length).toBeGreaterThan(5);
    for (const [file, source] of sources) {
      expect(source, file).not.toMatch(/\bBuffer\b|\bprocess\.|\brequire\(|from ['"]node:/);
    }
  });
});
