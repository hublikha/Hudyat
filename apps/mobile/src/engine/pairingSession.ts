import {
  Invitation,
  PairingError,
  PairingRole,
  PeerHello,
  PendingVerification,
  prepareVerification,
} from '@rcn/core';
import {
  DeviceId,
  Envelope,
  PROTOCOL_VERSION,
  PacketType,
  deviceIdFromIdentityKey,
  encodeEnvelope,
  fromBase64,
  newMessageId,
  toBase64,
} from '@rcn/protocol';

/**
 * The pairing handshake, as carried over the transport.
 *
 * This is the only exchange in the system that happens between devices with no
 * shared key, because establishing that key is its purpose. Everything that
 * makes it safe sits outside the packet:
 *
 *  - the joiner checks the identity key against the fingerprint printed in the
 *    QR, which travelled by a channel the network cannot touch;
 *  - both users then compare six digits that neither device can influence.
 *
 * A session is short-lived and explicit. The engine accepts a HELLO only while
 * one is open, so the untrusted-sender exception cannot be reached by a device
 * that simply shows up on the network.
 */

export interface HelloBody {
  readonly deviceId: string;
  readonly identityKey: string;
  readonly agreementKey: string;
  readonly displayName: string;
  /** Present only from the joiner: proves which invitation is being answered. */
  readonly nonce?: string;
}

export function encodeHello(input: {
  self: { deviceId: DeviceId; identityKey: Uint8Array; agreementKey: Uint8Array };
  displayName: string;
  to: DeviceId;
  nonce?: string;
}): Uint8Array {
  const body: HelloBody = {
    deviceId: input.self.deviceId,
    identityKey: toBase64(input.self.identityKey),
    agreementKey: toBase64(input.self.agreementKey),
    displayName: input.displayName,
    ...(input.nonce !== undefined ? { nonce: input.nonce } : {}),
  };
  const envelope: Envelope = {
    v: PROTOCOL_VERSION,
    type: PacketType.PAIR_HELLO,
    id: newMessageId(() => cryptoRandom(16)),
    from: input.self.deviceId,
    to: input.to,
    seq: 0,
    ts: Date.now(),
    payload: JSON.stringify(body),
  };
  return encodeEnvelope(envelope);
}

let randomSource: (n: number) => Uint8Array = () => {
  throw new Error('pairing randomness was not configured');
};

export function configurePairingRandom(fn: (n: number) => Uint8Array): void {
  randomSource = fn;
}

function cryptoRandom(n: number): Uint8Array {
  return randomSource(n);
}

/**
 * Parses a HELLO into a peer description.
 *
 * The payload is attacker-controlled: it arrives unencrypted from a device that
 * is not trusted yet. Every field is validated, and the device id is recomputed
 * from the key rather than believed — a peer that could name itself would
 * defeat the fingerprint check by claiming to be the inviter.
 */
export function parseHello(payload: string): PeerHello & { nonce?: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    throw new PairingError('malformed pairing message', 'ERR_HELLO_MALFORMED');
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new PairingError('malformed pairing message', 'ERR_HELLO_MALFORMED');
  }
  const o = raw as Record<string, unknown>;
  const str = (k: string): string => {
    const v = o[k];
    if (typeof v !== 'string' || v.length === 0) {
      throw new PairingError(`pairing message is missing ${k}`, 'ERR_HELLO_MALFORMED');
    }
    return v;
  };

  const identityKey = fromBase64(str('identityKey'));
  const agreementKey = fromBase64(str('agreementKey'));

  if (agreementKey.length !== 32) {
    throw new PairingError('pairing message has a malformed key', 'ERR_HELLO_MALFORMED');
  }

  const claimed = str('deviceId');
  const derived = deviceIdFromIdentityKey(identityKey);
  if (derived !== claimed) {
    // A device that could pick its own id could claim to be the inviter and
    // slip past a check that compares ids rather than keys.
    throw new PairingError('pairing message does not match its key', 'ERR_DEVICE_ID_MISMATCH');
  }

  const displayName = typeof o['displayName'] === 'string' ? o['displayName'] : '';
  const nonce = typeof o['nonce'] === 'string' ? o['nonce'] : undefined;

  return {
    deviceId: derived,
    identityKey,
    agreementKey,
    // Trimmed and bounded: this is displayed during verification, and a long or
    // crafted name could push the digits off screen or imitate other UI text.
    displayName: displayName.slice(0, 40),
    ...(nonce !== undefined ? { nonce } : {}),
  };
}

export interface PairingSession {
  readonly role: PairingRole;
  readonly invitation: Invitation;
  readonly self: { deviceId: DeviceId; identityKey: Uint8Array; agreementKey: Uint8Array };
  readonly displayName: string;
  /** Set once the peer's HELLO has arrived and been checked. */
  pending: PendingVerification | null;
  /** True once we have sent our own HELLO, so it is not sent twice. */
  helloSent: boolean;
  readonly startedAt: number;
}

export const PAIRING_TIMEOUT_MS = 3 * 60 * 1000;

export function sessionExpired(session: PairingSession, now: number): boolean {
  return now - session.startedAt > PAIRING_TIMEOUT_MS;
}

/**
 * Checks a peer's HELLO against the session and produces the digits.
 *
 * The joiner additionally verifies the invitation fingerprint; the inviter has
 * no equivalent out-of-band value and relies on the digits, which is why
 * `confirmPairing` will not write trust without the user's confirmation.
 */
export function acceptHello(
  session: PairingSession,
  hello: PeerHello & { nonce?: string },
): PendingVerification {
  if (session.role === 'INVITER') {
    if (hello.nonce !== session.invitation.nonce) {
      // Someone answering an invitation they were not shown.
      throw new PairingError('this device is answering a different code', 'ERR_WRONG_INVITATION');
    }
  } else if (hello.deviceId !== session.invitation.inviter) {
    throw new PairingError('this is not the device that showed the code', 'ERR_WRONG_DEVICE');
  }

  return prepareVerification({
    invitation: session.invitation,
    self: session.self,
    peer: hello,
    role: session.role,
  });
}
