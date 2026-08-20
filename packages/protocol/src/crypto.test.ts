import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CryptoError,
  associatedData,
  constantTimeEqual,
  deriveSessionKey,
  deviceIdFromIdentityKey,
  generateAgreementKeyPair,
  identityFingerprint,
  openPayload,
  pairingTranscript,
  sealPayload,
  shortAuthenticationString,
} from './crypto';
import { Envelope } from './envelope';
import { PacketType } from './constants';
import { DeviceId } from './ids';
import { PING_A_TO_B } from './fixtures';

/** Deterministic bytes for tests. Never acceptable outside one. */
function counterRandom(seed = 0): (n: number) => Uint8Array {
  let c = seed;
  return (n: number) => Uint8Array.from({ length: n }, () => (c = (c + 1) & 0xff));
}

const realRandom = (n: number) => {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
};

function pair() {
  const a = generateAgreementKeyPair(counterRandom(1));
  const b = generateAgreementKeyPair(counterRandom(100));
  const nonce = new Uint8Array(16).fill(7);
  const idA = 'a'.repeat(32) as DeviceId;
  const idB = 'b'.repeat(32) as DeviceId;
  const keyA = deriveSessionKey({
    ownAgreementPrivate: a.privateKey,
    peerAgreementPublic: b.publicKey,
    invitationNonce: nonce,
    aDeviceId: idA,
    bDeviceId: idB,
  });
  const keyB = deriveSessionKey({
    ownAgreementPrivate: b.privateKey,
    peerAgreementPublic: a.publicKey,
    invitationNonce: nonce,
    aDeviceId: idA,
    bDeviceId: idB,
  });
  return { a, b, nonce, idA, idB, keyA, keyB };
}

test('device id derives deterministically and in the expected format', () => {
  const spki = new Uint8Array([1, 2, 3, 4, 5]);
  const id = deviceIdFromIdentityKey(spki);
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(id, deviceIdFromIdentityKey(spki));
});

test('different identity keys give different device ids', () => {
  assert.notEqual(
    deviceIdFromIdentityKey(new Uint8Array([1])),
    deviceIdFromIdentityKey(new Uint8Array([2])),
  );
});

test('an empty identity key is refused', () => {
  assert.throws(() => deviceIdFromIdentityKey(new Uint8Array(0)), CryptoError);
});

test('both sides derive the same session key', () => {
  const { keyA, keyB } = pair();
  assert.deepEqual(keyA, keyB);
  assert.equal(keyA.length, 32);
});

test('device id order does not change the derived key', () => {
  const { a, b, nonce, idA, idB } = pair();
  const forward = deriveSessionKey({
    ownAgreementPrivate: a.privateKey,
    peerAgreementPublic: b.publicKey,
    invitationNonce: nonce,
    aDeviceId: idA,
    bDeviceId: idB,
  });
  const reversed = deriveSessionKey({
    ownAgreementPrivate: a.privateKey,
    peerAgreementPublic: b.publicKey,
    invitationNonce: nonce,
    aDeviceId: idB,
    bDeviceId: idA,
  });
  assert.deepEqual(forward, reversed, 'neither side negotiates who is "first"');
});

test('a different invitation nonce gives a different session key', () => {
  const { a, b, idA, idB } = pair();
  const first = deriveSessionKey({
    ownAgreementPrivate: a.privateKey,
    peerAgreementPublic: b.publicKey,
    invitationNonce: new Uint8Array(16).fill(1),
    aDeviceId: idA,
    bDeviceId: idB,
  });
  const second = deriveSessionKey({
    ownAgreementPrivate: a.privateKey,
    peerAgreementPublic: b.publicKey,
    invitationNonce: new Uint8Array(16).fill(2),
    aDeviceId: idA,
    bDeviceId: idB,
  });
  // Re-pairing after a revocation must not resurrect the old session.
  assert.notDeepEqual(first, second);
});

test('a low-order peer key is rejected rather than yielding a known key', () => {
  const a = generateAgreementKeyPair(counterRandom(1));
  // Raw X25519 returns an all-zero shared secret for these, which the attacker
  // also knows. @noble rejects them outright; either way the caller must see a
  // CryptoError rather than a library type or a usable key.
  const lowOrder = new Uint8Array(32);
  assert.throws(
    () =>
      deriveSessionKey({
        ownAgreementPrivate: a.privateKey,
        peerAgreementPublic: lowOrder,
        invitationNonce: new Uint8Array(16),
        aDeviceId: 'a'.repeat(32) as DeviceId,
        bDeviceId: 'b'.repeat(32) as DeviceId,
      }),
    CryptoError,
  );
});

test('sealed payload round-trips', () => {
  const { keyA, keyB } = pair();
  const aad = associatedData(PING_A_TO_B);
  const sealed = sealPayload({
    sessionKey: keyA,
    plaintext: 'ligtas ako',
    aad,
    randomBytes: counterRandom(9),
  });
  const opened = openPayload({ sessionKey: keyB, sealed, aad });
  assert.equal(Buffer.from(opened).toString('utf8'), 'ligtas ako');
});

test('the ciphertext does not contain the plaintext', () => {
  const { keyA } = pair();
  const sealed = sealPayload({
    sessionKey: keyA,
    plaintext: 'SOS at the barangay hall',
    aad: associatedData(PING_A_TO_B),
    randomBytes: counterRandom(3),
  });
  assert.ok(!Buffer.from(sealed.ciphertext).toString('utf8').includes('SOS'));
});

test('a tampered ciphertext fails authentication', () => {
  const { keyA, keyB } = pair();
  const aad = associatedData(PING_A_TO_B);
  const sealed = sealPayload({
    sessionKey: keyA,
    plaintext: 'meet at home',
    aad,
    randomBytes: counterRandom(5),
  });
  const tampered = Uint8Array.from(sealed.ciphertext);
  tampered[0] = tampered[0]! ^ 0x01;
  assert.throws(
    () => openPayload({ sessionKey: keyB, sealed: { ...sealed, ciphertext: tampered }, aad }),
    CryptoError,
  );
});

test('rewriting the recipient fails authentication', () => {
  const { keyA, keyB } = pair();
  const sealed = sealPayload({
    sessionKey: keyA,
    plaintext: 'private',
    aad: associatedData(PING_A_TO_B),
    randomBytes: counterRandom(11),
  });
  // Redirecting a message to a different device changes the associated data.
  const redirected: Envelope = { ...PING_A_TO_B, to: 'c'.repeat(32) as DeviceId };
  assert.throws(
    () => openPayload({ sessionKey: keyB, sealed, aad: associatedData(redirected) }),
    CryptoError,
  );
});

test('reordering by rewriting seq fails authentication', () => {
  const { keyA, keyB } = pair();
  const sealed = sealPayload({
    sessionKey: keyA,
    plaintext: 'first',
    aad: associatedData(PING_A_TO_B),
    randomBytes: counterRandom(13),
  });
  const reordered: Envelope = { ...PING_A_TO_B, seq: PING_A_TO_B.seq + 1 };
  assert.throws(
    () => openPayload({ sessionKey: keyB, sealed, aad: associatedData(reordered) }),
    CryptoError,
  );
});

test('changing the packet type fails authentication', () => {
  const { keyA, keyB } = pair();
  const sealed = sealPayload({
    sessionKey: keyA,
    plaintext: 'x',
    aad: associatedData(PING_A_TO_B),
    randomBytes: counterRandom(17),
  });
  const retyped: Envelope = { ...PING_A_TO_B, type: PacketType.TEST_PONG };
  assert.throws(
    () => openPayload({ sessionKey: keyB, sealed, aad: associatedData(retyped) }),
    CryptoError,
  );
});

test('a wrong session key fails authentication', () => {
  const { keyA } = pair();
  const aad = associatedData(PING_A_TO_B);
  const sealed = sealPayload({
    sessionKey: keyA,
    plaintext: 'x',
    aad,
    randomBytes: counterRandom(19),
  });
  const wrong = new Uint8Array(32).fill(42);
  assert.throws(() => openPayload({ sessionKey: wrong, sealed, aad }), CryptoError);
});

test('failure does not disclose which failure it was', () => {
  const { keyA, keyB } = pair();
  const aad = associatedData(PING_A_TO_B);
  const sealed = sealPayload({
    sessionKey: keyA,
    plaintext: 'x',
    aad,
    randomBytes: counterRandom(23),
  });
  const tampered = Uint8Array.from(sealed.ciphertext);
  tampered[1] = tampered[1]! ^ 0xff;

  const wrongKey = (() => {
    try {
      openPayload({ sessionKey: new Uint8Array(32).fill(1), sealed, aad });
    } catch (e) {
      return (e as Error).message;
    }
    return '';
  })();
  const badTag = (() => {
    try {
      openPayload({ sessionKey: keyB, sealed: { ...sealed, ciphertext: tampered }, aad });
    } catch (e) {
      return (e as Error).message;
    }
    return '';
  })();
  // Telling the two apart would tell an attacker which of them they achieved.
  assert.equal(wrongKey, badTag);
});

test('the nonce differs between messages under the same key', () => {
  const { keyA } = pair();
  const aad = associatedData(PING_A_TO_B);
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const sealed = sealPayload({ sessionKey: keyA, plaintext: 'x', aad, randomBytes: realRandom });
    seen.add(Buffer.from(sealed.nonce).toString('hex'));
  }
  assert.equal(seen.size, 200, 'a repeated nonce under a stream cipher leaks plaintext');
});

test('associated data excludes payload and matches canonical field order', () => {
  const aad = Buffer.from(associatedData(PING_A_TO_B)).toString('utf8');
  assert.ok(!aad.includes('payload'));
  assert.ok(aad.startsWith('{"v":'));
  assert.ok(aad.includes('"from"'));
  assert.ok(aad.includes('"to"'));
  assert.ok(aad.includes('"seq"'));
  assert.ok(aad.includes('"ts"'));
});

test('both sides compute the same verification digits', () => {
  const { a, b, nonce, idA, idB } = pair();
  const idKeyA = new Uint8Array([1, 1, 1]);
  const idKeyB = new Uint8Array([2, 2, 2]);
  const fromA = pairingTranscript({
    familyId: 'fam',
    invitationNonce: nonce,
    a: { deviceId: idA, identityKey: idKeyA, agreementKey: a.publicKey },
    b: { deviceId: idB, identityKey: idKeyB, agreementKey: b.publicKey },
  });
  const fromB = pairingTranscript({
    familyId: 'fam',
    invitationNonce: nonce,
    a: { deviceId: idB, identityKey: idKeyB, agreementKey: b.publicKey },
    b: { deviceId: idA, identityKey: idKeyA, agreementKey: a.publicKey },
  });
  assert.deepEqual(fromA, fromB, 'the transcript must not depend on who initiated');
  assert.equal(shortAuthenticationString(fromA), shortAuthenticationString(fromB));
  assert.match(shortAuthenticationString(fromA), /^[0-9]{6}$/);
});

test('a substituted key changes the verification digits', () => {
  const { a, b, nonce, idA, idB } = pair();
  const attacker = generateAgreementKeyPair(counterRandom(200));
  const honest = pairingTranscript({
    familyId: 'fam',
    invitationNonce: nonce,
    a: { deviceId: idA, identityKey: new Uint8Array([1]), agreementKey: a.publicKey },
    b: { deviceId: idB, identityKey: new Uint8Array([2]), agreementKey: b.publicKey },
  });
  const mitm = pairingTranscript({
    familyId: 'fam',
    invitationNonce: nonce,
    a: { deviceId: idA, identityKey: new Uint8Array([1]), agreementKey: a.publicKey },
    b: { deviceId: idB, identityKey: new Uint8Array([2]), agreementKey: attacker.publicKey },
  });
  // This is the whole point of reading the digits aloud.
  assert.notEqual(shortAuthenticationString(honest), shortAuthenticationString(mitm));
});

test('the transcript is not malleable by shifting field boundaries', () => {
  const base = {
    invitationNonce: new Uint8Array([1, 2]),
    a: {
      deviceId: 'a'.repeat(32) as DeviceId,
      identityKey: new Uint8Array([9]),
      agreementKey: new Uint8Array([8]),
    },
    b: {
      deviceId: 'b'.repeat(32) as DeviceId,
      identityKey: new Uint8Array([7]),
      agreementKey: new Uint8Array([6]),
    },
  };
  // Without length prefixes these two could produce identical bytes.
  const one = pairingTranscript({ ...base, familyId: 'ab' });
  const two = pairingTranscript({ ...base, familyId: 'a' });
  assert.notDeepEqual(one, two);
});

test('fingerprint is full-length SHA-256 and constant-time comparison works', () => {
  const fp = identityFingerprint(new Uint8Array([1, 2, 3]));
  assert.equal(fp.length, 32, 'the QR carries the full hash, not a truncation');
  assert.ok(constantTimeEqual(fp, identityFingerprint(new Uint8Array([1, 2, 3]))));
  assert.ok(!constantTimeEqual(fp, identityFingerprint(new Uint8Array([1, 2, 4]))));
  assert.ok(!constantTimeEqual(fp, fp.subarray(0, 31)));
});

test('crypto works with no platform TextEncoder present', () => {
  const savedEncoder = globalThis.TextEncoder;
  const savedDecoder = globalThis.TextDecoder;
  // Hermes has neither. Phase 0 shipped code that needed them.
  // @ts-expect-error - deliberately removing a global for the duration of the test
  delete globalThis.TextEncoder;
  // @ts-expect-error - see above
  delete globalThis.TextDecoder;
  try {
    const { keyA, keyB } = pair();
    const aad = associatedData(PING_A_TO_B);
    const sealed = sealPayload({
      sessionKey: keyA,
      plaintext: 'ligtas',
      aad,
      randomBytes: counterRandom(31),
    });
    assert.equal(
      Buffer.from(openPayload({ sessionKey: keyB, sealed, aad })).toString('utf8'),
      'ligtas',
    );
  } finally {
    globalThis.TextEncoder = savedEncoder;
    globalThis.TextDecoder = savedDecoder;
  }
});
