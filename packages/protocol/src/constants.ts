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
} as const;

export type PacketType = (typeof PacketType)[keyof typeof PacketType];
