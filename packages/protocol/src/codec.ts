import { Envelope, ENVELOPE_FIELD_ORDER, validateEnvelope } from './envelope';

/**
 * Canonical serialization. Fields are emitted in `ENVELOPE_FIELD_ORDER` with no
 * insignificant whitespace, so the same envelope always produces byte-identical
 * output on every device. Phase 1 signs and encrypts over exactly these bytes,
 * so any change to this function is a protocol-breaking change.
 */
export function encodeEnvelope(envelope: Envelope): Uint8Array {
  validateEnvelope(envelope);
  const parts = ENVELOPE_FIELD_ORDER.map(
    (key) => `${JSON.stringify(key)}:${JSON.stringify(envelope[key])}`,
  );
  return new TextEncoder().encode(`{${parts.join(',')}}`);
}

export class DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecodeError';
  }
}

export function decodeEnvelope(bytes: Uint8Array): Envelope {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new DecodeError('payload is not valid UTF-8');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DecodeError('payload is not valid JSON');
  }

  validateEnvelope(parsed);
  return parsed;
}
