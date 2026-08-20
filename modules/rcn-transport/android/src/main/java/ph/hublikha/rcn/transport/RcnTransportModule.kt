package ph.hublikha.rcn.transport

import android.util.Base64
import com.google.android.gms.nearby.Nearby
import com.google.android.gms.nearby.connection.AdvertisingOptions
import com.google.android.gms.nearby.connection.ConnectionInfo
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback
import com.google.android.gms.nearby.connection.ConnectionResolution
import com.google.android.gms.nearby.connection.ConnectionsClient
import com.google.android.gms.nearby.connection.ConnectionsStatusCodes
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo
import com.google.android.gms.nearby.connection.DiscoveryOptions
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback
import com.google.android.gms.nearby.connection.Payload
import com.google.android.gms.nearby.connection.PayloadCallback
import com.google.android.gms.nearby.connection.PayloadTransferUpdate
import com.google.android.gms.nearby.connection.Strategy
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.ConcurrentHashMap

private const val SERVICE_ID = "ph.hublikha.rcn.v1"
private val STRATEGY = Strategy.P2P_STAR

/**
 * Nearby Connections adapter for the RCN transport contract (ADR 0001).
 *
 * Everything Nearby-specific is confined to this class. Frames cross the bridge
 * as base64 and are opaque here — this module never parses an RCN envelope.
 */
class RcnTransportModule : Module() {

  private val client: ConnectionsClient
    get() = Nearby.getConnectionsClient(
      appContext.reactContext ?: throw CodedException("ERR_NO_CONTEXT", "React context unavailable", null),
    )

  /** deviceId -> endpointId for peers we have seen advertise. */
  private val endpointByDevice = ConcurrentHashMap<String, String>()

  /** endpointId -> deviceId, so Nearby callbacks can be mapped back to identity. */
  private val deviceByEndpoint = ConcurrentHashMap<String, String>()

  private val connected = ConcurrentHashMap.newKeySet<String>()

  @Volatile private var localDeviceId: String? = null

  override fun definition() = ModuleDefinition {
    Name("RcnTransport")

    Events(
      "onStateChanged",
      "onPeerFound",
      "onPeerLost",
      "onPeerConnectionChanged",
      "onFrameReceived",
    )

    AsyncFunction("start") { deviceId: String, displayName: String ->
      localDeviceId = deviceId
      emitState("STARTING")

      // The advertised name carries the device id so a discovered peer can be
      // mapped to protocol identity. This is a claim, not proof — see ADR 0002.
      val advertisedName = "$deviceId|$displayName"

      client.startAdvertising(
        advertisedName,
        SERVICE_ID,
        connectionLifecycle,
        AdvertisingOptions.Builder().setStrategy(STRATEGY).build(),
      ).addOnFailureListener { emitState("ERROR", "advertise failed: ${it.message}") }

      client.startDiscovery(
        SERVICE_ID,
        endpointDiscovery,
        DiscoveryOptions.Builder().setStrategy(STRATEGY).build(),
      )
        .addOnSuccessListener { emitState("READY") }
        .addOnFailureListener { emitState("ERROR", "discovery failed: ${it.message}") }

      // Every AsyncFunction here must end in Unit. A Play Services call returns a
      // Task, Kotlin returns the last expression implicitly, and the bridge then
      // tries to serialize it and rejects the promise with "Unknown type: class
      // com.google.android.gms.tasks.zzw". Nearby still starts, so the failure
      // shows up as a rejected call rather than a broken transport.
      Unit
    }

    AsyncFunction("stop") {
      client.stopAdvertising()
      client.stopDiscovery()
      client.stopAllEndpoints()
      endpointByDevice.clear()
      deviceByEndpoint.clear()
      connected.clear()
      localDeviceId = null
      emitState("STOPPED")
    }

    AsyncFunction("connect") { deviceId: String ->
      val endpoint = endpointByDevice[deviceId]
        ?: throw CodedException("ERR_UNKNOWN_PEER", "No discovered endpoint for $deviceId", null)
      val local = localDeviceId
        ?: throw CodedException("ERR_NOT_STARTED", "Transport is not started", null)

      emitConnection(deviceId, "CONNECTING")
      client.requestConnection(local, endpoint, connectionLifecycle)
        .addOnFailureListener { emitConnection(deviceId, "DISCONNECTED") }
      Unit
    }

    AsyncFunction("disconnect") { deviceId: String ->
      endpointByDevice[deviceId]?.let { client.disconnectFromEndpoint(it) }
      connected.remove(deviceId)
      emitConnection(deviceId, "DISCONNECTED")
    }

    AsyncFunction("send") { deviceId: String, frameBase64: String ->
      val endpoint = endpointByDevice[deviceId]
        ?: throw CodedException("ERR_UNKNOWN_PEER", "No endpoint for $deviceId", null)
      if (!connected.contains(deviceId)) {
        throw CodedException("ERR_NOT_CONNECTED", "Not connected to $deviceId", null)
      }
      val bytes = Base64.decode(frameBase64, Base64.NO_WRAP)
      client.sendPayload(endpoint, Payload.fromBytes(bytes))
      Unit
    }
  }

  private fun emitState(state: String, detail: String? = null) {
    sendEvent("onStateChanged", mapOf("state" to state, "detail" to detail))
  }

  private fun emitConnection(deviceId: String, state: String) {
    sendEvent("onPeerConnectionChanged", mapOf("deviceId" to deviceId, "state" to state))
  }

  private val endpointDiscovery = object : EndpointDiscoveryCallback() {
    override fun onEndpointFound(endpointId: String, info: DiscoveredEndpointInfo) {
      val parts = info.endpointName.split("|", limit = 2)
      val deviceId = parts.getOrNull(0)?.takeIf { it.length == 32 } ?: return
      val displayName = parts.getOrNull(1).orEmpty()

      // Observed on device: our own advertisement can come back through the BLE
      // medium while we both advertise and discover. Nearby is not documented to
      // do this, which is the reason to filter here rather than trust it not to —
      // a device listing itself as a peer would corrupt the peer model.
      if (deviceId == localDeviceId) return

      endpointByDevice[deviceId] = endpointId
      deviceByEndpoint[endpointId] = deviceId
      sendEvent(
        "onPeerFound",
        mapOf("deviceId" to deviceId, "endpointId" to endpointId, "displayName" to displayName),
      )
    }

    override fun onEndpointLost(endpointId: String) {
      val deviceId = deviceByEndpoint[endpointId] ?: return

      // Nearby stops advertising a peer once it connects, so this fires during
      // normal operation on a healthy link. Dropping the endpoint mapping here
      // made send() fail with "No endpoint" on a connection that was still open.
      // Losing discovery is not losing the peer; only onDisconnected is.
      if (connected.contains(deviceId)) {
        sendEvent("onPeerLost", mapOf("deviceId" to deviceId))
        return
      }

      deviceByEndpoint.remove(endpointId)
      endpointByDevice.remove(deviceId)
      sendEvent("onPeerLost", mapOf("deviceId" to deviceId))
    }
  }

  private val connectionLifecycle = object : ConnectionLifecycleCallback() {
    override fun onConnectionInitiated(endpointId: String, info: ConnectionInfo) {
      val deviceId = info.endpointName.split("|", limit = 2).getOrNull(0)
      if (deviceId != null && deviceId.length == 32) {
        endpointByDevice[deviceId] = endpointId
        deviceByEndpoint[endpointId] = deviceId
      }
      // Phase 0 auto-accepts to keep the spike unattended. Phase 1 replaces this
      // with the verified pairing decision — see ADR 0002.
      client.acceptConnection(endpointId, payloadCallback)
    }

    override fun onConnectionResult(endpointId: String, resolution: ConnectionResolution) {
      val deviceId = deviceByEndpoint[endpointId] ?: return
      if (resolution.status.statusCode == ConnectionsStatusCodes.STATUS_OK) {
        connected.add(deviceId)
        emitConnection(deviceId, "CONNECTED")
      } else {
        connected.remove(deviceId)
        emitConnection(deviceId, "DISCONNECTED")
      }
    }

    override fun onDisconnected(endpointId: String) {
      val deviceId = deviceByEndpoint[endpointId] ?: return
      connected.remove(deviceId)
      emitConnection(deviceId, "DISCONNECTED")
    }
  }

  private val payloadCallback = object : PayloadCallback() {
    override fun onPayloadReceived(endpointId: String, payload: Payload) {
      val deviceId = deviceByEndpoint[endpointId] ?: return
      val bytes = payload.asBytes() ?: return
      sendEvent(
        "onFrameReceived",
        mapOf("from" to deviceId, "frame" to Base64.encodeToString(bytes, Base64.NO_WRAP)),
      )
    }

    override fun onPayloadTransferUpdate(endpointId: String, update: PayloadTransferUpdate) = Unit
  }
}
