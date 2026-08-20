# ADR 0002 — Cryptography decision boundary

- **Status:** Open — decision deferred to the Phase 1 entry gate
- **Date:** 2026-08-20
- **Blocks:** Phase 1 implementation

## Why this ADR exists now

Phase 0 is a transport feasibility spike and deliberately implements no
application-layer cryptography. That is a scope decision, not an oversight, and
it needs to be written down so a later reader does not mistake the spike's
plaintext frames for an accepted design.

This ADR records what Phase 0 does **not** decide, and fixes the boundary that
the Phase 1 decision has to fill.

## What Phase 0 does

Phase 0 frames are **plaintext, unauthenticated, and unsigned**. The envelope's
`from` field is a self-asserted claim: any device on the transport can put any
device id there and nothing in the spike will detect it.

Nearby Connections encrypts its own links. That is a transport property, it is
terminated by the transport, and it is **not** the product's confidentiality
story. Relying on it would violate the invariant that transport adapters cannot
define application semantics.

Accordingly, the Phase 0 developer screen is a diagnostic tool. It must not be
shipped to users and must not be reused as a chat surface.

## What Phase 1 must decide before any code is written

1. **Identity primitive** — signature scheme for the long-lived device keypair,
   and the derivation from public key to `DeviceId`.
2. **Private key storage** — the Android Keystore posture, whether keys are
   hardware-backed, and what happens on devices where they cannot be.
3. **Authenticated key agreement** — the pairing handshake, and how it binds to
   the out-of-band QR invitation so that a network attacker cannot substitute a
   key.
4. **Authenticated encryption** — the AEAD, nonce discipline, and exactly which
   envelope bytes are covered as associated data.
5. **Replay and tamper rejection** — the window, the per-device sequence rules,
   and the persisted state that makes rejection survive a restart.
6. **Revocation** — what "removed device" means cryptographically, and why a
   removed device cannot continue to decrypt.
7. **Invitation replay** — expiry, single-use enforcement, and the persisted
   record that enforces it across restarts.

Each answer must name a vetted primitive from a maintained library. Per master
rule 11, no primitive is to be designed here.

## Boundary the current code already fixes

Phase 1's crypto changes the `payload` field and adds authentication fields. It
does not change `v`, `type`, `id`, `from`, `to`, `seq`, or `ts`, and it does not
change the canonical encoding in `packages/protocol/src/codec.ts` — that
function defines the bytes a signature will cover, which is why it is pinned by
a golden-bytes fixture.

The `Transport` interface moves opaque frames. Adding encryption above it
requires no transport change, which is the property Phase 0 exists to establish.

## Stop condition

If any of the seven items above is unresolved when Phase 1 implementation would
begin, the correct response is `BLOCKED_SECURITY_DECISION`. Per the Phase 1
prompt, encryption is not to be weakened to obtain a demo PASS.
