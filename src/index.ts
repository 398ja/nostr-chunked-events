/**
 * nostr-chunked-events
 *
 * A library for chunking and reassembling large Nostr events
 * to overcome relay message size limits.
 *
 * @packageDocumentation
 */

// ============================================================================
// High-Level API (Recommended)
// ============================================================================

export { ChunkedPublisher, createMigrationMarker } from './publisher';
export { ChunkedFetcher, SourceUnreachableError, SignatureVerificationError } from './fetcher';
export { ancestryOf, supersedesRelation, MAX_WALK } from './ancestry';

// ============================================================================
// Low-Level API (Pure Functions)
// ============================================================================

// Chunking
export {
  createChunks,
  createSnapshotChunks,
  needsChunking,
  calculateSize,
  estimateChunkCount,
  getSingleEventDTag,
  getChunkDTag,
  parseDTag,
  serializedEventSize,
} from './chunker';

// Reassembly
export {
  reassembleChunks,
  validateChunks,
  sortChunks,
  parseChunkFromEvent,
  parseChunkEvent,
  filterEventsByAuthor,
  groupChunksBySnapshot,
  validateSnapshot,
  selectBestSnapshot,
  reassembleSnapshot,
  recordIdOf,
  describeChunkValidationFailure,
  isGenesis,
  isMergeSnapshot,
  isLegacyPreAncestry,
  isChunkEvent,
  hasMigrationMarker,
  getTotalChunks,
  getEventVersion,
  getCompressionType,
} from './reassembler';

// Compression
export {
  compress,
  decompress,
  isCompressed,
  tryDecompress,
  DecompressedSizeError,
} from './compression';
export type { DecompressOptions } from './compression';

// Hashing and size budgeting
export {
  sha256Hex,
  nip44CiphertextSize,
  maxNip44PlaintextSize,
  NIP44_MAX_PLAINTEXT_SIZE,
} from './hash';

// Relay utilities
export { RelayPool, RelaysUnreachableError, publishToRelay, queryRelay } from './relay';

// ============================================================================
// Configuration
// ============================================================================

export {
  configure,
  config,
  MAX_SINGLE_EVENT_SIZE,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_MAX_CHUNKS,
  STRFRY_DEFAULT_MAX_EVENT_SIZE,
  DEFAULT_MAX_EVENT_SIZE,
  DEFAULT_MAX_DECOMPRESSED_SIZE,
  HASH_ALG_SHA256,
  DEFAULT_RELAY_TIMEOUT,
  DEFAULT_RELAY_RETRIES,
  LIBRARY_VERSION,
  CLIENT_TAG,
  TAGS,
  COMPRESSION,
  D_TAG_SUFFIXES,
} from './constants';

// ============================================================================
// Types
// ============================================================================

export type {
  // Core types
  Chunk,
  ChunkData,
  ChunkMetadata,
  ChunkEventData,
  SnapshotParentReference,
  ChunkOptions,
  ChunkValidationOptions,
  ValidationResult,
  SnapshotChunkOptions,
  SnapshotChunk,
  SnapshotChunks,
  SnapshotValidationIssue,
  SnapshotValidationOptions,
  SnapshotValidationResult,
  SnapshotCandidate,
  SnapshotSelectionOptions,
  SnapshotSelectionResult,
  AncestrySnapshotLike,

  // Compression
  CompressionResult,

  // Signer
  Signer,

  // Publisher
  PublisherOptions,
  PublishOptions,
  PublishResult,
  PublishSnapshotOptions,
  ChunkPublishResult,

  // Fetcher
  FetcherOptions,
  FetchOptions,
  FetchResult,
  ProbeResult,
  QueryEventsFn,

  // Relay
  RelayOptions,
  RelayPublishResponse,
} from './types';
