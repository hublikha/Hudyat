import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { PROTOCOL_IDENTIFIER } from './constants';
import { Envelope, ENVELOPE_FIELD_ORDER } from './envelope';
import { DeviceId, isDeviceId } from './ids';
import { utf8Encode } from './utf8';

/**
 * Application cryptography, per ADR 0004.
 *
 * Everything here is pure and deterministic apart from where randomness is
 * explicitly passed in. The platform-bound half — the P-256 identity key that
 * lives in the Android Keystore and never leaves it — is deliberately not in
 * this file: it cannot be modelled in Node, and pretending otherwise would
 * repeat the Phase 0 mistake of a test suite that proved nothing about the
 * device.
 *
 * No primitive is designed here (master rule 11).
 */

export const AGREEMENT_KEY_BYTES = 32;
export const SESSION_KEY_BYTES = 32;
export const NONCE_BYTES = 24;
export const SAS_DIGITS = 6;

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoError';
  }
}

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    out += b.toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * `DeviceId` is the first 16 bytes of SHA-256 over the DER SubjectPublicKeyInfo
 * of the identity key.
 *
 * The identifier is a convenience for addressing and display. **Trust is
 * anchored on the stored public key, never on this string** — an attacker who
 * found a 128-bit collision would still have to produce signatures from the
 * matching private key, which lives in a secure element.
 */
export function deviceIdFromIdentityKey(spkiDer: Uint8Array): DeviceId {
  if (spkiDer.length === 0) {
    throw new CryptoError('identity public key is empty');
  }
  const id = hex(sha256(spkiDer).subarray(0, 16));
  if (!isDeviceId(id)) {
    throw new CryptoError(`derived device id is malformed: ${id}`);
  }
  return id;
}

export function identityFingerprint(spkiDer: Uint8Array): Uint8Array {
  return sha256(spkiDer);
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

export interface AgreementKeyPair {
  readonly publicKey: Uint8Array;
  readonly privateKey: Uint8Array;
}

/**
 * Randomness is injected rather than taken from a global, so tests can pin it
 * and so the caller is forced to supply a real CSPRNG — on device that is
 * `expo-crypto`, which is the platform generator.
 */
export function generateAgreementKeyPair(
  randomBytes: (n: number) => Uint8Array,
): AgreementKeyPair {
  const privateKey = randomBytes(AGREEMENT_KEY_BYTES);
  if (privateKey.length !== AGREEMENT_KEY_BYTES) {
    throw new CryptoError('randomBytes returned the wrong length');
  }
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
}

/**
 * Canonical transcript for pairing.
 *
 * Both devices must build byte-identical input or they derive different keys
 * and different verification digits, so the layout is fixed here and the device
 * ids are sorted rather than ordered by who initiated. Every field is
 * length-prefixed: without that, adjacent variable-length fields could be
 * shifted between one another to produce the same bytes from different values.
 */
export function pairingTranscript(input: {
  familyId: string;
  invitationNonce: Uint8Array;
  a: { deviceId: DeviceId; identityKey: Uint8Array; agreementKey: Uint8Array };
  b: { deviceId: DeviceId; identityKey: Uint8Array; agreementKey: Uint8Array };
}): Uint8Array {
  const [low, high] =
    input.a.deviceId < input.b.deviceId ? [input.a, input.b] : [input.b, input.a];

  const parts: Uint8Array[] = [
    utf8Encode(`${PROTOCOL_IDENTIFIER} pair`),
    utf8Encode(input.familyId),
    input.invitationNonce,
    utf8Encode(low.deviceId),
    low.identityKey,
    low.agreementKey,
    utf8Encode(high.deviceId),
    high.identityKey,
    high.agreementKey,
  ];

  let total = 0;
  for (const p of parts) {
    total += 4 + p.length;
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out[offset] = (p.length >>> 24) & 0xff;
    out[offset + 1] = (p.length >>> 16) & 0xff;
    out[offset + 2] = (p.length >>> 8) & 0xff;
    out[offset + 3] = p.length & 0xff;
    offset += 4;
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * Session key from X25519 agreement, salted with the invitation nonce.
 *
 * The nonce is the salt so that two devices pairing a second time derive a
 * different key: re-pairing after a revocation must not resurrect the old
 * session.
 */
export function deriveSessionKey(input: {
  ownAgreementPrivate: Uint8Array;
  peerAgreementPublic: Uint8Array;
  invitationNonce: Uint8Array;
  aDeviceId: DeviceId;
  bDeviceId: DeviceId;
}): Uint8Array {
  let shared: Uint8Array;
  try {
    shared = x25519.getSharedSecret(input.ownAgreementPrivate, input.peerAgreementPublic);
  } catch {
    // @noble screens low-order and malformed public keys itself. Caught and
    // re-thrown so the domain never sees a library error type, and so a peer
    // cannot distinguish rejection reasons.
    throw new CryptoError('peer agreement key is unusable');
  }

  // Defence in depth. Raw X25519 does not fail on low-order points, it returns
  // an all-zero secret the attacker also knows; @noble rejects them above, but
  // this does not depend on it continuing to.
  if (constantTimeEqual(shared, new Uint8Array(shared.length))) {
    throw new CryptoError('peer agreement key is unusable');
  }

  const [low, high] =
    input.aDeviceId < input.bDeviceId
      ? [input.aDeviceId, input.bDeviceId]
      : [input.bDeviceId, input.aDeviceId];

  return hkdf(
    sha256,
    shared,
    input.invitationNonce,
    utf8Encode(`${PROTOCOL_IDENTIFIER} pair${low}${high}`),
    SESSION_KEY_BYTES,
  );
}

/**
 * Six digits both users read aloud and compare.
 *
 * This is what defeats an attacker who controls the network but cannot see the
 * two screens: they can substitute keys, but they cannot make two independently
 * computed transcripts agree.
 */
export function shortAuthenticationString(transcript: Uint8Array): string {
  const digest = hkdf(
    sha256,
    transcript,
    new Uint8Array(0),
    utf8Encode(`${PROTOCOL_IDENTIFIER} sas`),
    4,
  );
  const value =
    ((digest[0]! << 24) | (digest[1]! << 16) | (digest[2]! << 8) | digest[3]!) >>> 0;
  return (value % 10 ** SAS_DIGITS).toString().padStart(SAS_DIGITS, '0');
}

/**
 * The bytes an AEAD tag covers: every envelope field except `payload`, in
 * canonical order.
 *
 * Rewriting `to` to redirect a message, or `seq` to reorder one, changes these
 * bytes and fails authentication. This mirrors `encodeEnvelope` exactly and is
 * pinned by a golden fixture for the same reason that function is.
 */
export function associatedData(envelope: Omit<Envelope, 'payload'>): Uint8Array {
  const parts = ENVELOPE_FIELD_ORDER.filter((key) => key !== 'payload').map(
    (key) =>
      `${JSON.stringify(key)}:${JSON.stringify((envelope as Record<string, unknown>)[key])}`,
  );
  return utf8Encode(`{${parts.join(',')}}`);
}

export interface SealedPayload {
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
}

/**
 * The nonce is random, not a counter.
 *
 * Phase 0 shipped a sequence counter that lived in memory and reset to zero on
 * restart. The same bug applied to a nonce counter repeats nonces, and nonce
 * reuse under a stream cipher leaks plaintext outright. Twenty-four random
 * bytes have no state to get wrong.
 */
export function sealPayload(input: {
  sessionKey: Uint8Array;
  plaintext: string;
  aad: Uint8Array;
  randomBytes: (n: number) => Uint8Array;
}): SealedPayload {
  if (input.sessionKey.length !== SESSION_KEY_BYTES) {
    throw new CryptoError('session key must be 32 bytes');
  }
  const nonce = input.randomBytes(NONCE_BYTES);
  if (nonce.length !== NONCE_BYTES) {
    throw new CryptoError('randomBytes returned the wrong length');
  }
  const ciphertext = xchacha20poly1305(input.sessionKey, nonce, input.aad).encrypt(
    utf8Encode(input.plaintext),
  );
  return { nonce, ciphertext };
}

export function openPayload(input: {
  sessionKey: Uint8Array;
  sealed: SealedPayload;
  aad: Uint8Array;
}): Uint8Array {
  if (input.sessionKey.length !== SESSION_KEY_BYTES) {
    throw new CryptoError('session key must be 32 bytes');
  }
  if (input.sealed.nonce.length !== NONCE_BYTES) {
    throw new CryptoError('nonce must be 24 bytes');
  }
  try {
    return xchacha20poly1305(input.sessionKey, input.sealed.nonce, input.aad).decrypt(
      input.sealed.ciphertext,
    );
  } catch {
    // The reason is deliberately not reported: distinguishing "wrong key" from
    // "tampered ciphertext" tells an attacker which of the two they achieved.
    throw new CryptoError('payload failed authentication');
  }
}
