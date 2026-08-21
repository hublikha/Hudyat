import {
  DeviceId,
  constantTimeEqual,
  deriveSessionKey,
  deviceIdFromIdentityKey,
  identityFingerprint,
  pairingTranscript,
  shortAuthenticationString,
  toBase64,
  fromBase64,
} from '@rcn/protocol';

import { Db, transaction } from './database';
import * as repo from './repositories';

/**
 * Family enrolment: invitation, key exchange, and explicit verification.
 *
 * The security of this flow rests on two things that are easy to erode later,
 * so both are enforced here rather than left to the UI:
 *
 *  1. the joiner checks the inviter's identity key against the fingerprint
 *     carried in the QR, which is the out-of-band channel;
 *  2. both users compare six digits before any trust is written.
 *
 * Discovery plays no part. A device appearing on the network is not a candidate
 * for trust, and nothing in this file takes a peer's word for who it is.
 */

export const INVITATION_TTL_MS = 5 * 60 * 1000;
export const INVITATION_VERSION = 1;

export class PairingError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'PairingError';
  }
}

/** What the QR encodes. Small enough to scan reliably. */
export interface Invitation {
  readonly v: number;
  readonly familyId: string;
  readonly familyName: string;
  readonly inviter: DeviceId;
  /** Full SHA-256 of the inviter's identity key, base64. Not truncated. */
  readonly fingerprint: string;
  readonly nonce: string;
  readonly expiresAt: number;
}

export function encodeInvitation(invitation: Invitation): string {
  return JSON.stringify(invitation);
}

/**
 * Parses a scanned invitation.
 *
 * Every field is checked before use. A QR code is attacker-supplied input: it
 * can be printed, forwarded, or replaced on a wall, and the only thing that
 * makes it trustworthy is the fingerprint comparison that happens later.
 */
export function decodeInvitation(text: string): Invitation {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new PairingError('not a valid invitation code', 'ERR_INVITE_MALFORMED');
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new PairingError('not a valid invitation code', 'ERR_INVITE_MALFORMED');
  }
  const o = raw as Record<string, unknown>;
  const str = (k: string): string => {
    const v = o[k];
    if (typeof v !== 'string' || v.length === 0) {
      throw new PairingError(`invitation is missing ${k}`, 'ERR_INVITE_MALFORMED');
    }
    return v;
  };
  if (o['v'] !== INVITATION_VERSION) {
    throw new PairingError(
      'this invitation was made by a different version of the app',
      'ERR_INVITE_VERSION',
    );
  }
  const expiresAt = o['expiresAt'];
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    throw new PairingError('invitation is missing an expiry', 'ERR_INVITE_MALFORMED');
  }
  const inviter = str('inviter');
  if (!/^[0-9a-f]{32}$/.test(inviter)) {
    throw new PairingError('invitation names a malformed device', 'ERR_INVITE_MALFORMED');
  }
  return {
    v: INVITATION_VERSION,
    familyId: str('familyId'),
    familyName: str('familyName'),
    inviter: inviter as DeviceId,
    fingerprint: str('fingerprint'),
    nonce: str('nonce'),
    expiresAt,
  };
}

export interface CreateInvitationInput {
  db: Db;
  familyId: string;
  familyName: string;
  inviter: DeviceId;
  inviterIdentityKey: Uint8Array;
  now: number;
  randomBytes: (n: number) => Uint8Array;
  ttlMs?: number;
}

export function createInvitation(input: CreateInvitationInput): Invitation {
  const nonce = toBase64(input.randomBytes(16));
  const expiresAt = input.now + (input.ttlMs ?? INVITATION_TTL_MS);

  repo.insertInvitation(input.db, {
    nonce,
    familyId: input.familyId,
    createdAt: input.now,
    expiresAt,
  });

  return {
    v: INVITATION_VERSION,
    familyId: input.familyId,
    familyName: input.familyName,
    inviter: input.inviter,
    fingerprint: toBase64(identityFingerprint(input.inviterIdentityKey)),
    nonce,
    expiresAt,
  };
}

/**
 * The inviter decides whether an invitation may still be used.
 *
 * Expiry is checked here, on the issuing device, and never on the joiner. A
 * joining device's clock may be wrong or attacker-controlled, and if it were
 * the one deciding, setting a phone's date back would revive an expired
 * invitation indefinitely.
 */
export function redeemInvitation(input: {
  db: Db;
  nonce: string;
  joiner: DeviceId;
  now: number;
}): void {
  const row = repo.getInvitation(input.db, input.nonce);
  if (!row) {
    throw new PairingError('this invitation is not recognised', 'ERR_INVITE_UNKNOWN');
  }
  if (row.used_at !== null) {
    throw new PairingError('this invitation has already been used', 'ERR_INVITE_USED');
  }
  if (input.now > row.expires_at) {
    throw new PairingError('this invitation has expired', 'ERR_INVITE_EXPIRED');
  }
  if (!repo.consumeInvitation(input.db, { nonce: input.nonce, usedBy: input.joiner, now: input.now })) {
    // Lost a race with another joiner. The database decided, not this check.
    throw new PairingError('this invitation has already been used', 'ERR_INVITE_USED');
  }
}

export interface PeerHello {
  readonly deviceId: DeviceId;
  readonly identityKey: Uint8Array;
  readonly agreementKey: Uint8Array;
  readonly displayName: string;
}

export type PairingRole = 'JOINER' | 'INVITER';

export interface VerificationInput {
  invitation: Invitation;
  self: { deviceId: DeviceId; identityKey: Uint8Array; agreementKey: Uint8Array };
  peer: PeerHello;
  /**
   * Which side of the invitation this device is on.
   *
   * The two roles are not symmetric and must not be treated as if they were.
   * The QR carries the inviter's fingerprint, so only the joiner has an
   * out-of-band value to check the peer against. The inviter has nothing
   * equivalent — it never saw the joiner's key beforehand — and is protected by
   * the spoken digits alone.
   */
  role: PairingRole;
}

export interface PendingVerification {
  readonly sas: string;
  readonly transcript: Uint8Array;
  readonly peer: PeerHello;
}

/**
 * Checks the peer against the invitation and produces the digits to compare.
 *
 * On the **joiner** side the fingerprint check is the load-bearing step: it ties
 * the key arriving over the network to the QR that was shown in person. Without
 * it an attacker who controls the network substitutes their own key and the
 * pairing is theirs.
 *
 * On the **inviter** side there is nothing to check against — the QR carries the
 * inviter's own fingerprint, and the inviter never saw the joiner's key before
 * this moment. That side is protected entirely by the spoken digits, which is
 * why the comparison is not optional and why `confirmPairing` refuses to write
 * trust without it.
 *
 * Both sides recompute the peer's device id from its key rather than believing
 * the claim, so no peer can present an id belonging to someone else's key.
 */
export function prepareVerification(input: VerificationInput): PendingVerification {
  if (input.role === 'JOINER') {
    const expected = fromBase64(input.invitation.fingerprint);
    const actual = identityFingerprint(input.peer.identityKey);
    if (!constantTimeEqual(expected, actual)) {
      throw new PairingError(
        'this device does not match the invitation code',
        'ERR_FINGERPRINT_MISMATCH',
      );
    }
  }

  const derived = deviceIdFromIdentityKey(input.peer.identityKey);
  if (derived !== input.peer.deviceId) {
    throw new PairingError('this device is not who it claims to be', 'ERR_DEVICE_ID_MISMATCH');
  }

  const transcript = pairingTranscript({
    familyId: input.invitation.familyId,
    invitationNonce: fromBase64(input.invitation.nonce),
    a: {
      deviceId: input.self.deviceId,
      identityKey: input.self.identityKey,
      agreementKey: input.self.agreementKey,
    },
    b: {
      deviceId: input.peer.deviceId,
      identityKey: input.peer.identityKey,
      agreementKey: input.peer.agreementKey,
    },
  });

  return { sas: shortAuthenticationString(transcript), transcript, peer: input.peer };
}

/**
 * Derives the session key for a pairing, without writing anything.
 *
 * Separate from `confirmPairing` because sealing the key is an asynchronous
 * call into the Keystore, while writing trust is a synchronous transaction. The
 * caller derives here, seals, and then commits — so the key reaches the database
 * already sealed rather than being stored raw for want of an `await`.
 */
export function derivePairingSessionKey(input: {
  pending: PendingVerification;
  invitation: Invitation;
  self: { deviceId: DeviceId; agreementPrivateKey: Uint8Array };
}): Uint8Array {
  return deriveSessionKey({
    ownAgreementPrivate: input.self.agreementPrivateKey,
    peerAgreementPublic: input.pending.peer.agreementKey,
    invitationNonce: fromBase64(input.invitation.nonce),
    aDeviceId: input.self.deviceId,
    bDeviceId: input.pending.peer.deviceId,
  });
}

export interface ConfirmInput {
  db: Db;
  pending: PendingVerification;
  invitation: Invitation;
  self: { deviceId: DeviceId };
  now: number;
  /**
   * The session key, already sealed by the caller under the Keystore key.
   *
   * Taking sealed bytes rather than a sealing function is deliberate: a
   * synchronous callback cannot reach the Keystore, and the shape that "worked"
   * for a sync signature was one that stored the key in the clear.
   */
  sessionKeySealed: Uint8Array;
  /** True only when the user confirmed the digits matched. */
  userConfirmed: boolean;
}

/**
 * Writes trust — and only after the user says the digits matched.
 *
 * `userConfirmed` is a required argument rather than an implicit default so
 * that a caller cannot reach a trusted state by forgetting to ask. Skipping the
 * comparison would leave a pairing that looks verified and is not.
 */
export function confirmPairing(input: ConfirmInput): void {
  if (!input.userConfirmed) {
    throw new PairingError('pairing was not confirmed', 'ERR_NOT_CONFIRMED');
  }

  const peer = input.pending.peer;

  transaction(input.db, () => {
    if (repo.isRevoked(input.db, peer.deviceId)) {
      // Re-admitting a removed device must be a deliberate act, not something
      // that happens because it reappeared with a fresh invitation.
      throw new PairingError(
        'this device was removed from the family and must be re-added deliberately',
        'ERR_REVOKED',
      );
    }

    if (input.sessionKeySealed.length === 0) {
      throw new PairingError('the session key was not sealed', 'ERR_KEY_NOT_SEALED');
    }

    if (!repo.getDevice(input.db, peer.deviceId)) {
      repo.insertDevice(input.db, {
        device_id: peer.deviceId,
        identity_public_key: peer.identityKey,
        agreement_public_key: peer.agreementKey,
        display_name: peer.displayName,
        key_security_level: null,
        first_seen_at: input.now,
      });
    }

    repo.upsertTrust(input.db, {
      device_id: peer.deviceId,
      family_id: input.invitation.familyId,
      session_key_sealed: input.sessionKeySealed,
      sas: input.pending.sas,
      verified_at: input.now,
      status: 'ACTIVE',
    });

    repo.addMembership(input.db, {
      familyId: input.invitation.familyId,
      deviceId: peer.deviceId,
      role: 'MEMBER',
      joinedAt: input.now,
    });
  });
}

/**
 * Removes a device from the family.
 *
 * The revocation row outlives the device row, so the device cannot be
 * re-trusted by simply reappearing on the network. It keeps whatever it already
 * received: revocation is forward-only, as ADR 0004 §6 states.
 */
export function removeDevice(input: {
  db: Db;
  deviceId: DeviceId;
  now: number;
  reason?: string;
}): void {
  transaction(input.db, () => {
    repo.revokeDevice(input.db, {
      deviceId: input.deviceId,
      now: input.now,
      reason: input.reason ?? null,
    });
  });
}
