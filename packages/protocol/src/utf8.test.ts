import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Utf8Error, utf8ByteLength, utf8Decode, utf8Encode } from './utf8';

const SAMPLES = [
  '',
  'ascii',
  'ligtas ako',
  'Ligtás akó — Barangay',
  'safe \u0000 nul',
  '\u00e9\u00fc\u00f1',
  '\u4e2d\u6587\u30c6\u30b9\u30c8',
  '\ud83d\udea8\ud83c\uddf5\ud83c\udded',
  '\uffff\u10ff',
];

test('matches Node TextEncoder byte-for-byte', () => {
  const reference = new TextEncoder();
  for (const sample of SAMPLES) {
    assert.deepEqual(
      utf8Encode(sample),
      reference.encode(sample),
      `encode mismatch for ${JSON.stringify(sample)}`,
    );
  }
});

test('matches Node TextDecoder for every sample', () => {
  const reference = new TextEncoder();
  for (const sample of SAMPLES) {
    assert.equal(utf8Decode(reference.encode(sample)), sample);
  }
});

test('round-trips every sample', () => {
  for (const sample of SAMPLES) {
    assert.equal(utf8Decode(utf8Encode(sample)), sample);
  }
});

test('round-trips the whole basic multilingual plane except surrogates', () => {
  let text = '';
  for (let cp = 0; cp < 0x10000; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    text += String.fromCharCode(cp);
  }
  assert.equal(utf8Decode(utf8Encode(text)), text);
});

test('byte length agrees with the encoder', () => {
  for (const sample of SAMPLES) {
    assert.equal(utf8ByteLength(sample), utf8Encode(sample).byteLength);
  }
});

test('rejects overlong encodings', () => {
  // 0xC0 0x80 is an overlong encoding of NUL, the classic filter bypass.
  assert.throws(() => utf8Decode(new Uint8Array([0xc0, 0x80])), Utf8Error);
  assert.throws(() => utf8Decode(new Uint8Array([0xe0, 0x80, 0x80])), Utf8Error);
  assert.throws(() => utf8Decode(new Uint8Array([0xf0, 0x80, 0x80, 0x80])), Utf8Error);
});

test('rejects surrogate halves encoded as UTF-8', () => {
  assert.throws(() => utf8Decode(new Uint8Array([0xed, 0xa0, 0x80])), Utf8Error);
  assert.throws(() => utf8Decode(new Uint8Array([0xed, 0xbf, 0xbf])), Utf8Error);
});

test('rejects truncated sequences', () => {
  assert.throws(() => utf8Decode(new Uint8Array([0xe4, 0xb8])), Utf8Error);
  assert.throws(() => utf8Decode(new Uint8Array([0xf0, 0x9f])), Utf8Error);
});

test('rejects invalid lead and continuation bytes', () => {
  assert.throws(() => utf8Decode(new Uint8Array([0xff])), Utf8Error);
  assert.throws(() => utf8Decode(new Uint8Array([0x80])), Utf8Error);
  assert.throws(() => utf8Decode(new Uint8Array([0xe4, 0x28, 0xb8])), Utf8Error);
});

test('rejects code points beyond U+10FFFF', () => {
  assert.throws(() => utf8Decode(new Uint8Array([0xf7, 0xbf, 0xbf, 0xbf])), Utf8Error);
});

test('rejects unpaired surrogates on encode', () => {
  assert.throws(() => utf8Encode('\ud800'), Utf8Error);
  assert.throws(() => utf8Encode('\udc00x'), Utf8Error);
  assert.throws(() => utf8Encode('a\ud83d'), Utf8Error);
});

test('does not depend on platform TextEncoder', () => {
  const savedEncoder = globalThis.TextEncoder;
  const savedDecoder = globalThis.TextDecoder;
  // Hermes has neither. Deleting them here proves this module never reaches for
  // them, so a passing Node suite means the same code works on device.
  // @ts-expect-error - deliberately removing a global for the duration of the test
  delete globalThis.TextEncoder;
  // @ts-expect-error - see above
  delete globalThis.TextDecoder;
  try {
    assert.equal(utf8Decode(utf8Encode('ligtas \ud83d\udea8')), 'ligtas \ud83d\udea8');
  } finally {
    globalThis.TextEncoder = savedEncoder;
    globalThis.TextDecoder = savedDecoder;
  }
});
