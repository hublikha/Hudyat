# RCN Threat Model — Phase 0

**Scope:** the feasibility spike only. Phase 0 has no application cryptography,
so most of this document describes exposure that is *accepted for now* and the
Phase 1 work that closes it. Read it as a to-do list, not a security posture.

## What we are protecting, eventually

Family message content and metadata; the integrity of trust decisions; and the
authenticity of emergency events. In Phase 0 none of these exist yet — there is
no user content, no trust store, and no SOS.

## Attacker model

Assume an attacker within radio range who can run a modified client, observe and
inject frames, replay captured frames, and restart devices at will. Assume phone
clocks are wrong. Assume the transport SDK is not hostile but is not trusted to
provide application guarantees.

Out of scope for Phase 0: a physically compromised unlocked device, a malicious
OS, and supply-chain compromise of the toolchain.

## Phase 0 exposure (accepted, time-boxed)

| # | Exposure | Status |
| --- | --- | --- |
| T1 | **Identity spoofing.** `from` is self-asserted; any device can claim any id. | Open — ADR 0002 §1 |
| T2 | **Eavesdropping.** Frames are plaintext above the transport. Nearby's link encryption is a transport property and is not the product's confidentiality story. | Open — ADR 0002 §4 |
| T3 | **Tampering.** No authentication tag; a modified frame that stays well-formed is accepted. | Open — ADR 0002 §4 |
| T4 | **Replay.** A captured frame can be re-injected and will decode. | Open — ADR 0002 §5 |
| T5 | **Unauthorized peers.** Any nearby device can connect; there is no membership check. | Open — Phase 1 trust store |

These are acceptable only because Phase 0 carries no user data and its screen is
a diagnostic tool that does not ship. The moment real content flows, T1–T5 are
release blockers.

## Already mitigated in Phase 0

**Malformed and hostile input.** All network input is treated as hostile.
`decodeEnvelope` validates every field before any value is used, rejects unknown
fields rather than ignoring them, and caps payload size. Rejection is total —
a bad frame is never partially applied.

**Wire-format drift.** The canonical encoding is pinned by a golden-bytes
fixture, so a change that would silently break signature verification between
builds fails a test instead.

**Version confusion.** A frame with an unexpected `v` is rejected rather than
best-effort parsed.

**Clock manipulation.** `ts` is advisory. No Phase 0 logic branches on it, so a
wrong or attacker-controlled clock cannot change behavior. Phase 1 must keep
this property: freshness is the replay window, not a timestamp comparison.

**Transport capture.** Because the adapter cannot define application semantics,
a compromised transport can drop, delay, or reorder frames but cannot forge an
application-level guarantee it does not have. Phase 0's guarantees are thin
enough that this is currently a weak claim; it becomes load-bearing in Phase 1.

**Log disclosure.** Frame payloads are not written to logs. Per master security
requirement, plaintext content stays out of diagnostics unless explicitly
enabled in a development-only fixture.

## Availability

Radio jamming and battery exhaustion are unmitigated and largely unmitigable at
this layer. The product answer is degradation, not prevention: Phase 1 persists
before sending so that an unreachable peer produces a truthfully queued message
rather than a lost one.

## Privacy

Device ids are random and carry no personal information. Discovery broadcasts a
display name, which is user-visible metadata — Phase 1 should default it to
something non-identifying rather than a phone's model or owner name.

No analytics, no telemetry, no network egress.

## Review trigger

Revisit before Phase 1 implementation begins, and whenever a transport is added,
the envelope changes, or persisted state is introduced.
