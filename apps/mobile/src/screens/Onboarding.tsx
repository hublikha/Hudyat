import { insertFamily, addMembership, setDisplayName } from '@rcn/core';
import { useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';

import { Button, Card } from '../ui/components';
import { colors, styles } from '../ui/theme';
import { AppState } from '../state/useApp';
import { randomBytes } from '../engine/identity';
import { toBase64 } from '@rcn/protocol';

/**
 * First run: name this device, then create or join a family.
 *
 * No account, no phone number, no email — the white paper's explicit non-scope.
 * The device's identity already exists in hardware by the time this screen is
 * shown; naming it is for the humans, not for the protocol.
 */
export function Onboarding(props: { app: AppState; onDone: () => void; onJoin: () => void }) {
  const { app } = props;
  const [name, setName] = useState('');
  const [familyName, setFamilyName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createFamily = () => {
    if (!app.db || !app.self) return;
    setBusy(true);
    setError(null);
    try {
      const familyId = toBase64(randomBytes(9));
      insertFamily(app.db, {
        familyId,
        name: familyName.trim() || 'My Family',
        createdAt: Date.now(),
        createdBy: app.self.deviceId,
      });
      addMembership(app.db, {
        familyId,
        deviceId: app.self.deviceId,
        role: 'OWNER',
        joinedAt: Date.now(),
      });
      setDisplayName(app.db, app.self.deviceId, name.trim() || 'This phone');
      props.onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveNameThenJoin = () => {
    if (!app.db || !app.self) return;
    setDisplayName(app.db, app.self.deviceId, name.trim() || 'This phone');
    props.onJoin();
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.h1}>Hudyat</Text>
      <Text style={styles.body}>
        Stay in touch with your family when the internet is down. Messages go directly between
        your phones.
      </Text>

      <Card title="Name this phone">
        <Text style={styles.dim}>
          Your family will see this name. It is stored only on the phones in your family.
        </Text>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={setName}
          placeholder="e.g. Nanay's phone"
          placeholderTextColor={colors.textDim}
          maxLength={40}
          accessibilityLabel="Name for this phone"
        />
      </Card>

      <Card title="Start a family">
        <TextInput
          style={styles.input}
          value={familyName}
          onChangeText={setFamilyName}
          placeholder="Family name"
          placeholderTextColor={colors.textDim}
          maxLength={40}
          accessibilityLabel="Family name"
        />
        <View style={styles.row}>
          <Button label="Create family" onPress={createFamily} busy={busy} />
        </View>
      </Card>

      <Card title="Or join a family">
        <Text style={styles.dim}>
          Someone in your family shows you a code on their phone. You will compare six digits with
          them before the phones trust each other.
        </Text>
        <View style={styles.row}>
          <Button label="Scan a family code" variant="quiet" onPress={saveNameThenJoin} />
        </View>
      </Card>

      {error !== null && (
        <Card>
          <Text style={{ color: colors.rejected }}>{error}</Text>
        </Card>
      )}

      {app.self !== null && (
        <Card title="This device">
          <Text style={styles.mono}>{app.self.deviceId}</Text>
          <KeyBackingNotice level={app.self.securityLevel} />
        </Card>
      )}
    </ScrollView>
  );
}

/**
 * States plainly where the private key lives.
 *
 * A phone without hardware key storage still works, and says so. ADR 0004 §2
 * allows the weaker backing but forbids hiding it, and a family deciding
 * whether to trust this phone with emergency messages deserves the fact.
 */
export function KeyBackingNotice(props: { level: string }) {
  if (props.level === 'STRONGBOX' || props.level === 'TEE') {
    return (
      <Text style={styles.dim}>
        This phone's private key is stored in secure hardware and cannot be copied off it.
      </Text>
    );
  }
  return (
    <Text style={{ color: colors.queued, fontSize: 14, lineHeight: 20 }}>
      This phone does not offer secure hardware key storage. Messages are still encrypted, but the
      key is protected by software alone.
    </Text>
  );
}
