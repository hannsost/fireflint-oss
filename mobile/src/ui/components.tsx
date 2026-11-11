import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { colors, styles } from './theme';

export function Flame({ size = 27 }: { size?: number }) {
  return <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" accessible={false}>
    <Path d="M13 1c2 7 8 9 8 14a9 9 0 0 1-18 0c0-4 3-7 6-10-1 5 0 7 2 8 3-3 3-7 2-12Z" stroke={colors.flame} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
    <Path d="M12 14c-3 3-3 6 0 7 3-1 3-4 0-7Z" fill={colors.flame} />
  </Svg>;
}

export function Brand() {
  return <View style={styles.row} accessible accessibilityLabel="FireFlint">
    <Flame /><Text style={[styles.heading, { fontSize: 23, letterSpacing: -0.8 }]}>FireFlint<Text style={{ color: colors.flame }}>.</Text></Text>
  </View>;
}

export function Button({ label, onPress, disabled = false, busy = false, secondary = false, testID, hint }: {
  label: string; onPress: () => void; disabled?: boolean; busy?: boolean; secondary?: boolean; testID?: string; hint?: string;
}) {
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} accessibilityHint={hint}
    accessibilityState={{ disabled: disabled || busy, busy }} disabled={disabled || busy} onPress={onPress}
    style={({ pressed }) => [styles.button, secondary && styles.secondary, (disabled || busy) && styles.disabled, pressed && styles.pressed]}>
    {busy && <ActivityIndicator size="small" color={secondary ? colors.green : colors.white} />}
    <Text style={[styles.buttonText, secondary && styles.secondaryText]}>{label}</Text>
  </Pressable>;
}

export function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <View accessibilityLiveRegion="polite" style={[styles.notice, error && styles.error]}>
    <Text style={error ? styles.errorText : styles.body}>{children}</Text>
  </View>;
}

export function Badge({ children, draft = false }: { children: ReactNode; draft?: boolean }) {
  return <View style={[styles.badge, draft && { backgroundColor: colors.lightFlame }]}>
    <Text style={[styles.badgeText, draft && { color: colors.flame }]}>{children}</Text>
  </View>;
}

export function Loading({ label = 'Wird geladen …' }: { label?: string }) {
  return <View style={[styles.card, { alignItems: 'center', padding: 30 }]}><ActivityIndicator color={colors.green} /><Text style={styles.muted}>{label}</Text></View>;
}

export function displayValue(value: unknown): string {
  if (value === undefined) return 'Nicht gesetzt';
  if (value === null) return 'Leer';
  if (typeof value === 'string') return value || 'Leer';
  if (typeof value === 'boolean') return value ? 'Ja' : 'Nein';
  return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
}

export function contentTitle(data: Record<string, unknown>): string {
  for (const key of ['title', 'name', 'headline', 'label']) {
    if (typeof data[key] === 'string' && data[key].trim()) return data[key];
  }
  const first = Object.values(data).find(value => typeof value === 'string' && value.trim());
  return typeof first === 'string' ? first : 'Inhalt ohne Titel';
}
