import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Switch,
  TextInput,
  View as RNView,
  type TextInputProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text, useThemeColor } from '@/components/Themed';
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { t } from '@/lib/i18n';

/** Cap --oc-settings-group-radius (1rem). Distinct from --oc-mobile-surface-radius. */
export const SURFACE_RADIUS = 16;
/** Cap --oc-settings-row-min-height (3.25rem). */
export const SETTINGS_ROW_MIN_HEIGHT = 52;
/** Cap --oc-settings-row-inset (0.875rem). */
export const SETTINGS_ROW_INSET = 14;
/** Cap --oc-settings-section-stack-gap (1.25rem). */
export const SETTINGS_SECTION_STACK_GAP = 20;
/** Cap --oc-settings-section-gap (0.5rem). */
export const SETTINGS_SECTION_GAP = 8;
/** Cap --oc-mobile-control-radius for search / controls. */
export const SETTINGS_CONTROL_RADIUS = 20;
/** Cap --oc-mobile-page-inline-inset ≈ 1.125rem; Expo tabs use 16. */
export const SETTINGS_PAGE_INSET = 16;

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
    surface: dark ? Colors.dark.card : Colors.light.card,
    border: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
    danger: dark ? Colors.dark.destructive : Colors.light.destructive,
    field: dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
    selectionWash: dark ? 'rgba(251,146,60,0.18)' : 'rgba(194,65,12,0.12)',
  };
}

/** Cap arrow-right-s chevron on nav / search rows. */
export function SettingsChevron({ color }: { color: string }) {
  return (
    <Text style={[styles.chevron, { color }]} accessible={false}>
      ›
    </Text>
  );
}

/** Divider style for list rows inside a SettingsCard (skip last). */
export function settingsRowDivider(
  borderColor: string,
  isLast: boolean,
): StyleProp<ViewStyle> {
  if (isLast) return null;
  return {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: borderColor,
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
        <Pressable
          onPress={onBack}
          hitSlop={12}
          testID="settings-back"
          style={[styles.backHit, { backgroundColor: theme.field }]}
        >
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
  showDivider = true,
}: {
  label: string;
  description?: string;
  children?: React.ReactNode;
  showDivider?: boolean;
}) {
  const theme = useSettingsTheme();
  return (
    <RNView
      style={[
        styles.row,
        showDivider ? { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border } : null,
      ]}
    >
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
  showDivider = true,
}: {
  label: string;
  description?: string;
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
  showDivider?: boolean;
}) {
  const theme = useSettingsTheme();
  return (
    <SettingsRow label={label} description={description} showDivider={showDivider}>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        trackColor={{ false: theme.border, true: theme.tint }}
        thumbColor="#ffffff"
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
            backgroundColor: theme.field,
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
        <Pressable onPress={onRetry} hitSlop={8}>
          <Text style={{ color: theme.tint, marginTop: 8, fontWeight: '600' }}>
            {t('settings.actions.retry')}
          </Text>
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
  showDivider = true,
}: {
  label: string;
  options: { value: string; label: string }[];
  value: string;
  onChange: (next: string) => void;
  showDivider?: boolean;
}) {
  const theme = useSettingsTheme();
  return (
    <SettingsRow label={label} showDivider={showDivider}>
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
    minHeight: 56,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  backHit: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  back: { fontSize: 28, fontWeight: '300', marginTop: -2 },
  pageTitle: { flex: 1, fontSize: 17, fontWeight: '700', letterSpacing: -0.2 },
  trailingSlot: { minWidth: 40, alignItems: 'flex-end' },
  card: {
    borderRadius: SURFACE_RADIUS,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    marginHorizontal: SETTINGS_PAGE_INSET,
    marginBottom: 16,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingHorizontal: SETTINGS_ROW_INSET,
    paddingVertical: 11,
    minHeight: SETTINGS_ROW_MIN_HEIGHT,
  },
  rowText: { flex: 1, minWidth: 0 },
  rowLabel: { fontSize: 15, fontWeight: '400' },
  rowDesc: { fontSize: 12, marginTop: 2, lineHeight: 16 },
  fieldWrap: { paddingHorizontal: SETTINGS_ROW_INSET, paddingVertical: 10 },
  fieldLabel: { fontSize: 12, marginBottom: 6, fontWeight: '400' },
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
    marginHorizontal: SETTINGS_PAGE_INSET,
    marginBottom: 16,
    borderRadius: 14,
    paddingVertical: 12,
    alignItems: 'center',
  },
  primaryBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  choiceRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    justifyContent: 'flex-end',
    maxWidth: '55%',
  },
  choiceChip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  chevron: {
    fontSize: 22,
    fontWeight: '300',
    lineHeight: 24,
    opacity: 0.6,
    marginLeft: 4,
  },
});
