/**
 * Default configuration values for the library
 */

/** strfry's stock `events.maxEventSize`: the limit on the full serialized event, in bytes. */
export const STRFRY_DEFAULT_MAX_EVENT_SIZE = 65_536;

/**
 * Default limit on the full serialized event (id, pubkey, sig, tags and
 * content after JSON escaping), checked before anything is sent. Matches
 * strfry's stock limit, the most common relay. Raise it for relays with a
 * looser limit.
 */
export const DEFAULT_MAX_EVENT_SIZE = STRFRY_DEFAULT_MAX_EVENT_SIZE;

/**
 * Content size (UTF-8 bytes) above which a payload is chunked (32,000).
 *
 * Under half of {@link DEFAULT_MAX_EVENT_SIZE}: content whose every byte
 * doubles when JSON-escaped (`"` and `\\`), plus id, pubkey, sig and tags,
 * still fits in 65,536. Content full of control characters (`\u00XX`, six
 * bytes each) can still exceed it; the publisher's serialized-size check
 * refuses such an event locally instead of sending it.
 */
export const MAX_SINGLE_EVENT_SIZE = 32_000;

/** Maximum payload bytes per chunk (32,000). Same reasoning as {@link MAX_SINGLE_EVENT_SIZE}. */
export const DEFAULT_CHUNK_SIZE = 32_000;

/**
 * Largest decompressed payload a reader accepts (8 MiB). Gzip expands zeros
 * about 1000:1, so without a cap one 60 KB event could inflate to 60 MB.
 */
export const DEFAULT_MAX_DECOMPRESSED_SIZE = 8 * 1024 * 1024;

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
  /**
   * Logical record a chunk belongs to, for regular kinds (e.g. 7375) where
   * several unrelated chunked payloads share one author and kind. Same name
   * and meaning as imani-wallet's `RECORD_ID_TAG`.
   */
  RECORD_ID: 'record_id',
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
  maxEventSize: DEFAULT_MAX_EVENT_SIZE,
  maxDecompressedSize: DEFAULT_MAX_DECOMPRESSED_SIZE,
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
  if (options.maxEventSize !== undefined) {
    config.maxEventSize = options.maxEventSize;
  }
  if (options.maxDecompressedSize !== undefined) {
    config.maxDecompressedSize = options.maxDecompressedSize;
  }
  if (options.relayTimeout !== undefined) {
    config.relayTimeout = options.relayTimeout;
  }
  if (options.relayRetries !== undefined) {
    config.relayRetries = options.relayRetries;
  }
}
