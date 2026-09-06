import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Switch,
  TextInput,
  View as RNView,
  type TextInputProps,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text, useThemeColor } from '@/components/Themed';
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';

export const SURFACE_RADIUS = 24;

export function useSettingsTheme() {
  const scheme = useColorScheme();
  const dark = scheme === 'dark';
  return {
    scheme,
    dark,
    tint: Colors[scheme].tint,
    text: useThemeColor({}, 'text'),
    background: useThemeColor({}, 'background'),
    muted: dark ? 'rgba(250,250,250,0.55)' : 'rgba(24,24,27,0.55)',
    surface: dark ? '#171717' : '#ffffff',
    border: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
    danger: '#E07A3D',
  };
}

export function SettingsPageScaffold({
  title,
  onBack,
  children,
  trailing,
}: {
  title: string;
  onBack: () => void;
  children: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const theme = useSettingsTheme();
  return (
    <RNView style={[styles.flex, { backgroundColor: theme.background }]}>
      <RNView
        style={[
          styles.pageHeader,
          {
            paddingTop: Math.max(insets.top, 12),
            borderBottomColor: theme.border,
          },
        ]}
      >
        <Pressable onPress={onBack} hitSlop={12} testID="settings-back">
          <Text style={[styles.back, { color: theme.tint }]}>‹</Text>
        </Pressable>
        <Text style={[styles.pageTitle, { color: theme.text }]} numberOfLines={1}>
          {title}
        </Text>
        <RNView style={styles.trailingSlot}>{trailing}</RNView>
      </RNView>
      {children}
    </RNView>
  );
}

export function SettingsCard({ children }: { children: React.ReactNode }) {
  const theme = useSettingsTheme();
  return (
    <RNView style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
      {children}
    </RNView>
  );
}

export function SettingsRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children?: React.ReactNode;
}) {
  const theme = useSettingsTheme();
  return (
    <RNView style={[styles.row, { borderBottomColor: theme.border }]}>
      <RNView style={styles.rowText}>
        <Text style={[styles.rowLabel, { color: theme.text }]}>{label}</Text>
        {description ? (
          <Text style={[styles.rowDesc, { color: theme.muted }]}>{description}</Text>
        ) : null}
      </RNView>
      {children}
    </RNView>
  );
}

export function SettingsToggleRow({
  label,
  description,
  value,
  onValueChange,
  disabled,
}: {
  label: string;
  description?: string;
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  const theme = useSettingsTheme();
  return (
    <SettingsRow label={label} description={description}>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        trackColor={{ false: theme.border, true: theme.tint }}
      />
    </SettingsRow>
  );
}

export function SettingsTextField(props: TextInputProps & { label?: string }) {
  const theme = useSettingsTheme();
  const { label, style, ...rest } = props;
  return (
    <RNView style={styles.fieldWrap}>
      {label ? <Text style={[styles.fieldLabel, { color: theme.muted }]}>{label}</Text> : null}
      <TextInput
        placeholderTextColor={theme.muted}
        style={[
          styles.input,
          {
            color: theme.text,
            backgroundColor: theme.dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
            borderColor: theme.border,
          },
          style,
        ]}
        {...rest}
      />
    </RNView>
  );
}

export function SettingsErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  const theme = useSettingsTheme();
  return (
    <RNView style={styles.stateBox} testID="settings-error">
      <Text style={[styles.stateText, { color: theme.danger }]}>{message}</Text>
      {onRetry ? (
        <Pressable onPress={onRetry}>
          <Text style={{ color: theme.tint, marginTop: 8 }}>{/* retry */}Retry</Text>
        </Pressable>
      ) : null}
    </RNView>
  );
}

export function SettingsLoading() {
  const theme = useSettingsTheme();
  return (
    <RNView style={styles.stateBox} testID="settings-loading">
      <ActivityIndicator color={theme.tint} />
    </RNView>
  );
}

export function SettingsPrimaryButton({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const theme = useSettingsTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[
        styles.primaryBtn,
        { backgroundColor: theme.tint, opacity: disabled ? 0.5 : 1 },
      ]}
    >
      <Text style={styles.primaryBtnText}>{label}</Text>
    </Pressable>
  );
}

export function SettingsChoiceRow({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: string; label: string }[];
  value: string;
  onChange: (next: string) => void;
}) {
  const theme = useSettingsTheme();
  return (
    <SettingsRow label={label}>
      <RNView style={styles.choiceRow}>
        {options.map((opt) => {
          const selected = opt.value === value;
          return (
            <Pressable
              key={opt.value}
              onPress={() => onChange(opt.value)}
              style={[
                styles.choiceChip,
                {
                  backgroundColor: selected ? theme.tint : 'transparent',
                  borderColor: theme.border,
                },
              ]}
            >
              <Text style={{ color: selected ? '#fff' : theme.text, fontSize: 12, fontWeight: '600' }}>
                {opt.label}
              </Text>
            </Pressable>
          );
        })}
      </RNView>
    </SettingsRow>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  pageHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  back: { fontSize: 28, fontWeight: '300', width: 28, textAlign: 'center' },
  pageTitle: { flex: 1, fontSize: 17, fontWeight: '700' },
  trailingSlot: { minWidth: 28, alignItems: 'flex-end' },
  card: {
    borderRadius: SURFACE_RADIUS,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    marginHorizontal: 16,
    marginBottom: 16,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowText: { flex: 1, minWidth: 0 },
  rowLabel: { fontSize: 15, fontWeight: '600' },
  rowDesc: { fontSize: 12, marginTop: 2, lineHeight: 16 },
  fieldWrap: { paddingHorizontal: 14, paddingVertical: 10 },
  fieldLabel: { fontSize: 12, marginBottom: 6, fontWeight: '600' },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  stateBox: { padding: 24, alignItems: 'center' },
  stateText: { textAlign: 'center', fontSize: 14, lineHeight: 20 },
  primaryBtn: {
    marginHorizontal: 16,
    marginBottom: 16,
    borderRadius: 14,
    paddingVertical: 12,
    alignItems: 'center',
  },
  primaryBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end', maxWidth: '55%' },
  choiceChip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
});
