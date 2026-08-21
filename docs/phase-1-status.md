# Phase 1 — build status

**Built and passing in Node. Not yet verified on hardware.**

Everything below compiles and the release APK builds. Nothing here has run on a
phone yet, and Phase 0 established that a clean build says very little: five
defects were found on hardware that no compiler, typecheck, or test could reach.

## What exists

| Layer | State | Verified by |
| --- | --- | --- |
| `packages/protocol` | Envelope, canonical encoding, UTF-8, base64, cryptography | 64 tests |
| `packages/core` | Schema, migrations, repositories, message lifecycle, pairing | 63 tests |
| `modules/rcn-transport` | Nearby adapter | Phase 0 device evidence |
| `modules/rcn-identity` | Keystore P-256, signing, sealing | compiles only |
| `apps/mobile` | Nine screens, engine, self-test | typecheck + release build |

127 tests. All run against the real SQLite engine and the real cryptography, but
in Node on V8 — not Hermes, and not against a real Keystore.

## Security properties, and where they are enforced

| Property | Enforced in |
| --- | --- |
| Identity key never leaves secure hardware | `RcnIdentityModule.kt` |
| Message redirect fails authentication | `crypto.ts` associated data |
| Message reorder fails authentication | same |
| Replay refused across restarts | `processed_message` table |
| Removed device cannot deliver | trust check before decryption |
| Invitation single-use and expiring | issuer-side, `pairing.ts` |
| Key substitution caught | QR fingerprint plus six spoken digits |
| No ambiguous "maybe sent" state | SQL `CHECK` constraint |
| Nothing decided by a timestamp | throughout; sequence orders, clocks only display |

## What two devices cannot prove

The Phase 1 gate asks for four. With two, these rows stay open:

- **SOS fan-out** — "reaches reachable trusted members" needs a sender and at
  least two recipients.
- **Partial reachability** — one member in range while another is not, which is
  the realistic emergency case and the one where queueing matters most.
- **Four-device enrolment** — whether pairing holds up as a family grows.

Everything else is reachable with two: pairing, verification, chat, persistence,
queue recovery, restart, duplicate and replay rejection, revocation, and the
WAN-off proof.

Recording this rather than redefining the gate. "Verified on two devices,
fan-out pending" is a position that survives scrutiny; a claimed PASS without
the four-device matrix is one a technical reviewer would puncture immediately.

## Device session plan

Run in this order, because each step depends on the one before it.

1. **Self-test on both phones.** Home screen, "Run self-test". Sixteen checks
   covering randomness, UTF-8 and base64 under Hermes, Keystore generation,
   signing, sealing, key agreement, encryption, tamper rejection, envelope
   encoding, verification digits, migrations, sequence durability, duplicate
   suppression, and untrusted-sender refusal.

   Record the reported key backing level per phone: STRONGBOX, TEE, or SOFTWARE.
   That is a fact worth having for any proposal, and it differs by manufacturer.

2. **Onboarding.** Name each phone. Create a family on one.

3. **Pairing.** Show the code on the first phone, scan on the second, compare
   the six digits, confirm on both.

4. **Chat.** Send both ways. Check that state reads "Waiting to send" then
   "Delivered".

5. **Queue recovery.** Move one phone out of range, send, confirm it stays
   "Waiting to send", bring it back, confirm it delivers without duplicating.

6. **Restart.** Kill and reopen both. Identity, history, and queue must survive.

7. **Emergency.** Send SOS and "I'm safe". Check Family Status shows the report
   and its time.

8. **Revocation.** Remove the second phone. Confirm it can no longer deliver.

9. **WAN off.** Unplug the router's internet — the Topology B condition from
   Phase 0 — verify `8.8.8.8` fails on both, then repeat steps 4 to 7.

## Known gaps

- **Pairing key exchange is not wired to the transport.** The screens, the
  invitation, the fingerprint check, the digits, and the trust write are all
  built and tested, but the step where two phones exchange their keys over
  Nearby is not connected. Pairing will not complete on hardware until it is.
  This is the next piece of work and it is deliberately not being claimed as
  finished.
- No forward secrecy (ADR 0004, deliberate).
- Nothing verified on a real Keystore.
- iOS is out of reach without a Mac and an iPhone; Phase 2 is blocked.
- Phase 3 carries a `BLOCKED_SUBSCRIPTION` condition for hosted sync.
