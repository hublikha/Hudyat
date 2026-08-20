/**
 * UTF-8 codec.
 *
 * The platform's `TextEncoder`/`TextDecoder` are deliberately not used: Hermes
 * does not provide them, and this package must behave identically everywhere it
 * runs. Node has them, so a test suite alone would not catch the difference.
 *
 * Decoding is strict. Overlong encodings, surrogate halves, and out-of-range
 * code points are rejected rather than replaced with U+FFFD, because a lenient
 * decoder lets two devices disagree about what a frame says — and in Phase 1
 * these bytes are what a signature covers.
 */

export class Utf8Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Utf8Error';
  }
}

export function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];

  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i);

    if (cp >= 0xd800 && cp <= 0xdbff) {
      const low = text.charCodeAt(i + 1);
      if (Number.isNaN(low) || low < 0xdc00 || low > 0xdfff) {
        throw new Utf8Error(`unpaired high surrogate at index ${i}`);
      }
      cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
      i++;
    } else if (cp >= 0xdc00 && cp <= 0xdfff) {
      throw new Utf8Error(`unpaired low surrogate at index ${i}`);
    }

    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }

  return Uint8Array.from(out);
}

export function utf8ByteLength(text: string): number {
  return utf8Encode(text).byteLength;
}

export function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;

  while (i < bytes.length) {
    const b0 = bytes[i]!;
    let cp: number;
    let width: number;
    let lowerBound: number;

    if (b0 < 0x80) {
      cp = b0;
      width = 1;
      lowerBound = 0;
    } else if ((b0 & 0xe0) === 0xc0) {
      cp = b0 & 0x1f;
      width = 2;
      lowerBound = 0x80;
    } else if ((b0 & 0xf0) === 0xe0) {
      cp = b0 & 0x0f;
      width = 3;
      lowerBound = 0x800;
    } else if ((b0 & 0xf8) === 0xf0) {
      cp = b0 & 0x07;
      width = 4;
      lowerBound = 0x10000;
    } else {
      throw new Utf8Error(`invalid lead byte 0x${b0.toString(16)} at offset ${i}`);
    }

    if (i + width > bytes.length) {
      throw new Utf8Error(`truncated sequence at offset ${i}`);
    }

    for (let k = 1; k < width; k++) {
      const b = bytes[i + k]!;
      if ((b & 0xc0) !== 0x80) {
        throw new Utf8Error(`invalid continuation byte at offset ${i + k}`);
      }
      cp = (cp << 6) | (b & 0x3f);
    }

    if (cp < lowerBound) {
      throw new Utf8Error(`overlong encoding at offset ${i}`);
    }
    if (cp >= 0xd800 && cp <= 0xdfff) {
      throw new Utf8Error(`surrogate code point at offset ${i}`);
    }
    if (cp > 0x10ffff) {
      throw new Utf8Error(`code point out of range at offset ${i}`);
    }

    if (cp < 0x10000) {
      out += String.fromCharCode(cp);
    } else {
      const v = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
    }

    i += width;
  }

  return out;
}
