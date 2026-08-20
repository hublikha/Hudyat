# RCN Architecture — Phase 0

**Baseline:** `00_RCN_FINAL_WHITEPAPER.md`. This document describes what exists
now, not the target system.

## Layering

```
apps/mobile          Expo dev build. Phase 0: developer screen only.
       |
packages/protocol    RCN/1 envelope, canonical codec, Transport interface.
       |
modules/rcn-transport  Kotlin Nearby Connections adapter.
```

The dependency arrow points one way. `packages/protocol` imports nothing from
the transport module and has no React Native or Android dependency — it is plain
TypeScript, which is why its tests run in bare Node.

## The transport boundary

`Transport` moves opaque `Uint8Array` frames between device ids. It does not
know the envelope exists. The protocol layer owns encode/decode; the adapter
owns radios, discovery, and connection lifecycle.

Two rules keep this boundary honest:

1. **No SDK type crosses it.** Nearby's `Payload`, `ConnectionInfo`, and
   endpoint types stay inside the adapter.
2. **No caller reaches around it.** Domain code depends on the interface, never
   on a concrete adapter.

This is what makes the transport replaceable. Swapping Nearby for Wi-Fi Direct
should touch one class and no tests in `packages/protocol`.

### Discovery is not trust

The transport reports which devices are *reachable*. Nothing more. A discovered
peer is an untrusted stranger asserting a device id, and Phase 0 has no way to
check that assertion — see [ADR 0002](adr/0002-cryptography-decision-boundary.md).

Trust is a separate, explicit, persisted decision that Phase 1 introduces. No
code may treat presence on the transport as membership.

### Adapter-local identifiers are not identity

Nearby's `endpointId` is a handle that changes between sessions. It is exposed
as `Peer.endpointId`, documented as opaque, and must never be persisted or used
as a trust key. Identity is `Peer.deviceId`.

## Local-first posture

Phase 0 requires no backend, no account, and no Internet, and there is no code
path that reaches for one. The real-device test runs with WAN disabled
specifically so that an accidental Internet dependency fails the test instead of
hiding inside a passing one.

Per master rule 16, there is no silent fallback from a local transport to a
network one.

## Where Phase 1 attaches

- **Crypto** sits above the transport and below the domain: the payload becomes
  ciphertext, the envelope gains authentication fields, and the `Transport`
  interface does not change. Phase 0 exists partly to establish that.
- **Persistence** (SQLite) attaches above the protocol. Phase 0 holds no durable
  state; persist-before-send arrives with the outbox in Phase 1.
- **Domain** (family, membership, conversations) is not yet present. The Phase 0
  developer screen talks to the transport directly, which is acceptable for a
  diagnostic tool and is not a template for product code.

## Deliberately absent

No backend, no state store, no retry, no queue, no domain model, no product UI.
Per master rule 7, none of these are scaffolded ahead of the phase that needs
them.
