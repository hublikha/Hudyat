export const PROTOCOL_ID = 'RCN';
export const PROTOCOL_VERSION = 1;
export const PROTOCOL_IDENTIFIER = `${PROTOCOL_ID}/${PROTOCOL_VERSION}`;

export const DEVICE_ID_BYTES = 16;
export const MESSAGE_ID_BYTES = 16;

export const MAX_PAYLOAD_BYTES = 32 * 1024;

export const PacketType = {
  /** Phase 0 diagnostics. Retained so the spike's fixtures still decode. */
  TEST_PING: 'TEST_PING',
  TEST_PONG: 'TEST_PONG',

  /** Family messages. The payload is an AEAD ciphertext (ADR 0004 §4). */
  MESSAGE: 'MSG',
  /** Acknowledgement of receipt. The only thing that makes a message DELIVERED. */
  RECEIPT: 'ACK',
  /**
   * SOS and status. A protocol event carrying the same authentication as any
   * other message - never a separate, weaker channel.
   */
  SAFETY: 'SAFE',

  /**
   * Pairing key exchange.
   *
   * This is the one packet whose payload is **not** encrypted, because it is
   * what establishes the key. It is therefore also the only packet accepted
   * from a device that is not yet trusted, and that exception is exactly why it
   * is narrow: it is honoured only while the user has a pairing open, and what
   * it carries is checked against the QR fingerprint and then against six
   * digits read aloud before any trust is written.
   */
  PAIR_HELLO: 'HELLO',
} as const;

export type PacketType = (typeof PacketType)[keyof typeof PacketType];
