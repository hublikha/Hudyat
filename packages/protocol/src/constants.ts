export const PROTOCOL_ID = 'RCN';
export const PROTOCOL_VERSION = 1;
export const PROTOCOL_IDENTIFIER = `${PROTOCOL_ID}/${PROTOCOL_VERSION}`;

export const DEVICE_ID_BYTES = 16;
export const MESSAGE_ID_BYTES = 16;

export const MAX_PAYLOAD_BYTES = 32 * 1024;

export const PacketType = {
  TEST_PING: 'TEST_PING',
  TEST_PONG: 'TEST_PONG',
} as const;

export type PacketType = (typeof PacketType)[keyof typeof PacketType];
