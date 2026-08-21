import { DeviceId } from '@rcn/protocol';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { AppState, useSafety, useTrustedDevices } from '../state/useApp';
import { Button, Card, Empty, StatusPill } from '../ui/components';
import { colors, styles } from '../ui/theme';

/**
 * Family Home.
 *
 * The connectivity line at the top never says "offline". Losing the internet is
 * not the same as losing contact with family, and conflating them would tell
 * someone their phone is useless at the moment it is most useful.
 */
export function FamilyHome(props: {
  app: AppState;
  onOpenChat: (peer: DeviceId) => void;
  onEmergency: () => void;
  onStatus: () => void;
  onDevices: () => void;
  onAdd: () => void;
  onConnectivity: () => void;
  onSelfTest: () => void;
}) {
  const { app } = props;
  const trusted = useTrustedDevices(app.db, app.family?.family_id ?? null, app.version);
  const safety = useSafety(app.db, app.family?.family_id ?? null, app.version);
  const reachable = new Set(app.peers.filter((p) => p.trusted).map((p) => p.deviceId));

  const statusFor = (deviceId: string) => safety.find((s) => s.device_id === deviceId);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.spread}>
        <Text style={styles.h1}>{app.family?.name ?? 'My Family'}</Text>
        <Pressable onPress={props.onConnectivity} accessibilityRole="button">
          <Text style={{ color: colors.accent, fontSize: 15 }}>Connection</Text>
        </Pressable>
      </View>

      <ConnectivityLine app={app} reachableCount={reachable.size} />

      <View style={styles.row}>
        <Button label="Emergency" variant="danger" onPress={props.onEmergency} />
        <Button label="Family status" variant="quiet" onPress={props.onStatus} />
      </View>

      <Card title={`Family (${trusted.length})`}>
        {trusted.length === 0 ? (
          <>
            <Empty text="No family members yet. Add someone by showing them a code." />
            <Button label="Add a family member" onPress={props.onAdd} />
          </>
        ) : (
          trusted.map((member) => {
            const status = statusFor(member.device_id);
            const here = reachable.has(member.device_id as DeviceId);
            return (
              <Pressable
                key={member.device_id}
                accessibilityRole="button"
                accessibilityLabel={`Open chat with ${member.display_name}`}
                onPress={() => props.onOpenChat(member.device_id as DeviceId)}
                style={({ pressed }) => [
                  {
                    paddingVertical: 12,
                    borderTopWidth: 1,
                    borderTopColor: colors.border,
                    opacity: pressed ? 0.6 : 1,
                  },
                ]}
              >
                <View style={styles.spread}>
                  <Text style={styles.body}>{member.display_name || 'Unnamed phone'}</Text>
                  {status !== undefined && <StatusPill status={status.status} />}
                </View>
                <Text style={styles.dim}>
                  {here ? 'Nearby now' : 'Not reachable right now — messages will wait'}
                </Text>
              </Pressable>
            );
          })
        )}
      </Card>

      {trusted.length > 0 && (
        <View style={styles.row}>
          <Button label="Add a member" variant="quiet" onPress={props.onAdd} />
          <Button label="Manage devices" variant="quiet" onPress={props.onDevices} />
        </View>
      )}

      <Pressable onPress={props.onSelfTest} accessibilityRole="button">
        <Text style={[styles.dim, { textAlign: 'center' }]}>Run self-test</Text>
      </Pressable>
    </ScrollView>
  );
}

/**
 * The connectivity summary.
 *
 * Internet and family reachability are separate facts and are reported
 * separately. "No internet" with three family members nearby is a working
 * state, and the wording says so rather than leaving the user to guess.
 */
export function ConnectivityLine(props: { app: AppState; reachableCount: number }) {
  const running = props.app.transport === 'READY' || props.app.transport === 'STARTING';

  if (!running) {
    return (
      <Card>
        <Text style={styles.body}>Not searching for family devices.</Text>
        <Text style={styles.dim}>Open Connection to start.</Text>
      </Card>
    );
  }

  if (props.reachableCount > 0) {
    return (
      <Card>
        <Text style={{ color: colors.delivered, fontSize: 17, fontWeight: '600' }}>
          {props.reachableCount} family {props.reachableCount === 1 ? 'phone' : 'phones'} nearby
        </Text>
        <Text style={styles.dim}>You can message them now, with or without the internet.</Text>
      </Card>
    );
  }

  return (
    <Card>
      <Text style={{ color: colors.queued, fontSize: 17, fontWeight: '600' }}>
        No family phones nearby
      </Text>
      <Text style={styles.dim}>
        Anything you send is saved and will be delivered when they are in range.
      </Text>
    </Card>
  );
}
