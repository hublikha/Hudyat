import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Base64Error, fromBase64, toBase64 } from './base64';

// RFC 4648 §10. Pinned so an "optimisation" that breaks padding is caught.
const VECTORS: ReadonlyArray<readonly [string, string]> = [
  ['', ''],
  ['f', 'Zg=='],
  ['fo', 'Zm8='],
  ['foo', 'Zm9v'],
  ['foob', 'Zm9vYg=='],
  ['fooba', 'Zm9vYmE='],
  ['foobar', 'Zm9vYmFy'],
];

const bytes = (s: string) => Uint8Array.from(Buffer.from(s, 'utf8'));

test('matches the RFC 4648 test vectors', () => {
  for (const [plain, encoded] of VECTORS) {
    assert.equal(toBase64(bytes(plain)), encoded, `encoding ${JSON.stringify(plain)}`);
  }
});

test('decodes the RFC 4648 test vectors', () => {
  for (const [plain, encoded] of VECTORS) {
    assert.deepEqual(fromBase64(encoded), bytes(plain), `decoding ${encoded}`);
  }
});

test('agrees with Node for every byte value', () => {
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.equal(toBase64(all), Buffer.from(all).toString('base64'));
  assert.deepEqual(fromBase64(Buffer.from(all).toString('base64')), all);
});

test('agrees with Node across every length that exercises padding', () => {
  for (let n = 0; n < 64; n++) {
    const data = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff);
    const ours = toBase64(data);
    assert.equal(ours, Buffer.from(data).toString('base64'), `length ${n}`);
    assert.deepEqual(fromBase64(ours), data, `round trip at length ${n}`);
  }
});

test('round-trips a 32-byte key and a P-256 SPKI-sized blob', () => {
  for (const n of [32, 91]) {
    const key = Uint8Array.from({ length: n }, (_, i) => (i * 7) & 0xff);
    assert.deepEqual(fromBase64(toBase64(key)), key);
  }
});

test('rejects invalid characters rather than skipping them', () => {
  // A lenient decoder would hand back plausible bytes for corrupted input that
  // is about to be used as a key.
  assert.throws(() => fromBase64('Zm9v!'), Base64Error);
  assert.throws(() => fromBase64('Zm 9v'), Base64Error);
  assert.throws(() => fromBase64('Zm9v\n'), Base64Error);
  assert.throws(() => fromBase64('Zm9v_-'), Base64Error);
});

test('rejects a truncated final group', () => {
  // Five characters cannot be a whole number of bytes; returning the prefix
  // would look like success.
  assert.throws(() => fromBase64('Zm9vY'), Base64Error);
});

test('padding inside the string is not silently accepted', () => {
  assert.throws(() => fromBase64('Zg==Zg=='), Base64Error);
});

test('works with no platform TextEncoder, atob, or Buffer', () => {
  const saved = {
    TextEncoder: globalThis.TextEncoder,
    TextDecoder: globalThis.TextDecoder,
    atob: globalThis.atob,
    btoa: globalThis.btoa,
    Buffer: globalThis.Buffer,
  };
  // Hermes has none of these. This is the same gap that let Phase 0 ship code
  // which passed in Node and could not run on the device.
  // @ts-expect-error - deliberately removing globals for the test
  delete globalThis.TextEncoder;
  // @ts-expect-error - see above
  delete globalThis.TextDecoder;
  // @ts-expect-error - see above
  delete globalThis.atob;
  // @ts-expect-error - see above
  delete globalThis.btoa;
  // @ts-expect-error - see above
  delete globalThis.Buffer;
  try {
    const data = Uint8Array.from([0, 1, 250, 251, 252, 253, 254, 255]);
    assert.deepEqual(fromBase64(toBase64(data)), data);
  } finally {
    Object.assign(globalThis, saved);
  }
});
