# ADR 0001 — Phase 0 transport adapter: Google Nearby Connections

- **Status:** Accepted (Phase 0 only)
- **Date:** 2026-08-20
- **Scope:** Feasibility spike. This decision does not bind Phase 1 or later.

## Context

Phase 0 must prove that two physical Android devices can discover each other,
exchange RCN/1 frames, disconnect, reconnect, and exchange again while WAN is
unavailable. The repository was empty at the time of this decision, so there is
no prior implementation to weigh against the candidates.

The master prompt forbids paid services and backend infrastructure, and requires
that the protocol never import the transport SDK.

## Options considered

**Google Nearby Connections (chosen).** Handles discovery, connection
negotiation, and the Bluetooth/BLE/Wi-Fi radio selection itself. Works with no
access point and no Internet. Costs nothing and needs no account. The cost is a
dependency on Google Play Services, which rules out de-Googled handsets, and an
opaque strategy layer we do not control.

**Raw Wi-Fi Direct (`WifiP2pManager`).** No Play Services dependency and full
control over the socket. Rejected for the spike because peer discovery, group
ownership negotiation, and reconnection are all hand-rolled — that is a large
amount of the exact code whose feasibility the spike is meant to test cheaply.
It stays the leading fallback if Nearby proves unreliable on real devices.

**mDNS/NSD over a shared access point.** Simple and well understood, but it
assumes an access point exists. The product thesis targets scenarios where local
infrastructure is degraded, so an AP-dependent transport cannot be the only one.

**BLE GATT alone.** Throughput is too low for the messaging Phase 1 needs, and
the spike should not prove a transport we already know we must replace.

## Decision

Use Nearby Connections (`P2P_STAR`) as the single Phase 0 Android adapter,
behind the `Transport` interface in `@rcn/protocol`.

## Consequences

- The spike gets discovery and reconnection for free and can focus on proving
  the frame round trip on real hardware.
- Devices without Play Services are out of scope for Phase 0 and must be treated
  as a known limitation in the phase report.
- Nearby's own encryption is a transport detail and is explicitly **not** the
  product's confidentiality story. See ADR 0002.

## Vendor lock-in mitigation

`packages/protocol` has no dependency on the Nearby SDK, and the SDK's types do
not appear anywhere in the `Transport` interface. Everything Nearby-specific
lives inside the adapter in `modules/rcn-transport`. Replacing Nearby means
writing one new class against the same interface; the protocol, its tests, and
the domain layer are untouched.

The `Peer.endpointId` field is the one place an adapter-local identifier is
exposed. It is documented as opaque and must never be persisted or used as a
trust identifier — device identity is `Peer.deviceId`.

## Revisit when

Real-device testing shows unreliable discovery or reconnection; or Phase 3
begins evaluating additional transports; or a target device population without
Play Services enters scope.
