import { describe, expect, it } from 'vitest';
import type { Event } from 'nostr-tools';
import {
  ancestryOf,
  isGenesis,
  isLegacyPreAncestry,
  isMergeSnapshot,
  MAX_WALK,
  parseChunkEvent,
  supersedesRelation,
  validateSnapshot,
} from '../src/index';

function createMockEvent(tags: string[][], content: string, overrides: Partial<Event> = {}): Event {
  return {
    id: overrides.id ?? `event-${Math.random()}`,
    pubkey: overrides.pubkey ?? 'test-pubkey',
    created_at: overrides.created_at ?? Math.floor(Date.now() / 1000),
    kind: overrides.kind ?? 37375,
    tags: overrides.tags ?? tags,
    content: overrides.content ?? content,
    sig: overrides.sig ?? 'test-sig',
  };
}

function createSnapshot(
  snapshotId: string,
  contentHash: string,
  parents: Array<{ snapshotId: string; contentHash: string }> = [],
) {
  return { snapshotId, contentHash, parents };
}

describe('ancestry helpers', () => {
  it('classifies genesis, ordinary, merge, and legacy snapshots', () => {
    const legacy = parseChunkEvent(createMockEvent([
      ['d', 'wallet-chunk-0'],
      ['chunk', '0', '1'],
      ['snapshot_id', 'legacy-snapshot'],
      ['payload_hash', 'hash-legacy'],
      ['hash_alg', 'sha256'],
      ['total_chunks', '1'],
    ], 'payload'));
    const genesis = parseChunkEvent(createMockEvent([
      ['d', 'wallet-chunk-0'],
      ['chunk', '0', '1'],
      ['snapshot_id', 'genesis-snapshot'],
      ['payload_hash', 'hash-genesis'],
      ['hash_alg', 'sha256'],
      ['total_chunks', '1'],
      ['parent_snapshot_id', ''],
      ['parent_content_hash', ''],
    ], 'payload'));
    const ordinary = parseChunkEvent(createMockEvent([
      ['d', 'wallet-chunk-0'],
      ['chunk', '0', '1'],
      ['snapshot_id', 'ordinary-snapshot'],
      ['payload_hash', 'hash-ordinary'],
      ['hash_alg', 'sha256'],
      ['total_chunks', '1'],
      ['parent_snapshot_id', 'genesis-snapshot'],
      ['parent_content_hash', 'hash-genesis'],
    ], 'payload'));
    const merge = parseChunkEvent(createMockEvent([
      ['d', 'wallet-chunk-0'],
      ['chunk', '0', '1'],
      ['snapshot_id', 'merge-snapshot'],
      ['payload_hash', 'hash-merge'],
      ['hash_alg', 'sha256'],
      ['total_chunks', '1'],
      ['parent_snapshot_id', 'ordinary-snapshot'],
      ['parent_content_hash', 'hash-ordinary'],
      ['parent_snapshot_id', 'server-snapshot'],
      ['parent_content_hash', 'hash-server'],
    ], 'payload'));

    expect(legacy).not.toBeNull();
    expect(genesis).not.toBeNull();
    expect(ordinary).not.toBeNull();
    expect(merge).not.toBeNull();

    expect(isLegacyPreAncestry(legacy!)).toBe(true);
    expect(isGenesis(genesis!)).toBe(true);
    expect(isGenesis(ordinary!)).toBe(false);
    expect(isMergeSnapshot(ordinary!)).toBe(false);
    expect(isMergeSnapshot(merge!)).toBe(true);
  });

  it('walks ancestry in parent order', () => {
    const genesis = createSnapshot('genesis', 'hash-g', []);
    const local = createSnapshot('local', 'hash-l', [{ snapshotId: 'genesis', contentHash: 'hash-g' }]);
    const remote = createSnapshot('remote', 'hash-r', [{ snapshotId: 'genesis', contentHash: 'hash-g' }]);
    const merge = createSnapshot('merge', 'hash-m', [
      { snapshotId: 'local', contentHash: 'hash-l' },
      { snapshotId: 'remote', contentHash: 'hash-r' },
    ]);

    expect(ancestryOf(merge, [genesis, local, remote, merge])).toEqual([
      { snapshotId: 'local', contentHash: 'hash-l' },
      { snapshotId: 'remote', contentHash: 'hash-r' },
      { snapshotId: 'genesis', contentHash: 'hash-g' },
    ]);
  });

  it('detects linear supersession, equality, divergence, and max-walk cutoff', () => {
    const genesis = createSnapshot('genesis', 'hash-g', []);
    const a = createSnapshot('a', 'hash-a', [{ snapshotId: 'genesis', contentHash: 'hash-g' }]);
    const b = createSnapshot('b', 'hash-b', [{ snapshotId: 'a', contentHash: 'hash-a' }]);
    const c = createSnapshot('c', 'hash-c', [{ snapshotId: 'b', contentHash: 'hash-b' }]);
    const sibling = createSnapshot('sibling', 'hash-s', [{ snapshotId: 'a', contentHash: 'hash-a' }]);

    expect(supersedesRelation(c, a, [genesis, a, b, c])).toBe('a-supersedes-b');
    expect(supersedesRelation(a, c, [genesis, a, b, c])).toBe('b-supersedes-a');
    expect(supersedesRelation(c, c, [genesis, a, b, c])).toBe('equal');
    expect(supersedesRelation(c, sibling, [genesis, a, b, c, sibling])).toBe('divergent');

    const chain = [{ snapshotId: 'root', contentHash: 'hash-root', parents: [] as Array<{ snapshotId: string; contentHash: string }> }];
    for (let index = 1; index <= MAX_WALK + 2; index += 1) {
      chain.push({
        snapshotId: `node-${index}`,
        contentHash: `hash-${index}`,
        parents: [{ snapshotId: index === 1 ? 'root' : `node-${index - 1}`, contentHash: index === 1 ? 'hash-root' : `hash-${index - 1}` }],
      });
    }

    expect(
      supersedesRelation(
        chain[chain.length - 1],
        chain[0],
        chain,
      ),
    ).toBe('divergent');
  });

  it('rejects snapshots whose fragments disagree on ancestry tags', async () => {
    const chunks = [
      parseChunkEvent(createMockEvent([
        ['d', 'wallet-chunk-0'],
        ['chunk', '0', '2'],
        ['snapshot_id', 'snapshot-a'],
        ['payload_hash', 'hash-a'],
        ['hash_alg', 'sha256'],
        ['total_chunks', '2'],
        ['parent_snapshot_id', 'local-a'],
        ['parent_content_hash', 'hash-local-a'],
      ], '{"chunk":0')),
      parseChunkEvent(createMockEvent([
        ['d', 'wallet-chunk-1'],
        ['chunk', '1', '2'],
        ['snapshot_id', 'snapshot-a'],
        ['payload_hash', 'hash-a'],
        ['hash_alg', 'sha256'],
        ['total_chunks', '2'],
        ['parent_snapshot_id', 'local-b'],
        ['parent_content_hash', 'hash-local-b'],
      ], '"payload"}')),
    ].filter((chunk): chunk is NonNullable<typeof chunk> => chunk !== null);

    const validation = await validateSnapshot(chunks, {
      expectedAuthor: 'test-pubkey',
      verifyPayloadHash: false,
    });

    expect(validation.valid).toBe(false);
    expect(validation.issues.some((issue) => issue.code === 'inconsistent_parents')).toBe(true);
  });
});
