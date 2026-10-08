import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Event, Filter } from 'nostr-tools';
import { ChunkedFetcher } from '../src/fetcher';
import { getChunkDTag } from '../src/chunker';
import { RelayPool } from '../src/relay';

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function createChunkEvent(
  author: string,
  index: number,
  total: number,
  snapshotId: string,
  payloadHash: string,
  data: string,
  overrides: Partial<Event> = {},
): Event {
  return {
    id: overrides.id ?? `${snapshotId}-${index}`,
    pubkey: overrides.pubkey ?? author,
    created_at: overrides.created_at ?? Math.floor(Date.now() / 1000),
    kind: overrides.kind ?? 37375,
    tags: overrides.tags ?? [
      ['d', getChunkDTag('wallet', index)],
      ['chunk', String(index), String(total)],
      ['snapshot_id', snapshotId],
      ['payload_hash', payloadHash],
      ['hash_alg', 'sha256'],
      ['total_chunks', String(total)],
    ],
    content: overrides.content ?? data,
    sig: overrides.sig ?? 'sig',
  };
}

describe('ChunkedFetcher', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('selects the newest valid snapshot and filters wrong-author chunk results', async () => {
    const author = 'a'.repeat(64);
    const wrongAuthor = 'b'.repeat(64);
    const olderPayload = 'older-valid-payload';
    const olderHash = sha256(olderPayload);
    const newerPayload = 'newer-incomplete-payload';
    const newerHash = sha256(newerPayload);
    const olderChunk0 = createChunkEvent(
      author,
      0,
      2,
      'snapshot-old',
      olderHash,
      olderPayload.slice(0, 8),
      { id: 'old-0', created_at: 10 },
    );
    const olderChunk1 = createChunkEvent(
      author,
      1,
      2,
      'snapshot-old',
      olderHash,
      olderPayload.slice(8),
      { id: 'old-1', created_at: 10 },
    );
    const newerChunk0 = createChunkEvent(
      author,
      0,
      3,
      'snapshot-new',
      newerHash,
      newerPayload.slice(0, 8),
      { id: 'new-0', created_at: 20 },
    );
    const wrongAuthorChunk = createChunkEvent(
      author,
      1,
      2,
      'snapshot-old',
      olderHash,
      'ignored',
      {
        id: 'wrong-1',
        pubkey: wrongAuthor,
        created_at: 30,
      },
    );

    vi.spyOn(RelayPool.prototype, 'close').mockImplementation(() => {});
    vi.spyOn(RelayPool.prototype, 'query').mockImplementation(async (filter: Filter) => {
      const dTags = filter['#d'] ?? [];
      if (dTags.length === 1 && dTags[0] === getChunkDTag('wallet', 0)) {
        return [newerChunk0, olderChunk0];
      }
      if (Array.isArray(dTags) && dTags.includes(getChunkDTag('wallet', 1))) {
        return [newerChunk0, olderChunk0, olderChunk1, wrongAuthorChunk];
      }
      return [];
    });

    const fetcher = new ChunkedFetcher({
      defaultRelays: ['wss://relay.example.com'],
    });

    const result = await fetcher.fetch(author, {
      kind: 37375,
      dTagPrefix: 'wallet',
      snapshotSelection: {
        strategy: 'newest-valid',
        expectedAuthor: author,
        verifyPayloadHash: true,
        allowLegacy: false,
      },
    });

    expect(result.success).toBe(true);
    expect(result.content).toBe(olderPayload);
    expect(result.snapshotId).toBe('snapshot-old');
    expect(result.validation?.valid).toBe(true);
    expect(result.rejectedSnapshots).toEqual([
      expect.objectContaining({
        snapshotId: 'snapshot-new',
      }),
    ]);
    expect(result.events.map((event) => event.pubkey)).toEqual([author, author]);
  });

  // Ported from the imani-apps fork, where the source was `globalThis.nostrApi`.
  // The general library takes the same hook as the `queryEvents` option.
  it('does not trust wrong-author results from a custom queryEvents source', async () => {
    const author = 'a'.repeat(64);
    const wrongEvent: Event = {
      id: 'wrong-single',
      pubkey: 'b'.repeat(64),
      created_at: 10,
      kind: 37375,
      tags: [['d', 'wallet-state']],
      content: '{"state":true}',
      sig: 'sig',
    };

    const fetcher = new ChunkedFetcher({
      async queryEvents(filter: Filter) {
        const dTags = filter['#d'] ?? [];
        if (dTags.includes('wallet-state')) {
          return [wrongEvent];
        }
        return [];
      },
    });

    const result = await fetcher.fetch(author, {
      kind: 37375,
      dTagPrefix: 'wallet',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('No data found');
  });
});
