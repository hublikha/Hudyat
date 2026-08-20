# ADR 0003 — Dual-path transport architecture (LAN and Internet)

**Status:** Accepted (architecture), implementation mostly deferred
**Date:** 2026-08-20
**Supersedes:** nothing
**Relates to:** ADR 0001 (transport choice), ADR 0002 (cryptography boundary)

## Context

The founder raised a clarification: RCN must support two independent
communication paths — Internet when it exists, and local networking when it does
not — and the local path must work through ordinary consumer equipment (router,
access point, extender, repeater, mesh node) with the WAN down.

The important correction in that request is terminological, and it is right:
**once WAN connectivity disappears the ISP is irrelevant.** What determines
whether two devices can talk is whether they are routable to each other at the
IP layer. "Same Wi-Fi network" is not the condition, and is not even sufficient —
client isolation can place two devices on one SSID with no path between them.

## Decision

Adopt the dual-path model as the target architecture. Implement almost none of
it now.

The Phase 0 review question was whether the existing abstraction can carry this
cleanly. It can. `Transport` in `packages/protocol/src/transport.ts` already
moves opaque frames between device ids, names no vendor SDK in its signatures,
and is not bypassed by the protocol layer. Adding `LanTransport` alongside
`NearbyTransport` requires no change to the protocol package. That is the
property this ADR exists to protect, and it is already held.

Concretely we accept now:

1. **Reachability is not discovery, and neither is trust.** Three separate
   questions, three separate answers, never collapsed.
2. **Connectivity is not a boolean.** Internet reachability, LAN availability,
   trusted-peer reachability, and gateway reachability are tracked
   independently. `isOnline` is banned as a concept.
3. **One logical message keeps one id across every transport.** Deduplication
   spans transports or it does not work.
4. **Durability precedes route selection.** A message is persisted before any
   transport is consulted, so no routing decision can affect whether it survives.
5. **The same cryptographic treatment applies on every path.** A local network is
   a hostile network. No `if (sameWifi) trust()`, no `if (local) skipEncryption()`.

## Scope classification

**REQUIRED NOW** — cheap, and shapes the interface correctly:

- `canReach(deviceId): Promise<boolean>` on `Transport`. This is the
  discovery-vs-reachability distinction made executable, and it is the only
  honest way to detect client isolation: an active probe, never an inference
  from SSID. Without it the interface quietly encourages treating "discovered"
  as "reachable", which is the exact bug this ADR is trying to prevent.
- A structured connectivity type replacing any single online flag.

**DEFER — Phase 1:** `LanTransport` implementation; router/extender test matrix;
the duplicate-across-transports test, which needs two working transports before
it can mean anything.

**DEFER — Phase 3:** `InternetTransport`, backend sync, gateway. Unchanged from
the white paper, and unchanged by this ADR.

**DEFER until two transports exist:** transport selection policy. A preference
order is untestable and unfalsifiable with one adapter, and writing it now would
be guessing.

**REJECTED from the proposal:**

- Replacing the event-based peer model with `discoverPeers(): AsyncIterable`. An
  async iterable expresses "peer found" but has no natural place for "peer lost",
  and peer loss is precisely what truthful reachability reporting depends on.
- Dropping `connect`/`disconnect` from the interface. Nearby requires an explicit
  connection lifecycle; removing them breaks the working adapter.
- `getCapabilities()`. Speculative while one transport exists. Revisit when the
  second lands and the differences are known rather than imagined.

## Open question that must be answered before any selection policy

**Nearby Connections may take the Wi-Fi radio away from the router.** It uses
Wi-Fi Direct and hotspot mediums and can disassociate the device from the AP.
If it does, `NearbyTransport` and `LanTransport` cannot run at the same time,
and "try both paths" is not implementable as stated.

This is the single most consequential unknown in the dual-path design, it is
answerable only on real hardware, and it should be measured during the Phase 0
device matrix — observe whether the device stays associated to the AP while
Nearby is advertising and discovering.

## Notes toward LanTransport

mDNS is the obvious choice and the weakest one on Android: multicast is dropped
by many consumer routers, suppressed by battery optimization, and requires an
explicit `MulticastLock`. Evaluate UDP broadcast plus TCP, and Android NSD,
against it rather than defaulting to mDNS because it is familiar.

Discovery metadata must stay minimal — no personal names, no family names, no
message content. A hostile device on the same router can spoof any of it, so it
must carry no weight beyond "something is there, go verify it".

## Consequences

The delta is small, which is the finding. Most of the proposal describes
properties the Phase 0 design already has, and the rest belongs to later phases
by the white paper's own sequencing.

The cost of `canReach` is one method on an interface with one implementor. The
cost of omitting it is an interface that invites conflating discovery with
reachability — cheap to add now, expensive to retrofit once call sites exist.

We accept that the Nearby/LAN radio conflict may force a choice rather than a
combination. We would rather discover that on two phones in Phase 0 than design
a routing policy on top of an assumption that hardware does not support.
