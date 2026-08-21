import { createInvitation, encodeInvitation } from '@rcn/core';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { randomBytes } from '../engine/identity';
import { AppState } from '../state/useApp';
import { Button, Card } from '../ui/components';
import { colors, styles } from '../ui/theme';

/**
 * Showing an invitation.
 *
 * The code expires and can be used once. Both are enforced on this device, the
 * issuer, because a joining phone's clock may be wrong or attacker-controlled.
 */
export function ShowInvitation(props: {
  app: AppState;
  onBack: () => void;
  onInvitation: (invitation: ReturnType<typeof createInvitation>) => void;
}) {
  const { app } = props;
  const [payload, setPayload] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState(0);
  const [remaining, setRemaining] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const make = () => {
    if (!app.db || !app.self || !app.family) return;
    try {
      const invitation = createInvitation({
        db: app.db,
        familyId: app.family.family_id,
        familyName: app.family.name,
        inviter: app.self.deviceId,
        inviterIdentityKey: app.self.identityKey,
        now: Date.now(),
        randomBytes,
      });
      setPayload(encodeInvitation(invitation));
      setExpiresAt(invitation.expiresAt);
      setError(null);
      props.onInvitation(invitation);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(make, []);

  useEffect(() => {
    const t = setInterval(() => setRemaining(Math.max(0, expiresAt - Date.now())), 500);
    return () => clearInterval(t);
  }, [expiresAt]);

  const expired = remaining <= 0 && expiresAt > 0;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.h1}>Add a family member</Text>
      <Text style={styles.body}>
        Show this code to the phone you are adding. Stay together — you will compare six digits
        before the phones trust each other.
      </Text>

      <Card>
        {payload !== null && !expired ? (
          <View style={{ alignItems: 'center', paddingVertical: 12, gap: 12 }}>
            <View style={{ backgroundColor: '#fff', padding: 12, borderRadius: 12 }}>
              <QRCode value={payload} size={230} />
            </View>
            <Text style={styles.dim}>
              Expires in {Math.ceil(remaining / 1000)}s · can be used once
            </Text>
          </View>
        ) : (
          <View style={{ alignItems: 'center', paddingVertical: 24, gap: 12 }}>
            <Text style={styles.body}>
              {expired ? 'This code has expired.' : 'Preparing a code…'}
            </Text>
            {expired && <Button label="Make a new code" onPress={make} />}
          </View>
        )}
      </Card>

      {error !== null && (
        <Card>
          <Text style={{ color: colors.rejected }}>{error}</Text>
        </Card>
      )}

      <Button label="Back" variant="quiet" onPress={props.onBack} />
    </ScrollView>
  );
}

/**
 * Scanning an invitation.
 *
 * A scanned code is attacker-supplied input: it can be printed, forwarded, or
 * swapped on a wall. Nothing here trusts it — the fingerprint it carries is
 * checked against the key that arrives over the network, and then the two users
 * still have to agree on six digits.
 */
export function ScanInvitation(props: {
  app: AppState;
  onScanned: (payload: string) => void;
  onBack: () => void;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const [handled, setHandled] = useState(false);

  if (permission === null) {
    return (
      <View style={[styles.screen, { justifyContent: 'center', padding: 24 }]}>
        <Text style={styles.body}>Checking camera access…</Text>
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <Text style={styles.h1}>Camera needed</Text>
        <Text style={styles.body}>
          Hudyat needs the camera to scan your family's code. The camera is used only for this and
          nothing is uploaded.
        </Text>
        <Button label="Allow camera" onPress={() => void requestPermission()} />
        <Button label="Back" variant="quiet" onPress={props.onBack} />
      </ScrollView>
    );
  }

  return (
    <View style={styles.screen}>
      <CameraView
        style={{ flex: 1 }}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={({ data }) => {
          // The camera fires repeatedly while the code is in frame; without this
          // guard one scan would start several pairings.
          if (handled) return;
          setHandled(true);
          props.onScanned(data);
        }}
      />
      <View style={{ padding: 16, gap: 12 }}>
        <Text style={styles.dim}>Point the camera at the code on the other phone.</Text>
        <Button label="Cancel" variant="quiet" onPress={props.onBack} />
      </View>
    </View>
  );
}

/**
 * The verification step.
 *
 * This screen is the security of the whole pairing. An attacker who controls
 * the network can relay and substitute keys, but cannot make two independently
 * computed numbers agree — so the users comparing them out loud is what decides
 * it. The confirm button is deliberately not the visually dominant one.
 */
export function VerifyPairing(props: {
  sas: string;
  peerName: string;
  onConfirm: () => void;
  onReject: () => void;
  busy?: boolean;
}) {
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.h1}>Check these numbers</Text>
      <Text style={styles.body}>
        Both phones should show the same six digits. Read them out loud to each other.
      </Text>

      <Card>
        <View style={{ alignItems: 'center', paddingVertical: 20 }}>
          <Text
            accessibilityLabel={`Verification digits ${props.sas.split('').join(' ')}`}
            style={{
              color: colors.text,
              fontSize: 46,
              fontWeight: '700',
              letterSpacing: 8,
              fontFamily: 'monospace',
            }}
          >
            {props.sas}
          </Text>
        </View>
        <Text style={styles.dim}>Pairing with {props.peerName}</Text>
      </Card>

      <Card>
        <Text style={{ color: colors.queued, fontSize: 15, lineHeight: 21 }}>
          If the numbers are different, someone may be interfering. Do not continue.
        </Text>
      </Card>

      <View style={styles.row}>
        <Button label="They do not match" variant="quiet" onPress={props.onReject} />
        <Button label="They match" onPress={props.onConfirm} busy={props.busy} />
      </View>
    </ScrollView>
  );
}
