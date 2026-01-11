import type { Event, UnsignedEvent } from 'nostr-tools';

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
 * Options for creating chunks
 */
export interface ChunkOptions {
  /** Maximum bytes per chunk (default: 300KB) */
  chunkSize?: number;
  /** d-tag prefix (e.g., "wallet", "backup") */
  dTagPrefix?: string;
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
  /** Error message if failed */
  error?: string;
}

// ============================================================================
// Fetcher Types
// ============================================================================

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
