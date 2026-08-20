/**
 * Durable schema for the Family domain.
 *
 * Migrations are append-only and are applied in order inside one transaction.
 * `PRAGMA user_version` records progress, so a half-applied upgrade cannot be
 * mistaken for a completed one.
 *
 * Two conventions worth stating because they are load-bearing rather than
 * stylistic:
 *
 * - Every timestamp is milliseconds since the epoch from the *local* clock, and
 *   is advisory. Nothing accepts, rejects, orders, or expires on the strength of
 *   a timestamp — ADR 0004 §5. Columns named `*_at` record what a clock said,
 *   not what is true.
 * - Message state is a closed set. There is deliberately no state meaning
 *   "possibly sent": the phase prompt forbids an ambiguous outcome, so a
 *   recoverable failure returns to QUEUED rather than inventing a middle.
 */

export const MIGRATIONS: readonly string[] = [
  // ---- v1: Family domain ------------------------------------------------
  `
  -- Every device we know of, including this one. Trust lives in trust_record;
  -- presence here means "seen", never "trusted".
  CREATE TABLE device (
    device_id            TEXT    PRIMARY KEY,
    identity_public_key  BLOB    NOT NULL,
    agreement_public_key BLOB,
    display_name         TEXT    NOT NULL DEFAULT '',
    is_self              INTEGER NOT NULL DEFAULT 0 CHECK (is_self IN (0, 1)),
    -- STRONGBOX | TEE | SOFTWARE. Self only. Surfaced in the UI so a weaker
    -- backing is disclosed rather than silent (ADR 0004 §2).
    key_security_level   TEXT,
    first_seen_at        INTEGER NOT NULL
  );

  -- At most one row may be self. A second identity would make "who am I"
  -- ambiguous, and every signature and session key derives from that answer.
  CREATE UNIQUE INDEX device_single_self ON device (is_self) WHERE is_self = 1;

  -- Sealed private material for this device. Split from device so the public
  -- table can be read, logged, or exported without touching secrets.
  CREATE TABLE self_secret (
    device_id                TEXT PRIMARY KEY REFERENCES device (device_id) ON DELETE CASCADE,
    agreement_private_sealed BLOB NOT NULL,
    keystore_alias           TEXT NOT NULL
  );

  CREATE TABLE family (
    family_id  TEXT    PRIMARY KEY,
    name       TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    created_by TEXT    NOT NULL REFERENCES device (device_id)
  );

  CREATE TABLE membership (
    family_id TEXT    NOT NULL REFERENCES family (family_id) ON DELETE CASCADE,
    device_id TEXT    NOT NULL REFERENCES device (device_id) ON DELETE CASCADE,
    role      TEXT    NOT NULL DEFAULT 'MEMBER' CHECK (role IN ('OWNER', 'MEMBER')),
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (family_id, device_id)
  );

  -- An ACTIVE row here is the only thing that authorises decrypting a peer's
  -- traffic. Discovery does not create rows; only completed verification does.
  CREATE TABLE trust_record (
    device_id          TEXT    PRIMARY KEY REFERENCES device (device_id) ON DELETE CASCADE,
    family_id          TEXT    NOT NULL REFERENCES family (family_id) ON DELETE CASCADE,
    session_key_sealed BLOB    NOT NULL,
    -- The 6 digits both users compared. Kept so it can be shown again.
    sas                TEXT    NOT NULL,
    verified_at        INTEGER NOT NULL,
    status             TEXT    NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED'))
  );

  -- Survives deletion of the device row, so a removed device cannot be
  -- re-trusted by simply reappearing (ADR 0004 §6).
  CREATE TABLE revoked_device (
    device_id  TEXT    PRIMARY KEY,
    revoked_at INTEGER NOT NULL,
    reason     TEXT
  );

  -- Expiry is enforced by the issuer, never the joiner, because the joiner's
  -- clock may be wrong or attacker-controlled (ADR 0004 §7).
  CREATE TABLE invitation (
    nonce      TEXT    PRIMARY KEY,
    family_id  TEXT    NOT NULL REFERENCES family (family_id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at    INTEGER,
    used_by    TEXT
  );

  CREATE TABLE conversation (
    conversation_id  TEXT    PRIMARY KEY,
    family_id        TEXT    NOT NULL REFERENCES family (family_id) ON DELETE CASCADE,
    peer_device_id   TEXT    NOT NULL REFERENCES device (device_id),
    created_at       INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL,
    UNIQUE (family_id, peer_device_id)
  );

  -- body is plaintext: this database is local, and the ciphertext exists only
  -- on the wire. Storage confidentiality is the device's job, and ADR 0004
  -- states plainly that a seized unlocked phone exposes its own history.
  CREATE TABLE message (
    message_id      TEXT    PRIMARY KEY,
    conversation_id TEXT    NOT NULL REFERENCES conversation (conversation_id) ON DELETE CASCADE,
    from_device     TEXT    NOT NULL,
    to_device       TEXT    NOT NULL,
    seq             INTEGER NOT NULL,
    kind            TEXT    NOT NULL CHECK (kind IN ('TEXT', 'SOS', 'STATUS')),
    body            TEXT    NOT NULL,
    direction       TEXT    NOT NULL CHECK (direction IN ('OUT', 'IN')),
    -- No "maybe sent". A recoverable transport failure returns to QUEUED.
    state           TEXT    NOT NULL CHECK (state IN ('QUEUED', 'SENDING', 'DELIVERED', 'REJECTED')),
    state_reason    TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  );

  CREATE INDEX message_by_conversation ON message (conversation_id, created_at);
  CREATE INDEX message_by_state ON message (state) WHERE state IN ('QUEUED', 'SENDING');

  -- The frame is built and stored before any transport is consulted, so no
  -- routing decision can affect whether a message survives.
  CREATE TABLE outbox (
    message_id      TEXT    PRIMARY KEY REFERENCES message (message_id) ON DELETE CASCADE,
    frame           BLOB    NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    last_error      TEXT
  );

  CREATE INDEX outbox_due ON outbox (next_attempt_at);

  CREATE TABLE receipt (
    message_id  TEXT    PRIMARY KEY,
    from_device TEXT    NOT NULL,
    received_at INTEGER NOT NULL
  );

  -- reported_at is the reporter's clock and received_at is ours. Both are kept
  -- because they disagree in exactly the cases that matter, and "I'm Safe" is a
  -- timestamped report rather than a standing fact.
  CREATE TABLE safety_event (
    event_id    TEXT    PRIMARY KEY,
    family_id   TEXT    NOT NULL REFERENCES family (family_id) ON DELETE CASCADE,
    device_id   TEXT    NOT NULL,
    status      TEXT    NOT NULL CHECK (status IN ('SOS', 'SAFE', 'NEEDS_ASSISTANCE', 'EMERGENCY')),
    seq         INTEGER NOT NULL,
    reported_at INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    note        TEXT
  );

  CREATE INDEX safety_event_by_device ON safety_event (device_id, seq);

  -- The durable half of replay defence. A message id seen before is dropped
  -- however it arrives, and this survives restart (ADR 0004 §5).
  CREATE TABLE processed_message (
    message_id   TEXT    PRIMARY KEY,
    from_device  TEXT    NOT NULL,
    processed_at INTEGER NOT NULL
  );

  CREATE TABLE peer_sequence (
    device_id  TEXT    PRIMARY KEY,
    high_water INTEGER NOT NULL
  );

  -- Persisted because Phase 0 held this in memory and it reset to zero on
  -- restart. With a durable outbox that reset breaks duplicate suppression.
  CREATE TABLE local_sequence (
    device_id TEXT    PRIMARY KEY REFERENCES device (device_id) ON DELETE CASCADE,
    next_seq  INTEGER NOT NULL
  );
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;
