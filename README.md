# nostr-chunked-events

A library for chunking and reassembling large Nostr events to overcome relay message size limits.

## Problem

Nostr relays impose size limits on events:
- **strfry default**: `maxEventSize = 65536` (64KB)
- **strfry default**: `maxWebsocketPayloadSize = 131072` (128KB)

When applications need to store large data (encrypted files, wallet states, long-form content), these limits cause WebSocket errors (code 1009) and data loss.

## Solution

This library automatically splits large content into multiple smaller events (chunks) and seamlessly reassembles them on retrieval.

## Installation

```bash
npm install nostr-chunked-events nostr-tools
```

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
  dTagPrefix: 'myapp-data'
});

console.log(`Published ${result.chunkCount} chunks`);
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

## API Reference

### High-Level API

#### `ChunkedPublisher`

```typescript
interface PublisherOptions {
  defaultRelays?: string[];        // Default relay URLs
  compression?: boolean;           // Enable gzip compression (default: false)
  deleteOrphanedChunks?: boolean;  // Delete old chunks when count decreases (default: false)
  authHandler?: (challenge: string) => Promise<Event>;  // NIP-42 auth
  timeout?: number;                // Connection timeout in ms
}

interface PublishOptions {
  kind: number;                    // Event kind (e.g., 30078, 37375)
  dTagPrefix: string;              // Prefix for d-tags
  relayUrls?: string[];            // Override default relays
  additionalTags?: string[][];     // Extra tags for all events
  onProgress?: (published: number, total: number) => void;
}
```

#### `ChunkedFetcher`

```typescript
interface FetcherOptions {
  defaultRelays?: string[];
  authHandler?: (challenge: string) => Promise<Event>;
  timeout?: number;
}

interface FetchOptions {
  kind: number;
  dTagPrefix: string;
  relayUrls?: string[];
  timeout?: number;
  author?: string;
}
```

### Low-Level API

For fine-grained control:

```typescript
import {
  createChunks,
  reassembleChunks,
  validateChunks,
  needsChunking,
  compress,
  decompress
} from 'nostr-chunked-events';

// Check if content needs chunking
if (needsChunking(content)) {
  const chunks = createChunks(content, {
    chunkSize: 250_000,
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

## Event Format

### Single Event (< 350KB)

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

### Chunked Events (>= 350KB)

```json
{
  "kind": 30078,
  "tags": [
    ["d", "mydata-chunk-0"],
    ["chunk", "0", "3"],
    ["v", "1"],
    ["compressed", "gzip"],
    ["client", "nostr-chunked-events"]
  ],
  "content": "<chunk 0>"
}
```

## Configuration

```typescript
import { configure } from 'nostr-chunked-events';

configure({
  maxSingleEventSize: 400_000,  // Threshold to trigger chunking
  chunkSize: 350_000,           // Size per chunk
  relayTimeout: 15_000,         // Connection timeout
  relayRetries: 3               // Retry attempts
});
```

## Use Cases

| Use Case | Event Kind | Description |
|----------|------------|-------------|
| NIP-60 Wallet | 37375 | Encrypted Cashu wallet state |
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

## License

MIT
