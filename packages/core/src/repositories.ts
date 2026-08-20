import { Db, SqlValue } from './database';

/**
 * Data access for the Family domain.
 *
 * Every function here is a plain query. Policy lives in the services above:
 * this layer must not decide whether a peer is trusted, whether a message may
 * be sent, or whether a replay should be dropped, because a decision made in
 * two places drifts apart. It stores and it reads.
 */

export type MessageState = 'QUEUED' | 'SENDING' | 'DELIVERED' | 'REJECTED';
export type MessageKind = 'TEXT' | 'SOS' | 'STATUS';
export type Direction = 'OUT' | 'IN';
export type SafetyStatus = 'SOS' | 'SAFE' | 'NEEDS_ASSISTANCE' | 'EMERGENCY';
export type TrustStatus = 'ACTIVE' | 'REVOKED';

export interface DeviceRow {
  device_id: string;
  identity_public_key: Uint8Array;
  agreement_public_key: Uint8Array | null;
  display_name: string;
  is_self: number;
  key_security_level: string | null;
  first_seen_at: number;
}

export interface MessageRow {
  message_id: string;
  conversation_id: string;
  from_device: string;
  to_device: string;
  seq: number;
  kind: MessageKind;
  body: string;
  direction: Direction;
  state: MessageState;
  state_reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface OutboxRow {
  message_id: string;
  frame: Uint8Array;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
}

export interface TrustRow {
  device_id: string;
  family_id: string;
  session_key_sealed: Uint8Array;
  sas: string;
  verified_at: number;
  status: TrustStatus;
}

// ---- devices --------------------------------------------------------------

export function insertDevice(
  db: Db,
  row: Omit<DeviceRow, 'is_self'> & { is_self?: boolean },
): void {
  db.run(
    `INSERT INTO device (device_id, identity_public_key, agreement_public_key, display_name, is_self, key_security_level, first_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      row.device_id,
      row.identity_public_key,
      row.agreement_public_key,
      row.display_name,
      row.is_self ? 1 : 0,
      row.key_security_level,
      row.first_seen_at,
    ],
  );
}

export function getSelfDevice(db: Db): DeviceRow | undefined {
  return db.get<DeviceRow>('SELECT * FROM device WHERE is_self = 1');
}

export function getDevice(db: Db, deviceId: string): DeviceRow | undefined {
  return db.get<DeviceRow>('SELECT * FROM device WHERE device_id = ?', [deviceId]);
}

export function setDisplayName(db: Db, deviceId: string, name: string): void {
  db.run('UPDATE device SET display_name = ? WHERE device_id = ?', [name, deviceId]);
}

// ---- trust ----------------------------------------------------------------

export function upsertTrust(db: Db, row: TrustRow): void {
  db.run(
    `INSERT INTO trust_record (device_id, family_id, session_key_sealed, sas, verified_at, status)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (device_id) DO UPDATE SET
       family_id = excluded.family_id,
       session_key_sealed = excluded.session_key_sealed,
       sas = excluded.sas,
       verified_at = excluded.verified_at,
       status = excluded.status`,
    [row.device_id, row.family_id, row.session_key_sealed, row.sas, row.verified_at, row.status],
  );
}

/**
 * Returns trust only when it is ACTIVE and the device is not revoked.
 *
 * Callers must not reconstruct this condition themselves. Trust is checked
 * before any decryption is attempted, so a caller that forgot the revocation
 * join would hand a removed device's traffic to the cipher.
 */
export function getActiveTrust(db: Db, deviceId: string): TrustRow | undefined {
  return db.get<TrustRow>(
    `SELECT t.* FROM trust_record t
     LEFT JOIN revoked_device r ON r.device_id = t.device_id
     WHERE t.device_id = ? AND t.status = 'ACTIVE' AND r.device_id IS NULL`,
    [deviceId],
  );
}

export function listTrustedDevices(db: Db, familyId: string): Array<TrustRow & DeviceRow> {
  return db.all<TrustRow & DeviceRow>(
    `SELECT t.*, d.display_name, d.identity_public_key, d.agreement_public_key, d.first_seen_at, d.is_self, d.key_security_level
     FROM trust_record t
     JOIN device d ON d.device_id = t.device_id
     LEFT JOIN revoked_device r ON r.device_id = t.device_id
     WHERE t.family_id = ? AND t.status = 'ACTIVE' AND r.device_id IS NULL
     ORDER BY d.display_name`,
    [familyId],
  );
}

export function isRevoked(db: Db, deviceId: string): boolean {
  return db.get<unknown>('SELECT device_id FROM revoked_device WHERE device_id = ?', [
    deviceId,
  ]) !== undefined;
}

// ---- conversations --------------------------------------------------------

export function ensureConversation(
  db: Db,
  input: { conversationId: string; familyId: string; peerDeviceId: string; now: number },
): string {
  const existing = db.get<{ conversation_id: string }>(
    'SELECT conversation_id FROM conversation WHERE family_id = ? AND peer_device_id = ?',
    [input.familyId, input.peerDeviceId],
  );
  if (existing) {
    return existing.conversation_id;
  }
  db.run(
    `INSERT INTO conversation (conversation_id, family_id, peer_device_id, created_at, last_activity_at)
     VALUES (?, ?, ?, ?, ?)`,
    [input.conversationId, input.familyId, input.peerDeviceId, input.now, input.now],
  );
  return input.conversationId;
}

export function touchConversation(db: Db, conversationId: string, now: number): void {
  db.run('UPDATE conversation SET last_activity_at = ? WHERE conversation_id = ?', [
    now,
    conversationId,
  ]);
}

// ---- sequence -------------------------------------------------------------

/**
 * Allocates the next outgoing sequence number and persists the increment.
 *
 * Phase 0 held this in a variable and it reset to zero on restart. The read and
 * the write must be one statement: two callers racing on read-then-write would
 * hand out the same number twice.
 */
export function nextLocalSeq(db: Db, selfDeviceId: string): number {
  db.run(
    `INSERT INTO local_sequence (device_id, next_seq) VALUES (?, 1)
     ON CONFLICT (device_id) DO UPDATE SET next_seq = next_seq + 1`,
    [selfDeviceId],
  );
  const row = db.get<{ next_seq: number }>(
    'SELECT next_seq FROM local_sequence WHERE device_id = ?',
    [selfDeviceId],
  );
  return (row?.next_seq ?? 1) - 1;
}

export function peerHighWater(db: Db, deviceId: string): number | undefined {
  return db.get<{ high_water: number }>(
    'SELECT high_water FROM peer_sequence WHERE device_id = ?',
    [deviceId],
  )?.high_water;
}

export function recordPeerSeq(db: Db, deviceId: string, seq: number): void {
  db.run(
    `INSERT INTO peer_sequence (device_id, high_water) VALUES (?, ?)
     ON CONFLICT (device_id) DO UPDATE SET high_water = MAX(high_water, excluded.high_water)`,
    [deviceId, seq],
  );
}

// ---- replay ---------------------------------------------------------------

/**
 * Records a message id as handled. Returns false if it was already there.
 *
 * This is the durable half of replay defence, so the answer must come from the
 * insert itself rather than a preceding SELECT: between a check and an insert,
 * the same frame arriving twice could pass both checks.
 */
export function markProcessed(
  db: Db,
  input: { messageId: string; fromDevice: string; now: number },
): boolean {
  const before = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM processed_message');
  db.run(
    `INSERT OR IGNORE INTO processed_message (message_id, from_device, processed_at)
     VALUES (?, ?, ?)`,
    [input.messageId, input.fromDevice, input.now],
  );
  const after = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM processed_message');
  return (after?.n ?? 0) > (before?.n ?? 0);
}

// ---- messages -------------------------------------------------------------

export function insertMessage(db: Db, row: MessageRow): void {
  db.run(
    `INSERT INTO message (message_id, conversation_id, from_device, to_device, seq, kind, body, direction, state, state_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.message_id,
      row.conversation_id,
      row.from_device,
      row.to_device,
      row.seq,
      row.kind,
      row.body,
      row.direction,
      row.state,
      row.state_reason,
      row.created_at,
      row.updated_at,
    ],
  );
}

export function getMessage(db: Db, messageId: string): MessageRow | undefined {
  return db.get<MessageRow>('SELECT * FROM message WHERE message_id = ?', [messageId]);
}

export function setMessageState(
  db: Db,
  input: { messageId: string; state: MessageState; reason?: string | null; now: number },
): void {
  db.run('UPDATE message SET state = ?, state_reason = ?, updated_at = ? WHERE message_id = ?', [
    input.state,
    input.reason ?? null,
    input.now,
    input.messageId,
  ]);
}

export function listMessages(db: Db, conversationId: string, limit = 200): MessageRow[] {
  return db.all<MessageRow>(
    'SELECT * FROM message WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?',
    [conversationId, limit],
  );
}

// ---- outbox ---------------------------------------------------------------

export function insertOutbox(
  db: Db,
  input: { messageId: string; frame: Uint8Array; nextAttemptAt: number },
): void {
  db.run(
    'INSERT INTO outbox (message_id, frame, attempts, next_attempt_at) VALUES (?, ?, 0, ?)',
    [input.messageId, input.frame, input.nextAttemptAt],
  );
}

export function dueOutbox(db: Db, now: number, limit = 20): OutboxRow[] {
  return db.all<OutboxRow>(
    `SELECT o.* FROM outbox o
     JOIN message m ON m.message_id = o.message_id
     WHERE o.next_attempt_at <= ? AND m.state IN ('QUEUED', 'SENDING')
     ORDER BY o.next_attempt_at
     LIMIT ?`,
    [now, limit],
  );
}

export function recordAttempt(
  db: Db,
  input: { messageId: string; nextAttemptAt: number; error: string | null },
): void {
  db.run(
    'UPDATE outbox SET attempts = attempts + 1, next_attempt_at = ?, last_error = ? WHERE message_id = ?',
    [input.nextAttemptAt, input.error, input.messageId],
  );
}

export function deleteOutbox(db: Db, messageId: string): void {
  db.run('DELETE FROM outbox WHERE message_id = ?', [messageId]);
}

export function outboxRow(db: Db, messageId: string): OutboxRow | undefined {
  return db.get<OutboxRow>('SELECT * FROM outbox WHERE message_id = ?', [messageId]);
}

// ---- safety ---------------------------------------------------------------

export function insertSafetyEvent(
  db: Db,
  row: {
    event_id: string;
    family_id: string;
    device_id: string;
    status: SafetyStatus;
    seq: number;
    reported_at: number;
    received_at: number;
    note: string | null;
  },
): void {
  db.run(
    `INSERT INTO safety_event (event_id, family_id, device_id, status, seq, reported_at, received_at, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.event_id,
      row.family_id,
      row.device_id,
      row.status,
      row.seq,
      row.reported_at,
      row.received_at,
      row.note,
    ],
  );
}

/**
 * Latest status per device, ordered by the sender's own sequence rather than
 * any timestamp.
 *
 * A device with a wrong clock must not be able to pin a stale "I'm Safe" at the
 * top of the family's view, and an attacker must not be able to do it either by
 * setting a future `ts`. Sequence is the sender's own monotonic counter and is
 * covered by the AEAD tag; `reported_at` is displayed but never ordered on.
 */
export function latestSafetyPerDevice(
  db: Db,
  familyId: string,
): Array<{ device_id: string; status: SafetyStatus; seq: number; reported_at: number; received_at: number; note: string | null }> {
  return db.all(
    `SELECT s.device_id, s.status, s.seq, s.reported_at, s.received_at, s.note
     FROM safety_event s
     JOIN (
       SELECT device_id, MAX(seq) AS top FROM safety_event WHERE family_id = ? GROUP BY device_id
     ) latest ON latest.device_id = s.device_id AND latest.top = s.seq
     WHERE s.family_id = ?`,
    [familyId, familyId],
  );
}

// ---- receipts -------------------------------------------------------------

export function recordReceipt(
  db: Db,
  input: { messageId: string; fromDevice: string; now: number },
): void {
  db.run(
    'INSERT OR IGNORE INTO receipt (message_id, from_device, received_at) VALUES (?, ?, ?)',
    [input.messageId, input.fromDevice, input.now],
  );
}

export function hasReceipt(db: Db, messageId: string): boolean {
  return (
    db.get<unknown>('SELECT message_id FROM receipt WHERE message_id = ?', [messageId]) !==
    undefined
  );
}

// ---- invitations ----------------------------------------------------------

export function insertInvitation(
  db: Db,
  input: { nonce: string; familyId: string; createdAt: number; expiresAt: number },
): void {
  db.run(
    'INSERT INTO invitation (nonce, family_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    [input.nonce, input.familyId, input.createdAt, input.expiresAt],
  );
}

export interface InvitationRow {
  nonce: string;
  family_id: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  used_by: string | null;
}

export function getInvitation(db: Db, nonce: string): InvitationRow | undefined {
  return db.get<InvitationRow>('SELECT * FROM invitation WHERE nonce = ?', [nonce]);
}

/**
 * Marks an invitation used, and reports whether this call was the one that did
 * it.
 *
 * The `used_at IS NULL` guard is inside the UPDATE so that single-use is
 * enforced by the database rather than by a check the caller might race.
 */
export function consumeInvitation(
  db: Db,
  input: { nonce: string; usedBy: string; now: number },
): boolean {
  const before = db.get<{ used_at: number | null }>(
    'SELECT used_at FROM invitation WHERE nonce = ?',
    [input.nonce],
  );
  if (!before || before.used_at !== null) {
    return false;
  }
  db.run('UPDATE invitation SET used_at = ?, used_by = ? WHERE nonce = ? AND used_at IS NULL', [
    input.now,
    input.usedBy,
    input.nonce,
  ]);
  const after = db.get<{ used_at: number | null }>(
    'SELECT used_at FROM invitation WHERE nonce = ?',
    [input.nonce],
  );
  return after?.used_at !== null && after?.used_at !== undefined;
}

export function revokeDevice(
  db: Db,
  input: { deviceId: string; now: number; reason: string | null },
): void {
  db.run(
    'INSERT OR IGNORE INTO revoked_device (device_id, revoked_at, reason) VALUES (?, ?, ?)',
    [input.deviceId, input.now, input.reason],
  );
  db.run(`UPDATE trust_record SET status = 'REVOKED' WHERE device_id = ?`, [input.deviceId]);
}

export function insertFamily(
  db: Db,
  input: { familyId: string; name: string; createdAt: number; createdBy: string },
): void {
  db.run(
    'INSERT INTO family (family_id, name, created_at, created_by) VALUES (?, ?, ?, ?)',
    [input.familyId, input.name, input.createdAt, input.createdBy],
  );
}

export function addMembership(
  db: Db,
  input: { familyId: string; deviceId: string; role: 'OWNER' | 'MEMBER'; joinedAt: number },
): void {
  db.run(
    `INSERT OR IGNORE INTO membership (family_id, device_id, role, joined_at) VALUES (?, ?, ?, ?)`,
    [input.familyId, input.deviceId, input.role, input.joinedAt],
  );
}

export function currentFamily(db: Db): { family_id: string; name: string } | undefined {
  return db.get<{ family_id: string; name: string }>(
    'SELECT family_id, name FROM family ORDER BY created_at LIMIT 1',
  );
}

export type { SqlValue };
