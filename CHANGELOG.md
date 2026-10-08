# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.1] - 2026-10-08

### Fixed
- CommonJS `require('nostr-chunked-events')` failed with `ERR_REQUIRE_ESM` (#2).
  Because the package is `"type": "module"`, Node loaded the CommonJS build
  `dist/index.cjs.js` as ESM. The build is now `dist/index.cjs`, and `main`
  and `exports.require` point at it.
- Types resolve correctly for each condition. `import` uses `dist/index.d.ts`
  and `require` uses the new `dist/index.d.cts`. Before, the top-level `types`
  condition came after `import`/`require` and never took effect, so node16
  CommonJS TypeScript consumers got TS1479.

### Changed
- The unreachable `browser` export condition is replaced by an explicit
  `nostr-chunked-events/umd` subpath. The `browser` field and the unpkg URL
  `dist/index.umd.js` are unchanged.

### Added
- `test/package.test.ts`: packs the tarball, installs it into a temporary
  project and checks `require()`, ESM `import`, node16 types and the UMD global.

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
- **Record identity for regular kinds**: `SnapshotChunkOptions.recordId` /
  `PublishSnapshotOptions.recordId` write a `record_id` tag on every chunk
  (`TAGS.RECORD_ID`, same name and meaning as imani-wallet's `RECORD_ID_TAG`).
  `SnapshotValidationOptions.recordId` filters candidates in
  `selectBestSnapshot` / `groupChunksBySnapshot` and makes `validateSnapshot`
  report other records' chunks as the new issue code `wrong_record`.
  `recordIdOf(event)` reads the tag, falling back to the d-tag without
  `-chunk-<n>`. `ChunkEventData.recordId` and `SnapshotCandidate.recordId`.
- **Decompressed-size cap**: `decompress(b64, { maxSize })` inflates in
  streaming mode and throws `DecompressedSizeError` once the output passes the
  limit (default `DEFAULT_MAX_DECOMPRESSED_SIZE` = 8 MiB, via
  `configure({ maxDecompressedSize })`, `FetcherOptions.maxDecompressedSize` or
  `FetchOptions.maxDecompressedSize`). A 120 KB gzip bomb no longer inflates
  to 60 MiB.
- **Signature verification for `queryEvents`**: every event a custom source
  returns has its id and signature checked, and failures are dropped.
  `FetcherOptions.verifySignatures: false` opts out for sources that already
  verify.
- **Serialized-size check before publishing**: `PublishOptions.maxEventSize` /
  `configure({ maxEventSize })` (default `DEFAULT_MAX_EVENT_SIZE` = 65,536).
  Every event is signed and measured before any is sent. If one is too big,
  nothing is published and `publish()` returns `success: false`.
  `serializedEventSize(event)` is exported.
- `FetchResult.unreachable` and `RelaysUnreachableError`: see Changed.
- `SourceUnreachableError` (a `queryEvents` source threw) is exported, so
  `probe()` callers can `instanceof` it alongside `RelaysUnreachableError`.
- `FetchResult.unverified` and `SignatureVerificationError`: when a
  `queryEvents` source returned events for the author but every one failed
  signature verification, `fetch` returns `{ success: false, unverified: true }`
  and `probe()` rejects with `SignatureVerificationError`, instead of
  "No data found" / `exists: false`. A single bad event among good ones is
  still dropped silently.
- `PublishOptions.maxDecompressedSize`: see Changed.
- `LICENSE` file (MIT, as `package.json` already declared).

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
- **Defaults are strfry-safe**: `maxSingleEventSize` and `chunkSize` drop from
  350,000 / 300,000 to 32,000 / 32,000, so content whose bytes all double when
  JSON-escaped still fits in strfry's 65,536-byte event limit. Pass larger
  values (and `maxEventSize`) for relays with a looser limit.
- The publisher caps `chunkSize` at the effective `maxSingleEventSize`. Setting
  only a per-call `maxSingleEventSize` used to chunk the payload into one
  oversized chunk and send it anyway.
- `validateSnapshot` verifies `payload_hash` by default (`verifyPayloadHash`
  now defaults to `true`). It also rejects a candidate whose chunks come from
  more than one author or more than one record, even without
  `expectedAuthor` / `recordId`.
- `selectBestSnapshot` without `expectedAuthor` refuses to choose when the
  events come from more than one author, rather than returning the newest.
- `groupChunksBySnapshot` groups by record id and snapshot id, so two records
  never compete with each other.
- `RelayPool.query` connects first and throws `RelaysUnreachableError` when no
  relay can be reached. `ChunkedFetcher.fetch` turns that, or a throwing
  `queryEvents`, into `{ success: false, unreachable: true }` instead of
  `error: 'No data found'`.
- The default fetcher sorts chunk-0 candidates (and each chunk query) newest
  first, so a stale relay listed first no longer wins.
- With compression on, `publish()` refuses (nothing sent) a payload whose
  uncompressed size exceeds `maxDecompressedSize` (per call or
  `configure()`, default 8 MiB), since readers with the same limit refuse to
  inflate it. The reader's cap is a bomb guard and does not follow the writer.
- The README's strfry guidance is rewritten: the old "unencrypted 60,000"
  example overflowed strfry for quote-heavy JSON.
- New runtime dependency `@noble/hashes` (pure-JS SHA-256), see above.
- `npm run prepare` now builds `dist/`, so installing from git works. A git
  install therefore needs the devDependencies (rollup, TypeScript) to be
  installable.

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
7. Chunk tags are parsed strictly: `["chunk","1abc","2"]`, `"0x1"` or `"2.5"`
   make the event a non-chunk. v0.1.0 read them with `parseInt` and accepted
   them.
8. Default `maxSingleEventSize` / `chunkSize` are 32,000 (were 350,000 /
   300,000). The same payload now produces more, smaller chunks, and readers
   of v0.1.0-sized chunks are unaffected. Pass the old values explicitly to
   keep the old layout.
9. `publish()` refuses (locally, nothing sent) any event whose serialized size
   exceeds `maxEventSize` (65,536). Raise it for relays with a looser limit.
10. `decompress()` and the fetcher refuse output above 8 MiB.
11. `ChunkedFetcher` with `queryEvents` drops events whose signature does not
    verify. Sources that return unsigned or re-serialized events need
    `verifySignatures: false`.
12. `validateSnapshot` / `selectBestSnapshot` verify `payload_hash` by default.
    Callers that hash something other than the concatenated chunk data (e.g.
    plaintext before per-chunk encryption, without decrypting first) must pass
    `verifyPayloadHash: false`. Mixed-author candidates are rejected.
13. `RelayPool.query` throws `RelaysUnreachableError` when every relay is
    down, rather than returning `[]`.
14. `npm run prepare` builds `dist/`, so a git install needs devDependencies.
15. `ChunkedFetcher.probe()` rejects (with `RelaysUnreachableError`,
    `SourceUnreachableError` or `SignatureVerificationError`) when the source
    is unreachable or every returned event fails verification. v0.1.0
    resolved `{ exists: false }`, which reads as "no data".
16. With compression on, `publish()` refuses payloads above
    `maxDecompressedSize` uncompressed (default 8 MiB) instead of writing
    data the default reader cannot inflate.

Relative to the imani-apps fork 0.2.0: `FetcherOptions.useApi` and the implicit
`globalThis.nostrApi` lookup are gone (see above).

## [0.1.0] - 2026-01-11

### Added
- Initial release: `ChunkedPublisher`, `ChunkedFetcher`, chunking,
  reassembly, gzip compression and relay helpers.
