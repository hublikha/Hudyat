import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import {
  DeviceId,
  generateAgreementKeyPair,
  identityFingerprint,
  toBase64,
} from '@rcn/protocol';

import { Db, migrate } from './database';
import {
  INVITATION_TTL_MS,
  PairingError,
  confirmPairing,
  createInvitation,
  decodeInvitation,
  encodeInvitation,
  prepareVerification,
  redeemInvitation,
  removeDevice,
} from './pairing';
import { NodeDb } from './nodeDb';
import * as repo from './repositories';

const FAMILY = 'fam1';
const NOW = 1_000_000;

function counterRandom(seed = 0): (n: number) => Uint8Array {
  let c = seed;
  return (n: number) => Uint8Array.from({ length: n }, () => (c = (c + 1) & 0xff));
}

/** Sealing is the Keystore's job on device; identity here keeps tests honest. */
const seal = (b: Uint8Array) => b;

let db: Db;

// Identity keys are opaque bytes to this layer; the device id is derived from
// them, so tests must derive rather than invent ids.
const inviterKey = new Uint8Array([10, 11, 12, 13]);
const joinerKey = new Uint8Array([20, 21, 22, 23]);
const attackerKey = new Uint8Array([90, 91, 92, 93]);

import { deviceIdFromIdentityKey } from '@rcn/protocol';
const INVITER = deviceIdFromIdentityKey(inviterKey);
const JOINER = deviceIdFromIdentityKey(joinerKey);

const inviterAgree = generateAgreementKeyPair(counterRandom(1));
const joinerAgree = generateAgreementKeyPair(counterRandom(100));
const attackerAgree = generateAgreementKeyPair(counterRandom(200));

beforeEach(() => {
  db = new NodeDb();
  migrate(db);
  repo.insertDevice(db, {
    device_id: INVITER,
    identity_public_key: inviterKey,
    agreement_public_key: inviterAgree.publicKey,
    display_name: 'Nanay',
    is_self: true,
    key_security_level: 'TEE',
    first_seen_at: 1,
  });
  repo.insertFamily(db, { familyId: FAMILY, name: 'Household', createdAt: 1, createdBy: INVITER });
});

function invite(now = NOW) {
  return createInvitation({
    db,
    familyId: FAMILY,
    familyName: 'Household',
    inviter: INVITER,
    inviterIdentityKey: inviterKey,
    now,
    randomBytes: counterRandom(7),
  });
}

const joinerHello = {
  deviceId: JOINER,
  identityKey: joinerKey,
  agreementKey: joinerAgree.publicKey,
  displayName: 'Tatay',
};

const selfSide = {
  deviceId: JOINER,
  identityKey: joinerKey,
  agreementKey: joinerAgree.publicKey,
};

const inviterSide = {
  deviceId: INVITER,
  identityKey: inviterKey,
  agreementKey: inviterAgree.publicKey,
};

const inviterHello = {
  deviceId: INVITER,
  identityKey: inviterKey,
  agreementKey: inviterAgree.publicKey,
  displayName: 'Nanay',
};

test('an invitation round-trips through the QR encoding', () => {
  const original = invite();
  const decoded = decodeInvitation(encodeInvitation(original));
  assert.deepEqual(decoded, original);
});

test('a malformed or truncated code is refused', () => {
  for (const bad of ['', 'not json', '{}', '{"v":1}', JSON.stringify({ v: 99 })]) {
    assert.throws(() => decodeInvitation(bad), PairingError, `should reject ${JSON.stringify(bad)}`);
  }
});

test('an invitation naming a malformed device is refused', () => {
  const bad = { ...invite(), inviter: 'not-a-device-id' };
  assert.throws(() => decodeInvitation(JSON.stringify(bad)), PairingError);
});

test('the fingerprint in the invitation is the full hash, not a truncation', () => {
  const inv = invite();
  assert.equal(toBase64(identityFingerprint(inviterKey)), inv.fingerprint);
  assert.equal(identityFingerprint(inviterKey).length, 32);
});

test('an invitation can be redeemed exactly once', () => {
  const inv = invite();
  redeemInvitation({ db, nonce: inv.nonce, joiner: JOINER, now: NOW + 1000 });
  assert.throws(
    () => redeemInvitation({ db, nonce: inv.nonce, joiner: JOINER, now: NOW + 2000 }),
    /already been used/,
  );
});

test('a replayed invitation cannot admit a second device', () => {
  const inv = invite();
  redeemInvitation({ db, nonce: inv.nonce, joiner: JOINER, now: NOW + 1 });
  const attacker = deviceIdFromIdentityKey(attackerKey);
  assert.throws(
    () => redeemInvitation({ db, nonce: inv.nonce, joiner: attacker, now: NOW + 2 }),
    PairingError,
  );
});

test('an expired invitation is refused', () => {
  const inv = invite();
  assert.throws(
    () =>
      redeemInvitation({
        db,
        nonce: inv.nonce,
        joiner: JOINER,
        now: NOW + INVITATION_TTL_MS + 1,
      }),
    /expired/,
  );
});

test('expiry is decided by the issuer, so a joiner clock cannot extend it', () => {
  const inv = invite();
  // The joiner's clock is irrelevant: redeemInvitation runs on the inviter and
  // uses the inviter's clock. Winding a phone back cannot revive this.
  assert.throws(
    () =>
      redeemInvitation({
        db,
        nonce: inv.nonce,
        joiner: JOINER,
        now: NOW + INVITATION_TTL_MS + 1,
      }),
    /expired/,
  );
  const row = repo.getInvitation(db, inv.nonce);
  assert.equal(row?.used_at, null, 'an expired invitation must not be consumed');
});

test('an unknown invitation is refused', () => {
  assert.throws(
    () => redeemInvitation({ db, nonce: 'made-up', joiner: JOINER, now: NOW }),
    /not recognised/,
  );
});

test('both sides compute the same verification digits', () => {
  const inv = invite();
  const onJoiner = prepareVerification({ invitation: inv, self: selfSide, peer: inviterHello, role: 'JOINER' });
  const onInviter = prepareVerification({ invitation: inv, self: inviterSide, peer: joinerHello, role: 'INVITER' });
  assert.equal(onJoiner.sas, onInviter.sas);
  assert.match(onJoiner.sas, /^[0-9]{6}$/);
});

test('a substituted identity key is refused before any digits are shown', () => {
  const inv = invite();
  // The attacker controls the network and presents its own key.
  assert.throws(
    () =>
      prepareVerification({
        invitation: inv,
        self: selfSide,
        peer: { ...inviterHello, identityKey: attackerKey },
        role: 'JOINER',
      }),
    /does not match the invitation code/,
  );
});

test('a peer claiming an id that is not its own key is refused', () => {
  const inv = invite();
  assert.throws(
    () =>
      prepareVerification({
        invitation: inv,
        self: selfSide,
        peer: { ...inviterHello, deviceId: 'f'.repeat(32) as DeviceId },
        role: 'JOINER',
      }),
    /not who it claims to be/,
  );
});

test('a substituted agreement key changes the digits', () => {
  const inv = invite();
  const honest = prepareVerification({ invitation: inv, self: selfSide, peer: inviterHello, role: 'JOINER' });
  const mitm = prepareVerification({
    invitation: inv,
    self: selfSide,
    peer: { ...inviterHello, agreementKey: attackerAgree.publicKey },
    role: 'JOINER',
  });
  // The fingerprint still matches — the attacker relayed the real identity key
  // but swapped the agreement key. Only the spoken digits catch this.
  assert.notEqual(honest.sas, mitm.sas);
});

test('trust is written only after the user confirms', () => {
  const inv = invite();
  const pending = prepareVerification({ invitation: inv, self: inviterSide, peer: joinerHello, role: 'INVITER' });
  assert.throws(
    () =>
      confirmPairing({
        db,
        pending,
        invitation: inv,
        self: { deviceId: INVITER, agreementPrivateKey: inviterAgree.privateKey },
        now: NOW,
        seal,
        userConfirmed: false,
      }),
    /not confirmed/,
  );
  assert.equal(repo.getActiveTrust(db, JOINER), undefined);
});

test('confirming writes trust and membership', () => {
  const inv = invite();
  const pending = prepareVerification({ invitation: inv, self: inviterSide, peer: joinerHello, role: 'INVITER' });
  confirmPairing({
    db,
    pending,
    invitation: inv,
    self: { deviceId: INVITER, agreementPrivateKey: inviterAgree.privateKey },
    now: NOW,
    seal,
    userConfirmed: true,
  });
  const trust = repo.getActiveTrust(db, JOINER);
  assert.ok(trust);
  assert.equal(trust?.sas, pending.sas);
  assert.equal(repo.listTrustedDevices(db, FAMILY).length, 1);
});

test('both sides derive the same session key through pairing', () => {
  const inv = invite();
  const onInviter = prepareVerification({ invitation: inv, self: inviterSide, peer: joinerHello, role: 'INVITER' });
  confirmPairing({
    db, pending: onInviter, invitation: inv,
    self: { deviceId: INVITER, agreementPrivateKey: inviterAgree.privateKey },
    now: NOW, seal, userConfirmed: true,
  });
  const inviterKeyStored = repo.getActiveTrust(db, JOINER)?.session_key_sealed;

  // The joiner's device, computing independently from its own private key.
  const db2 = new NodeDb();
  migrate(db2);
  repo.insertDevice(db2, {
    device_id: JOINER, identity_public_key: joinerKey,
    agreement_public_key: joinerAgree.publicKey, display_name: 'Tatay',
    is_self: true, key_security_level: 'TEE', first_seen_at: 1,
  });
  repo.insertFamily(db2, { familyId: FAMILY, name: 'Household', createdAt: 1, createdBy: JOINER });
  const onJoiner = prepareVerification({ invitation: inv, self: selfSide, peer: inviterHello, role: 'JOINER' });
  confirmPairing({
    db: db2, pending: onJoiner, invitation: inv,
    self: { deviceId: JOINER, agreementPrivateKey: joinerAgree.privateKey },
    now: NOW, seal, userConfirmed: true,
  });
  const joinerKeyStored = repo.getActiveTrust(db2, INVITER)?.session_key_sealed;

  assert.deepEqual(inviterKeyStored, joinerKeyStored, 'both devices must reach the same key');
  db2.close();
});

test('a removed device loses trust and cannot be silently re-added', () => {
  const inv = invite();
  const pending = prepareVerification({ invitation: inv, self: inviterSide, peer: joinerHello, role: 'INVITER' });
  confirmPairing({
    db, pending, invitation: inv,
    self: { deviceId: INVITER, agreementPrivateKey: inviterAgree.privateKey },
    now: NOW, seal, userConfirmed: true,
  });

  removeDevice({ db, deviceId: JOINER, now: NOW + 1, reason: 'lost phone' });
  assert.equal(repo.getActiveTrust(db, JOINER), undefined);

  // A fresh invitation is not enough: re-admitting must be deliberate.
  const second = createInvitation({
    db, familyId: FAMILY, familyName: 'Household', inviter: INVITER,
    inviterIdentityKey: inviterKey, now: NOW + 2, randomBytes: counterRandom(50),
  });
  const retry = prepareVerification({ invitation: second, self: inviterSide, peer: joinerHello, role: 'INVITER' });
  assert.throws(
    () =>
      confirmPairing({
        db, pending: retry, invitation: second,
        self: { deviceId: INVITER, agreementPrivateKey: inviterAgree.privateKey },
        now: NOW + 3, seal, userConfirmed: true,
      }),
    /removed from the family/,
  );
});

test('a failed confirmation leaves no partial trust behind', () => {
  const inv = invite();
  const pending = prepareVerification({ invitation: inv, self: inviterSide, peer: joinerHello, role: 'INVITER' });
  repo.revokeDevice(db, { deviceId: JOINER, now: NOW, reason: 'x' });
  assert.throws(() =>
    confirmPairing({
      db, pending, invitation: inv,
      self: { deviceId: INVITER, agreementPrivateKey: inviterAgree.privateKey },
      now: NOW, seal, userConfirmed: true,
    }),
  );
  assert.equal(repo.getDevice(db, JOINER), undefined, 'the device row must not survive the rollback');
});
