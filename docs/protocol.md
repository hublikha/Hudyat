# RCN/1 Protocol

**Status:** Phase 0 spike. Plaintext by design — see
[ADR 0002](adr/0002-cryptography-decision-boundary.md).

Identifier: `RCN/1`. A frame whose `v` is not `1` is rejected, not coerced.

## Envelope

| Field | Type | Meaning |
| --- | --- | --- |
| `v` | int | Protocol version. Must equal `1`. |
| `type` | enum | Packet type. Phase 0: `TEST_PING`, `TEST_PONG`. |
| `id` | hex(16B) | Message id, unique per sender. The duplicate-suppression key. |
| `from` | hex(16B) | Sender device id. **Self-asserted in Phase 0.** |
| `to` | hex(16B) \| null | Recipient device id, or `null` for broadcast. |
| `seq` | uint | Per-device monotonic counter. |
| `ts` | uint | Sender wall-clock ms. Advisory — see below. |
| `payload` | string | Opaque to the protocol. Max 32 KiB UTF-8. |

Unknown fields are rejected rather than ignored: a field this build does not
understand may be one a signature covers, and silently dropping it would let an
attacker strip meaning from a frame.

### `ts` is not trusted

`ts` is the sender's clock and phone clocks are wrong. It is for display and
ordering hints only. Nothing may authorize, expire, or deduplicate on `ts`
alone; ordering within a sender is `seq`, and freshness in Phase 1 will be the
replay window from ADR 0002, not a timestamp comparison.

## Canonical encoding

Frames are UTF-8 JSON with fields emitted in the fixed order above and no
insignificant whitespace. Encoding is a pure function of the envelope's values —
key order in the source object cannot change the output bytes.

This matters because Phase 1 signs and encrypts over exactly these bytes. Two
devices that disagree by one byte disagree on every signature. The format is
pinned by a golden-bytes fixture in `packages/protocol/src/fixtures.ts`; if a
change makes that test fail, the wire format changed and old builds can no
longer talk to new ones.

JSON was chosen for the spike because it is debuggable on real hardware. It is
not a commitment — a compact binary format is a reasonable later change, and the
codec is the only file that would move.

## Validation

`decodeEnvelope` rejects, in order: non-UTF-8 bytes, non-JSON text, non-object
roots, unknown fields, wrong version, unknown packet type, malformed ids (length,
lowercase hex), negative or non-integer `seq`/`ts`, non-string payloads, and
oversized payloads.

All network input is hostile. A rejected frame raises a typed error naming the
offending field; it is never partially applied.

## Phase 0 exchange

```
A --TEST_PING(id=M, seq=n, payload=nonce)--> B
A <--TEST_PONG(id=M', seq=m, payload=nonce)-- B
```

`TEST_PONG` echoes the ping's payload so the round trip is verifiable rather
than merely observable. This is a reachability check, not a delivery receipt —
durable receipts arrive in Phase 1.

## Not in Phase 0

Encryption, authentication, replay rejection, retry, acknowledgement semantics,
store-and-forward, multi-hop, group messaging, SOS, status events.
