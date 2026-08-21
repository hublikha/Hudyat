import {
  Db,
  getSelfDevice,
  insertDevice,
} from '@rcn/core';
import {
  DeviceId,
  deviceIdFromIdentityKey,
  generateAgreementKeyPair,
} from '@rcn/protocol';
import * as Crypto from 'expo-crypto';

import { ensureIdentity, seal, unseal } from '../../../../modules/rcn-identity';
import type { KeySecurityLevel } from '../../../../modules/rcn-identity';

/**
 * Establishes this device's identity, once, and keeps it.
 *
 * The identity key is created inside the Android Keystore and never leaves it.
 * The X25519 agreement key is generated here and stored sealed under a second
 * Keystore key, because Keystore ECDH needs API 31+ and the floor is 24
 * (ADR 0004 §3).
 */

export interface SelfIdentity {
  readonly deviceId: DeviceId;
  readonly identityKey: Uint8Array;
  readonly agreementPublicKey: Uint8Array;
  readonly securityLevel: KeySecurityLevel;
}

/** Platform CSPRNG. Never `Math.random`, which is not one. */
export function randomBytes(n: number): Uint8Array {
  return Crypto.getRandomBytes(n);
}

/**
 * Loads the identity, creating it on first run.
 *
 * Regenerating an identity is not a recoverable action: every trust record the
 * family verified is bound to the old key, so a device that quietly made a new
 * one would appear to its own family as a stranger. Hence this reuses whatever
 * the Keystore already holds and never silently replaces it.
 */
export async function loadOrCreateIdentity(db: Db): Promise<SelfIdentity> {
  const keystore = await ensureIdentity();
  const deviceId = deviceIdFromIdentityKey(keystore.publicKeyDer);

  const existing = getSelfDevice(db);
  if (existing) {
    if (existing.device_id !== deviceId) {
      // The Keystore holds a different key than the database was built around.
      // Continuing would mean signing as one identity while the family's trust
      // records name another, and every message would fail authentication for
      // reasons no user could act on.
      throw new Error(
        'Stored identity does not match the key in secure hardware. ' +
          'The app data and the device keystore have diverged.',
      );
    }
    return {
      deviceId,
      identityKey: existing.identity_public_key,
      agreementPublicKey: existing.agreement_public_key ?? new Uint8Array(0),
      securityLevel: (existing.key_security_level ?? 'UNKNOWN') as KeySecurityLevel,
    };
  }

  const agreement = generateAgreementKeyPair(randomBytes);
  const sealedPrivate = await seal(agreement.privateKey);

  insertDevice(db, {
    device_id: deviceId,
    identity_public_key: keystore.publicKeyDer,
    agreement_public_key: agreement.publicKey,
    display_name: '',
    is_self: true,
    key_security_level: keystore.securityLevel,
    first_seen_at: Date.now(),
  });
  db.run('INSERT INTO self_secret (device_id, agreement_private_sealed, keystore_alias) VALUES (?, ?, ?)', [
    deviceId,
    sealedPrivate,
    'rcn.seal.v1',
  ]);

  return {
    deviceId,
    identityKey: keystore.publicKeyDer,
    agreementPublicKey: agreement.publicKey,
    securityLevel: keystore.securityLevel,
  };
}

/**
 * Unseals the agreement private key for the duration of one operation.
 *
 * Callers should not hold the result. It is in app memory while in use — the
 * disclosed weakening in ADR 0004 §2 — and the shorter that window, the better.
 */
export async function withAgreementPrivateKey<T>(
  db: Db,
  deviceId: DeviceId,
  fn: (privateKey: Uint8Array) => T,
): Promise<T> {
  const row = db.get<{ agreement_private_sealed: Uint8Array }>(
    'SELECT agreement_private_sealed FROM self_secret WHERE device_id = ?',
    [deviceId],
  );
  if (!row) {
    throw new Error('This device has no agreement key. Identity setup did not complete.');
  }
  const priv = await unseal(row.agreement_private_sealed);
  try {
    return fn(priv);
  } finally {
    // Best effort: the bytes are unreachable after this, though the runtime
    // decides when they are actually collected.
    priv.fill(0);
  }
}

export async function sealBytes(plaintext: Uint8Array): Promise<Uint8Array> {
  return seal(plaintext);
}

export async function unsealBytes(sealed: Uint8Array): Promise<Uint8Array> {
  return unseal(sealed);
}
