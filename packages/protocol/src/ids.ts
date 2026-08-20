import { DEVICE_ID_BYTES, MESSAGE_ID_BYTES } from './constants';

export type DeviceId = string;
export type MessageId = string;

export type RandomBytes = (byteLength: number) => Uint8Array;

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    out += b.toString(16).padStart(2, '0');
  }
  return out;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('hex string must have even length');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error(`invalid hex at offset ${i * 2}`);
    }
    out[i] = byte;
  }
  return out;
}

function isHexOfLength(value: unknown, byteLength: number): boolean {
  return (
    typeof value === 'string' &&
    value.length === byteLength * 2 &&
    /^[0-9a-f]+$/.test(value)
  );
}

export function isDeviceId(value: unknown): value is DeviceId {
  return isHexOfLength(value, DEVICE_ID_BYTES);
}

export function isMessageId(value: unknown): value is MessageId {
  return isHexOfLength(value, MESSAGE_ID_BYTES);
}

export function newDeviceId(random: RandomBytes): DeviceId {
  return toHex(random(DEVICE_ID_BYTES));
}

export function newMessageId(random: RandomBytes): MessageId {
  return toHex(random(MESSAGE_ID_BYTES));
}
