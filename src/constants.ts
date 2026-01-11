/**
 * Default configuration values for the library
 */

/** Maximum size for a single event before chunking is triggered (350KB) */
export const MAX_SINGLE_EVENT_SIZE = 350_000;

/** Maximum size for each chunk (300KB) */
export const DEFAULT_CHUNK_SIZE = 300_000;

/** Default relay connection timeout in ms */
export const DEFAULT_RELAY_TIMEOUT = 10_000;

/** Default number of retry attempts */
export const DEFAULT_RELAY_RETRIES = 3;

/** Library version tag value */
export const LIBRARY_VERSION = '1';

/** Client tag value */
export const CLIENT_TAG = 'nostr-chunked-events';

/** Tag names used in events */
export const TAGS = {
  /** d-tag for replaceable events */
  D_TAG: 'd',
  /** Chunk metadata tag: ["chunk", index, total] */
  CHUNK: 'chunk',
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
 * Global configuration that can be modified at runtime
 */
export const config = {
  maxSingleEventSize: MAX_SINGLE_EVENT_SIZE,
  chunkSize: DEFAULT_CHUNK_SIZE,
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
  if (options.relayTimeout !== undefined) {
    config.relayTimeout = options.relayTimeout;
  }
  if (options.relayRetries !== undefined) {
    config.relayRetries = options.relayRetries;
  }
}
