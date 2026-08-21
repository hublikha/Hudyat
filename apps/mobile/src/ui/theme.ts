import { StyleSheet } from 'react-native';

/**
 * Visual language for an emergency tool.
 *
 * Two decisions that are function rather than taste:
 *
 * Status colour is never the only signal. Every state that matters also carries
 * a word, because colour alone fails for colour-blind users and fails again on
 * a dim screen in daylight — and the state being communicated here is whether a
 * message reached someone.
 *
 * Type is large by default. This is read in bad light, in a hurry, by people of
 * every age in a household.
 */

export const colors = {
  bg: '#0B0F14',
  surface: '#141A22',
  surfaceRaised: '#1C242E',
  border: '#2A343F',
  text: '#F2F5F8',
  textDim: '#94A3B2',
  accent: '#4C9AFF',

  queued: '#E0A23C',
  delivered: '#3DBE7B',
  rejected: '#E5484D',

  sos: '#E5484D',
  safe: '#3DBE7B',
  assistance: '#E0A23C',
  emergency: '#C2410C',
} as const;

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 } as const;

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, paddingBottom: spacing.xl, gap: spacing.md },

  h1: { color: colors.text, fontSize: 26, fontWeight: '700' },
  h2: { color: colors.text, fontSize: 19, fontWeight: '600' },
  body: { color: colors.text, fontSize: 16, lineHeight: 23 },
  dim: { color: colors.textDim, fontSize: 14, lineHeight: 20 },
  mono: { color: colors.text, fontFamily: 'monospace', fontSize: 13 },

  card: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    padding: spacing.md,
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },

  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  spread: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },

  button: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
  },
  buttonQuiet: { backgroundColor: colors.surfaceRaised },
  buttonDanger: { backgroundColor: colors.sos },
  buttonLabel: { color: '#fff', fontSize: 16, fontWeight: '600' },
  buttonDisabled: { opacity: 0.4 },

  input: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: 12,
    padding: spacing.md,
    color: colors.text,
    fontSize: 16,
    borderWidth: 1,
    borderColor: colors.border,
  },

  pill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: colors.surfaceRaised,
  },
  pillText: { fontSize: 12, fontWeight: '600' },
});
