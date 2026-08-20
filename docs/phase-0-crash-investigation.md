# Open issue — release APK closes at launch

**Status:** unresolved, blocking the Phase 0 device gate.
**Symptom:** "Hudyat RCN (Phase 0) has stopped" immediately on launch.
Reproduced on v0.1.0 and v0.1.1. No on-screen error in either.

## What this tells us

v0.1.1 added a React error boundary, made `requireNativeModule` lazy, and
guarded the async paths. None of it produced a message, so the crash is
**native, before React renders**. No JS-level defence can surface it — the
Android crash log is the only source of the actual cause.

## Ruled out, with evidence

| Hypothesis | Evidence against |
| --- | --- |
| Native module missing from APK | `RcnTransportModule` present in `classes2.dex`/`classes3.dex` |
| JS bundle not embedded | `assets/index.android.bundle` present, 1.2 MB |
| Nearby SDK missing | `play-services-nearby.properties` bundled |
| Permissions lost in manifest merge | All present with API-level splits intact |
| R8/ProGuard stripping classes | `minifyEnabled` resolves to `false` (default) |
| Import-time `requireNativeModule` throw | Made lazy in v0.1.1; crash unchanged |
| `TextEncoder` missing in Hermes | Real bug, fixed in b3f5c7c — but fires on first send, not at launch |

## Leading hypotheses, untested

1. **Expo 57 / RN 0.86 release path with New Architecture.** `newArchEnabled=true`
   and this stack is very new. Highest prior.
2. **Hermes bytecode / release bundle loading.** Would crash natively before JS.
3. **`edgeToEdgeEnabled=true` in `gradle.properties` while
   `react-native-edge-to-edge` is not installed.** Nothing in the generated Java
   references it, so this is weak — but it is an inconsistency.

Our Kotlin is a low prior: it compiles, and Expo modules are not constructed
until first use, which v0.1.1 deferred.

## Next session — do this first

Phone: Developer options → USB debugging → on → plug in → "Allow" on the prompt.

```bash
"$LOCALAPPDATA/Android/Sdk/platform-tools/adb.exe" devices
```

Clear the buffer, launch the app, reproduce the crash, then read the trace:

```bash
"$LOCALAPPDATA/Android/Sdk/platform-tools/adb.exe" logcat -c && "$LOCALAPPDATA/Android/Sdk/platform-tools/adb.exe" logcat -b crash -d
```

If `-b crash` is empty, widen it:

```bash
"$LOCALAPPDATA/Android/Sdk/platform-tools/adb.exe" logcat -d -v time | grep -iE "ph.hublikha.rcn|AndroidRuntime|FATAL|hermes|SoLoader"
```

Installing over USB is also faster than sideloading:

```bash
"$LOCALAPPDATA/Android/Sdk/platform-tools/adb.exe" install -r dist/hudyat-rcn-phase0-v0.1.1.apk
```

## If the trace points at Expo 57 / RN 0.86

Fallback is pinning to Expo SDK 56, where the release path is better proven.
That is a `package.json` change plus `npx expo install --fix` and a clean
prebuild — the protocol package is unaffected, and the Kotlin module needs at
most a dependency bump. Do this only if the log supports it.

## Then switch to wireless

Once the app launches, pair over Wi-Fi so the phones can be moved apart for
discovery-range testing. Developer options → Wireless debugging → Pair device
with pairing code.

```bash
"$LOCALAPPDATA/Android/Sdk/platform-tools/adb.exe" pair HOST:PORT
```

`adb` over Wi-Fi keeps working on a LAN with no Internet, so this stays usable
during the WAN-off matrix.

## Known-good state

Everything below the app shell is verified and unaffected by this bug:

- `packages/protocol` — 33 tests passing, no platform dependencies
- `modules/rcn-transport` — compiles, `:rcn-transport:assembleDebug` produces an AAR
- App typecheck clean; release APK builds
