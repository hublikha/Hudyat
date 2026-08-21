import { removeDevice } from '@rcn/core';
import { DeviceId } from '@rcn/protocol';
import { useState } from 'react';
import { Alert, ScrollView, Text, View } from 'react-native';

import { requestNearbyPermissions } from '../permissions';
import { AppState, useTrustedDevices } from '../state/useApp';
import { Button, Card, Empty } from '../ui/components';
import { colors, styles } from '../ui/theme';
import { KeyBackingNotice } from './Onboarding';

/**
 * Trusted devices.
 *
 * Removing is deliberately a two-step action with plain consequences written
 * out. It is not reversible by simply re-scanning a code, and someone doing it
 * in a hurry deserves to know that before rather than after.
 */
export function TrustedDevices(props: { app: AppState; onBack: () => void }) {
  const { app } = props;
  const trusted = useTrustedDevices(app.db, app.family?.family_id ?? null, app.version);
  const [busy, setBusy] = useState<string | null>(null);
  const reachable = new Set(app.peers.map((p) => p.deviceId));

  const remove = (deviceId: string, name: string) => {
    Alert.alert(
      `Remove ${name}?`,
      'That phone will no longer be able to send or receive messages in this family. ' +
        'It keeps the messages it already has. Adding it back needs a new code and checking ' +
        'the six digits again.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            if (!app.db) return;
            setBusy(deviceId);
            try {
              removeDevice({ db: app.db, deviceId: deviceId as DeviceId, now: Date.now() });
              app.refresh();
            } finally {
              setBusy(null);
            }
          },
        },
      ],
    );
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.h1}>Family devices</Text>
      <Text style={styles.dim}>
        These phones can send and receive messages in your family. Each one was verified by
        comparing six digits in person.
      </Text>

      <Card title="This phone">
        <Text style={styles.body}>{app.self ? 'You' : '—'}</Text>
        <Text style={styles.mono}>{app.self?.deviceId ?? ''}</Text>
        {app.self !== null && <KeyBackingNotice level={app.self.securityLevel} />}
      </Card>

      <Card title={`Family members (${trusted.length})`}>
        {trusted.length === 0 ? (
          <Empty text="No family members yet." />
        ) : (
          trusted.map((member) => (
            <View
              key={member.device_id}
              style={{ paddingVertical: 12, borderTopWidth: 1, borderTopColor: colors.border, gap: 8 }}
            >
              <View style={styles.spread}>
                <Text style={styles.body}>{member.display_name || 'Unnamed phone'}</Text>
                <Text style={styles.dim}>
                  {reachable.has(member.device_id as DeviceId) ? 'Nearby' : 'Away'}
                </Text>
              </View>
              <Text style={styles.mono}>{member.device_id}</Text>
              <Text style={styles.dim}>
                Verified with digits {member.sas} on{' '}
                {new Date(member.verified_at).toLocaleDateString()}
              </Text>
              <Button
                label="Remove from family"
                variant="quiet"
                busy={busy === member.device_id}
                onPress={() => remove(member.device_id, member.display_name || 'this phone')}
              />
            </View>
          ))
        )}
      </Card>

      <Button label="Back" variant="quiet" onPress={props.onBack} />
    </ScrollView>
  );
}

/**
 * Connectivity.
 *
 * Internet reachability and family reachability are shown as separate lines
 * because they are separate facts. The app never reduces them to "online" or
 * "offline" — that single word is what makes people give up on a device that is
 * still perfectly able to reach their family.
 */
export function Connectivity(props: { app: AppState; onBack: () => void }) {
  const { app } = props;
  const [busy, setBusy] = useState(false);
  const running = app.transport === 'READY' || app.transport === 'STARTING';
  const reachable = app.peers.filter((p) => p.trusted).length;

  const [denied, setDenied] = useState<string[] | null>(null);

  const toggle = async () => {
    if (!app.engine || !app.self) return;
    setBusy(true);
    setDenied(null);
    try {
      if (running) {
        await app.engine.stop();
        return;
      }
      // Requested here rather than at startup: asking for nearby-device access
      // before the user has chosen to look for family reads as an app grabbing
      // permissions it has not earned, and a denial at that point is sticky.
      const permission = await requestNearbyPermissions();
      if (!permission.granted) {
        setDenied(permission.denied);
        return;
      }
      await app.engine.start(app.self.deviceId, app.self.deviceId.slice(0, 8));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.h1}>Connection</Text>

      <Card title="Local connection">
        <View style={styles.spread}>
          <Text style={styles.body}>Searching for family phones</Text>
          <Text style={{ color: running ? colors.delivered : colors.textDim }}>
            {running ? 'On' : 'Off'}
          </Text>
        </View>
        <Text style={styles.dim}>
          This works over Wi-Fi and Bluetooth directly between phones. It does not need the
          internet or a mobile signal.
        </Text>
        <Button
          label={running ? 'Stop searching' : 'Start searching'}
          variant={running ? 'quiet' : 'primary'}
          onPress={() => void toggle()}
          busy={busy}
        />
      </Card>

      {denied !== null && (
        <Card title="Permission needed">
          <Text style={{ color: colors.queued, fontSize: 15, lineHeight: 21 }}>
            Hudyat needs permission to find nearby devices. Without it this phone cannot reach your
            family when the internet is down.
          </Text>
          <Text style={styles.dim}>
            If you were not asked, the permission may have been refused before. You can grant it in
            Android Settings under Apps, Hudyat, Permissions.
          </Text>
          <Text style={styles.dim}>Missing: {denied.join(', ')}</Text>
        </Card>
      )}

      <Card title="Family reachable now">
        <Text style={{ color: reachable > 0 ? colors.delivered : colors.queued, fontSize: 17 }}>
          {reachable} {reachable === 1 ? 'phone' : 'phones'}
        </Text>
        <Text style={styles.dim}>
          Messages to anyone not listed here are saved and sent automatically when they come back
          in range.
        </Text>
      </Card>

      <Card title="Technical detail">
        <Text style={styles.dim}>Transport state: {app.transport}</Text>
        <Text style={styles.dim}>Devices seen: {app.peers.length}</Text>
      </Card>

      {app.errors.length > 0 && (
        <Card title="Recent problems">
          {app.errors.slice(0, 8).map((e, i) => (
            <Text key={`${e}-${i}`} style={{ color: colors.queued, fontSize: 13 }}>
              {e}
            </Text>
          ))}
        </Card>
      )}

      <Button label="Back" variant="quiet" onPress={props.onBack} />
    </ScrollView>
  );
}
