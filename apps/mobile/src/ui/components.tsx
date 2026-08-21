import { ReactNode } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import { colors, styles } from './theme';

export function Button(props: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'quiet' | 'danger';
  busy?: boolean;
}) {
  const variant =
    props.variant === 'quiet'
      ? styles.buttonQuiet
      : props.variant === 'danger'
        ? styles.buttonDanger
        : null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: props.disabled === true, busy: props.busy === true }}
      onPress={props.onPress}
      disabled={props.disabled === true || props.busy === true}
      style={({ pressed }) => [
        styles.button,
        variant,
        (props.disabled === true || props.busy === true) && styles.buttonDisabled,
        pressed && { opacity: 0.7 },
        { flex: 1 },
      ]}
    >
      {props.busy === true ? (
        <ActivityIndicator color="#fff" />
      ) : (
        <Text style={styles.buttonLabel}>{props.label}</Text>
      )}
    </Pressable>
  );
}

export function Card(props: { title?: string; children: ReactNode }) {
  return (
    <View style={styles.card}>
      {props.title !== undefined && <Text style={styles.h2}>{props.title}</Text>}
      {props.children}
    </View>
  );
}

/**
 * Delivery state, always as a word.
 *
 * The colour is a second channel, never the only one — a family needs to know
 * whether a message arrived, and that answer cannot depend on being able to
 * distinguish amber from green on a bright street.
 */
export function DeliveryPill(props: { state: 'QUEUED' | 'SENDING' | 'DELIVERED' | 'REJECTED' }) {
  const map = {
    QUEUED: { label: 'Waiting to send', color: colors.queued },
    // SENDING is shown as waiting too. The distinction is real internally but
    // meaningless to a user, and "sending" invites reading it as "sent".
    SENDING: { label: 'Waiting to send', color: colors.queued },
    DELIVERED: { label: 'Delivered', color: colors.delivered },
    REJECTED: { label: 'Not delivered', color: colors.rejected },
  } as const;
  const { label, color } = map[props.state];
  return (
    <View style={[styles.pill, { backgroundColor: `${color}22` }]}>
      <Text style={[styles.pillText, { color }]}>{label}</Text>
    </View>
  );
}

export function StatusPill(props: {
  status: 'SOS' | 'SAFE' | 'NEEDS_ASSISTANCE' | 'EMERGENCY';
}) {
  const map = {
    SOS: { label: 'SOS', color: colors.sos },
    SAFE: { label: "I'm safe", color: colors.safe },
    NEEDS_ASSISTANCE: { label: 'Needs help', color: colors.assistance },
    EMERGENCY: { label: 'Emergency', color: colors.emergency },
  } as const;
  const { label, color } = map[props.status];
  return (
    <View style={[styles.pill, { backgroundColor: `${color}22` }]}>
      <Text style={[styles.pillText, { color }]}>{label}</Text>
    </View>
  );
}

export function Empty(props: { text: string }) {
  return <Text style={styles.dim}>{props.text}</Text>;
}

/**
 * Shows a timestamp with whose clock produced it.
 *
 * Two clocks are stored for a reason and the difference is shown rather than
 * smoothed over: a phone with the wrong date would otherwise present a
 * confident, wrong time for when someone said they were safe.
 */
export function ReportedAt(props: { reportedAt: number; receivedAt: number }) {
  const drift = Math.abs(props.reportedAt - props.receivedAt);
  const time = new Date(props.reportedAt).toLocaleString();
  if (drift < 5 * 60 * 1000) {
    return <Text style={styles.dim}>{time}</Text>;
  }
  return (
    <Text style={styles.dim}>
      {time} · their clock differs from yours, received{' '}
      {new Date(props.receivedAt).toLocaleString()}
    </Text>
  );
}
