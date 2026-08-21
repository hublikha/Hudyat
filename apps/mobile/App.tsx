import {
  Invitation,
  PendingVerification,
  confirmPairing,
  currentFamily,
  derivePairingSessionKey,
  decodeInvitation,
  insertFamily,
  addMembership,
  redeemInvitation,
} from '@rcn/core';
import { DeviceId } from '@rcn/protocol';
import { StatusBar } from 'expo-status-bar';
import { Component, ReactNode, useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';

import { sealBytes, withAgreementPrivateKey } from './src/engine/identity';
import { Chat } from './src/screens/Chat';
import { Connectivity, TrustedDevices } from './src/screens/Devices';
import { Emergency, FamilyStatus } from './src/screens/Emergency';
import { FamilyHome } from './src/screens/FamilyHome';
import { Onboarding } from './src/screens/Onboarding';
import { ScanInvitation, ShowInvitation, VerifyPairing } from './src/screens/Pairing';
import { SelfTest } from './src/screens/SelfTest';
import { AppState, useApp } from './src/state/useApp';
import { Button, Card } from './src/ui/components';
import { colors, styles } from './src/ui/theme';

/**
 * Screen routing.
 *
 * A plain state machine rather than a navigation library: nine screens with one
 * level of depth do not need one, and every dependency in an emergency tool is
 * something that can break on a device we cannot test.
 */
type Screen =
  | { name: 'HOME' }
  | { name: 'ONBOARDING' }
  | { name: 'SHOW_INVITE' }
  | { name: 'SCAN_INVITE' }
  | { name: 'VERIFY'; pending: PendingVerification; invitation: Invitation }
  | { name: 'CHAT'; peer: DeviceId }
  | { name: 'EMERGENCY' }
  | { name: 'STATUS' }
  | { name: 'DEVICES' }
  | { name: 'CONNECTIVITY' }
  | { name: 'SELFTEST' };

function Router() {
  const app = useApp();
  const [screen, setScreen] = useState<Screen | null>(null);
  const [pairError, setPairError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const home = useCallback(() => setScreen({ name: 'HOME' }), []);

  if (app.startup.phase === 'LOADING') {
    return (
      <View style={[styles.screen, { justifyContent: 'center', alignItems: 'center', gap: 16 }]}>
        <ActivityIndicator color={colors.accent} size="large" />
        <Text style={styles.dim}>Setting up this phone…</Text>
      </View>
    );
  }

  if (app.startup.phase === 'FAILED') {
    // Shown rather than swallowed. A release build dying silently here is what
    // Phase 0 spent an evening diagnosing with no message on screen.
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <Text style={styles.h1}>Hudyat could not start</Text>
        <Card>
          <Text style={{ color: colors.rejected }}>{app.startup.error}</Text>
        </Card>
        <Text style={styles.dim}>
          This is a fault in the app, not something you did. The message above is what a technician
          needs.
        </Text>
      </ScrollView>
    );
  }

  const hasFamily = app.family !== null;

  // Digits arriving is a fact from the other phone, not a navigation choice, so
  // it takes precedence over whatever screen is showing.
  const current: Screen =
    app.pairingReady !== null
      ? {
          name: 'VERIFY',
          pending: app.pairingReady.pending,
          invitation: app.pairingReady.invitation,
        }
      : (screen ?? (hasFamily ? { name: 'HOME' } : { name: 'ONBOARDING' }));

  /**
   * Handles a scanned invitation.
   *
   * Phase 1 pairs over the same transport the family uses, so the peer's keys
   * arrive during the handshake. Until that exchange runs on hardware this
   * screen surfaces the parse and expiry failures, which are the ones a user
   * can actually act on.
   */
  const onScanned = (payload: string) => {
    setPairError(null);
    try {
      const invitation = decodeInvitation(payload);
      if (Date.now() > invitation.expiresAt) {
        // Advisory only: the issuer decides for real when the join is
        // attempted. Checking here saves a round trip and cannot extend a code.
        throw new Error('This code has expired. Ask for a new one.');
      }
      if (app.db !== null && currentFamily(app.db) === null) {
        insertFamily(app.db, {
          familyId: invitation.familyId,
          name: invitation.familyName,
          createdAt: Date.now(),
          createdBy: invitation.inviter,
        });
        if (app.self !== null) {
          addMembership(app.db, {
            familyId: invitation.familyId,
            deviceId: app.self.deviceId,
            role: 'MEMBER',
            joinedAt: Date.now(),
          });
        }
        app.refresh();
      }
      if (app.engine === null || app.self === null) {
        throw new Error('This phone is not ready to pair yet.');
      }
      app.engine.beginPairing({
        role: 'JOINER',
        invitation,
        self: {
          deviceId: app.self.deviceId,
          identityKey: app.self.identityKey,
          agreementKey: app.self.agreementPublicKey,
        },
        displayName: app.self.deviceId.slice(0, 8),
      });
      setPairError(
        'Waiting for the other phone. Keep both together — the six digits appear once they connect.',
      );
      home();
    } catch (error) {
      setPairError((error as Error).message);
      home();
    }
  };

  const confirm = async (pending: PendingVerification, invitation: Invitation) => {
    if (!app.db || !app.self) return;
    setBusy(true);
    try {
      redeemInvitation({
        db: app.db,
        nonce: invitation.nonce,
        joiner: pending.peer.deviceId,
        now: Date.now(),
      });
      // Derive, seal, then write. Sealing is a call into the Keystore and is
      // asynchronous; the trust write is a synchronous transaction. Doing them
      // in that order is what keeps the raw session key out of the database.
      const sessionKey = await withAgreementPrivateKey(
        app.db,
        app.self.deviceId,
        (priv) =>
          derivePairingSessionKey({
            pending,
            invitation,
            self: { deviceId: app.self!.deviceId, agreementPrivateKey: priv },
          }),
      );
      const sessionKeySealed = await sealBytes(sessionKey);
      sessionKey.fill(0);

      confirmPairing({
        db: app.db,
        pending,
        invitation,
        self: { deviceId: app.self.deviceId },
        now: Date.now(),
        sessionKeySealed,
        userConfirmed: true,
      });
      app.clearPairing();
      app.refresh();
      setPairError(null);
      home();
    } catch (error) {
      setPairError((error as Error).message);
      home();
    } finally {
      setBusy(false);
    }
  };

  switch (current.name) {
    case 'ONBOARDING':
      return (
        <Onboarding
          app={app}
          onDone={() => {
            app.refresh();
            home();
          }}
          onJoin={() => setScreen({ name: 'SCAN_INVITE' })}
        />
      );

    case 'SHOW_INVITE':
      return (
        <ShowInvitation
          app={app}
          onInvitation={(invitation) => {
            if (app.engine === null || app.self === null) return;
            // The window opens when the code is shown and closes when the user
            // leaves, so the untrusted-HELLO exception exists only while a
            // person is actually standing there pairing a phone.
            app.engine.beginPairing({
              role: 'INVITER',
              invitation,
              self: {
                deviceId: app.self.deviceId,
                identityKey: app.self.identityKey,
                agreementKey: app.self.agreementPublicKey,
              },
              displayName: app.self.deviceId.slice(0, 8),
            });
          }}
          onBack={() => {
            app.clearPairing();
            home();
          }}
        />
      );

    case 'SCAN_INVITE':
      return <ScanInvitation app={app} onScanned={onScanned} onBack={home} />;

    case 'VERIFY':
      return (
        <VerifyPairing
          sas={current.pending.sas}
          peerName={current.pending.peer.displayName || 'this phone'}
          busy={busy}
          onConfirm={() => void confirm(current.pending, current.invitation)}
          onReject={() => {
            app.clearPairing();
            setPairError('Pairing cancelled. Nothing was trusted.');
            home();
          }}
        />
      );

    case 'CHAT':
      return <Chat app={app} peer={current.peer} onBack={home} />;

    case 'EMERGENCY':
      return <Emergency app={app} onBack={home} />;

    case 'STATUS':
      return <FamilyStatus app={app} onBack={home} />;

    case 'DEVICES':
      return <TrustedDevices app={app} onBack={home} />;

    case 'CONNECTIVITY':
      return <Connectivity app={app} onBack={home} />;

    case 'SELFTEST':
      return <SelfTest app={app} onBack={home} />;

    default:
      return (
        <>
          {app.pairingError !== null && (
            <View style={{ padding: 16, backgroundColor: colors.surfaceRaised }}>
              <Text style={{ color: colors.rejected }}>{app.pairingError}</Text>
              <Button label="Dismiss" variant="quiet" onPress={app.clearPairing} />
            </View>
          )}
          {pairError !== null && (
            <View style={{ padding: 16, backgroundColor: colors.surfaceRaised }}>
              <Text style={{ color: colors.queued }}>{pairError}</Text>
              <Button label="Dismiss" variant="quiet" onPress={() => setPairError(null)} />
            </View>
          )}
          <FamilyHome
            app={app}
            onOpenChat={(peer) => setScreen({ name: 'CHAT', peer })}
            onEmergency={() => setScreen({ name: 'EMERGENCY' })}
            onStatus={() => setScreen({ name: 'STATUS' })}
            onDevices={() => setScreen({ name: 'DEVICES' })}
            onAdd={() => setScreen({ name: 'SHOW_INVITE' })}
            onConnectivity={() => setScreen({ name: 'CONNECTIVITY' })}
            onSelfTest={() => setScreen({ name: 'SELFTEST' })}
          />
        </>
      );
  }
}

/**
 * Catches render-time failures.
 *
 * Without this a release build closes with no message, which is exactly what a
 * user reported in Phase 0 and what took a USB cable and a crash log to explain.
 */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override render() {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <Text style={styles.h1}>Something went wrong</Text>
        <Card>
          <Text style={{ color: colors.rejected }}>{error.message}</Text>
        </Card>
        <Card>
          <Text style={styles.mono}>{error.stack ?? 'no stack available'}</Text>
        </Card>
      </ScrollView>
    );
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <StatusBar style="light" />
      <Router />
    </ErrorBoundary>
  );
}

export type { AppState };
