/**
 * Payload hashing and size budgeting helpers.
 *
 * Pure JavaScript (no Buffer, no SubtleCrypto), so they run in Node, browsers
 * and insecure (http:) browser contexts where `crypto.subtle` is missing.
 */

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

const encoder = new TextEncoder();

/**
 * SHA-256 of the UTF-8 bytes of `content`, as lowercase hex.
 * This is the value written to and checked against the `payload_hash` tag.
 */
export function sha256Hex(content: string): string {
  return bytesToHex(sha256(encoder.encode(content)));
}

/** NIP-44 v2 padded plaintext length (mirrors nostr-tools `nip44.v2.utils.calcPaddedLen`). */
function nip44PaddedLength(len: number): number {
  if (len <= 32) return 32;
  const nextPower = 1 << (Math.floor(Math.log2(len - 1)) + 1);
  const chunk = nextPower <= 256 ? 32 : nextPower / 8;
  return chunk * (Math.floor((len - 1) / chunk) + 1);
}

/** Largest plaintext NIP-44 v2 accepts, in bytes. */
export const NIP44_MAX_PLAINTEXT_SIZE = 65_535;

/**
 * Length in bytes of the base64 NIP-44 v2 payload produced for a plaintext of
 * `plaintextBytes` UTF-8 bytes. This is what lands in `event.content`.
 *
 * @throws RangeError if the plaintext is outside 1..65535 bytes
 */
export function nip44CiphertextSize(plaintextBytes: number): number {
  if (!Number.isSafeInteger(plaintextBytes) || plaintextBytes < 1 || plaintextBytes > NIP44_MAX_PLAINTEXT_SIZE) {
    throw new RangeError(`NIP-44 plaintext must be 1..${NIP44_MAX_PLAINTEXT_SIZE} bytes, got ${plaintextBytes}`);
  }
  // version(1) + nonce(32) + length prefix(2) + padded plaintext + mac(32), then base64
  const raw = 1 + 32 + 2 + nip44PaddedLength(plaintextBytes) + 32;
  return 4 * Math.ceil(raw / 3);
}

/**
 * Largest plaintext chunk (in bytes) whose NIP-44 v2 ciphertext fits within
 * `maxContentBytes`. Use it to pick a `chunkSize` when each chunk is encrypted
 * separately, e.g. for strfry:
 *
 * ```ts
 * // leave ~1.5KB for id, pubkey, sig, kind, created_at and tags
 * const chunkSize = maxNip44PlaintextSize(STRFRY_DEFAULT_MAX_EVENT_SIZE - 1_536); // 40_960
 * ```
 *
 * @returns 0 if not even a 1-byte plaintext fits
 */
export function maxNip44PlaintextSize(maxContentBytes: number): number {
  let lo = 0;
  let hi = NIP44_MAX_PLAINTEXT_SIZE;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (nip44CiphertextSize(mid) <= maxContentBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}
