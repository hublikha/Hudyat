# Phase 0 — Real-Device Test Procedure

Two physical Android devices are required. An emulator cannot satisfy this gate:
Nearby Connections needs real Bluetooth and Wi-Fi radios, and the point of the
test is that the radios work when WAN does not.

Record results in `docs/phase-0-evidence.md` (create it from the template at the
bottom). A leg that was not observed is not a pass.

## Device requirements

- Android 8.0 (API 24) or newer.
- Google Play Services present. Devices without it are out of scope — ADR 0001.
- Location and Bluetooth toggles on. Nearby needs the radios enabled, not just
  the permission granted; this trips people up because the app-level permission
  prompt succeeds while discovery silently returns nothing.

## Establishing WAN-off

Do all of the following on both devices, then verify:

1. Enable airplane mode.
2. Re-enable Bluetooth and Wi-Fi (airplane mode turns them off; Nearby needs
   them and this is exactly the "infrastructure degraded" shape we are proving).
3. Confirm mobile data is off.
4. Verify no Internet: open a browser to any URL and confirm it fails.

Step 4 is not a formality. It is the control for the whole test — without it, a
pass could be an accidental Internet round trip, which is precisely the silent
fallback the master rules forbid.

The app must be installed **before** WAN goes off — see below.

## Installing the test build

Use a **release** APK, not a debug build. A debug build loads its JavaScript
from the Metro dev server, so it cannot start with WAN unavailable — which would
fail the test for a reason that has nothing to do with the transport. The release
APK embeds the bundle and needs no network and no PC.

Build it:

```bash
./apps/mobile/android/gradlew -p apps/mobile/android assembleRelease
```

Output: `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`

Install on each device by either route:

- **By file** — copy the APK to the phone, open it, and allow installation from
  unknown sources when prompted. No cable needed.
- **By cable** — enable Developer Options and USB debugging on the phone, then
  `adb install -r app-release.apk`.

The APK is signed with the standard Android debug keystore. That is fine for
sideloading onto test devices and is **not** suitable for distribution: the key
is public and shared by every debug build on earth. A real signing key is a
Phase 2 concern and is out of scope here.

Both devices must run the **same build**. A protocol change between them would
show up as a decode rejection, which is a real finding but not the one this
matrix is testing for.

## Test matrix

| # | Step | Expected | Result |
| --- | --- | --- | --- |
| 1 | Launch app on A and B | Each shows a persistent 32-hex device id | |
| 2 | Confirm WAN unavailable on both | Browser fails to load | |
| 3 | Tap Start on both | Status reaches `READY` | |
| 4 | Wait for discovery | A lists B; B lists A | |
| 5 | A taps Connect on B | Both show `CONNECTED` | |
| 6 | A taps Ping | A logs `SENT TEST_PING` | |
| 7 | B receives | B logs `RECV TEST_PING` with matching payload | |
| 8 | B auto-replies | A logs `RECV TEST_PONG`, payload echoes the ping | |
| 9 | A taps Disconnect | Both show `DISCONNECTED` | |
| 10 | Reconnect | Both return to `CONNECTED` | |
| 11 | Send `P2` | Round trip succeeds again | |
| 12 | Repeat 9–11 at least three times | Every cycle succeeds | |
| 13 | Force-stop and reopen A | Same device id as step 1; Start works; round trip succeeds | |

Step 13 is why the device id is persisted. A new id after restart means identity
is not durable, and Phase 1's trust store would inherit that bug.

## Negative checks

These confirm the validation path is real rather than untested code.

| # | Step | Expected |
| --- | --- | --- |
| N1 | Stop the transport on B, then Ping from A | A logs `SEND FAILED`, no silent success |
| N2 | Deny a permission at the prompt, then Start | App reports which permission was denied and does not start |
| N3 | Move devices out of range | Peer disappears from the list |

Malformed-frame rejection is covered by the automated tests in
`packages/protocol` and does not need a device.

## Recording evidence

Note device model, Android version, and API level. Do not record IMEIs, serial
numbers, or account identifiers. Device ids may be recorded truncated to the
first 8 hex characters, matching what the UI shows.

## Evidence template

```text
DATE:
DEVICE A:                    (model / Android version / API)
DEVICE B:
WAN-OFF METHOD:
WAN-OFF VERIFIED BY:

MATRIX 1-13:                 (result per row)
NEGATIVE N1-N3:
RECONNECT CYCLES COMPLETED:
ROUND TRIPS ATTEMPTED / SUCCEEDED:
DISCOVERY TIME (typical):
FAILURES OBSERVED:
KNOWN LIMITATIONS:
VERDICT:                     PASS | BLOCKED_REAL_DEVICE | BLOCKED_VERIFICATION
```
