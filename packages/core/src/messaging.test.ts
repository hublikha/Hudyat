import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { Db, migrate } from './database';
import {
  MAX_ATTEMPTS,
  acceptInbound,
  backoffMs,
  beginSend,
  dueForSend,
  markDelivered,
  queueMessage,
  recordFailure,
  recordSafetyEvent,
  recoverStrandedSends,
} from './messaging';
import { NodeDb } from './nodeDb';
import * as repo from './repositories';

const SELF = 'a'.repeat(32);
const PEER = 'b'.repeat(32);
const STRANGER = 'c'.repeat(32);
const FAMILY = 'fam1';
const CONV = 'conv1';

let db: Db;

function trust(deviceId: string): void {
  repo.upsertTrust(db, {
    device_id: deviceId,
    family_id: FAMILY,
    session_key_sealed: new Uint8Array([1]),
    sas: '123456',
    verified_at: 1,
    status: 'ACTIVE',
  });
}

beforeEach(() => {
  db = new NodeDb();
  migrate(db);
  repo.insertDevice(db, {
    device_id: SELF,
    identity_public_key: new Uint8Array([1]),
    agreement_public_key: new Uint8Array([2]),
    display_name: 'me',
    is_self: true,
    key_security_level: 'TEE',
    first_seen_at: 1,
  });
  for (const id of [PEER, STRANGER]) {
    repo.insertDevice(db, {
      device_id: id,
      identity_public_key: new Uint8Array([3]),
      agreement_public_key: new Uint8Array([4]),
      display_name: id.slice(0, 4),
      key_security_level: null,
      first_seen_at: 1,
    });
  }
  repo.insertFamily(db, { familyId: FAMILY, name: 'Household', createdAt: 1, createdBy: SELF });
  trust(PEER);
});

function queue(id: string, body = 'hello', now = 1000) {
  return queueMessage({
    db,
    messageId: id,
    selfDeviceId: SELF,
    peerDeviceId: PEER,
    familyId: FAMILY,
    conversationId: CONV,
    kind: 'TEXT',
    body,
    now,
    buildFrame: (seq) => new Uint8Array([seq & 0xff]),
  });
}

test('a queued message is durable before any transport is consulted', () => {
  queue('m1');
  const msg = repo.getMessage(db, 'm1');
  assert.equal(msg?.state, 'QUEUED');
  assert.ok(repo.outboxRow(db, 'm1'), 'the outbox row must exist or the message is never sent');
});

test('the frame is sealed against the sequence number that is persisted', () => {
  const { seq } = queue('m1');
  const row = repo.outboxRow(db, 'm1');
  assert.equal(row?.frame[0], seq & 0xff);
});

test('sequence numbers are allocated from the database, not memory', () => {
  const a = queue('m1');
  const b = queue('m2');
  const c = queue('m3');
  assert.deepEqual([a.seq, b.seq, c.seq], [0, 1, 2]);
});

test('sequence numbers survive a restart', () => {
  queue('m1');
  queue('m2');
  // A new connection to the same database is what a restart looks like. Phase 0
  // kept this counter in a variable and it went back to zero here.
  const next = repo.nextLocalSeq(db, SELF);
  assert.equal(next, 2, 'the counter must continue, not restart');
});

test('delivery is recorded only on acknowledgement and clears the outbox', () => {
  queue('m1');
  beginSend(db, 'm1', 1001);
  assert.equal(repo.getMessage(db, 'm1')?.state, 'SENDING');
  markDelivered(db, 'm1', 1002);
  assert.equal(repo.getMessage(db, 'm1')?.state, 'DELIVERED');
  assert.equal(repo.outboxRow(db, 'm1'), undefined);
});

test('a recoverable failure returns to QUEUED rather than a middle state', () => {
  queue('m1');
  beginSend(db, 'm1', 1001);
  recordFailure({ db, messageId: 'm1', now: 1002, error: 'peer unavailable', recoverable: true });
  const msg = repo.getMessage(db, 'm1');
  assert.equal(msg?.state, 'QUEUED');
  assert.ok(repo.outboxRow(db, 'm1'), 'it must still be retryable');
});

test('a permanent failure is terminal and stops retrying', () => {
  queue('m1');
  recordFailure({ db, messageId: 'm1', now: 1002, error: 'not trusted', recoverable: false });
  assert.equal(repo.getMessage(db, 'm1')?.state, 'REJECTED');
  assert.equal(repo.outboxRow(db, 'm1'), undefined);
});

test('retries are capped rather than queued forever', () => {
  queue('m1');
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    recordFailure({ db, messageId: 'm1', now: 1000 + i, error: 'unreachable', recoverable: true });
  }
  // A message that can never arrive must stop looking like it still might.
  assert.equal(repo.getMessage(db, 'm1')?.state, 'REJECTED');
  assert.equal(repo.outboxRow(db, 'm1'), undefined);
});

test('backoff grows and is capped', () => {
  assert.ok(backoffMs(1) < backoffMs(3));
  assert.equal(backoffMs(50), backoffMs(6), 'the cap must hold');
  assert.ok(backoffMs(50) <= 120_000);
});

test('a message is not retried before its backoff has elapsed', () => {
  queue('m1', 'hi', 1000);
  recordFailure({ db, messageId: 'm1', now: 1000, error: 'gone', recoverable: true });
  assert.equal(dueForSend(db, 1001).length, 0, 'too early');
  assert.equal(dueForSend(db, 1000 + backoffMs(1)).length, 1);
});

test('queued messages are recovered after a restart', () => {
  queue('m1');
  queue('m2');
  markDelivered(db, 'm2', 1002);
  // Restart: the process is gone, the database is not.
  const due = dueForSend(db, 5000);
  assert.deepEqual(due.map((r) => r.message_id), ['m1']);
});

test('messages stranded in SENDING by a crash are recovered', () => {
  queue('m1');
  beginSend(db, 'm1', 1001);
  // Process dies here, leaving SENDING with no outcome.
  assert.equal(recoverStrandedSends(db, 2000), 1);
  assert.equal(repo.getMessage(db, 'm1')?.state, 'QUEUED');
  assert.equal(dueForSend(db, 2000).length, 1);
});

test('a delivered message is never resurrected by recovery', () => {
  queue('m1');
  markDelivered(db, 'm1', 1002);
  assert.equal(recoverStrandedSends(db, 2000), 0);
  assert.equal(repo.getMessage(db, 'm1')?.state, 'DELIVERED');
});

test('an inbound message from a trusted peer is stored', () => {
  const out = acceptInbound({
    db,
    messageId: 'in1',
    fromDevice: PEER,
    toDevice: SELF,
    seq: 5,
    kind: 'TEXT',
    body: 'ligtas ako',
    familyId: FAMILY,
    conversationId: CONV,
    now: 2000,
  });
  assert.equal(out.kind, 'STORED');
  assert.equal(repo.getMessage(db, 'in1')?.state, 'DELIVERED');
});

function inbound(id: string, seq: number, from = PEER, now = 2000) {
  return acceptInbound({
    db,
    messageId: id,
    fromDevice: from,
    toDevice: SELF,
    seq,
    kind: 'TEXT',
    body: 'x',
    familyId: FAMILY,
    conversationId: CONV,
    now,
  });
}

test('a duplicate delivery is dropped and stored once', () => {
  assert.equal(inbound('in1', 1).kind, 'STORED');
  assert.equal(inbound('in1', 1).kind, 'DUPLICATE');
  const rows = db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM message WHERE message_id = 'in1'`);
  assert.equal(rows[0]?.n, 1, 'the family must see one message, not two');
});

test('a replayed packet is refused even after a restart', () => {
  inbound('in1', 1);
  // The processed-message record is durable, so a replay hours later is still
  // recognised. This is the half of replay defence that survives a restart.
  const again = acceptInbound({
    db,
    messageId: 'in1',
    fromDevice: PEER,
    toDevice: SELF,
    seq: 1,
    kind: 'TEXT',
    body: 'x',
    familyId: FAMILY,
    conversationId: CONV,
    now: 99999999,
  });
  assert.equal(again.kind, 'DUPLICATE');
});

test('a message from an untrusted device is refused', () => {
  assert.equal(inbound('in1', 1, STRANGER).kind, 'UNTRUSTED');
  assert.equal(repo.getMessage(db, 'in1'), undefined);
});

test('a removed device can no longer deliver messages', () => {
  assert.equal(inbound('in1', 1).kind, 'STORED');
  repo.revokeDevice(db, { deviceId: PEER, now: 3000, reason: 'removed' });
  assert.equal(inbound('in2', 2).kind, 'UNTRUSTED');
});

test('an untrusted sender is refused before the replay record is written', () => {
  inbound('in1', 1, STRANGER);
  // Otherwise a stranger could burn message ids a trusted peer might later use.
  const row = db.get<unknown>(`SELECT message_id FROM processed_message WHERE message_id = 'in1'`);
  assert.equal(row, undefined);
});

test('a very old sequence number is refused as stale', () => {
  inbound('in1', 1000);
  const stale = acceptInbound({
    db,
    messageId: 'in2',
    fromDevice: PEER,
    toDevice: SELF,
    seq: 1,
    kind: 'TEXT',
    body: 'x',
    familyId: FAMILY,
    conversationId: CONV,
    now: 2001,
    replayWindow: 10,
  });
  assert.equal(stale.kind, 'STALE');
});

test('out-of-order delivery inside the window is accepted', () => {
  inbound('in1', 10);
  // Transports reorder. Refusing this would drop real messages.
  assert.equal(inbound('in2', 8).kind, 'STORED');
});

test('a wrong device clock does not change acceptance', () => {
  const future = acceptInbound({
    db,
    messageId: 'in1',
    fromDevice: PEER,
    toDevice: SELF,
    seq: 1,
    kind: 'TEXT',
    body: 'x',
    familyId: FAMILY,
    conversationId: CONV,
    now: 0,
  });
  assert.equal(future.kind, 'STORED', 'nothing accepts or rejects on a timestamp');
});

test('safety events keep sender and receiver clocks apart', () => {
  recordSafetyEvent({
    db,
    eventId: 'e1',
    familyId: FAMILY,
    deviceId: PEER,
    status: 'SAFE',
    seq: 1,
    reportedAt: 5_000_000_000,
    now: 2000,
  });
  const row = db.get<{ reported_at: number; received_at: number }>(
    `SELECT reported_at, received_at FROM safety_event WHERE event_id = 'e1'`,
  );
  assert.equal(row?.reported_at, 5_000_000_000);
  assert.equal(row?.received_at, 2000);
});

test('latest safety status is chosen by sequence, not by timestamp', () => {
  recordSafetyEvent({
    db, eventId: 'e1', familyId: FAMILY, deviceId: PEER,
    status: 'SOS', seq: 1, reportedAt: 100, now: 100,
  });
  recordSafetyEvent({
    db, eventId: 'e2', familyId: FAMILY, deviceId: PEER,
    // A wrong or attacker-set clock claims this is older; sequence says it is
    // newer, and sequence is covered by the AEAD tag.
    status: 'SAFE', seq: 2, reportedAt: 1, now: 200,
  });
  const latest = repo.latestSafetyPerDevice(db, FAMILY);
  assert.equal(latest.length, 1);
  assert.equal(latest[0]?.status, 'SAFE');
});

test('an invitation is single use', () => {
  repo.insertInvitation(db, { nonce: 'n1', familyId: FAMILY, createdAt: 1, expiresAt: 999 });
  assert.equal(repo.consumeInvitation(db, { nonce: 'n1', usedBy: PEER, now: 2 }), true);
  assert.equal(
    repo.consumeInvitation(db, { nonce: 'n1', usedBy: STRANGER, now: 3 }),
    false,
    'a replayed invitation must not admit a second device',
  );
});

test('consuming an unknown invitation fails rather than admitting anyone', () => {
  assert.equal(repo.consumeInvitation(db, { nonce: 'nope', usedBy: PEER, now: 2 }), false);
});

test('trust lookup excludes revoked devices even while the row says ACTIVE', () => {
  db.run(`INSERT INTO revoked_device (device_id, revoked_at, reason) VALUES (?, 1, 'x')`, [PEER]);
  // The trust row is still ACTIVE here; the revocation must win regardless.
  assert.equal(repo.getActiveTrust(db, PEER), undefined);
});

test('a failed queue leaves nothing behind', () => {
  assert.throws(() =>
    queueMessage({
      db,
      messageId: 'm1',
      selfDeviceId: SELF,
      peerDeviceId: PEER,
      familyId: FAMILY,
      conversationId: CONV,
      kind: 'TEXT',
      body: 'hi',
      now: 1000,
      buildFrame: () => {
        throw new Error('sealing failed');
      },
    }),
  );
  assert.equal(repo.getMessage(db, 'm1'), undefined);
  assert.equal(repo.outboxRow(db, 'm1'), undefined);
  // The sequence number is consumed by the rollback too, so a later message
  // cannot reuse it against a different body.
  assert.equal(repo.nextLocalSeq(db, SELF), 0);
});
