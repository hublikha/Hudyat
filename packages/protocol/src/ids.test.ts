import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEVICE_ID_BYTES } from './constants';
import { fromHex, isDeviceId, isMessageId, newDeviceId, newMessageId, toHex } from './ids';

const counterRandom = (start: number) => (n: number) =>
  Uint8Array.from({ length: n }, (_, i) => (start + i) & 0xff);

test('hex conversion round-trips every byte value', () => {
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.deepEqual(fromHex(toHex(all)), all);
});

test('toHex zero-pads bytes below 0x10', () => {
  assert.equal(toHex(new Uint8Array([0x00, 0x0f, 0xff])), '000fff');
});

test('fromHex rejects odd-length and non-hex input', () => {
  assert.throws(() => fromHex('abc'));
  assert.throws(() => fromHex('zzzz'));
});

test('generated ids are well-formed', () => {
  assert.ok(isDeviceId(newDeviceId(counterRandom(0))));
  assert.ok(isMessageId(newMessageId(counterRandom(7))));
});

test('id validators reject wrong length, casing, and non-strings', () => {
  const valid = newDeviceId(counterRandom(0));
  assert.equal(isDeviceId(valid.slice(0, -2)), false);
  assert.equal(isDeviceId(valid + '00'), false);
  assert.equal(isDeviceId(valid.toUpperCase()), false);
  assert.equal(isDeviceId(null), false);
  assert.equal(isDeviceId(123), false);
});

test('device ids consume the documented number of random bytes', () => {
  let requested = 0;
  newDeviceId((n) => {
    requested = n;
    return counterRandom(0)(n);
  });
  assert.equal(requested, DEVICE_ID_BYTES);
});
