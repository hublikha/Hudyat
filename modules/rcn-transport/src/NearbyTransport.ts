import { requireNativeModule } from 'expo-modules-core';
import type {
  DeviceId,
  Peer,
  PeerConnectionState,
  Transport,
  TransportEvents,
  TransportState,
} from '@rcn/protocol';
import { TransportError } from '@rcn/protocol';

import { fromBase64, toBase64 } from './base64';

interface NativeModule {
  start(deviceId: string, displayName: string): Promise<void>;
  stop(): Promise<void>;
  connect(deviceId: string): Promise<void>;
  disconnect(deviceId: string): Promise<void>;
  send(deviceId: string, frameBase64: string): Promise<void>;
  addListener(event: string, handler: (payload: any) => void): { remove(): void };
}

const native = requireNativeModule<NativeModule>('RcnTransport');

const RECOVERABLE_CODES = new Set(['ERR_NOT_CONNECTED', 'ERR_UNKNOWN_PEER']);

function wrap(error: unknown): TransportError {
  const code = (error as { code?: string } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return new TransportError(message, code !== undefined && RECOVERABLE_CODES.has(code));
}

/**
 * Nearby Connections implementation of the RCN transport contract. Nothing
 * Nearby-specific escapes this class — see docs/architecture.md.
 */
export class NearbyTransport implements Transport {
  readonly name = 'nearby-connections';

  #state: TransportState = 'STOPPED';
  #listeners = new Set<Partial<TransportEvents>>();
  #subscriptions: { remove(): void }[] = [];

  get state(): TransportState {
    return this.#state;
  }

  async start(localDeviceId: DeviceId, displayName: string): Promise<void> {
    if (this.#subscriptions.length === 0) {
      this.#attachNativeListeners();
    }
    try {
      await native.start(localDeviceId, displayName);
    } catch (error) {
      this.#setState('ERROR', String(error));
      throw wrap(error);
    }
  }

  async stop(): Promise<void> {
    try {
      await native.stop();
    } finally {
      for (const sub of this.#subscriptions) {
        sub.remove();
      }
      this.#subscriptions = [];
      this.#setState('STOPPED');
    }
  }

  async connect(deviceId: DeviceId): Promise<void> {
    try {
      await native.connect(deviceId);
    } catch (error) {
      throw wrap(error);
    }
  }

  async disconnect(deviceId: DeviceId): Promise<void> {
    try {
      await native.disconnect(deviceId);
    } catch (error) {
      throw wrap(error);
    }
  }

  async send(deviceId: DeviceId, frame: Uint8Array): Promise<void> {
    try {
      await native.send(deviceId, toBase64(frame));
    } catch (error) {
      throw wrap(error);
    }
  }

  subscribe(listener: Partial<TransportEvents>): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit<K extends keyof TransportEvents>(
    event: K,
    ...args: Parameters<TransportEvents[K]>
  ): void {
    for (const listener of this.#listeners) {
      const handler = listener[event] as ((...a: unknown[]) => void) | undefined;
      handler?.apply(listener, args);
    }
  }

  #setState(state: TransportState, detail?: string): void {
    this.#state = state;
    this.#emit('stateChanged', state, detail);
  }

  #attachNativeListeners(): void {
    this.#subscriptions = [
      native.addListener('onStateChanged', (e: { state: TransportState; detail?: string }) => {
        this.#setState(e.state, e.detail);
      }),
      native.addListener('onPeerFound', (peer: Peer) => {
        this.#emit('peerFound', peer);
      }),
      native.addListener('onPeerLost', (e: { deviceId: DeviceId }) => {
        this.#emit('peerLost', e.deviceId);
      }),
      native.addListener(
        'onPeerConnectionChanged',
        (e: { deviceId: DeviceId; state: PeerConnectionState }) => {
          this.#emit('peerConnectionChanged', e.deviceId, e.state);
        },
      ),
      native.addListener('onFrameReceived', (e: { from: DeviceId; frame: string }) => {
        this.#emit('frameReceived', e.from, fromBase64(e.frame));
      }),
    ];
  }
}
