/**
 * Base64, standard alphabet with padding.
 *
 * One implementation, shared by every native module, because the bridge has no
 * binary type and every key, frame, and signature crosses it as base64. Two
 * copies of this had already appeared — in the transport and identity modules —
 * and a divergence between them would corrupt keys silently: sealed material
 * that decodes to the wrong bytes produces an authentication failure with no
 * hint that the encoding, rather than the cryptography, was at fault.
 *
 * Hermes has no `atob`/`btoa` and no `Buffer`, so this is hand-rolled for the
 * same reason the UTF-8 codec is.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const REVERSE: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i++) {
  REVERSE[ALPHABET[i]!] = i;
}

export class Base64Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Base64Error';
  }
}

export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];

    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? '=' : ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? '=' : ALPHABET[b2 & 0x3f];
  }
  return out;
}

/**
 * Decoding is strict: an unexpected character throws rather than being skipped.
 *
 * A lenient decoder that ignores stray characters would accept a corrupted or
 * attacker-modified value and hand back plausible-looking bytes, which is the
 * worst outcome for data that is about to be treated as a key or a frame.
 */
export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));

  let bits = 0;
  let acc = 0;
  let o = 0;
  for (const ch of clean) {
    const value = REVERSE[ch];
    if (value === undefined) {
      throw new Base64Error(`invalid base64 character ${JSON.stringify(ch)}`);
    }
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }

  // A trailing group of one character cannot encode a whole byte, so the input
  // was truncated. Returning the shorter prefix would look like success.
  if (clean.length % 4 === 1) {
    throw new Base64Error('truncated base64 input');
  }

  return out.subarray(0, o);
}
