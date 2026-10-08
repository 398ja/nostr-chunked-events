# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-10-08

Reconciles this repository with the hardened copy that lived in
`imani-apps/packages/nostr-chunked-events` (published there as 0.2.0, never on
npm). This release is the superset of both. It skips 0.2.0 so the number does
not collide with the fork's different 0.2.0.

### Added
- Strict snapshot API, ported from the fork: `parseChunkEvent`,
  `validateSnapshot`, `groupChunksBySnapshot`, `selectBestSnapshot`
  (`newest-valid` / `newest-seen`), `reassembleSnapshot`, `filterEventsByAuthor`,
  with structured `SnapshotValidationIssue` codes.
- Snapshot metadata tags: `snapshot_id`, `payload_hash`, `hash_alg`,
  `total_chunks`, plus ancestry tags `parent_snapshot_id` /
  `parent_content_hash` with `ancestryOf`, `supersedesRelation`, `MAX_WALK`,
  `isGenesis`, `isMergeSnapshot`, `isLegacyPreAncestry`.
- `ChunkedFetcher` strict mode via `FetchOptions.snapshotSelection`: fetches all
  candidate chunks, rejects incomplete or mixed snapshots and returns the newest
  valid one together with `validation` and `rejectedSnapshots`.
- `createSnapshotChunks()`: splits a payload and returns ready-made integrity
  tags for **any kind**, with no `d` tag unless `dTagPrefix` is set, so regular
  kinds such as NIP-60 kind 7375 can be chunked.
- Per-call size thresholds: `PublishOptions.maxSingleEventSize` and
  `PublishOptions.chunkSize` (they no longer require the global `configure()`).
- `PublishOptions.snapshot`: opt-in integrity tags on published chunks.
- `PublishResult.chunkResults` (per-event `acceptedBy` / `rejectedBy` with the
  relay's reason) and `PublishResult.snapshotId`.
- `FetcherOptions.queryEvents`: plug in your own query function (cache,
  backend) instead of opening relay connections.
- `maxChunks` limit (default `DEFAULT_MAX_CHUNKS` = 1,000) on `configure()`,
  `FetcherOptions`, `FetchOptions`, `validateChunks`, `reassembleChunks` and
  `SnapshotValidationOptions`.
- `FetchOptions.verifyPayloadHash` (default `true`).
- `SnapshotValidationOptions.allowIdenticalDuplicates` for regular-kind retries.
- `validateChunks` results gain `outOfRange` and `inconsistentTotal`;
  new helper `describeChunkValidationFailure`.
- Size helpers: `sha256Hex`, `nip44CiphertextSize`, `maxNip44PlaintextSize`,
  `NIP44_MAX_PLAINTEXT_SIZE`, `STRFRY_DEFAULT_MAX_EVENT_SIZE` (65,536),
  `HASH_ALG_SHA256`.
- ESLint flat config, with a rule that keeps `Buffer`, `process`, `require` and
  `node:` imports out of `src/`.

### Changed
- **Browser-safe**: no Node `Buffer` anywhere. `createChunks`, `needsChunking`,
  `calculateSize` and `compress`/`decompress` use `TextEncoder`/`TextDecoder`,
  `Uint8Array`, `btoa`/`atob`. v0.1.0's `createChunks` threw
  `ReferenceError: Buffer is not defined` in browsers.
- Payload hashing uses a pure-JS SHA-256 (`@noble/hashes`, new dependency), so
  verification also works where `crypto.subtle` is missing (http: pages, older
  runtimes). The fork's version failed there with "SubtleCrypto is not available".
- `hashFn` may return a string or a promise.
- Payload hash comparison is case-insensitive.
- `RelayPool.query` uses nostr-tools' own `maxWait` instead of racing a timer,
  so a slow relay no longer discards events that already arrived.
- Timeout timers are cleared, so they no longer keep Node processes alive.
- `RelayPool.publish` passes `authHandler` to nostr-tools (NIP-42), which v0.1.0
  accepted but never used.

### Fixed
- **`RelayPool.publish` reported success for every relay**, including relays
  that answered `OK false` (e.g. strfry's `invalid: event too large`). It never
  awaited the per-relay promise from `SimplePool.publish`. Rejections are now
  failures with the relay's message.
- **`createChunks` looped forever** when `chunkSize` was smaller than a
  multi-byte character or `<= 0` / `NaN`. It now throws `RangeError` for
  anything that is not an integer `>= 4`.
- `validateChunks` / `reassembleChunks` accepted indices `>= total` and
  concatenated them into the output. They are now rejected (`outOfRange`).
- Chunk tags were parsed with `parseInt`, so `"1abc"`, `"0x1"`, `"2.5"` were
  read as numbers. Only plain decimal integers are accepted now.
- The default fetcher trusted chunk-0's `total` and issued one query per
  claimed chunk, so a hostile `["chunk","0","1000000000"]` meant a billion queries.
  Totals above `maxChunks` are refused.
- The default fetcher accepted events from other authors if a relay or backend
  returned them. Results are filtered to the exact author on every path.
- The default fetcher spliced chunks from different snapshots after an
  interrupted re-publish. When chunks carry `snapshot_id` / `payload_hash`, the
  set must agree and the hash must match.
- Content tagged `compressed` that failed to decompress was returned as-is. It
  is now an error.

### Not ported from the fork (imani-specific)
- The `globalThis.nostrApi` backend hook in `RelayPool.query` and
  `ChunkedFetcher` (and `FetcherOptions.useApi`). Use
  `FetcherOptions.queryEvents` instead. The fork's hook also sent a
  backend-specific filter shape (`{ tags: { '#d': [...] } }`) rather than a
  standard NIP-01 filter.

### Breaking changes
Relative to v0.1.0 (the API is a superset, but these behaviours changed):
1. `RelayPool.publish` / `ChunkedPublisher.publish` now report `success: false`
   when relays reject the event. Code that relied on the old always-success
   result will see failures it previously missed.
2. `createChunks` throws `RangeError` for `chunkSize` that is not an integer
   `>= 4` (it used to hang or emit empty chunks).
3. `validateChunks` / `reassembleChunks` reject indices outside `0..total-1`
   and totals above `maxChunks` (default 1,000). Raise `maxChunks` if you
   really have more chunks.
4. `ChunkedFetcher.fetch` fails instead of returning spliced content when
   chunk metadata disagrees or `payload_hash` does not match, and when the
   chunk count exceeds `maxChunks`.
5. Content tagged `compressed` that does not decompress is an error rather than
   being returned raw.
6. Error messages for invalid chunk sets can now also be
   `Chunk index out of range: ...` or `Inconsistent chunk totals`.

Relative to the imani-apps fork 0.2.0: `FetcherOptions.useApi` and the implicit
`globalThis.nostrApi` lookup are gone (see above).

## [0.1.0] - 2026-01-11

### Added
- Initial release: `ChunkedPublisher`, `ChunkedFetcher`, chunking,
  reassembly, gzip compression and relay helpers.
