import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  TextInput,
  View as RNView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GlassComposerShell } from '@/components/chrome/GlassComposerShell';
import { Text, useThemeColor } from '@/components/Themed';
import { useColorScheme } from '@/components/useColorScheme';
import { t } from '@/lib/i18n';
import { impactLight, impactMedium } from '@/lib/systemShell/haptics';

export type ChatComposerProps = {
  value: string;
  onChangeText: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  disabled?: boolean;
};

/**
 * Text + Send/Stop only. No mic / TTS (will-not-port).
 * iOS glass via expo-glass-effect UIGlassEffect; Android solid capsule (honest degrade).
 * Occupancy = collapsed pill only (Cap contract) — no opaque banner behind the pill.
 */
export function ChatComposer({
  value,
  onChangeText,
  onSend,
  onStop,
  busy,
  disabled,
}: ChatComposerProps) {
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme();
  const text = useThemeColor({}, 'text');
  const muted = useThemeColor({}, 'muted');
  const canSend = value.trim().length > 0 && !disabled;

  return (
    <RNView
      pointerEvents="box-none"
      style={[
        styles.shell,
        {
          paddingBottom: Math.max(insets.bottom, 8),
        },
      ]}
    >
      <GlassComposerShell colorScheme={colorScheme === 'dark' ? 'dark' : 'light'} style={styles.pill}>
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={t('mobile.chat.composer.placeholder')}
          placeholderTextColor={muted}
          style={[styles.input, { color: text }]}
          multiline
          editable={!disabled}
          accessibilityLabel={t('mobile.chat.composer.placeholder')}
        />
        {busy ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('mobile.chat.stop')}
            onPress={() => {
              void impactMedium();
              onStop();
            }}
            style={[styles.action, styles.stop]}
          >
            <Text style={styles.actionLabel}>{t('mobile.chat.stop')}</Text>
          </Pressable>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('mobile.chat.send')}
            onPress={() => {
              if (!canSend) return;
              void impactLight();
              onSend();
            }}
            disabled={!canSend}
            style={[styles.action, styles.send, !canSend && styles.disabled]}
          >
            {disabled ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.actionLabel}>{t('mobile.chat.send')}</Text>
            )}
          </Pressable>
        )}
      </GlassComposerShell>
    </RNView>
  );
}

const styles = StyleSheet.create({
  shell: {
    paddingHorizontal: 12,
    paddingTop: 8,
    backgroundColor: 'transparent',
  },
  pill: {
    minHeight: 48,
    borderRadius: 24,
    paddingLeft: 14,
    paddingRight: 6,
    paddingVertical: 6,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
  },
  input: {
    flex: 1,
    maxHeight: 120,
    fontSize: 16,
    lineHeight: 22,
    paddingTop: 8,
    paddingBottom: 8,
  },
  action: {
    minWidth: 64,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  send: {
    backgroundColor: '#E87722',
  },
  stop: {
    backgroundColor: '#B42318',
  },
  disabled: {
    opacity: 0.45,
  },
  actionLabel: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 14,
  },
});
