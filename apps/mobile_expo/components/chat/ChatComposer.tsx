import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  TextInput,
  View as RNView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text, useThemeColor } from '@/components/Themed';
import { t } from '@/lib/i18n';

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
  const text = useThemeColor({}, 'text');
  const muted = useThemeColor({}, 'muted');
  const background = useThemeColor({}, 'background');
  const canSend = value.trim().length > 0 && !disabled;

  return (
    <RNView
      style={[
        styles.shell,
        {
          paddingBottom: Math.max(insets.bottom, 8),
          backgroundColor: background,
          borderTopColor: 'rgba(127,127,127,0.25)',
        },
      ]}
    >
      <RNView style={[styles.pill, { borderColor: 'rgba(127,127,127,0.35)' }]}>
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
            onPress={onStop}
            style={[styles.action, styles.stop]}
          >
            <Text style={styles.actionLabel}>{t('mobile.chat.stop')}</Text>
          </Pressable>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('mobile.chat.send')}
            onPress={onSend}
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
      </RNView>
    </RNView>
  );
}

const styles = StyleSheet.create({
  shell: {
    paddingHorizontal: 12,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  pill: {
    minHeight: 48,
    borderRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
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
