import { Component, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Crypto from 'expo-crypto';
import {
  DeviceId,
  Envelope,
  PROTOCOL_IDENTIFIER,
  PROTOCOL_VERSION,
  PacketType,
  Peer,
  PeerConnectionState,
  TransportState,
  decodeEnvelope,
  encodeEnvelope,
  newMessageId,
} from '@rcn/protocol';
import { NearbyTransport } from '../../modules/rcn-transport';

import { loadOrCreateDeviceId } from './src/deviceIdentity';
import { requestNearbyPermissions } from './src/permissions';

interface LogEntry {
  at: number;
  text: string;
}

type PeerRow = Peer & { connection: PeerConnectionState };

function DeveloperScreen() {
  const transport = useMemo(() => new NearbyTransport(), []);
  const [deviceId, setDeviceId] = useState<DeviceId | null>(null);
  const [state, setState] = useState<TransportState>('STOPPED');
  const [peers, setPeers] = useState<Record<DeviceId, PeerRow>>({});
  const [log, setLog] = useState<LogEntry[]>([]);
  const seq = useRef(0);

  const append = useCallback((text: string) => {
    setLog((prev) => [{ at: Date.now(), text }, ...prev].slice(0, 200));
  }, []);

  useEffect(() => {
    loadOrCreateDeviceId().then(setDeviceId, (error: unknown) => {
      append(`identity failed: ${(error as Error).message}`);
    });
  }, [append]);

  useEffect(() => {
    return transport.subscribe({
      stateChanged: (next, detail) => {
        setState(next);
        append(detail ? `transport ${next}: ${detail}` : `transport ${next}`);
      },
      peerFound: (peer) => {
        setPeers((prev) => ({ ...prev, [peer.deviceId]: { ...peer, connection: 'DISCOVERED' } }));
        append(`found ${short(peer.deviceId)} (${peer.displayName})`);
      },
      peerLost: (lost) => {
        setPeers((prev) => {
          const next = { ...prev };
          delete next[lost];
          return next;
        });
        append(`lost ${short(lost)}`);
      },
      peerConnectionChanged: (id, connection) => {
        setPeers((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id]!, connection } } : prev));
        append(`${short(id)} ${connection}`);
      },
      frameReceived: (from, frame) => {
        try {
          const envelope = decodeEnvelope(frame);
          append(`RECV ${envelope.type} seq=${envelope.seq} "${envelope.payload}" from ${short(from)}`);
          if (envelope.type === PacketType.TEST_PING) {
            void sendPacket(from, PacketType.TEST_PONG, envelope.payload);
          }
        } catch (error) {
          append(`REJECTED frame from ${short(from)}: ${(error as Error).message}`);
        }
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transport, append, deviceId]);

  const sendPacket = useCallback(
    async (to: DeviceId, type: PacketType, payload: string) => {
      if (!deviceId) return;
      const envelope: Envelope = {
        v: PROTOCOL_VERSION,
        type,
        id: newMessageId((n) => Crypto.getRandomBytes(n)),
        from: deviceId,
        to,
        seq: seq.current++,
        ts: Date.now(),
        payload,
      };
      try {
        await transport.send(to, encodeEnvelope(envelope));
        append(`SENT ${type} seq=${envelope.seq} "${payload}" to ${short(to)}`);
      } catch (error) {
        append(`SEND FAILED to ${short(to)}: ${(error as Error).message}`);
      }
    },
    [deviceId, transport, append],
  );

  const start = useCallback(async () => {
    if (!deviceId) return;
    const permission = await requestNearbyPermissions();
    if (!permission.granted) {
      append(`permission denied: ${permission.denied.join(', ')}`);
      return;
    }
    try {
      await transport.start(deviceId, `rcn-${short(deviceId)}`);
    } catch (error) {
      // Includes the case where the native module is not registered at all,
      // which would otherwise be an unhandled rejection and no visible cause.
      append(`start failed: ${(error as Error).message}`);
    }
  }, [deviceId, transport, append]);

  const running = state === 'READY' || state === 'STARTING';

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>{PROTOCOL_IDENTIFIER} · Phase 0 spike</Text>
        <Text style={styles.warning}>
          Diagnostic tool. Frames are unencrypted and unauthenticated.
        </Text>

        <Section label="This device">
          <Text style={styles.mono}>{deviceId ?? 'generating…'}</Text>
          <Text style={[styles.state, running && styles.stateReady]}>{state}</Text>
        </Section>

        <View style={styles.row}>
          <Button label="Start" onPress={start} disabled={running || !deviceId} />
          <Button label="Stop" onPress={() => void transport.stop()} disabled={!running} />
        </View>

        <Section label={`Peers (${Object.keys(peers).length})`}>
          {Object.values(peers).length === 0 ? (
            <Text style={styles.dim}>No peers discovered.</Text>
          ) : (
            Object.values(peers).map((peer) => (
              <View key={peer.deviceId} style={styles.peer}>
                <Text style={styles.mono}>{short(peer.deviceId)}</Text>
                <Text style={styles.dim}>{peer.connection}</Text>
                <View style={styles.row}>
                  {peer.connection === 'CONNECTED' ? (
                    <>
                      <Button
                        label="Ping"
                        onPress={() =>
                          void sendPacket(peer.deviceId, PacketType.TEST_PING, `p${seq.current}`)
                        }
                      />
                      <Button
                        label="Disconnect"
                        onPress={() => void transport.disconnect(peer.deviceId)}
                      />
                    </>
                  ) : (
                    <Button
                      label="Connect"
                      onPress={() => void transport.connect(peer.deviceId)}
                    />
                  )}
                </View>
              </View>
            ))
          )}
        </Section>

        <Section label="Event log">
          {log.map((entry, i) => (
            <Text key={`${entry.at}-${i}`} style={styles.logLine}>
              {new Date(entry.at).toISOString().slice(11, 23)} {entry.text}
            </Text>
          ))}
        </Section>
      </ScrollView>
    </View>
  );
}


/**
 * Without this, any render-time throw closes a release build with no message —
 * the user sees "has stopped" and there is nothing to act on.
 */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override render() {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }
    return (
      <View style={styles.root}>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.title}>Startup failed</Text>
          <Text style={styles.warning}>{error.message}</Text>
          <Text style={styles.logLine}>{error.stack ?? 'no stack available'}</Text>
        </ScrollView>
      </View>
    );
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <DeveloperScreen />
    </ErrorBoundary>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{label}</Text>
      {children}
    </View>
  );
}

function Button({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        disabled && styles.buttonDisabled,
        pressed && styles.buttonPressed,
      ]}
    >
      <Text style={[styles.buttonText, disabled && styles.dim]}>{label}</Text>
    </Pressable>
  );
}

const short = (id: string) => id.slice(0, 8);

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0d1117' },
  content: { padding: 16, paddingTop: 56, gap: 12 },
  title: { color: '#e6edf3', fontSize: 20, fontWeight: '600' },
  warning: { color: '#f0883e', fontSize: 12 },
  section: { backgroundColor: '#161b22', borderRadius: 10, padding: 12, gap: 6 },
  sectionLabel: { color: '#7d8590', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 },
  mono: { color: '#e6edf3', fontFamily: 'monospace', fontSize: 13 },
  dim: { color: '#7d8590', fontSize: 12 },
  state: { color: '#7d8590', fontSize: 12, fontWeight: '600' },
  stateReady: { color: '#3fb950' },
  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  peer: { borderTopWidth: 1, borderTopColor: '#21262d', paddingTop: 8, gap: 4 },
  button: {
    backgroundColor: '#21262d',
    borderRadius: 6,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  buttonDisabled: { opacity: 0.4 },
  buttonPressed: { backgroundColor: '#30363d' },
  buttonText: { color: '#e6edf3', fontSize: 13, fontWeight: '600' },
  logLine: { color: '#8b949e', fontFamily: 'monospace', fontSize: 11 },
});
