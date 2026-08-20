import { DeviceId } from './ids';

/**
 * Transport contract. Adapters move opaque frames between devices and know
 * nothing about envelope structure; the protocol layer owns encode/decode. No
 * implementation of this interface may leak its vendor SDK types through it,
 * and no domain code may reach around it to a concrete adapter.
 */

export type TransportState =
  | 'STOPPED'
  | 'STARTING'
  | 'READY'
  | 'ERROR';

export interface Peer {
  readonly deviceId: DeviceId;
  /** Adapter-local handle. Opaque to the protocol and domain layers. */
  readonly endpointId: string;
  readonly displayName: string;
}

export type PeerConnectionState = 'DISCOVERED' | 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED';

export interface TransportEvents {
  stateChanged(state: TransportState, detail?: string): void;
  peerFound(peer: Peer): void;
  peerLost(deviceId: DeviceId): void;
  peerConnectionChanged(deviceId: DeviceId, state: PeerConnectionState): void;
  frameReceived(from: DeviceId, frame: Uint8Array): void;
}

export interface Transport {
  readonly name: string;
  readonly state: TransportState;

  start(localDeviceId: DeviceId, displayName: string): Promise<void>;
  stop(): Promise<void>;

  connect(deviceId: DeviceId): Promise<void>;
  disconnect(deviceId: DeviceId): Promise<void>;

  /** Resolves once the adapter has handed the frame to the OS, not on delivery. */
  send(deviceId: DeviceId, frame: Uint8Array): Promise<void>;

  subscribe(listener: Partial<TransportEvents>): () => void;
}

export class TransportError extends Error {
  constructor(
    message: string,
    public readonly recoverable: boolean,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}
