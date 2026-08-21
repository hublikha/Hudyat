import { SafetyStatus, recordSafetyEvent } from '@rcn/core';
import { DeviceId, newMessageId } from '@rcn/protocol';
import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { randomBytes } from '../engine/identity';
import { AppState, conversationIdFor, useSafety, useTrustedDevices } from '../state/useApp';
import { Button, Card, Empty, ReportedAt, StatusPill } from '../ui/components';
import { colors, styles } from '../ui/theme';

/**
 * Emergency.
 *
 * SOS and status are ordinary protocol messages with the same authentication
 * and encryption as any other. There is deliberately no faster, weaker path:
 * an unauthenticated emergency channel is one an attacker can use to send a
 * family a message that appears to come from someone they love.
 *
 * Sending is fan-out over the trusted list — Phase 1 has no group key, so this
 * is N separate 1:1 messages, each queued durably and retried independently.
 */
export function Emergency(props: { app: AppState; onBack: () => void }) {
  const { app } = props;
  const trusted = useTrustedDevices(app.db, app.family?.family_id ?? null, app.version);
  const [busy, setBusy] = useState<SafetyStatus | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const reachable = new Set(app.peers.filter((p) => p.trusted).map((p) => p.deviceId));

  const broadcast = async (status: SafetyStatus) => {
    if (!app.engine || !app.family || !app.self || !app.db) return;
    setBusy(status);
    setResult(null);

    // Recorded locally first. Our own status is a fact about this device and
    // must not depend on anyone being reachable.
    recordSafetyEvent({
      db: app.db,
      eventId: newMessageId(randomBytes),
      familyId: app.family.family_id,
      deviceId: app.self.deviceId,
      status,
      seq: Date.now(),
      reportedAt: Date.now(),
      now: Date.now(),
    });

    let queued = 0;
    for (const member of trusted) {
      try {
        await app.engine.send({
          to: member.device_id as DeviceId,
          body: status,
          kind: 'STATUS',
          familyId: app.family.family_id,
          conversationId: conversationIdFor(app.self.deviceId, member.device_id as DeviceId),
        });
        queued++;
      } catch {
        // One unreachable member must not stop the rest. Each message is
        // durable on its own and retries on its own.
      }
    }

    const here = trusted.filter((m) => reachable.has(m.device_id as DeviceId)).length;
    setResult(
      queued === 0
        ? 'Saved on this phone. Nothing could be sent yet.'
        : here === queued
          ? `Sent to ${queued} ${queued === 1 ? 'phone' : 'phones'} nearby.`
          : `Sent to ${here} nearby. ${queued - here} will be delivered when they are in range.`,
    );
    setBusy(null);
    app.refresh();
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.h1}>Emergency</Text>
      <Text style={styles.body}>
        This tells your family. It does not contact the police, fire service, or an ambulance.
      </Text>

      <Card>
        <Text style={{ color: colors.queued, fontSize: 15, lineHeight: 21 }}>
          Hudyat is an extra way to reach your family when networks fail. For official help, call
          emergency services if you can.
        </Text>
      </Card>

      <Card title="Send an alert">
        <Button
          label="SOS — I need help now"
          variant="danger"
          onPress={() => void broadcast('SOS')}
          busy={busy === 'SOS'}
        />
        <Button
          label="I need assistance"
          variant="quiet"
          onPress={() => void broadcast('NEEDS_ASSISTANCE')}
          busy={busy === 'NEEDS_ASSISTANCE'}
        />
        <Button
          label="There is an emergency here"
          variant="quiet"
          onPress={() => void broadcast('EMERGENCY')}
          busy={busy === 'EMERGENCY'}
        />
        <Button
          label="I'm safe"
          variant="quiet"
          onPress={() => void broadcast('SAFE')}
          busy={busy === 'SAFE'}
        />
        {result !== null && <Text style={styles.dim}>{result}</Text>}
        {trusted.length === 0 && (
          <Text style={styles.dim}>
            You have no family members yet, so this will only be saved on this phone.
          </Text>
        )}
      </Card>

      <Button label="Back" variant="quiet" onPress={props.onBack} />
    </ScrollView>
  );
}

/**
 * Family status.
 *
 * Every entry carries when it was reported, because "I'm safe" is a report from
 * a moment and not a standing fact. A three-hour-old "safe" during a flood
 * means something quite different from one sent a minute ago, and the screen
 * must not let the two look alike.
 */
export function FamilyStatus(props: { app: AppState; onBack: () => void }) {
  const { app } = props;
  const trusted = useTrustedDevices(app.db, app.family?.family_id ?? null, app.version);
  const safety = useSafety(app.db, app.family?.family_id ?? null, app.version);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.h1}>Family status</Text>
      <Text style={styles.dim}>
        The last thing each person reported. It shows what they said and when, not where they are.
      </Text>

      <Card>
        {trusted.length === 0 ? (
          <Empty text="No family members yet." />
        ) : (
          trusted.map((member) => {
            const status = safety.find((s) => s.device_id === member.device_id);
            return (
              <View
                key={member.device_id}
                style={{ paddingVertical: 12, borderTopWidth: 1, borderTopColor: colors.border, gap: 6 }}
              >
                <View style={styles.spread}>
                  <Text style={styles.body}>{member.display_name || 'Unnamed phone'}</Text>
                  {status !== undefined ? (
                    <StatusPill status={status.status} />
                  ) : (
                    <Text style={styles.dim}>No report</Text>
                  )}
                </View>
                {status !== undefined && (
                  <ReportedAt reportedAt={status.reported_at} receivedAt={status.received_at} />
                )}
              </View>
            );
          })
        )}
      </Card>

      <Button label="Back" variant="quiet" onPress={props.onBack} />
    </ScrollView>
  );
}
