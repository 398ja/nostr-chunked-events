# nostr-chunked-events

A library for chunking and reassembling large Nostr events to overcome relay message size limits.

## Problem

Nostr relays impose size limits on events:
- **strfry default**: `events.maxEventSize = 65536` (64KB) for the whole serialized event (id, pubkey, sig, tags *and* content)
- **strfry default**: `relay.maxWebsocketPayloadSize = 131072` (128KB)

When applications need to store large data (encrypted files, wallet states, long-form content, ecash backups), these limits cause rejected events, WebSocket errors (code 1009) and data loss.

## Solution

This library splits large content into multiple smaller events (chunks) and reassembles them on retrieval. Optional snapshot metadata (`snapshot_id`, `payload_hash`, `total_chunks`) lets readers reject incomplete, mixed or tampered chunk sets and pick the newest *valid* snapshot.

Everything runs in browsers and Node: the code uses `TextEncoder`/`Uint8Array` and a pure-JS SHA-256, never Node's `Buffer`.

## Installation

```bash
npm install nostr-chunked-events nostr-tools
```

### Compatibility

ESM consumers work with any `nostr-tools` 2.x on supported Node versions.

CommonJS consumers (`require('nostr-chunked-events')`) on Node < 20.19 need
`nostr-tools` < 2.25, or Node >= 20.19. From 2.25, nostr-tools' own CJS build
`require()`s the ESM-only `@noble/curves`, which older Node cannot load. This
is an upstream limitation, not one of this package.

## Size limits and defaults

The defaults are safe for strfry, the most common relay:

| Setting | Default | Meaning |
|---|---|---|
| `maxEventSize` | 65,536 bytes | limit on each full serialized event; checked after signing, before anything is sent |
| `maxSingleEventSize` | 32,000 bytes | content above this is chunked |
| `chunkSize` | 32,000 bytes | UTF-8 bytes of content per chunk (never above `maxSingleEventSize`) |
| `maxChunks` | 1,000 | readers refuse chunk sets that claim more |
| `maxDecompressedSize` | 8 MiB | readers refuse gzip content that inflates beyond this |

Why 32,000 and not 60,000: strfry's `maxEventSize` (65,536) applies to the *serialized* event, and JSON escaping grows content. Every `"` and `\` becomes two bytes, so a 60,000-byte chunk of JSON-in-a-string (or quote-heavy text) can serialize to well over 65,536 and be rejected. 32,000 bytes leaves room for every byte doubling plus id, pubkey, sig and tags. Content made of control characters (`\u00XX`, six bytes each) can still overflow; the publisher measures the signed event and fails locally, with nothing sent, rather than leave a partial chunk set on the relay.

For a relay with a looser limit, raise all three per call (they never touch the global defaults), or globally with `configure()`:

```typescript
await publisher.publish(content, {
  kind: 30078,
  dTagPrefix: 'myapp-data',
  maxEventSize: 512_000,
  maxSingleEventSize: 300_000,
  chunkSize: 300_000,
});
```

Setting only `maxSingleEventSize` is enough: chunks are never larger than it.

Content you NIP-44 encrypt per chunk is base64, which needs no JSON escaping, so it can use more of the budget:

```typescript
import { STRFRY_DEFAULT_MAX_EVENT_SIZE, maxNip44PlaintextSize } from 'nostr-chunked-events';

// 40,960 bytes of plaintext is the largest that fits strfry with ~1.5KB of tags.
const chunkSize = maxNip44PlaintextSize(STRFRY_DEFAULT_MAX_EVENT_SIZE - 1_536); // 40_960
```

`serializedEventSize(event)` measures an event the way relays do.

`nip44CiphertextSize(n)` gives the exact `content` length NIP-44 v2 produces for `n` plaintext bytes. You can still change the global defaults with `configure()`.

## Quick Start

### Publishing

```typescript
import { ChunkedPublisher } from 'nostr-chunked-events';

const publisher = new ChunkedPublisher(signer, {
  defaultRelays: ['wss://relay.example.com'],
  compression: true  // Optional: enable gzip compression
});

const result = await publisher.publish(largeContent, {
  kind: 30078,           // Any parameterized replaceable kind
  dTagPrefix: 'myapp-data',
  snapshot: true,        // Optional: add snapshot_id / payload_hash / total_chunks
});

console.log(`Published ${result.chunkCount} chunks`);
if (!result.success) {
  // A relay that answers OK=false counts as a failure, with its reason
  console.error(result.error, result.chunkResults);
}
```

### Fetching

```typescript
import { ChunkedFetcher } from 'nostr-chunked-events';

const fetcher = new ChunkedFetcher({
  defaultRelays: ['wss://relay.example.com']
});

const result = await fetcher.fetch(pubkey, {
  kind: 30078,
  dTagPrefix: 'myapp-data'
});

if (result.success) {
  console.log('Content:', result.content);
  console.log('Was chunked:', result.chunked);
}
```

The fetcher only uses events signed by the requested author, refuses chunk-0 events that claim more than `maxChunks` chunks, and, when chunks carry snapshot metadata, refuses to splice chunks from different snapshots or with a wrong `payload_hash`.

### Strict snapshot selection

When writes can be interrupted (a newer snapshot only partly published), ask for the newest *valid* snapshot instead of trusting chunk-0:

```typescript
const result = await fetcher.fetch(pubkey, {
  kind: 37375,
  dTagPrefix: 'wallet',
  snapshotSelection: {
    strategy: 'newest-valid',   // or 'newest-seen'
    verifyPayloadHash: true,
    allowLegacy: false,         // require snapshot_id + payload_hash
  },
});

result.snapshotId;          // the snapshot that was chosen
result.rejectedSnapshots;   // newer candidates that failed, with reasons
```

### Custom query source

To read through your own cache or backend instead of opening relay connections, pass `queryEvents`. The fetcher verifies the id and signature of every event it returns and drops the ones that fail, then filters to the exact author and validates. The author filter alone only checks the `pubkey` field, which anyone can write, so do not turn verification off unless your source already verified the events:

```typescript
const fetcher = new ChunkedFetcher({
  queryEvents: (filter) => myBackend.queryEvents(filter),
  // verifySignatures: false,   // only if myBackend returns verified events
});
```

Make `queryEvents` **throw** when the backend is unreachable, not return `[]`. The fetcher then answers `{ success: false, unreachable: true }` instead of `error: 'No data found'`.

### Unreachable vs. no data

`result.unreachable === true` means no relay could be reached (or `queryEvents` threw): the data may well exist. Never treat it as an empty account and publish fresh state over it. `error: 'No data found'` with `unreachable` unset means a source answered and had nothing.

`result.unverified === true` means `queryEvents` returned events for the author but every one failed signature verification (typically a source that strips or re-serializes signatures). Treat it like `unreachable`, not as an empty account.

`probe()` rejects instead of answering `exists: false` in the same cases: `RelaysUnreachableError`, `SourceUnreachableError` or `SignatureVerificationError`, all exported for `instanceof` checks.

`selectBestSnapshot` / `validateSnapshot` / `groupChunksBySnapshot` filter by author but do not check signatures: verify events before passing them in, unless they came from a verifying pool such as nostr-tools' `SimplePool`.

With `compression: true`, `publish()` refuses a payload whose uncompressed size is above `maxDecompressedSize` (default 8 MiB), because readers with the same limit would refuse it. Raise `maxDecompressedSize` on both sides to store more.

### With Encryption

The library is encryption-agnostic. Encrypt before publishing, decrypt after fetching:

```typescript
import { ChunkedPublisher, ChunkedFetcher } from 'nostr-chunked-events';
import { nip04 } from 'nostr-tools';

// Encrypt before publishing
const plaintext = JSON.stringify(myData);
const encrypted = await nip04.encrypt(privateKey, pubkey, plaintext);

await publisher.publish(encrypted, {
  kind: 37375,
  dTagPrefix: 'wallet'
});

// Decrypt after fetching
const result = await fetcher.fetch(pubkey, {
  kind: 37375,
  dTagPrefix: 'wallet'
});

if (result.success && result.content) {
  const decrypted = await nip04.decrypt(privateKey, pubkey, result.content);
  const myData = JSON.parse(decrypted);
}
```

## Regular (non-replaceable) kinds

`ChunkedPublisher` and `ChunkedFetcher` address chunks by `d` tag (`<prefix>-chunk-<i>`, `<prefix>-state`), which only makes sense for addressable kinds (30000-39999).

For regular kinds, such as NIP-60 token events (kind `7375`), use the low-level API and your own relay code. `createSnapshotChunks` adds no `d` tag unless you ask for one, and every chunk carries the tags needed to validate the set.

**Regular-kind consumers must pass `recordId`.** With a regular kind nothing else says *which* logical record a chunk belongs to: `snapshot_id` changes on every write. Without a record id, two unrelated chunked payloads of one author and kind (two coupon backups, say) look like two versions of one thing, and `selectBestSnapshot` returns whichever is newest. `recordId` writes `["record_id", <id>]` on every chunk; read it back with `selectBestSnapshot(events, { recordId })` or `validateSnapshot(chunks, { recordId })`, which reports chunks of another record as `wrong_record`. `recordIdOf(event)` returns the tag, falling back to the d-tag without `-chunk-<n>` for chunks written before the tag existed (the same rule imani-wallet uses).

```typescript
import {
  createSnapshotChunks, parseChunkEvent, validateSnapshot,
} from 'nostr-chunked-events';
import { nip44, finalizeEvent } from 'nostr-tools';

// Write: split the plaintext, encrypt each chunk, publish each as kind 7375
const { chunks, snapshotId } = createSnapshotChunks(JSON.stringify(backup), {
  chunkSize: 40_960,          // fits strfry after NIP-44, see "Size limits"
  recordId: backup.tokenId,   // required for regular kinds: which record this is
});
const events = chunks.map((chunk) => finalizeEvent({
  kind: 7375,
  created_at: Math.floor(Date.now() / 1000),
  tags: chunk.tags,           // record_id, chunk, snapshot_id, payload_hash, hash_alg, total_chunks
  content: nip44.v2.encrypt(chunk.data, conversationKey),
}, secretKey));

// Read: query by author and kind (or #snapshot_id if your relay indexes it),
// decrypt, then validate. payload_hash covers the plaintext.
const parsed = fetched
  .map((event) => {
    const chunk = parseChunkEvent(event);
    return chunk && { ...chunk, data: nip44.v2.decrypt(event.content, conversationKey) };
  })
  .filter(Boolean);
const validation = await validateSnapshot(parsed, {
  expectedAuthor: pubkey,
  recordId: backup.tokenId,
  verifyPayloadHash: true,
  requirePayloadHash: true,
  allowIdenticalDuplicates: true,   // a retried publish of a regular event leaves a twin
});
if (validation.valid) {
  const backup = JSON.parse(validation.chunks.map((c) => c.data).join(''));
}
```

When several snapshots share a kind, `groupChunksBySnapshot()` and `selectBestSnapshot()` split them by `record_id` and `snapshot_id`, and with `recordId` set pick the newest valid snapshot of that record only.

`validateSnapshot` and `selectBestSnapshot` default to the safe settings: `payload_hash` is verified when present (`verifyPayloadHash: false` to opt out), a candidate mixing authors or records is rejected, and `selectBestSnapshot` without `expectedAuthor` refuses to choose when the events come from more than one author. Always pass `expectedAuthor` anyway. Deleting superseded regular events (NIP-09) is up to the caller.

## API Reference

### High-Level API

#### `ChunkedPublisher`

```typescript
interface PublisherOptions {
  defaultRelays?: string[];        // Default relay URLs
  compression?: boolean;           // Enable gzip compression (default: false)
  deleteOrphanedChunks?: boolean;  // Reserved, not implemented yet
  authHandler?: (challenge: string) => Promise<Event>;  // NIP-42 auth
  timeout?: number;                // Per-relay timeout in ms
}

interface PublishOptions {
  kind: number;                    // Event kind (e.g., 30078, 37375)
  dTagPrefix: string;              // Prefix for d-tags
  relayUrls?: string[];            // Override default relays
  additionalTags?: string[][];     // Extra tags for all events
  onProgress?: (published: number, total: number) => void;
}

interface PublishOptions {
  kind: number;
  dTagPrefix: string;
  maxSingleEventSize?: number;     // Per-call chunking threshold (default 32,000)
  chunkSize?: number;              // Per-call chunk size (default 32,000, capped at maxSingleEventSize)
  maxEventSize?: number;           // Serialized-size check before sending (default 65,536)
  snapshot?: boolean | { snapshotId?: string; recordId?: string; parents?: SnapshotParentReference[] };
  // relayUrls, additionalTags, onProgress
}

interface PublishResult {
  success: boolean;                // every chunk accepted (OK=true) by at least one relay
  chunked: boolean;
  compressed: boolean;
  chunkCount: number;
  eventIds: string[];
  publishedAt: number;
  originalSize: number;
  finalSize: number;
  snapshotId?: string;             // when snapshot publishing was on
  chunkResults?: ChunkPublishResult[];  // per event: acceptedBy / rejectedBy (with reason)
  error?: string;
}
```

#### `ChunkedFetcher`

```typescript
interface FetcherOptions {
  defaultRelays?: string[];
  authHandler?: (challenge: string) => Promise<Event>;
  timeout?: number;
  queryEvents?: (filter: Filter) => Promise<Event[]>;  // custom query source; throw when unreachable
  verifySignatures?: boolean;      // check id + sig of queryEvents results (default true)
  maxChunks?: number;              // default 1,000
  maxDecompressedSize?: number;    // default 8 MiB
}

interface FetchOptions {
  kind: number;
  dTagPrefix: string;
  relayUrls?: string[];
  timeout?: number;
  author?: string;
  snapshotSelection?: SnapshotSelectionOptions;  // strict mode
  maxChunks?: number;
  verifyPayloadHash?: boolean;     // default mode: check payload_hash when present (default true)
  maxDecompressedSize?: number;
}

// FetchResult adds `unreachable?: boolean` (see "Unreachable vs. no data").
```

### Low-Level API

For fine-grained control:

```typescript
import {
  createChunks,          // split content (v0.1.0 format)
  createSnapshotChunks,  // split content + integrity tags, any kind
  reassembleChunks,
  validateChunks,        // missing / duplicates / outOfRange
  parseChunkEvent,       // chunk + snapshot metadata from an event
  validateSnapshot,      // structured issues, optional payload hash check
  groupChunksBySnapshot,
  selectBestSnapshot,    // newest valid snapshot among candidates
  reassembleSnapshot,
  needsChunking,
  compress,
  decompress,            // decompress(b64, { maxSize }) refuses gzip bombs
  recordIdOf,
  serializedEventSize,
  sha256Hex,
  nip44CiphertextSize,
  maxNip44PlaintextSize,
} from 'nostr-chunked-events';

// Check if content needs chunking
if (needsChunking(content, 32_000)) {
  const chunks = createChunks(content, {
    chunkSize: 32_000,
    dTagPrefix: 'mydata'
  });
  // Manually create and publish events...
}

// Validate and reassemble
const validation = validateChunks(chunks);
if (validation.valid) {
  const content = reassembleChunks(chunks);
}
```

`validateSnapshot` reports issues with these codes: `empty`, `wrong_author`, `mixed_snapshot`, `duplicate_index`, `missing_snapshot_id`, `inconsistent_total`, `inconsistent_payload_hash`, `inconsistent_parents`, `missing_payload_hash`, `unsupported_hash_alg`, `missing_index`, `index_out_of_range`, `too_many_chunks`, `payload_hash_mismatch`.

### Snapshot ancestry

Chunks may carry ordered `parent_snapshot_id` / `parent_content_hash` tag pairs. An empty pair marks a genesis snapshot and two pairs mark a merge. `ancestryOf(snapshot, pool)` walks the parents (up to `MAX_WALK` = 32 generations) and `supersedesRelation(a, b, pool)` returns `'a-supersedes-b' | 'b-supersedes-a' | 'equal' | 'divergent'`. `isGenesis`, `isMergeSnapshot` and `isLegacyPreAncestry` classify a parsed chunk.

## Event Format

### Single Event (content <= `maxSingleEventSize`)

```json
{
  "kind": 30078,
  "tags": [
    ["d", "mydata-state"],
    ["v", "1"],
    ["client", "nostr-chunked-events"]
  ],
  "content": "<content>"
}
```

### Chunked Events (content > `maxSingleEventSize`)

```json
{
  "kind": 30078,
  "tags": [
    ["d", "mydata-chunk-0"],
    ["v", "1"],
    ["client", "nostr-chunked-events"],
    ["chunk", "0", "3"],
    ["compressed", "gzip"]
  ],
  "content": "<chunk 0>"
}
```

With `snapshot` enabled (or from `createSnapshotChunks`), each chunk also carries:

```json
["snapshot_id", "6f1c..."],
["payload_hash", "<sha256 hex of the full payload>"],
["hash_alg", "sha256"],
["total_chunks", "3"]
```

and, optionally, `["parent_snapshot_id", "..."]` / `["parent_content_hash", "..."]` pairs.

## Configuration

```typescript
import { configure } from 'nostr-chunked-events';

configure({
  maxEventSize: 65_536,        // Serialized-size limit checked before sending
  maxSingleEventSize: 32_000,  // Threshold to trigger chunking
  chunkSize: 32_000,           // Size per chunk
  maxChunks: 1_000,            // Readers refuse sets that claim more
  maxDecompressedSize: 8 * 1024 * 1024,  // Readers refuse bigger gzip output
  relayTimeout: 15_000,        // Connection timeout
  relayRetries: 3              // Retry attempts (publishToRelay)
});
```

Per-call options (`maxEventSize`, `maxSingleEventSize`, `chunkSize`, `maxChunks`, `maxDecompressedSize`) take precedence over these globals.

## Use Cases

| Use Case | Event Kind | Description |
|----------|------------|-------------|
| NIP-60 Wallet | 37375 | Encrypted Cashu wallet state |
| NIP-60 token / coupon backups | 7375 | Regular kind, low-level API |
| Long-form Content | 30023 | Articles > 64KB |
| File Storage | 30078 | Base64 encoded files |
| Encrypted Backups | 30078 | Application state |

## Browser Usage

```html
<script src="https://unpkg.com/nostr-tools/lib/nostr.bundle.js"></script>
<script src="https://unpkg.com/nostr-chunked-events/dist/index.umd.js"></script>
<script>
  const { ChunkedPublisher, ChunkedFetcher } = NostrChunkedEvents;
  // Use the library...
</script>
```

## Upgrading from 0.1.x

See [CHANGELOG.md](CHANGELOG.md). In short: relay `OK=false` is now a publish failure, chunk sizes below 4 bytes throw, chunk sets with out-of-range indices or more than `maxChunks` chunks are rejected, and the default fetcher no longer splices chunks from different snapshots.

## License

MIT, see [LICENSE](LICENSE).
