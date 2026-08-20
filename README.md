# Hudyat — Resilient Communications Network (RCN)

> When infrastructure fails, communication should degrade — not disappear.

Local-first communications for families, built to keep working when the
Internet, cellular data, and cloud services do not.

**Current phase: 0 — Feasibility & Protocol Spike.** This repository does not
contain a messenger. It contains a spike that proves two Android devices can
exchange RCN/1 frames with WAN unavailable, plus the protocol and documentation
that Phase 1 will build on.

Architecture baseline: `00_RCN_FINAL_WHITEPAPER.md`.

## Status

| Deliverable | State |
| --- | --- |
| `packages/protocol` — envelope, canonical codec, transport contract | Done, 20 tests passing |
| `modules/rcn-transport` — Nearby Connections adapter (Kotlin) | Implemented |
| `apps/mobile` — developer test screen | Implemented |
| Docs and ADRs | Done |
| Two-device WAN-off proof | **Not yet run** — gates the phase |

Phase 0 is not PASS until the real-device matrix in
[docs/phase-0-test-procedure.md](docs/phase-0-test-procedure.md) is recorded.

## Security posture

**Phase 0 frames are plaintext, unauthenticated, and unsigned.** The `from`
field is a self-asserted claim that nothing verifies. Nearby's link encryption
is a transport detail and is explicitly not the product's confidentiality story.

The developer screen is a diagnostic tool. It must not ship and must not be
reused as a chat surface. See
[ADR 0002](docs/adr/0002-cryptography-decision-boundary.md) for what Phase 1 has
to decide before any user content flows, and
[docs/threat-model.md](docs/threat-model.md) for what is currently exposed.

## Layout

```
packages/protocol      RCN/1 envelope, codec, Transport interface. Plain TS.
modules/rcn-transport  Nearby Connections adapter. All SDK code lives here.
apps/mobile            Expo dev build. Phase 0: developer screen only.
docs/                  Architecture, protocol, threat model, ADRs.
```

The dependency arrow points one way: `packages/protocol` has no React Native,
Android, or Nearby dependency, which is why its tests run in bare Node.

## Requirements

- Node 20+
- JDK 17
- Android SDK with platform 36
- Two physical Android devices with Google Play Services (for the phase gate)

## Getting started

Install and run the protocol tests — these need no device:

```bash
npm install
```

```bash
npm test
```

Generate the native project and build onto a connected device:

```bash
npm run android --workspace=@rcn/mobile
```

## Documentation

- [Architecture](docs/architecture.md) — layering and the transport boundary
- [Protocol](docs/protocol.md) — RCN/1 envelope and canonical encoding
- [Threat model](docs/threat-model.md) — what is and is not mitigated
- [ADR 0001](docs/adr/0001-transport-nearby-connections.md) — transport choice
- [ADR 0002](docs/adr/0002-cryptography-decision-boundary.md) — crypto boundary
- [Test procedure](docs/phase-0-test-procedure.md) — the phase gate

## Phase discipline

One active phase at a time. Phase 1 does not begin until the founder reviews
Phase 0 evidence and authorizes it, and the crypto decisions in ADR 0002 are
resolved. Nothing for a later phase is scaffolded ahead of time.
