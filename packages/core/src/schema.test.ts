import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { Db, MigrationError, migrate, transaction } from './database';
import { NodeDb } from './nodeDb';
import { MIGRATIONS, SCHEMA_VERSION } from './schema';

let db: Db;

beforeEach(() => {
  db = new NodeDb();
  migrate(db);
});

function seedSelf(id = 'a'.repeat(32)): string {
  db.run(
    `INSERT INTO device (device_id, identity_public_key, display_name, is_self, key_security_level, first_seen_at)
     VALUES (?, ?, 'me', 1, 'TEE', 1)`,
    [id, new Uint8Array([1, 2, 3])],
  );
  return id;
}

function seedPeer(id: string): string {
  db.run(
    `INSERT INTO device (device_id, identity_public_key, display_name, is_self, first_seen_at)
     VALUES (?, ?, 'peer', 0, 1)`,
    [id, new Uint8Array([4, 5, 6])],
  );
  return id;
}

function seedFamily(owner: string, familyId = 'fam1'): string {
  db.run(
    `INSERT INTO family (family_id, name, created_at, created_by) VALUES (?, 'Household', 1, ?)`,
    [familyId, owner],
  );
  return familyId;
}

test('migration reaches the expected version', () => {
  const row = db.get<{ user_version: number }>('PRAGMA user_version');
  assert.equal(row?.user_version, SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, MIGRATIONS.length);
});

test('migrating an already-current database is a no-op', () => {
  assert.equal(migrate(db), SCHEMA_VERSION);
  assert.equal(migrate(db), SCHEMA_VERSION);
});

test('refuses to run against a database written by a newer build', () => {
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 5}`);
  assert.throws(() => migrate(db), MigrationError);
});

test('a failed migration rolls back and leaves the version where it was', () => {
  const fresh = new NodeDb();
  assert.throws(
    () => migrate(fresh, ['CREATE TABLE ok (a INTEGER); THIS IS NOT SQL;']),
    MigrationError,
  );
  assert.equal(
    fresh.get<{ user_version: number }>('PRAGMA user_version')?.user_version,
    0,
    'a partial upgrade reporting success is worse than a failed one',
  );
  assert.equal(
    fresh.get<unknown>(`SELECT name FROM sqlite_master WHERE name = 'ok'`),
    undefined,
    'the rolled-back migration must leave no tables behind',
  );
  fresh.close();
});

test('a later migration applies on top of an earlier one', () => {
  const fresh = new NodeDb();
  assert.equal(migrate(fresh, ['CREATE TABLE a (x INTEGER)']), 1);
  assert.equal(migrate(fresh, ['CREATE TABLE a (x INTEGER)', 'CREATE TABLE b (y INTEGER)']), 2);
  assert.ok(fresh.get<unknown>(`SELECT name FROM sqlite_master WHERE name = 'b'`));
  fresh.close();
});

test('only one device can be self', () => {
  seedSelf();
  assert.throws(
    () => seedSelf('b'.repeat(32)),
    /UNIQUE/i,
    'a second identity would make "who am I" ambiguous',
  );
});

test('many peers are allowed alongside one self', () => {
  seedSelf();
  seedPeer('b'.repeat(32));
  seedPeer('c'.repeat(32));
  const row = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM device');
  assert.equal(row?.n, 3);
});

test('foreign keys are enforced', () => {
  assert.throws(
    () =>
      db.run(
        `INSERT INTO family (family_id, name, created_at, created_by) VALUES ('f', 'x', 1, 'nobody')`,
      ),
    /FOREIGN KEY/i,
    'SQLite defaults foreign keys off; unenforced references would orphan trust records',
  );
});

test('message state cannot be anything outside the closed set', () => {
  const self = seedSelf();
  const peer = seedPeer('b'.repeat(32));
  const fam = seedFamily(self);
  db.run(
    `INSERT INTO conversation (conversation_id, family_id, peer_device_id, created_at, last_activity_at)
     VALUES ('c1', ?, ?, 1, 1)`,
    [fam, peer],
  );

  const insert = (state: string) =>
    db.run(
      `INSERT INTO message (message_id, conversation_id, from_device, to_device, seq, kind, body, direction, state, created_at, updated_at)
       VALUES (?, 'c1', ?, ?, 0, 'TEXT', 'hi', 'OUT', ?, 1, 1)`,
      [`m-${state}`, self, peer, state],
    );

  for (const ok of ['QUEUED', 'SENDING', 'DELIVERED', 'REJECTED']) {
    insert(ok);
  }
  // The phase prompt forbids an ambiguous outcome, so the schema must refuse
  // one rather than rely on callers never writing it.
  for (const bad of ['SENT_MAYBE', 'UNKNOWN', 'PENDING', '']) {
    assert.throws(() => insert(bad), /CHECK/i, `state ${JSON.stringify(bad)} must be refused`);
  }
});

test('a duplicate message id cannot be processed twice', () => {
  db.run(`INSERT INTO processed_message (message_id, from_device, processed_at) VALUES ('m1', 'd', 1)`);
  assert.throws(
    () =>
      db.run(
        `INSERT INTO processed_message (message_id, from_device, processed_at) VALUES ('m1', 'd', 2)`,
      ),
    /UNIQUE|PRIMARY/i,
  );
  // The real call site uses INSERT OR IGNORE and treats "no row inserted" as
  // "already handled", which is what makes replay handling idempotent.
  db.run(
    `INSERT OR IGNORE INTO processed_message (message_id, from_device, processed_at) VALUES ('m1', 'd', 3)`,
  );
  const row = db.get<{ processed_at: number }>(
    `SELECT processed_at FROM processed_message WHERE message_id = 'm1'`,
  );
  assert.equal(row?.processed_at, 1, 'the first processing must win');
});

test('revocation outlives deletion of the device row', () => {
  const self = seedSelf();
  const peer = seedPeer('b'.repeat(32));
  const fam = seedFamily(self);
  db.run(
    `INSERT INTO trust_record (device_id, family_id, session_key_sealed, sas, verified_at, status)
     VALUES (?, ?, ?, '123456', 1, 'ACTIVE')`,
    [peer, fam, new Uint8Array([9])],
  );
  db.run(`INSERT INTO revoked_device (device_id, revoked_at, reason) VALUES (?, 2, 'removed')`, [
    peer,
  ]);
  db.run(`DELETE FROM device WHERE device_id = ?`, [peer]);

  assert.equal(
    db.get<unknown>(`SELECT device_id FROM trust_record WHERE device_id = ?`, [peer]),
    undefined,
    'trust must cascade away with the device',
  );
  assert.ok(
    db.get<unknown>(`SELECT device_id FROM revoked_device WHERE device_id = ?`, [peer]),
    'revocation must survive, or a removed device could be re-trusted by reappearing',
  );
});

test('an invitation nonce cannot be reused', () => {
  const self = seedSelf();
  const fam = seedFamily(self);
  db.run(
    `INSERT INTO invitation (nonce, family_id, created_at, expires_at) VALUES ('n1', ?, 1, 2)`,
    [fam],
  );
  assert.throws(
    () =>
      db.run(
        `INSERT INTO invitation (nonce, family_id, created_at, expires_at) VALUES ('n1', ?, 1, 2)`,
        [fam],
      ),
    /UNIQUE|PRIMARY/i,
  );
});

test('safety events keep both the reporter clock and ours', () => {
  const self = seedSelf();
  const fam = seedFamily(self);
  db.run(
    `INSERT INTO safety_event (event_id, family_id, device_id, status, seq, reported_at, received_at)
     VALUES ('e1', ?, ?, 'SAFE', 0, 999999, 1)`,
    [fam, self],
  );
  const row = db.get<{ reported_at: number; received_at: number }>(
    `SELECT reported_at, received_at FROM safety_event WHERE event_id = 'e1'`,
  );
  // They disagree here on purpose: a wrong reporter clock must be recorded as
  // what it claimed, not silently corrected into something we then trust.
  assert.equal(row?.reported_at, 999999);
  assert.equal(row?.received_at, 1);
});

test('safety status is a closed set', () => {
  const self = seedSelf();
  const fam = seedFamily(self);
  for (const ok of ['SOS', 'SAFE', 'NEEDS_ASSISTANCE', 'EMERGENCY']) {
    db.run(
      `INSERT INTO safety_event (event_id, family_id, device_id, status, seq, reported_at, received_at)
       VALUES (?, ?, ?, ?, 0, 1, 1)`,
      [`e-${ok}`, fam, self, ok],
    );
  }
  assert.throws(
    () =>
      db.run(
        `INSERT INTO safety_event (event_id, family_id, device_id, status, seq, reported_at, received_at)
         VALUES ('bad', ?, ?, 'PROBABLY_FINE', 0, 1, 1)`,
        [fam, self],
      ),
    /CHECK/i,
  );
});

test('deleting a message takes its outbox row with it', () => {
  const self = seedSelf();
  const peer = seedPeer('b'.repeat(32));
  const fam = seedFamily(self);
  db.run(
    `INSERT INTO conversation (conversation_id, family_id, peer_device_id, created_at, last_activity_at)
     VALUES ('c1', ?, ?, 1, 1)`,
    [fam, peer],
  );
  db.run(
    `INSERT INTO message (message_id, conversation_id, from_device, to_device, seq, kind, body, direction, state, created_at, updated_at)
     VALUES ('m1', 'c1', ?, ?, 0, 'TEXT', 'hi', 'OUT', 'QUEUED', 1, 1)`,
    [self, peer],
  );
  db.run(`INSERT INTO outbox (message_id, frame, next_attempt_at) VALUES ('m1', ?, 1)`, [
    new Uint8Array([1]),
  ]);
  db.run(`DELETE FROM message WHERE message_id = 'm1'`);
  assert.equal(
    db.get<unknown>(`SELECT message_id FROM outbox WHERE message_id = 'm1'`),
    undefined,
    'an outbox row with no message would be sent forever with nothing to update',
  );
});

test('transaction rolls back every statement on failure', () => {
  const self = seedSelf();
  const fam = seedFamily(self);
  assert.throws(() =>
    transaction(db, () => {
      db.run(
        `INSERT INTO invitation (nonce, family_id, created_at, expires_at) VALUES ('n9', ?, 1, 2)`,
        [fam],
      );
      throw new Error('boom');
    }),
  );
  assert.equal(
    db.get<unknown>(`SELECT nonce FROM invitation WHERE nonce = 'n9'`),
    undefined,
    'a message persisted without its outbox row would never be sent and never report why',
  );
});

test('transaction commits on success', () => {
  const self = seedSelf();
  const fam = seedFamily(self);
  transaction(db, () => {
    db.run(
      `INSERT INTO invitation (nonce, family_id, created_at, expires_at) VALUES ('n8', ?, 1, 2)`,
      [fam],
    );
  });
  assert.ok(db.get<unknown>(`SELECT nonce FROM invitation WHERE nonce = 'n8'`));
});
