/**
 * Default configuration values for the library
 */

/**
 * Maximum content size for a single event before chunking is triggered (350KB).
 *
 * This default suits relays with a loose event size limit. strfry's stock
 * `events.maxEventSize` is 65,536 bytes for the WHOLE serialized event (id,
 * pubkey, sig, tags and content), so for strfry pass a much smaller
 * `maxSingleEventSize` / `chunkSize` per call. See {@link STRFRY_DEFAULT_MAX_EVENT_SIZE}.
 */
export const MAX_SINGLE_EVENT_SIZE = 350_000;

/** Maximum size for each chunk (300KB). Same caveat as {@link MAX_SINGLE_EVENT_SIZE}. */
export const DEFAULT_CHUNK_SIZE = 300_000;

/** strfry's stock `events.maxEventSize`: the limit on the full serialized event, in bytes. */
export const STRFRY_DEFAULT_MAX_EVENT_SIZE = 65_536;

/**
 * Upper bound on the number of chunks a reader will accept for one payload.
 * Protects readers from a chunk tag that claims e.g. 10^9 chunks.
 */
export const DEFAULT_MAX_CHUNKS = 1_000;

/** Default relay connection timeout in ms */
export const DEFAULT_RELAY_TIMEOUT = 10_000;

/** Default number of retry attempts */
export const DEFAULT_RELAY_RETRIES = 3;

/** Library version tag value */
export const LIBRARY_VERSION = '1';

/** Client tag value */
export const CLIENT_TAG = 'nostr-chunked-events';

/** Hash algorithm written to `hash_alg` by this library */
export const HASH_ALG_SHA256 = 'sha256';

/** Tag names used in events */
export const TAGS = {
  /** d-tag for replaceable events */
  D_TAG: 'd',
  /** Chunk metadata tag: ["chunk", index, total] */
  CHUNK: 'chunk',
  /** Snapshot identifier shared by all chunks of one write */
  SNAPSHOT_ID: 'snapshot_id',
  /** Hash of the full reconstructed payload */
  PAYLOAD_HASH: 'payload_hash',
  /** Hash algorithm for payload_hash */
  HASH_ALG: 'hash_alg',
  /** Explicit total chunk count */
  TOTAL_CHUNKS: 'total_chunks',
  /** Snapshot ancestry parent snapshot id (repeatable, order-sensitive) */
  PARENT_SNAPSHOT_ID: 'parent_snapshot_id',
  /** Snapshot ancestry parent content hash (repeatable, order-sensitive) */
  PARENT_CONTENT_HASH: 'parent_content_hash',
  /** Library version tag */
  VERSION: 'v',
  /** Compression indicator tag */
  COMPRESSED: 'compressed',
  /** Migration indicator tag */
  MIGRATED: 'migrated',
  /** Client identifier tag */
  CLIENT: 'client',
} as const;

/** Compression algorithms */
export const COMPRESSION = {
  GZIP: 'gzip',
} as const;

/** d-tag suffixes */
export const D_TAG_SUFFIXES = {
  /** Suffix for single-event (non-chunked) data */
  STATE: '-state',
  /** Prefix for chunked data (followed by index) */
  CHUNK: '-chunk-',
} as const;

/**
 * Global configuration that can be modified at runtime.
 * Every size threshold can also be overridden per call.
 */
export const config = {
  maxSingleEventSize: MAX_SINGLE_EVENT_SIZE,
  chunkSize: DEFAULT_CHUNK_SIZE,
  maxChunks: DEFAULT_MAX_CHUNKS,
  relayTimeout: DEFAULT_RELAY_TIMEOUT,
  relayRetries: DEFAULT_RELAY_RETRIES,
};

/**
 * Configure global defaults
 */
export function configure(options: Partial<typeof config>): void {
  if (options.maxSingleEventSize !== undefined) {
    config.maxSingleEventSize = options.maxSingleEventSize;
  }
  if (options.chunkSize !== undefined) {
    config.chunkSize = options.chunkSize;
  }
  if (options.maxChunks !== undefined) {
    config.maxChunks = options.maxChunks;
  }
  if (options.relayTimeout !== undefined) {
    config.relayTimeout = options.relayTimeout;
  }
  if (options.relayRetries !== undefined) {
    config.relayRetries = options.relayRetries;
  }
}
