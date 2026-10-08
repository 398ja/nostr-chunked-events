import type { Event, Filter, UnsignedEvent } from 'nostr-tools';

// ============================================================================
// Core Types
// ============================================================================

/**
 * A chunk of content with metadata
 */
export interface Chunk {
  /** 0-based chunk index */
  index: number;
  /** Total number of chunks */
  total: number;
  /** Chunk content */
  data: string;
  /** Generated d-tag (e.g., "mydata-chunk-0") */
  dTag: string;
}

/**
 * Chunk data extracted from an event
 */
export interface ChunkData {
  /** 0-based chunk index */
  index: number;
  /** Total number of chunks */
  total: number;
  /** Chunk content */
  data: string;
}

/**
 * Additional metadata extracted from a chunk event
 */
export interface ChunkMetadata {
  /** Snapshot identifier shared across all chunks in a snapshot */
  snapshotId?: string;
  /** Hash of the reconstructed payload */
  payloadHash?: string;
  /** Hash algorithm for payloadHash */
  hashAlg?: string;
  /** Explicit total chunk count tag value */
  totalChunksTag?: number;
  /** Author pubkey for the source event */
  author?: string;
  /** Event timestamp */
  createdAt?: number;
  /** Source event ID */
  eventId?: string;
  /** Source event d-tag */
  dTag?: string;
  /** Logical record id: the `record_id` tag, else the d-tag without `-chunk-<n>` */
  recordId?: string;
  /** Parent ancestry references (undefined for legacy pre-ancestry snapshots) */
  parents?: SnapshotParentReference[];
}

/**
 * Ordered ancestry reference to a parent snapshot.
 */
export interface SnapshotParentReference {
  /** Parent snapshot identifier */
  snapshotId: string;
  /** Parent snapshot content hash */
  contentHash: string;
}

/**
 * Rich chunk data extracted from a source event
 */
export interface ChunkEventData extends ChunkData, ChunkMetadata {
  /** Original source event */
  rawEvent?: Event;
}

/**
 * Options for creating chunks
 */
export interface ChunkOptions {
  /** Maximum bytes per chunk (default: 300KB) */
  chunkSize?: number;
  /** d-tag prefix (e.g., "wallet", "backup") */
  dTagPrefix?: string;
}

/**
 * Options for {@link createSnapshotChunks}
 */
export interface SnapshotChunkOptions {
  /** Maximum UTF-8 bytes of payload per chunk (default: config.chunkSize). Must be >= 4. */
  chunkSize?: number;
  /**
   * d-tag prefix. When set, each chunk gets `["d", "<prefix>-chunk-<i>"]`, for
   * addressable kinds. Omit for regular kinds such as 7375.
   */
  dTagPrefix?: string;
  /** Snapshot id (default: random UUID) */
  snapshotId?: string;
  /**
   * Ancestry parents. `[]` marks a genesis snapshot, omit for no ancestry tags.
   * At most two parents (a merge).
   */
  parents?: SnapshotParentReference[];
  /**
   * Logical record id, written as `["record_id", recordId]` on every chunk.
   * **Required in practice for regular kinds** (e.g. 7375): without it, two
   * unrelated chunked payloads of one author and kind look like versions of
   * the same thing and the newest wins. Read it back with
   * `selectBestSnapshot(events, { recordId })`.
   */
  recordId?: string;
}

/**
 * One chunk of a snapshot, with every tag it needs
 */
export interface SnapshotChunk extends ChunkData {
  /** d-tag, if a dTagPrefix was given */
  dTag?: string;
  /** Tags to put on the event (merge in your own, e.g. NIP-60 tags) */
  tags: string[][];
}

/**
 * Result of {@link createSnapshotChunks}
 */
export interface SnapshotChunks {
  snapshotId: string;
  /** SHA-256 hex of the full UTF-8 payload */
  payloadHash: string;
  hashAlg: string;
  totalChunks: number;
  chunks: SnapshotChunk[];
}

/**
 * Result of chunk validation
 */
export interface ValidationResult {
  /** Whether all chunks are present and valid */
  valid: boolean;
  /** Indices of missing chunks */
  missing: number[];
  /** Indices with duplicate chunks */
  duplicates: number[];
  /**
   * Indices outside 0..total-1 (or chunk totals above maxChunks).
   * Optional for compatibility with v0.1.0 result objects.
   */
  outOfRange?: number[];
  /** Whether the chunks disagree on `total` */
  inconsistentTotal?: boolean;
}

/**
 * Options for {@link validateChunks}
 */
export interface ChunkValidationOptions {
  /** Reject chunk sets whose total exceeds this (default: config.maxChunks) */
  maxChunks?: number;
}

/**
 * Validation issue from strict snapshot validation
 */
export interface SnapshotValidationIssue {
  code:
    | 'empty'
    | 'wrong_author'
    | 'wrong_record'
    | 'mixed_snapshot'
    | 'duplicate_index'
    | 'missing_snapshot_id'
    | 'inconsistent_total'
    | 'inconsistent_payload_hash'
    | 'inconsistent_parents'
    | 'missing_payload_hash'
    | 'unsupported_hash_alg'
    | 'missing_index'
    | 'index_out_of_range'
    | 'too_many_chunks'
    | 'payload_hash_mismatch';
  message: string;
  chunkIndex?: number;
  eventId?: string;
}

/**
 * Options for strict snapshot validation
 */
export interface SnapshotValidationOptions {
  /**
   * Require all events to match this author. Without it, a candidate whose
   * chunks come from more than one author is still rejected (`wrong_author`).
   */
  expectedAuthor?: string;
  /**
   * Require every chunk to belong to this logical record (`record_id` tag, or
   * d-tag prefix as a fallback). Chunks of another record are `wrong_record`.
   * Even without it, a candidate mixing two records is rejected.
   */
  recordId?: string;
  /** Require consistent metadata across the candidate set (default: true) */
  requireConsistentMetadata?: boolean;
  /** Require snapshot_id on all chunks when strict metadata is in use */
  requireSnapshotId?: boolean;
  /** Require payload_hash on all chunks when strict metadata is in use */
  requirePayloadHash?: boolean;
  /**
   * Verify the reconstructed payload against `payload_hash` when present
   * (default: true). Set false only if the writer hashed something other than
   * the concatenated chunk data, e.g. plaintext before per-chunk encryption.
   */
  verifyPayloadHash?: boolean;
  /** Allow legacy chunk sets without strict metadata (default: true) */
  allowLegacy?: boolean;
  /**
   * Custom hashing function for payload verification. The default is a pure-JS
   * SHA-256 (@noble/hashes) that needs neither Buffer nor SubtleCrypto.
   */
  hashFn?: (algorithm: string, content: string) => Promise<string> | string;
  /** Reject candidates whose total exceeds this (default: config.maxChunks) */
  maxChunks?: number;
  /**
   * Accept several events for one index when their content is byte-identical
   * (e.g. a retried publish of a regular-kind chunk). Default: false, any
   * second event for an index is a `duplicate_index` issue.
   */
  allowIdenticalDuplicates?: boolean;
}

/**
 * Result of strict snapshot validation
 */
export interface SnapshotValidationResult {
  /** Whether the candidate snapshot is valid */
  valid: boolean;
  /** Snapshot ID for this candidate, if present */
  snapshotId: string | null;
  /** Deduped and sorted chunks used for evaluation */
  chunks: ChunkEventData[];
  /** Expected chunk count for the candidate */
  totalChunks: number;
  /** Validation issues */
  issues: SnapshotValidationIssue[];
  /** Whether the candidate used legacy metadata rules */
  legacyFormat: boolean;
  /** Whether payload hash verification was performed successfully */
  payloadHashVerified: boolean;
}

/**
 * Minimal snapshot shape used by ancestry helpers.
 */
export interface AncestrySnapshotLike {
  /** Snapshot identifier */
  snapshotId?: string | null;
  /** Snapshot content hash (or payload hash in raw chunk metadata) */
  contentHash?: string | null;
  /** Raw chunk payload hash, accepted as an alias for contentHash */
  payloadHash?: string | null;
  /** Ordered ancestry references (undefined for legacy snapshots) */
  parents?: SnapshotParentReference[];
}

/**
 * Group of chunk events belonging to one candidate snapshot
 */
export interface SnapshotCandidate {
  /** Snapshot ID shared by grouped chunks, or null for legacy groups */
  snapshotId: string | null;
  /** Record id shared by grouped chunks, if any */
  recordId?: string;
  /** Newest timestamp seen in this candidate */
  newestCreatedAt: number;
  /** Raw parsed chunks that belong to this candidate */
  chunks: ChunkEventData[];
}

/**
 * Options for choosing the best chunk snapshot
 */
export interface SnapshotSelectionOptions extends SnapshotValidationOptions {
  // `recordId` (inherited) also filters candidates: only that record's chunks are considered.
  /** How to choose among competing snapshots (default: newest-valid) */
  strategy?: 'newest-valid' | 'newest-seen';
}

/**
 * Result of choosing a best chunk snapshot
 */
export interface SnapshotSelectionResult {
  /** Selected candidate snapshot, if any */
  selected: SnapshotCandidate | null;
  /** Validation result for the selected candidate */
  validation: SnapshotValidationResult | null;
  /** Rejected candidates and their validation failures */
  rejected: Array<{
    candidate: SnapshotCandidate;
    validation: SnapshotValidationResult;
  }>;
}

// ============================================================================
// Compression Types
// ============================================================================

/**
 * Result of compression operation
 */
export interface CompressionResult {
  /** Compressed data (base64 encoded) */
  data: string;
  /** Original size in bytes */
  originalSize: number;
  /** Compressed size in bytes */
  compressedSize: number;
  /** Compression ratio (compressedSize / originalSize) */
  ratio: number;
}

// ============================================================================
// Signer Types
// ============================================================================

/**
 * Interface for signing Nostr events
 */
export interface Signer {
  /** Sign an unsigned event and return the signed event */
  signEvent: (event: UnsignedEvent) => Promise<Event>;
  /** Get the signer's public key in hex format */
  getPublicKey: () => Promise<string>;
}

// ============================================================================
// Publisher Types
// ============================================================================

/**
 * Options for the ChunkedPublisher constructor
 */
export interface PublisherOptions {
  /** Default relay URLs to publish to */
  defaultRelays?: string[];
  /** Enable gzip compression (default: false) */
  compression?: boolean;
  /** Delete orphaned chunks when chunk count decreases (default: false) */
  deleteOrphanedChunks?: boolean;
  /** NIP-42 authentication callback */
  authHandler?: (challenge: string) => Promise<Event>;
  /** Connection timeout in ms (default: 10000) */
  timeout?: number;
}

/**
 * Opt-in integrity metadata for published chunks
 */
export interface PublishSnapshotOptions {
  /** Snapshot id (default: random UUID) */
  snapshotId?: string;
  /** Logical record id, written as a `record_id` tag on every chunk */
  recordId?: string;
  /** Ancestry parents; `[]` marks genesis, omit for no ancestry tags */
  parents?: SnapshotParentReference[];
}

/**
 * Options for a publish operation
 */
export interface PublishOptions {
  /** Event kind (e.g., 30078, 37375) */
  kind: number;
  /** Prefix for d-tags (e.g., "wallet", "article") */
  dTagPrefix: string;
  /** Target relay URLs (uses defaultRelays if not specified) */
  relayUrls?: string[];
  /** Additional tags to include on all events */
  additionalTags?: string[][];
  /** Progress callback */
  onProgress?: (published: number, total: number) => void;
  /**
   * Content size (bytes) above which the payload is chunked, for this call
   * (default: config.maxSingleEventSize = 32,000). Chunks are never larger
   * than this either, so setting it alone is enough.
   */
  maxSingleEventSize?: number;
  /**
   * Bytes per chunk for this call (default: config.chunkSize = 32,000).
   * Capped at the effective `maxSingleEventSize`.
   */
  chunkSize?: number;
  /**
   * Limit on each full serialized signed event (id, pubkey, sig, tags and
   * JSON-escaped content), for this call (default: config.maxEventSize =
   * 65,536, strfry's stock limit). Every event is checked after signing and
   * before anything is sent; if one is over, nothing is published and the
   * result says so.
   */
  maxEventSize?: number;
  /**
   * Tag every chunk with snapshot_id / payload_hash / hash_alg / total_chunks
   * so readers can use strict snapshot selection. `true` uses defaults.
   * Only applies when the payload is chunked. Default: off (v0.1.0 tags).
   */
  snapshot?: boolean | PublishSnapshotOptions;
}

/**
 * Per-chunk publish outcome
 */
export interface ChunkPublishResult {
  index: number;
  eventId: string;
  /** Relays that acknowledged with OK=true */
  acceptedBy: string[];
  /** Relays that rejected or timed out, with the reason */
  rejectedBy: Array<{ relay: string; message?: string }>;
}

/**
 * Result of a publish operation
 */
export interface PublishResult {
  /** Whether the publish was successful */
  success: boolean;
  /** Whether content was chunked */
  chunked: boolean;
  /** Whether compression was applied */
  compressed: boolean;
  /** Number of chunks published */
  chunkCount: number;
  /** Event IDs of all published events */
  eventIds: string[];
  /** Timestamp when published */
  publishedAt: number;
  /** Original content size in bytes */
  originalSize: number;
  /** Final size after compression (if applied) */
  finalSize: number;
  /** Snapshot id, when `snapshot` publishing was enabled */
  snapshotId?: string;
  /** Per-event relay outcomes (one entry per published event) */
  chunkResults?: ChunkPublishResult[];
  /** Error message if failed */
  error?: string;
}

// ============================================================================
// Fetcher Types
// ============================================================================

/**
 * Custom query function. Lets callers route reads through their own cache,
 * backend or relay pool instead of the built-in RelayPool. Results are
 * signature-checked (unless `verifySignatures: false`), filtered to the exact
 * author and validated. Throw (rather than return `[]`) when the source is
 * unreachable, so the fetcher can report `unreachable` instead of "No data found".
 */
export type QueryEventsFn = (filter: Filter) => Promise<Event[]>;

/**
 * Options for the ChunkedFetcher constructor
 */
export interface FetcherOptions {
  /** Default relay URLs to fetch from */
  defaultRelays?: string[];
  /** NIP-42 authentication callback */
  authHandler?: (challenge: string) => Promise<Event>;
  /** Query timeout in ms (default: 10000) */
  timeout?: number;
  /**
   * Replace relay queries with a custom function (e.g. a backend API or local
   * cache). When set, `defaultRelays` is not required.
   */
  queryEvents?: QueryEventsFn;
  /** Maximum chunk count accepted from chunk-0 (default: config.maxChunks) */
  maxChunks?: number;
  /**
   * Verify the id and Schnorr signature of every event a `queryEvents` source
   * returns (default: true). Events that fail are dropped. Set false only if
   * your source already verified them; the author filter alone trusts the
   * `pubkey` field, which anyone can write. The built-in relay pool always
   * verifies (nostr-tools does it).
   */
  verifySignatures?: boolean;
  /** Largest decompressed payload accepted (default: config.maxDecompressedSize = 8 MiB) */
  maxDecompressedSize?: number;
}

/**
 * Options for a fetch operation
 */
export interface FetchOptions {
  /** Event kind to query */
  kind: number;
  /** d-tag prefix to look for */
  dTagPrefix: string;
  /** Relay URLs to query (uses defaultRelays if not specified) */
  relayUrls?: string[];
  /** Query timeout in ms */
  timeout?: number;
  /** Filter by author pubkey (optional, uses pubkey param if not set) */
  author?: string;
  /** Strict snapshot selection and validation options */
  snapshotSelection?: SnapshotSelectionOptions;
  /** Maximum chunk count accepted for this call (default: FetcherOptions.maxChunks) */
  maxChunks?: number;
  /**
   * Default (non-strict) mode only: when chunks carry `payload_hash`, check it
   * against the reassembled content (default: true). Set false if the writer
   * hashed something other than the concatenated event contents, e.g. the
   * plaintext before per-chunk encryption.
   */
  verifyPayloadHash?: boolean;
  /** Largest decompressed payload accepted for this call (default: FetcherOptions.maxDecompressedSize) */
  maxDecompressedSize?: number;
}

/**
 * Result of a fetch operation
 */
export interface FetchResult {
  /** Whether the fetch was successful */
  success: boolean;
  /** Reassembled content (null if not found) */
  content: string | null;
  /** Whether data was chunked */
  chunked: boolean;
  /** Number of chunks retrieved */
  chunkCount: number;
  /** Raw events retrieved */
  events: Event[];
  /** Whether content was compressed */
  compressed: boolean;
  /** Selected snapshot ID, if applicable */
  snapshotId?: string | null;
  /** Validation result for strict snapshot selection */
  validation?: SnapshotValidationResult;
  /** Rejected candidate snapshots during strict selection */
  rejectedSnapshots?: Array<{
    snapshotId: string | null;
    issues: SnapshotValidationIssue[];
  }>;
  /**
   * True when the source could not be reached (every relay failed to connect,
   * or `queryEvents` threw). Then `error` is not "No data found": the data may
   * exist. Never treat an unreachable result as an empty account.
   */
  unreachable?: boolean;
  /** Error message if failed */
  error?: string;
}

/**
 * Result of probing for chunked data
 */
export interface ProbeResult {
  /** Whether any data exists */
  exists: boolean;
  /** Whether data is chunked */
  chunked: boolean;
  /** Number of chunks (1 if not chunked) */
  chunkCount: number;
}

// ============================================================================
// Relay Types
// ============================================================================

/**
 * Options for relay connections
 */
export interface RelayOptions {
  /** Connection/query timeout in ms */
  timeout?: number;
  /** Number of retry attempts on failure */
  retries?: number;
  /** NIP-42 authentication callback */
  authHandler?: (challenge: string) => Promise<Event>;
}

/**
 * Response from a relay publish operation
 */
export interface RelayPublishResponse {
  /** Whether the publish was successful */
  success: boolean;
  /** Relay URL */
  relay: string;
  /** Response message from relay */
  message?: string;
}

// ============================================================================
// Constants for external use
// ============================================================================

export const LIBRARY_VERSION = '1';
export const CLIENT_TAG = 'nostr-chunked-events';
