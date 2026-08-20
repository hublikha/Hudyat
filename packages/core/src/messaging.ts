import { Db, transaction } from './database';
import * as repo from './repositories';
import { MessageKind, MessageRow, SafetyStatus } from './repositories';

/**
 * Message lifecycle.
 *
 * The states are exactly QUEUED, SENDING, DELIVERED, REJECTED. There is no
 * state meaning "possibly sent": the phase prompt forbids one, and a user in an
 * emergency must never have to guess whether a message left the device.
 *
 * ```text
 * queue()      -> QUEUED
 * beginSend()  -> SENDING
 * ack          -> DELIVERED   (terminal)
 * recoverable  -> QUEUED      (will retry)
 * permanent    -> REJECTED    (terminal)
 * ```
 *
 * A recoverable failure returns to QUEUED rather than inventing a middle state,
 * so the only thing the UI ever has to say is "waiting" or "delivered".
 */

export const MAX_ATTEMPTS = 12;

/** Backoff in milliseconds, capped. Deterministic so tests can assert it. */
export function backoffMs(attempts: number): number {
  const base = 2_000 * 2 ** Math.min(attempts, 6);
  return Math.min(base, 120_000);
}

export interface QueueInput {
  db: Db;
  messageId: string;
  selfDeviceId: string;
  peerDeviceId: string;
  familyId: string;
  conversationId: string;
  kind: MessageKind;
  body: string;
  now: number;
  /**
   * Builds the wire frame from the allocated sequence number.
   *
   * Called inside the transaction so the frame is sealed against the same
   * sequence number that is persisted. Sealing outside and passing the bytes in
   * would allow the two to disagree after a retry.
   */
  buildFrame: (seq: number) => Uint8Array;
}

export interface QueueResult {
  readonly messageId: string;
  readonly seq: number;
}

/**
 * Persists a message and its outbox row in one transaction, before any
 * transport is consulted.
 *
 * If the process dies immediately after this returns, the message is still
 * there and still queued. A message row without an outbox row would be
 * silently never sent, which is why both are written together or not at all.
 */
export function queueMessage(input: QueueInput): QueueResult {
  return transaction(input.db, () => {
    const seq = repo.nextLocalSeq(input.db, input.selfDeviceId);

    repo.ensureConversation(input.db, {
      conversationId: input.conversationId,
      familyId: input.familyId,
      peerDeviceId: input.peerDeviceId,
      now: input.now,
    });

    repo.insertMessage(input.db, {
      message_id: input.messageId,
      conversation_id: input.conversationId,
      from_device: input.selfDeviceId,
      to_device: input.peerDeviceId,
      seq,
      kind: input.kind,
      body: input.body,
      direction: 'OUT',
      state: 'QUEUED',
      state_reason: null,
      created_at: input.now,
      updated_at: input.now,
    });

    repo.insertOutbox(input.db, {
      messageId: input.messageId,
      frame: input.buildFrame(seq),
      nextAttemptAt: input.now,
    });

    repo.touchConversation(input.db, input.conversationId, input.now);
    return { messageId: input.messageId, seq };
  });
}

export function beginSend(db: Db, messageId: string, now: number): void {
  repo.setMessageState(db, { messageId, state: 'SENDING', reason: null, now });
}

/**
 * Delivery is confirmed by the recipient, never by the transport.
 *
 * Nearby resolving a send only means the OS accepted the bytes. Treating that
 * as delivery is exactly the "maybe sent" the phase forbids, dressed up as
 * certainty.
 */
export function markDelivered(db: Db, messageId: string, now: number): void {
  transaction(db, () => {
    repo.setMessageState(db, { messageId, state: 'DELIVERED', reason: null, now });
    repo.deleteOutbox(db, messageId);
  });
}

export interface FailureInput {
  db: Db;
  messageId: string;
  now: number;
  error: string;
  /** Recoverable failures retry; permanent ones are terminal. */
  recoverable: boolean;
}

/**
 * Records a failed attempt.
 *
 * A recoverable failure returns the message to QUEUED. Attempts are capped:
 * retrying forever would leave a message that can never arrive sitting in the
 * queue looking like it still might, which is a quieter form of lying than a
 * wrong state name.
 */
export function recordFailure(input: FailureInput): void {
  transaction(input.db, () => {
    const row = repo.outboxRow(input.db, input.messageId);
    const attempts = (row?.attempts ?? 0) + 1;

    if (!input.recoverable || attempts >= MAX_ATTEMPTS) {
      repo.setMessageState(input.db, {
        messageId: input.messageId,
        state: 'REJECTED',
        reason: input.recoverable ? `gave up after ${attempts} attempts` : input.error,
        now: input.now,
      });
      repo.deleteOutbox(input.db, input.messageId);
      return;
    }

    repo.recordAttempt(input.db, {
      messageId: input.messageId,
      nextAttemptAt: input.now + backoffMs(attempts),
      error: input.error,
    });
    repo.setMessageState(input.db, {
      messageId: input.messageId,
      state: 'QUEUED',
      reason: input.error,
      now: input.now,
    });
  });
}

/**
 * Returns messages whose retry time has arrived.
 *
 * Called on startup as well as on a timer: anything left in SENDING when the
 * process died is picked up here, because the send either never happened or was
 * never acknowledged, and both mean "try again".
 */
export function dueForSend(db: Db, now: number, limit = 20): repo.OutboxRow[] {
  return repo.dueOutbox(db, now, limit);
}

/**
 * Recovers messages stranded in SENDING by a crash or restart.
 *
 * Without this they would sit in SENDING forever: the outbox row still exists,
 * but nothing would ever move them back to a state the sender retries.
 */
export function recoverStrandedSends(db: Db, now: number): number {
  const stranded = db.all<{ message_id: string }>(
    `SELECT message_id FROM message WHERE direction = 'OUT' AND state = 'SENDING'`,
  );
  for (const row of stranded) {
    repo.setMessageState(db, {
      messageId: row.message_id,
      state: 'QUEUED',
      reason: 'interrupted, will retry',
      now,
    });
  }
  return stranded.length;
}

export type AcceptOutcome =
  | { readonly kind: 'STORED'; readonly message: MessageRow }
  | { readonly kind: 'DUPLICATE' }
  | { readonly kind: 'STALE' }
  | { readonly kind: 'UNTRUSTED' };

export interface AcceptInput {
  db: Db;
  messageId: string;
  fromDevice: string;
  toDevice: string;
  seq: number;
  kind: MessageKind;
  body: string;
  familyId: string;
  conversationId: string;
  now: number;
  /** How far below the high-water mark a sequence may fall before it is stale. */
  replayWindow?: number;
}

/**
 * Accepts an inbound message, or explains why it was refused.
 *
 * Order matters. Trust is checked first so a revoked device's traffic is
 * refused before anything else looks at it. Then the durable duplicate check,
 * which is what makes redelivery and replay the same harmless event.
 *
 * The caller must have already verified the AEAD tag: this function assumes the
 * fields it is handed are authenticated, and its job is what happens after.
 */
export function acceptInbound(input: AcceptInput): AcceptOutcome {
  const window = input.replayWindow ?? 256;

  return transaction(input.db, () => {
    if (!repo.getActiveTrust(input.db, input.fromDevice)) {
      return { kind: 'UNTRUSTED' } as const;
    }

    if (!repo.markProcessed(input.db, {
      messageId: input.messageId,
      fromDevice: input.fromDevice,
      now: input.now,
    })) {
      // Seen before. Delivered once, displayed once — however many times it
      // arrives, and whether that is retry or replay.
      return { kind: 'DUPLICATE' } as const;
    }

    const high = repo.peerHighWater(input.db, input.fromDevice);
    if (high !== undefined && input.seq + window < high) {
      return { kind: 'STALE' } as const;
    }

    repo.ensureConversation(input.db, {
      conversationId: input.conversationId,
      familyId: input.familyId,
      peerDeviceId: input.fromDevice,
      now: input.now,
    });

    const message: MessageRow = {
      message_id: input.messageId,
      conversation_id: input.conversationId,
      from_device: input.fromDevice,
      to_device: input.toDevice,
      seq: input.seq,
      kind: input.kind,
      body: input.body,
      direction: 'IN',
      // Inbound messages are delivered by definition: they are here.
      state: 'DELIVERED',
      state_reason: null,
      created_at: input.now,
      updated_at: input.now,
    };
    repo.insertMessage(input.db, message);
    repo.recordPeerSeq(input.db, input.fromDevice, input.seq);
    repo.touchConversation(input.db, input.conversationId, input.now);

    return { kind: 'STORED', message } as const;
  });
}

export interface SafetyInput {
  db: Db;
  eventId: string;
  familyId: string;
  deviceId: string;
  status: SafetyStatus;
  seq: number;
  reportedAt: number;
  now: number;
  note?: string | null;
}

/**
 * Records a safety report.
 *
 * "I'm Safe" is a timestamped, sequenced report and not a standing fact. Both
 * clocks are kept: `reported_at` is what the sender's clock claimed and
 * `received_at` is ours. They disagree in exactly the situations that matter,
 * and the reader deserves to see which is which rather than a single number
 * that quietly picked one.
 */
export function recordSafetyEvent(input: SafetyInput): void {
  repo.insertSafetyEvent(input.db, {
    event_id: input.eventId,
    family_id: input.familyId,
    device_id: input.deviceId,
    status: input.status,
    seq: input.seq,
    reported_at: input.reportedAt,
    received_at: input.now,
    note: input.note ?? null,
  });
}
