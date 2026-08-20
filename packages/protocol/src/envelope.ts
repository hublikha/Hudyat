import { MAX_PAYLOAD_BYTES, PROTOCOL_VERSION, PacketType } from './constants';
import { DeviceId, MessageId, isDeviceId, isMessageId } from './ids';

/**
 * Phase 0 envelope. Fields are plaintext by design — the spike proves transport
 * feasibility only. Phase 1 replaces `payload` with an AEAD ciphertext and adds
 * the authentication fields decided by the cryptography ADR; every other field
 * here is intended to survive that change unmodified.
 */
export interface Envelope {
  readonly v: number;
  readonly type: PacketType;
  readonly id: MessageId;
  readonly from: DeviceId;
  readonly to: DeviceId | null;
  readonly seq: number;
  readonly ts: number;
  readonly payload: string;
}

export const ENVELOPE_FIELD_ORDER: readonly (keyof Envelope)[] = [
  'v',
  'type',
  'id',
  'from',
  'to',
  'seq',
  'ts',
  'payload',
];

export class EnvelopeValidationError extends Error {
  constructor(public readonly field: string, message: string) {
    super(`envelope.${field}: ${message}`);
    this.name = 'EnvelopeValidationError';
  }
}

function isPacketType(value: unknown): value is PacketType {
  return typeof value === 'string' && value in PacketType;
}

function isNonNegativeSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function validateEnvelope(value: unknown): asserts value is Envelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new EnvelopeValidationError('root', 'must be an object');
  }
  const e = value as Record<string, unknown>;

  for (const key of Object.keys(e)) {
    if (!(ENVELOPE_FIELD_ORDER as readonly string[]).includes(key)) {
      throw new EnvelopeValidationError(key, 'unknown field');
    }
  }

  if (e.v !== PROTOCOL_VERSION) {
    throw new EnvelopeValidationError('v', `expected ${PROTOCOL_VERSION}, got ${String(e.v)}`);
  }
  if (!isPacketType(e.type)) {
    throw new EnvelopeValidationError('type', `unknown packet type ${String(e.type)}`);
  }
  if (!isMessageId(e.id)) {
    throw new EnvelopeValidationError('id', 'must be a 16-byte lowercase hex message id');
  }
  if (!isDeviceId(e.from)) {
    throw new EnvelopeValidationError('from', 'must be a 16-byte lowercase hex device id');
  }
  if (e.to !== null && !isDeviceId(e.to)) {
    throw new EnvelopeValidationError('to', 'must be null or a 16-byte lowercase hex device id');
  }
  if (!isNonNegativeSafeInt(e.seq)) {
    throw new EnvelopeValidationError('seq', 'must be a non-negative safe integer');
  }
  if (!isNonNegativeSafeInt(e.ts)) {
    throw new EnvelopeValidationError('ts', 'must be a non-negative safe integer');
  }
  if (typeof e.payload !== 'string') {
    throw new EnvelopeValidationError('payload', 'must be a string');
  }
  if (new TextEncoder().encode(e.payload).byteLength > MAX_PAYLOAD_BYTES) {
    throw new EnvelopeValidationError('payload', `exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  }
}
