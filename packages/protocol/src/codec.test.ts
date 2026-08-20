import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DecodeError, decodeEnvelope, encodeEnvelope } from './codec';
import { PROTOCOL_VERSION, PacketType } from './constants';
import { Envelope, EnvelopeValidationError } from './envelope';
import { DEVICE_A, DEVICE_B, MESSAGE_1, PING_A_TO_B, PING_A_TO_B_CANONICAL } from './fixtures';

const decoder = new TextDecoder();

test('encodes the golden fixture to the exact canonical bytes', () => {
  assert.equal(decoder.decode(encodeEnvelope(PING_A_TO_B)), PING_A_TO_B_CANONICAL);
});

test('encoding is independent of source key order', () => {
  const shuffled = {
    payload: PING_A_TO_B.payload,
    ts: PING_A_TO_B.ts,
    from: PING_A_TO_B.from,
    v: PING_A_TO_B.v,
    to: PING_A_TO_B.to,
    id: PING_A_TO_B.id,
    seq: PING_A_TO_B.seq,
    type: PING_A_TO_B.type,
  } as Envelope;

  assert.deepEqual(encodeEnvelope(shuffled), encodeEnvelope(PING_A_TO_B));
});

test('round-trips through encode and decode', () => {
  assert.deepEqual(decodeEnvelope(encodeEnvelope(PING_A_TO_B)), PING_A_TO_B);
});

test('accepts a broadcast envelope with a null recipient', () => {
  const broadcast: Envelope = { ...PING_A_TO_B, to: null };
  assert.equal(decodeEnvelope(encodeEnvelope(broadcast)).to, null);
});

test('preserves non-ASCII payloads across the round trip', () => {
  const envelope: Envelope = { ...PING_A_TO_B, payload: 'ligtas ako — 安全' };
  assert.equal(decodeEnvelope(encodeEnvelope(envelope)).payload, 'ligtas ako — 安全');
});

test('rejects a truncated frame', () => {
  const frame = encodeEnvelope(PING_A_TO_B);
  assert.throws(() => decodeEnvelope(frame.slice(0, frame.length - 5)), DecodeError);
});

test('rejects a frame whose bytes are not valid UTF-8', () => {
  assert.throws(() => decodeEnvelope(new Uint8Array([0xff, 0xfe, 0xfd])), DecodeError);
});

test('rejects a frame carrying an unknown protocol version', () => {
  const frame = new TextEncoder().encode(
    PING_A_TO_B_CANONICAL.replace(`"v":${PROTOCOL_VERSION}`, '"v":99'),
  );
  assert.throws(() => decodeEnvelope(frame), EnvelopeValidationError);
});

test('rejects a frame carrying an unknown packet type', () => {
  const frame = new TextEncoder().encode(
    PING_A_TO_B_CANONICAL.replace('"TEST_PING"', '"TEST_UNKNOWN"'),
  );
  assert.throws(() => decodeEnvelope(frame), EnvelopeValidationError);
});

test('rejects a frame carrying an unknown field', () => {
  const frame = new TextEncoder().encode(
    PING_A_TO_B_CANONICAL.replace('{', '{"injected":true,'),
  );
  assert.throws(() => decodeEnvelope(frame), EnvelopeValidationError);
});

test('rejects malformed device and message ids', () => {
  const cases: Partial<Envelope>[] = [
    { from: 'not-hex' },
    { from: DEVICE_A.slice(0, 30) },
    { from: DEVICE_A.toUpperCase() },
    { to: 'zz' + DEVICE_B.slice(2) },
    { id: MESSAGE_1.slice(0, 4) },
  ];
  for (const override of cases) {
    assert.throws(
      () => encodeEnvelope({ ...PING_A_TO_B, ...override } as Envelope),
      EnvelopeValidationError,
      `expected rejection for ${JSON.stringify(override)}`,
    );
  }
});

test('rejects non-integer, negative, and unsafe counters', () => {
  for (const seq of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
    assert.throws(
      () => encodeEnvelope({ ...PING_A_TO_B, seq } as Envelope),
      EnvelopeValidationError,
      `expected rejection for seq=${seq}`,
    );
  }
});

test('rejects a payload over the size limit', () => {
  const envelope = { ...PING_A_TO_B, payload: 'x'.repeat(32 * 1024 + 1) };
  assert.throws(() => encodeEnvelope(envelope), EnvelopeValidationError);
});

test('distinct packet types produce distinct bytes', () => {
  const pong: Envelope = { ...PING_A_TO_B, type: PacketType.TEST_PONG };
  assert.notDeepEqual(encodeEnvelope(pong), encodeEnvelope(PING_A_TO_B));
});
