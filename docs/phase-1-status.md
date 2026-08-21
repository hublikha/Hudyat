# Phase 1 — build status

**Single-device behaviour is verified on hardware. Two-device behaviour is not
yet tested at all.**

## Verified on a real phone

Infinix X6856, Android API 36, build v0.2.0. Self-test: **17 of 17 pass**.

| Check | Result |
| --- | --- |
| Keystore identity | **TEE** — the key is in secure hardware and cannot be extracted |
| Keystore signing | 70-byte ECDSA |
| Keystore sealing | 32 bytes sealed to 60 and recovered |
| Sealing non-deterministic | passes — the platform is not reusing a GCM nonce |
| UTF-8 and base64 under Hermes | round trip including emoji |
| Key agreement | both sides reach the same key |
| Encrypt and decrypt | sealed and opened with authenticated header |
| Tamper rejection | a redirected message fails authentication |
| Envelope encoding | encode and decode agree |
| Migrations | schema v1, foreign keys on |
| Sequence survives restart | allocated 2 then 3, continuing across a reinstall |
| Duplicate suppression | a repeated message id is refused |
| Untrusted sender | a message from an unknown device is refused |

The sequence row is the Phase 0 defect — the counter that reset to zero on
restart — demonstrated fixed on the device rather than in Node.

The key backing level differs by manufacturer and is worth recording per phone.
This one reports TEE; a phone that could only manage software backing would
still work and would say so on screen.

## Verified in Node

131 tests across `@rcn/protocol` and `@rcn/core`, run against the real SQLite
engine and the real cryptography — but on V8, and against no Keystore. That
distinction is the reason the self-test exists.

## Not yet tested

**Everything that needs two phones.** Only one device has been connected since
the Phase 1 app was built:

- pairing, including the HELLO exchange, fingerprint check and spoken digits
- chat in either direction
- delivery states progressing from waiting to delivered
- queue recovery when a peer goes out of range and returns
- SOS and status reaching another device
- revocation stopping a removed device
- the WAN-off proof, repeated for Phase 1 traffic

## What two devices still cannot prove

The Phase 1 gate asks for four. Three rows stay open regardless:

- **SOS fan-out** — "reaches reachable trusted members" needs a sender and at
  least two recipients.
- **Partial reachability** — one member in range while another is not, the
  realistic emergency case and where queueing matters most.
- **Four-device enrolment** — whether pairing holds up as a family grows.

Recorded rather than redefined. "Verified on two devices, fan-out pending"
survives scrutiny; a claimed PASS without the four-device matrix would not.

## Device session plan

1. **Self-test on the second phone.** Record its key backing level.
2. **Onboarding** on both. Create a family on one.
3. **Pairing** — show the code, scan it, compare six digits, confirm on both.
   This is the first exercise of the HELLO exchange and the most likely place
   to find something.
4. **Chat** both ways. State should read "Waiting to send" then "Delivered".
5. **Queue recovery** — take one phone out of range, send, confirm it stays
   waiting, bring it back, confirm delivery without duplication.
6. **Restart** both. Identity, history and queue must survive.
7. **Emergency** — SOS and "I'm safe", then check Family Status.
8. **Revocation** — remove the second phone, confirm it can no longer deliver.
9. **WAN off** — unplug the router's internet, verify `8.8.8.8` fails on both,
   then repeat 4 to 7.

## Defects found on hardware so far

Phase 0 found five. Phase 1 has found two, both by the self-test on its first
run, and neither reachable from the Node suite:

- **Packet types were validated against keys rather than values.** It passed for
  the Phase 0 types only because each key equalled its own value. Every real
  family message would have been rejected on decode.
- **Creating a family never updated state.** The home screen showed its
  placeholder title, which looked like success while `family_id` was missing
  for every send.

Both are fixed. The first also closed a test gap: the suite now round-trips
every declared packet type.

## Known limitations

- No forward secrecy (ADR 0004, deliberate and documented).
- iOS is out of reach without a Mac and an iPhone; Phase 2 is blocked.
- Phase 3 carries a `BLOCKED_SUBSCRIPTION` condition for hosted sync.
- The repository lives inside OneDrive, whose sync client contends with Gradle
  over build outputs. If a build fails with `EBUSY`, stop the Gradle daemons and
  retry.
