import { NativeModule, requireNativeModule } from 'expo';
import { fromBase64, toBase64 } from '@rcn/protocol';

/**
 * TypeScript face of the Keystore-backed identity.
 *
 * Values cross the bridge as base64 because the Expo bridge has no binary type.
 * Nothing above this file should see a base64 string: it decodes on the way in
 * and encodes on the way out, so the domain works in `Uint8Array` and cannot
 * accidentally hash or sign the base64 text instead of the bytes it represents.
 */

export type KeySecurityLevel = 'STRONGBOX' | 'TEE' | 'SOFTWARE' | 'UNKNOWN';

export interface DeviceIdentity {
  /** DER SubjectPublicKeyInfo of the P-256 identity key. */
  readonly publicKeyDer: Uint8Array;
  readonly securityLevel: KeySecurityLevel;
}

interface NativeIdentityModule extends NativeModule {
  ensureIdentity(): Promise<{ publicKeyDer: string; securityLevel: string }>;
  getIdentity(): Promise<{ publicKeyDer: string; securityLevel: string } | null>;
  sign(dataBase64: string): Promise<string>;
  seal(plaintextBase64: string): Promise<string>;
  unseal(sealedBase64: string): Promise<string>;
  destroyIdentity(): Promise<void>;
}

let cached: NativeIdentityModule | null = null;

/**
 * Resolved on first use rather than at import.
 *
 * Phase 0 shipped a top-level `requireNativeModule` and an unregistered module
 * killed the app before React could render, which on a release build is a
 * silent close with nothing on screen.
 */
function native(): NativeIdentityModule {
  if (cached === null) {
    cached = requireNativeModule<NativeIdentityModule>('RcnIdentity');
  }
  return cached;
}

export class IdentityError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'IdentityError';
  }
}

function wrap(error: unknown): IdentityError {
  const code = (error as { code?: string } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return new IdentityError(message, code);
}

function decodeIdentity(raw: { publicKeyDer: string; securityLevel: string }): DeviceIdentity {
  const levels: readonly string[] = ['STRONGBOX', 'TEE', 'SOFTWARE', 'UNKNOWN'];
  return {
    publicKeyDer: fromBase64(raw.publicKeyDer),
    // An unrecognised level is reported as UNKNOWN rather than trusted as one
    // of the strong ones. Guessing upward here would be a silent claim of
    // hardware backing the device never made.
    securityLevel: (levels.includes(raw.securityLevel)
      ? raw.securityLevel
      : 'UNKNOWN') as KeySecurityLevel,
  };
}

/** Creates the identity on first call; returns the existing one afterwards. */
export async function ensureIdentity(): Promise<DeviceIdentity> {
  try {
    return decodeIdentity(await native().ensureIdentity());
  } catch (error) {
    throw wrap(error);
  }
}

export async function getIdentity(): Promise<DeviceIdentity | null> {
  try {
    const raw = await native().getIdentity();
    return raw === null ? null : decodeIdentity(raw);
  } catch (error) {
    throw wrap(error);
  }
}

/** Signs with the key inside the secure element; it is never materialised here. */
export async function sign(data: Uint8Array): Promise<Uint8Array> {
  try {
    return fromBase64(await native().sign(toBase64(data)));
  } catch (error) {
    throw wrap(error);
  }
}

export async function seal(plaintext: Uint8Array): Promise<Uint8Array> {
  try {
    return fromBase64(await native().seal(toBase64(plaintext)));
  } catch (error) {
    throw wrap(error);
  }
}

export async function unseal(sealed: Uint8Array): Promise<Uint8Array> {
  try {
    return fromBase64(await native().unseal(toBase64(sealed)));
  } catch (error) {
    throw wrap(error);
  }
}

/**
 * Development and factory reset only. Destroying the sealing key makes every
 * sealed row in the database permanently unreadable.
 */
export async function destroyIdentity(): Promise<void> {
  try {
    await native().destroyIdentity();
  } catch (error) {
    throw wrap(error);
  }
}

