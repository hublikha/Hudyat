# Phase 0 — real-device qualification results

**Date:** 2026-08-20
**Build under test:** `md5 479cee7f0b8490b890d5e0692c46a8af` (v0.1.6, release)
**Verdict:** PASS

Both devices were confirmed to be running byte-identical APKs by comparing the
md5 of the installed `base.apk` on each against the local build, because every
build in this session reports `versionName=0.1.0` and the name alone cannot
distinguish them. See Known limitations.

## Devices

| | Device A | Device B |
| --- | --- | --- |
| Model | Infinix X6856 | Xiaomi M2101K6G |
| Android API | 36 | 33 |
| Wi-Fi | SSID `J_5G`, 192.168.0.193 | SSID `J_5G`, 192.168.0.194 |

Two manufacturers and two API levels, which is worth more than two of the same
phone: the API 33/36 split exercises both branches of the permission model.

## WAN-off control

The router stayed powered with its WAN uplink removed — Topology B, router
without Internet. Verified on both devices immediately before and again
immediately after the packet run:

```text
ping -c 2 -W 3 8.8.8.8   → no reply (timeout)
ping -c 1 -W 3 google.com → ping: unknown host google.com
```

Both remained associated to the router throughout, holding DHCP leases on the
same /24. This is the control for the entire gate: without it a pass could be an
accidental Internet round trip.

## Matrix

| # | Step | Result |
| --- | --- | --- |
| 1 | Both devices on same router | PASS — `J_5G`, 192.168.0.193 / .194 |
| 2 | WAN confirmed unavailable | PASS — ping and DNS both fail, checked twice |
| 3 | A discovers B | PASS — `found 52184fe8 (rcn-52184fe8)` |
| 4 | A connects to B | PASS — CONNECTED on both sides |
| 5 | A sends P1 | PASS — `SENT TEST_PING seq=0 "p0"` |
| 6 | B verifies and decodes P1 | PASS — `RECV TEST_PING seq=0 "p0" from afbe9c0e` |
| 7 | B responds | PASS — `SENT TEST_PONG seq=0 "p0"` |
| 8 | Disconnect | PASS — observed repeatedly, unforced |
| 9 | Reconnect | PASS — 12:36:12 → 12:36:26 → 12:36:37 → 12:36:42 |
| 10 | Send P2 | PASS — seq=1 and seq=2 round trips |
| 11 | Multiple cycles | PASS — 3 WAN-off round trips plus 3 earlier with WAN up |
| 12 | Kill and reopen app | PASS — see below |

### WAN-off packet evidence

Device B, Internet unavailable:

```text
12:44:10.036 RECV TEST_PING seq=0 "p0" from afbe9c0e
12:44:10.054 SENT TEST_PONG seq=0 "p0" to afbe9c0e
12:44:14.149 RECV TEST_PING seq=1 "p1" from afbe9c0e
12:44:14.157 SENT TEST_PONG seq=1 "p1" to afbe9c0e
12:44:18.285 RECV TEST_PING seq=2 "p2" from afbe9c0e
12:44:18.293 SENT TEST_PONG seq=2 "p2" to afbe9c0e
```

Sequence numbers and payloads survive encode → transmit → decode → respond →
decode. Round-trip latency 39–58 ms.

### Restart recovery

App force-stopped on A and reopened, WAN still unavailable:

```text
12:45:19.253 transport STARTING
12:45:21.202 transport READY
12:45:21.287 found 52184fe8
12:46:00.935 52184fe8 CONNECTED
12:46:08.610 SENT TEST_PING seq=0 "p0"
12:46:08.706 RECV TEST_PONG seq=3 "p0"
```

The device id was identical before and after the restart
(`afbe9c0e0037266e93bddb7d7e581f2b`), so identity is durable.

## Finding for ADR 0003

**Nearby did not take the Wi-Fi radio away from the router.** Both devices kept
their DHCP leases on 192.168.0.0/24 while advertising, discovering, connecting,
and exchanging payloads.

ADR 0003 records this as the most consequential unknown in the dual-path design,
because if Nearby seized the radio then `LanTransport` and `NearbyTransport`
could not run together and "try both paths" would be unimplementable. On this
hardware they can coexist.

Scope honestly: one router, one session, two devices. It is evidence that
coexistence is possible, not that it always holds — Nearby may still switch
mediums under load or on other hardware. Re-check when `LanTransport` is built.

## Defects found on hardware

Five, none reachable from the compiler, the protocol tests, or the typecheck.

| Defect | Effect if shipped |
| --- | --- |
| `expo-crypto` resolved off the SDK-57 line | App never launches |
| AsyncFunctions returned a Play Services `Task` | Every `send` rejects |
| Own advertisement discovered as a peer | Device lists itself as family |
| Kotlin dropped the endpoint on loss of discovery | `send` fails on an open link |
| UI could not re-add a peer that connected after being undiscovered | Working link invisible, no way to message |

The last three are the same mistake — treating discovery as reachability — in
three separate layers. That distinction is the one ADR 0003 exists to protect,
and it was violated three times in code written before the ADR was read back.
Phase 1 should treat it as a review checklist item, not a principle.

## Known limitations

- **Sequence numbers are in-memory and reset on restart.** Visible above: A
  restarted and sent `seq=0` while B continued at `seq=3`. Correct for Phase 0,
  but Phase 1's durable outbox must persist the counter or duplicate suppression
  breaks across restarts.
- **Frames are unencrypted and unauthenticated.** By design — ADR 0002.
- **Connections are auto-accepted.** Phase 0 keeps the spike unattended; Phase 1
  replaces this with verified pairing.
- **Two devices, not four.** Phase 1 requires a four-device matrix.
- **Untested topologies:** extender, repeater, mesh, guest/client isolation,
  separate subnets, router reboot. All deferred with `LanTransport`.
- **Every build reports `versionName=0.1.0`.** Builds were distinguished by md5.
  Bump the version per build before Phase 1 so evidence is unambiguous.
- **Tooling:** `uiautomator dump` returns stale cached content on both devices
  even after deleting the target file, which caused two wrong conclusions about
  taps not registering. Screenshots are ground truth here.
- **MIUI blocks `pm grant` and input injection**, so device B was driven by hand.
  Its permission grants therefore went through the real consent flow, which is
  the more faithful test.
