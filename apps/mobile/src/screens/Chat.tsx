import { getDevice } from '@rcn/core';
import { DeviceId } from '@rcn/protocol';
import { useState } from 'react';
import { FlatList, Text, TextInput, View } from 'react-native';

import { AppState, conversationIdFor, useMessages } from '../state/useApp';
import { Button, DeliveryPill } from '../ui/components';
import { colors, spacing, styles } from '../ui/theme';

/**
 * One-to-one chat.
 *
 * Every outgoing message shows its state as a word. The user should never have
 * to infer whether something arrived — that inference is the failure mode this
 * whole product exists to remove.
 */
export function Chat(props: { app: AppState; peer: DeviceId; onBack: () => void }) {
  const { app } = props;
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const conversationId =
    app.self !== null ? conversationIdFor(app.self.deviceId, props.peer) : null;
  const messages = useMessages(app.db, conversationId, app.version);
  const peerName =
    (app.db !== null ? getDevice(app.db, props.peer)?.display_name : null) || 'Family member';
  const reachable = app.peers.some((p) => p.deviceId === props.peer);

  const send = async () => {
    const body = text.trim();
    if (body.length === 0 || !app.engine || !app.family || conversationId === null) return;
    setSending(true);
    setError(null);
    try {
      await app.engine.send({
        to: props.peer,
        body,
        familyId: app.family.family_id,
        conversationId,
      });
      // Cleared only after the message is durable. Clearing earlier would risk
      // losing what someone typed if persisting failed.
      setText('');
      app.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <View style={styles.screen}>
      <View style={[styles.spread, { padding: spacing.md }]}>
        <View style={{ flex: 1 }}>
          <Text style={styles.h2}>{peerName}</Text>
          <Text style={styles.dim}>
            {reachable ? 'Nearby now' : 'Not reachable — messages will wait'}
          </Text>
        </View>
        <Button label="Back" variant="quiet" onPress={props.onBack} />
      </View>

      <FlatList
        inverted
        data={messages}
        keyExtractor={(m) => m.message_id}
        contentContainerStyle={{ padding: spacing.md, gap: spacing.sm }}
        ListEmptyComponent={
          <Text style={styles.dim}>No messages yet. Anything you send is saved on both phones.</Text>
        }
        renderItem={({ item }) => {
          const mine = item.direction === 'OUT';
          return (
            <View
              style={{
                alignSelf: mine ? 'flex-end' : 'flex-start',
                maxWidth: '85%',
                backgroundColor: mine ? colors.surfaceRaised : colors.surface,
                borderRadius: 14,
                padding: spacing.md,
                gap: 6,
                borderWidth: 1,
                borderColor: colors.border,
              }}
            >
              <Text style={styles.body}>{item.body}</Text>
              <View style={styles.row}>
                <Text style={styles.dim}>
                  {new Date(item.created_at).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </Text>
                {mine && <DeliveryPill state={item.state} />}
              </View>
              {item.state === 'REJECTED' && item.state_reason !== null && (
                <Text style={{ color: colors.rejected, fontSize: 13 }}>{item.state_reason}</Text>
              )}
            </View>
          );
        }}
      />

      {error !== null && (
        <Text style={{ color: colors.rejected, paddingHorizontal: spacing.md }}>{error}</Text>
      )}

      <View style={[styles.row, { padding: spacing.md }]}>
        <TextInput
          style={[styles.input, { flex: 1 }]}
          value={text}
          onChangeText={setText}
          placeholder="Message"
          placeholderTextColor={colors.textDim}
          multiline
          accessibilityLabel="Message to send"
        />
        <View style={{ width: 96 }}>
          <Button label="Send" onPress={() => void send()} busy={sending} disabled={text.trim().length === 0} />
        </View>
      </View>
    </View>
  );
}
