# ADR 0004 — Phase 1 cryptography

- **Status:** Accepted
- **Date:** 2026-08-20
- **Closes:** ADR 0002 (all seven deferred decisions)
- **Gates:** Phase 1 implementation

Per master rule 11, no primitive is designed here. Every construction below is a
standard one from a maintained, audited library or from the Android platform.

## Libraries

| Purpose | Source |
| --- | --- |
| Identity keypair, signing | Android Keystore, EC P-256, `SHA256withECDSA` |
| Key agreement | `@noble/curves` X25519 |
| AEAD | `@noble/ciphers` XChaCha20-Poly1305 |
| KDF, hashing | `@noble/hashes` HKDF-SHA256, SHA-256 |
| Randomness | `expo-crypto` `getRandomBytes` (platform CSPRNG) |

`@noble/*` is pure TypeScript with no native dependency, which matters after the
Phase 0 finding that Hermes lacks Web Crypto and `TextEncoder`. It has published
audits and is widely deployed.

## 1. Identity primitive

**EC P-256 keypair in the Android Keystore, non-exportable. Signatures are
ECDSA over SHA-256.**

P-256 is chosen over Ed25519 for one reason: Keystore has supported hardware
backing for P-256 since API 23, while Ed25519 support is API 33+ and uneven. A
non-exportable key in a secure element resists the threat that actually applies
here — a stolen or malware-infected phone — and that is worth more than a
preferred curve. A software Ed25519 key is extractable by anything that can read
app storage; a TEE-held P-256 key is not.

```text
DeviceId = lowercase_hex( SHA-256( SubjectPublicKeyInfo DER )[0..16] )
```

128 bits, and the existing 32-hex-character `DeviceId` format is unchanged, so
the protocol's `from` and `to` fields do not move. The identifier is a
convenience; **trust is anchored on the stored public key, never on the id
string.**

## 2. Private key storage

The identity private key is generated inside the Keystore and never leaves it.
User authentication is deliberately **not** required to use it: SOS must work on
a locked phone, and demanding an unlock mid-emergency would be a safety
regression.

Backing level is read at generation and **persisted on the device record and
shown in the UI**: StrongBox, TEE, or software. A device that can only manage
software backing still works, but it says so. That is disclosure, not a silent
downgrade — master rule 16 forbids the fallback being invisible, not the
fallback existing.

The X25519 agreement key cannot live in the Keystore (see §3), so it is sealed
at rest with AES-256-GCM under a non-exportable Keystore AES key. At rest it is
protected by hardware; **while in use it is in app memory.** That is a real and
disclosed weakening relative to the identity key.

## 3. Authenticated key agreement

**X25519 static-static ECDH, with the agreement key bound to the hardware
identity key by signature.**

Keystore ECDH needs `PURPOSE_AGREE_KEY`, which is API 31+. Our floor is API 24,
and the Phase 0 devices were API 33 and 36 — the range below 31 is exactly the
budget hardware this product exists for. Rather than exclude those devices, or
let security silently depend on API level, agreement runs in software on X25519
and is **authenticated by the hardware identity key**:

```text
identity_key (P-256, TEE, non-exportable)
      | signs
      v
agreement_pubkey (X25519)
```

Substituting an agreement key therefore requires forging an ECDSA signature from
a key inside the secure element. The hardware anchor is preserved where it
matters.

### Pairing, bound to the QR

The QR invitation carries, signed by the inviter's identity key:

```text
family_id
inviter_device_id
inviter_identity_pubkey_fingerprint   SHA-256, full 32 bytes
nonce                                 16 random bytes
expires_at
```

The joiner **must** verify that the identity key presented over the network
hashes to the fingerprint carried in the QR. The QR is the out-of-band channel,
and this comparison is what stops a network attacker substituting its own key. A
handshake that skips this check is not a Phase 1 handshake.

Both sides then sign a transcript over both identity public keys, both agreement
public keys, the family id, and the invitation nonce.

```text
shared  = X25519(own_agreement_priv, peer_agreement_pub)
session = HKDF-SHA256(
            ikm  = shared,
            salt = invitation_nonce,
            info = "RCN/1 pair" || lower(device_id) || higher(device_id)
          )
```

Device ids are sorted so both sides derive the same key without negotiating who
plays which role.

### Explicit verification step

Phase 1 requires an explicit verification step, so pairing displays a **6-digit
short authentication string** derived from the transcript:

```text
SAS = decimal( HKDF-SHA256(transcript, info="RCN/1 sas")[0..4] ) mod 10^6
```

Both users compare the digits aloud and confirm. This is what makes pairing
resistant to an attacker who controls the network but cannot see the two
screens. The trust record is written only after confirmation.

## 4. Authenticated encryption

**XChaCha20-Poly1305 with a 24-byte random nonce per message.**

The nonce is random rather than a counter, and that is a direct consequence of a
Phase 0 finding: the sequence counter lived in memory and reset to zero on
restart. The same bug applied to a nonce counter repeats nonces, and nonce reuse
under a stream cipher is catastrophic — it leaks plaintext. Twenty-four random
bytes have no state to get wrong.

**Associated data is the canonical encoding of every envelope field except
`payload`** — `v`, `type`, `id`, `from`, `to`, `seq`, `ts`. Altering any of them,
including retargeting a message by rewriting `to` or reordering by rewriting
`seq`, fails authentication. This is why `codec.ts` is pinned by a golden-bytes
fixture: it defines exactly the bytes the tag covers.

## 5. Replay and tamper rejection

Two layers, and the durable one is primary:

1. **`processed_message(message_id PRIMARY KEY, from_device, received_at)`.** A
   message id already present is dropped as already handled. This survives
   restart, which is what makes it the real defence.
2. **Per-peer high-water sequence**, persisted. A `seq` far below the high-water
   mark is stale and rejected.

**`ts` is advisory and is never used to accept or reject.** The Phase 0 threat
model records this and Phase 1 keeps it: a wrong or attacker-controlled clock
must not change behaviour. It is also why invitation expiry is enforced by the
issuer (§7).

The sender's `seq` **must be persisted**, not held in memory. Phase 0 shipped it
in memory and it reset on restart; with a durable outbox that same bug breaks
duplicate suppression across restarts.

## 6. Revocation

Removing a device deletes its `trust_record` and derived session state, and
writes a durable `revoked_device` row. Revocation is checked **before** any
decryption is attempted: an unknown or revoked `from` is rejected at trust
lookup, so a removed device's traffic never reaches the cipher.

Re-pairing a revoked device requires a fresh invitation and a fresh explicit
verification. It cannot be re-trusted silently by reappearing on the network.

**Limitation, stated plainly: revocation is forward-only.** A removed device
keeps whatever it already received. Phase 1 has no group key, so there is
nothing to rotate; when group messaging arrives it will need its own ADR.

## 7. Invitation replay

Invitations are single-use and short-lived:

```text
invitation(nonce PRIMARY KEY, family_id, expires_at, used_at)
```

- **Single use** — the inviter marks `used_at` on the first successful join. A
  second presentation of the same nonce is refused.
- **Expiry, enforced by the issuer.** The inviter checks it, not the joiner,
  precisely because a joiner's clock may be wrong or attacker-controlled. A
  skewed clock on the joining device cannot extend an invitation's life.
- Default lifetime 5 minutes.

Both records are persisted, so replay is refused across restarts.

## Known limitations

**No forward secrecy.** Static-static X25519 means compromising a device's
agreement key exposes past messages it could decrypt. A ratchet is the standard
answer and is deliberately out of Phase 1 scope: the phase requires authenticated
key agreement, not post-compromise security, and a ratchet implemented in haste
is worse than one implemented later with its own ADR. The envelope has room to
carry ratchet headers without a wire break.

This is worth stating to the founder directly rather than burying: **if a family
member's phone is seized and unlocked, prior messages on that phone are readable
regardless.** Device storage is the exposure there, not the transport.

**Agreement key in app memory.** See §2. The identity key is not.

**No group keying.** Phase 1 is 1:1 only, per the phase's explicit non-scope. SOS
to multiple members is N separate authenticated 1:1 messages.

## Consequences

Phase 1 may proceed. The stop condition in ADR 0002 is cleared: all seven items
have answers, each naming a vetted primitive.

The wire format changes only in `payload`, which becomes a ciphertext, plus new
authentication fields. `v`, `type`, `id`, `from`, `to`, `seq`, `ts` and the
canonical encoding are unchanged, as ADR 0002 required.
