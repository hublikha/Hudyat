# Phase 1 handoff

**Status:** Phase 0 PASS (founder-approved). Phase 1 authorised and started.
**Last commit:** `d764897`
**Next action:** build the identity module — Kotlin Keystore + TypeScript wrapper.

## Where the project stands

| Piece | State |
| --- | --- |
| `packages/protocol` | Done for Phase 0. 33 tests. Wire format pinned by a golden fixture. |
| `packages/core` | Schema + migration runner. 17 tests against `node:sqlite`. |
| `modules/rcn-transport` | Nearby adapter, proven on two phones with WAN off. |
| `apps/mobile` | Phase 0 diagnostic screen only. **Not** a product surface; must not ship. |
| ADRs | 0001 transport, 0002 crypto boundary (closed), 0003 dual-path, 0004 Phase 1 crypto. |

Phase 0 evidence is in `docs/phase-0-results.md`. Phase 1 crypto decisions are in
`docs/adr/0004-phase-1-cryptography.md` and are binding — read it before writing
any crypto code.

## Done in this session

1. **Phase 0 qualification passed** on two physical devices with the router's
   WAN uplink removed. Five defects found that no static check could reach.
2. **ADR 0003** — dual-path (LAN + Internet) architecture, mostly deferred.
   Its open question was answered by the Phase 0 run: Nearby did **not** take
   the Wi-Fi radio from the router, so LAN and Nearby transports can coexist.
3. **ADR 0004** — Phase 1 cryptography. Closes all seven ADR 0002 decisions.
4. **`packages/core`** — the full Family schema and a migration runner.

## Build order from here

Each step ends with tests, and steps 1–2 end with a real-device check, because
Phase 0 established that native behaviour is not predictable from a clean build.

1. **Identity** — Kotlin: generate a non-exportable P-256 keypair in the Android
   Keystore, report its backing level (StrongBox / TEE / software), sign with
   `SHA256withECDSA`. TypeScript wrapper over it. Derive `DeviceId` as
   `hex(SHA-256(SPKI)[0..16])` so the existing 32-hex format is unchanged.
2. **Agreement key** — X25519 via `@noble/curves`, private key sealed at rest
   with AES-256-GCM under a non-exportable Keystore AES key. The X25519 public
   key is signed by the identity key; that signature is the hardware anchor.
3. **Envelope v2** — `payload` becomes XChaCha20-Poly1305 ciphertext. AAD is the
   canonical encoding of every other field. `v`, `type`, `id`, `from`, `to`,
   `seq`, `ts` and `codec.ts` do **not** change (ADR 0002 fixed this boundary,
   and the golden fixture enforces it).
4. **Pairing** — expiring QR invitation, fingerprint check against the QR, SAS
   comparison, trust record written only after confirmation.
5. **Messaging** — persist-before-send, outbox, retry, duplicate suppression,
   truthful delivery state.
6. **Emergency** — SOS and STATUS as protocol events, never a separate channel.
7. **UI** — the nine screens the phase lists.
8. **Failure tests** — the thirteen the phase lists.

## Constraints that are easy to forget

- **Persist before send.** The frame is built and stored before any transport is
  consulted. No routing decision may affect whether a message survives.
- **`ts` is advisory.** Nothing accepts, rejects, orders, or expires on a
  timestamp. Invitation expiry is enforced by the issuer, not the joiner.
- **Sender `seq` must come from `local_sequence`**, never a variable. Phase 0
  held it in memory and it reset on restart.
- **Discovery is not reachability is not trust.** This conflation caused three
  of the five Phase 0 defects, in three separate layers. Treat it as a review
  checklist item, not a principle: when it appears, enumerate every layer that
  encodes it before fixing any of them.
- **No silent downgrade.** A device that can only manage software key backing
  still works, but the UI says so.
- **The Phase 0 developer screen must not become the chat UI.** It sends
  plaintext and auto-accepts connections.

## Device and tooling notes

Both phones connect over USB. Device A can be driven entirely from the command
line; device B cannot.

| | Device A | Device B |
| --- | --- | --- |
| Model | Infinix X6856, API 36 | Xiaomi M2101K6G (MIUI), API 33 |
| `adb install` | works | works |
| `adb shell input` | works | **blocked** (`INJECT_EVENTS`) |
| `pm grant` | works | **blocked** |

So device B needs a human to tap Start and grant permissions. That is not purely
a nuisance: it means B exercises the real consent flow rather than a bypass.

**`uiautomator dump` returns stale cached content on both devices**, even after
deleting the target file. It caused two wrong conclusions in this session. Use
`screencap` and read the image instead.

Verify installs by hash, not by exit code — `adb install` piped into `tail`
reports the pipe's status, and every build so far reports `versionName=0.1.0`:

```bash
adb -s <serial> shell md5sum $(adb -s <serial> shell pm path ph.hublikha.rcn | sed 's/package://' | tr -d '\r')
```

**Bump the version per build before the Phase 1 qualification**, so evidence does
not depend on hashes to tell builds apart.

## Commands

```bash
npm test
```

```bash
./apps/mobile/android/gradlew -p apps/mobile/android assembleRelease
```

Git Bash mangles device paths; prefix `adb` work with `MSYS_NO_PATHCONV=1`.

## Open items carried forward

- No forward secrecy in Phase 1 (ADR 0004, deliberate, documented).
- Four devices required for the Phase 1 gate; only two are on hand.
- Extender, mesh, guest-isolation and multi-subnet topologies untested; they
  belong with `LanTransport`.
- Root `LICENSE` still unchosen.
