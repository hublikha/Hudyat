import type { Invitation, PairingRole, PendingVerification } from '@rcn/core';
import {
  Db,
  acceptInbound,
  beginSend,
  currentFamily,
  dueForSend,
  getActiveTrust,
  getMessage,
  markDelivered,
  queueMessage,
  recordFailure,
  recordSafetyEvent,
  recordReceipt,
  recoverStrandedSends,
  touchConversation,
  type MessageKind,
  type SafetyStatus,
} from '@rcn/core';
import {
  DeviceId,
  Envelope,
  PROTOCOL_VERSION,
  PacketType,
  Peer,
  TransportState,
  associatedData,
  decodeEnvelope,
  encodeEnvelope,
  fromBase64,
  newMessageId,
  openPayload,
  sealPayload,
  toBase64,
  utf8Decode,
} from '@rcn/protocol';
import { NearbyTransport } from '../../../../modules/rcn-transport';

import { randomBytes, unsealBytes } from './identity';
import {
  PairingSession,
  acceptHello,
  configurePairingRandom,
  encodeHello,
  parseHello,
  sessionExpired,
} from './pairingSession';

/**
 * Binds transport, cryptography and domain together.
 *
 * The rules this file exists to hold:
 *
 *  - a message is durable before any transport is consulted;
 *  - delivery is recorded when the recipient acknowledges, never when the
 *    transport accepts bytes;
 *  - an inbound frame is authenticated before anything reads its contents;
 *  - trust is checked before decryption is attempted.
 *
 * Nothing above this file talks to the transport, and the transport knows
 * nothing about messages.
 */

export type EngineEvent =
  | { type: 'transport'; state: TransportState; detail?: string }
  | { type: 'peers'; peers: PeerView[] }
  | { type: 'changed' }
  | { type: 'error'; message: string }
  /** The peer's keys arrived and the digits are ready to compare. */
  | { type: 'pairing-ready'; pending: PendingVerification; invitation: Invitation }
  | { type: 'pairing-failed'; message: string };

export interface PeerView {
  readonly deviceId: DeviceId;
  readonly displayName: string;
  readonly reachable: boolean;
  readonly trusted: boolean;
}

type Listener = (event: EngineEvent) => void;

interface SealedBody {
  readonly n: string;
  readonly c: string;
}

export class Engine {
  readonly #db: Db;
  readonly #transport = new NearbyTransport();
  readonly #listeners = new Set<Listener>();
  readonly #reachable = new Map<DeviceId, Peer>();
  #self: DeviceId | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #pairing: PairingSession | null = null;

  constructor(db: Db) {
    this.#db = db;
    configurePairingRandom(randomBytes);
  }

  /**
   * Opens a pairing window.
   *
   * Nothing accepts an unauthenticated HELLO unless one of these is open, so the
   * exception that pairing needs cannot be reached by a device that merely
   * appears on the network. The window closes on success, on cancellation, or
   * on timeout.
   */
  beginPairing(input: {
    role: PairingRole;
    invitation: Invitation;
    self: { deviceId: DeviceId; identityKey: Uint8Array; agreementKey: Uint8Array };
    displayName: string;
  }): void {
    this.#pairing = {
      role: input.role,
      invitation: input.invitation,
      self: input.self,
      displayName: input.displayName,
      pending: null,
      helloSent: false,
      startedAt: Date.now(),
    };
    void this.#offerHello();
  }

  cancelPairing(): void {
    this.#pairing = null;
  }

  get pairingOpen(): boolean {
    return this.#pairing !== null && !sessionExpired(this.#pairing, Date.now());
  }

  /**
   * Sends our HELLO to the other side of the pairing.
   *
   * The joiner sends first and includes the invitation nonce, which is how the
   * inviter knows which code is being answered. The inviter replies only after
   * a valid HELLO arrives, so it never broadcasts its keys to whoever asks.
   */
  async #offerHello(): Promise<void> {
    const session = this.#pairing;
    if (session === null || session.helloSent) return;
    if (session.role !== 'JOINER') return;

    const target = session.invitation.inviter;
    if (!this.#reachable.has(target)) return;

    try {
      await this.#transport.send(
        target,
        encodeHello({
          self: session.self,
          displayName: session.displayName,
          to: target,
          nonce: session.invitation.nonce,
        }),
      );
      session.helloSent = true;
    } catch {
      // Retried when the peer next connects; the pairing window is still open.
    }
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event: EngineEvent): void {
    for (const l of this.#listeners) {
      try {
        l(event);
      } catch {
        // A listener that throws must not stop delivery to the others, and must
        // never abort an inbound message that has already been stored.
      }
    }
  }

  get transportState(): TransportState {
    return this.#transport.state;
  }

  isReachable(deviceId: DeviceId): boolean {
    return this.#reachable.has(deviceId);
  }

  reachableCount(): number {
    let n = 0;
    for (const id of this.#reachable.keys()) {
      if (getActiveTrust(this.#db, id)) n++;
    }
    return n;
  }

  async start(selfDeviceId: DeviceId, displayName: string): Promise<void> {
    this.#self = selfDeviceId;

    // Anything left SENDING when the process died either never went out or was
    // never acknowledged. Both mean "try again".
    recoverStrandedSends(this.#db, Date.now());

    this.#transport.subscribe({
      stateChanged: (state, detail) => this.#emit({ type: 'transport', state, detail }),
      peerFound: (peer) => {
        this.#reachable.set(peer.deviceId, peer);
        this.#emitPeers();
        void this.#transport.connect(peer.deviceId).catch(() => {
          // Connection is attempted opportunistically; failure is normal and
          // the retry loop will try again when the peer is next seen.
        });
      },
      peerLost: (deviceId) => {
        // Discovery ending is not reachability ending: a connected peer stays
        // usable. Phase 0 conflated these three times in three layers.
        this.#emitPeers();
        void deviceId;
      },
      peerConnectionChanged: (deviceId, state) => {
        if (state === 'CONNECTED') {
          this.#reachable.set(deviceId, {
            deviceId,
            endpointId: '',
            displayName: '',
          });
        } else if (state === 'DISCONNECTED') {
          this.#reachable.delete(deviceId);
        }
        this.#emitPeers();
        if (state === 'CONNECTED') {
          void this.pump();
          void this.#offerHello();
        }
      },
      frameReceived: (from, frame) => {
        void this.#onFrame(from, frame);
      },
    });

    await this.#transport.start(selfDeviceId, `rcn-${selfDeviceId.slice(0, 8)}`);

    this.#timer = setInterval(() => void this.pump(), 5_000);
  }

  async stop(): Promise<void> {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    await this.#transport.stop();
    this.#reachable.clear();
    this.#emitPeers();
  }

  #emitPeers(): void {
    const peers: PeerView[] = [];
    for (const [deviceId, peer] of this.#reachable) {
      peers.push({
        deviceId,
        displayName: peer.displayName,
        reachable: true,
        trusted: getActiveTrust(this.#db, deviceId) !== undefined,
      });
    }
    this.#emit({ type: 'peers', peers });
  }

  // ---- sending ----------------------------------------------------------

  /**
   * Queues a message. Returns as soon as it is durable, not when it is sent.
   *
   * The caller can show it immediately and truthfully as waiting, because at
   * this point it will survive a restart and be retried.
   */
  async send(input: {
    to: DeviceId;
    body: string;
    kind?: MessageKind;
    familyId: string;
    conversationId: string;
  }): Promise<string> {
    const self = this.#requireSelf();
    const trust = getActiveTrust(this.#db, input.to);
    if (!trust) {
      throw new Error('That device is not a trusted family member.');
    }
    const sessionKey = await unsealBytes(trust.session_key_sealed);
    const messageId = newMessageId(randomBytes);
    const now = Date.now();
    const kind = input.kind ?? 'TEXT';

    queueMessage({
      db: this.#db,
      messageId,
      selfDeviceId: self,
      peerDeviceId: input.to,
      familyId: input.familyId,
      conversationId: input.conversationId,
      kind,
      body: input.body,
      now,
      buildFrame: (seq) =>
        this.#buildFrame({
          type: kind === 'TEXT' ? PacketType.MESSAGE : PacketType.SAFETY,
          messageId,
          from: self,
          to: input.to,
          seq,
          now,
          plaintext: kind === 'TEXT' ? input.body : input.body,
          sessionKey,
        }),
    });

    sessionKey.fill(0);
    this.#emit({ type: 'changed' });
    void this.pump();
    return messageId;
  }

  #buildFrame(input: {
    type: PacketType;
    messageId: string;
    from: DeviceId;
    to: DeviceId;
    seq: number;
    now: number;
    plaintext: string;
    sessionKey: Uint8Array;
  }): Uint8Array {
    const header: Omit<Envelope, 'payload'> = {
      v: PROTOCOL_VERSION,
      type: input.type,
      id: input.messageId as Envelope['id'],
      from: input.from,
      to: input.to,
      seq: input.seq,
      ts: input.now,
    };
    const sealed = sealPayload({
      sessionKey: input.sessionKey,
      plaintext: input.plaintext,
      // Every field except payload is authenticated, so a relay cannot
      // retarget or reorder this message without failing the tag.
      aad: associatedData(header),
      randomBytes,
    });
    const body: SealedBody = { n: toBase64(sealed.nonce), c: toBase64(sealed.ciphertext) };
    return encodeEnvelope({ ...header, payload: JSON.stringify(body) });
  }

  /**
   * Attempts every message whose retry time has arrived.
   *
   * Unreachable peers are skipped without consuming an attempt: burning the
   * retry budget while a phone is simply out of range would reject messages
   * that were never actually tried.
   */
  async pump(): Promise<void> {
    const now = Date.now();
    for (const row of dueForSend(this.#db, now)) {
      const message = getMessage(this.#db, row.message_id);
      if (!message) continue;

      const to = message.to_device as DeviceId;
      if (!this.#reachable.has(to)) {
        continue;
      }

      beginSend(this.#db, row.message_id, Date.now());
      try {
        await this.#transport.send(to, row.frame);
        // Deliberately not marked delivered here. The transport accepting bytes
        // is not the recipient receiving them; DELIVERED waits for the ACK.
      } catch (error) {
        const recoverable = (error as { recoverable?: boolean }).recoverable !== false;
        recordFailure({
          db: this.#db,
          messageId: row.message_id,
          now: Date.now(),
          error: (error as Error).message,
          recoverable,
        });
        this.#emit({ type: 'changed' });
      }
    }
  }

  // ---- receiving --------------------------------------------------------

  async #onFrame(from: DeviceId, frame: Uint8Array): Promise<void> {
    const self = this.#requireSelf();
    try {
      const envelope = decodeEnvelope(frame);

      if (envelope.type === PacketType.PAIR_HELLO) {
        // The one packet accepted from an untrusted device, and only while the
        // user has a pairing open. Its payload is plaintext by necessity: it is
        // the key exchange. Nothing is trusted as a result of it.
        this.#onHello(envelope, from);
        return;
      }

      // Trust is checked before decryption is attempted, so a removed or
      // unknown device's traffic never reaches the cipher.
      const trust = getActiveTrust(this.#db, envelope.from);
      if (!trust) {
        this.#emit({ type: 'error', message: `Ignored a message from an untrusted device.` });
        return;
      }
      if (envelope.from !== from) {
        // The sender field disagrees with the connection it arrived on.
        this.#emit({ type: 'error', message: 'Ignored a message with a mismatched sender.' });
        return;
      }

      const { payload, ...header } = envelope;
      const body = JSON.parse(payload) as SealedBody;
      const sessionKey = await unsealBytes(trust.session_key_sealed);
      let plaintext: string;
      try {
        const opened = openPayload({
          sessionKey,
          sealed: { nonce: fromBase64(body.n), ciphertext: fromBase64(body.c) },
          aad: associatedData(header),
        });
        plaintext = utf8Decode(opened);
      } finally {
        sessionKey.fill(0);
      }

      const family = currentFamily(this.#db);
      if (!family) return;

      // Phase 1 is strictly 1:1, so an unaddressed frame has no meaning here.
      // The envelope allows null for a broadcast the Family phase does not have.
      if (envelope.to === null) {
        this.#emit({ type: 'error', message: 'Ignored a message with no recipient.' });
        return;
      }

      // `to` is inside the associated data, so it cannot be rewritten in
      // flight — but authentication alone does not prove the message was meant
      // for us. A trusted peer holding our session key could address a frame to
      // a third device and it would still verify here. Storing that would put
      // someone else's message in this family's history.
      if (envelope.to !== self) {
        this.#emit({ type: 'error', message: 'Ignored a message addressed to another device.' });
        return;
      }

      if (envelope.type === PacketType.RECEIPT) {
        // The recipient confirmed. This is the only path to DELIVERED.
        markDelivered(this.#db, plaintext, Date.now());
        this.#emit({ type: 'changed' });
        return;
      }

      const conversationId = `c-${[envelope.from, envelope.to].sort().join('-')}`;
      const outcome = acceptInbound({
        db: this.#db,
        messageId: envelope.id,
        fromDevice: envelope.from,
        toDevice: envelope.to,
        seq: envelope.seq,
        kind: envelope.type === PacketType.SAFETY ? 'STATUS' : 'TEXT',
        body: plaintext,
        familyId: family.family_id,
        conversationId,
        now: Date.now(),
      });

      if (outcome.kind !== 'STORED') {
        // Duplicates and replays are silent by design: the message was already
        // delivered once and the family must see it once.
        return;
      }

      if (envelope.type === PacketType.SAFETY) {
        const status = plaintext.split('|')[0] as SafetyStatus;
        recordSafetyEvent({
          db: this.#db,
          eventId: envelope.id,
          familyId: family.family_id,
          deviceId: envelope.from,
          status,
          seq: envelope.seq,
          reportedAt: envelope.ts,
          now: Date.now(),
          note: plaintext.split('|')[1] ?? null,
        });
      }

      recordReceipt(this.#db, {
        messageId: envelope.id,
        fromDevice: envelope.from,
        now: Date.now(),
      });
      touchConversation(this.#db, conversationId, Date.now());
      this.#emit({ type: 'changed' });

      void this.#sendReceipt(envelope.from, envelope.id, trust.session_key_sealed);
    } catch (error) {
      // A frame that fails to decode or authenticate is dropped and counted.
      // The reason is not reported to the sender: telling an attacker which of
      // their attempts failed and how is a hint they do not need.
      this.#emit({
        type: 'error',
        message: `Rejected a malformed or unauthenticated message.`,
      });
      void error;
    }
  }

  /**
   * Handles a pairing HELLO.
   *
   * Every rejection here is silent to the peer: an attacker probing which
   * invitation is open, or which device is expected, learns nothing from the
   * difference between "no pairing open" and "wrong nonce".
   */
  #onHello(envelope: Envelope, from: DeviceId): void {
    const session = this.#pairing;
    if (session === null) return;
    if (sessionExpired(session, Date.now())) {
      this.#pairing = null;
      this.#emit({ type: 'pairing-failed', message: 'The pairing timed out. Try again.' });
      return;
    }
    if (envelope.from !== from) return;

    try {
      const hello = parseHello(envelope.payload);
      const pending = acceptHello(session, hello);
      session.pending = pending;

      if (session.role === 'INVITER' && !session.helloSent) {
        // Reply only now, to a device that answered our own code.
        session.helloSent = true;
        void this.#transport
          .send(
            hello.deviceId,
            encodeHello({
              self: session.self,
              displayName: session.displayName,
              to: hello.deviceId,
            }),
          )
          .catch(() => {
            this.#emit({
              type: 'pairing-failed',
              message: 'Lost contact with the other phone during pairing.',
            });
          });
      }

      this.#emit({ type: 'pairing-ready', pending, invitation: session.invitation });
    } catch (error) {
      this.#emit({ type: 'pairing-failed', message: (error as Error).message });
    }
  }

  async #sendReceipt(to: DeviceId, messageId: string, sealedKey: Uint8Array): Promise<void> {
    const self = this.#requireSelf();
    if (!this.#reachable.has(to)) return;
    const sessionKey = await unsealBytes(sealedKey);
    try {
      const frame = this.#buildFrame({
        type: PacketType.RECEIPT,
        messageId: newMessageId(randomBytes),
        from: self,
        to,
        seq: 0,
        now: Date.now(),
        plaintext: messageId,
        sessionKey,
      });
      await this.#transport.send(to, frame);
    } catch {
      // A lost receipt costs a retry, not a message. The sender will resend and
      // the duplicate will be suppressed on arrival.
    } finally {
      sessionKey.fill(0);
    }
  }

  #requireSelf(): DeviceId {
    if (this.#self === null) {
      throw new Error('The engine has not been started.');
    }
    return this.#self;
  }
}
