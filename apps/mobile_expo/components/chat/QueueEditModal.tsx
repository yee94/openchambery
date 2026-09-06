/**
 * Simple TextInput modal for Android queue edit (iOS keeps Alert.prompt).
 */

import React, { useEffect, useState } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  TextInput,
  View as RNView,
} from 'react-native';

import { Text, useThemeColor } from '@/components/Themed';
import { t } from '@/lib/i18n';

export type QueueEditModalProps = {
  visible: boolean;
  initialValue: string;
  onCancel: () => void;
  onSave: (value: string) => void;
};

export function QueueEditModal({
  visible,
  initialValue,
  onCancel,
  onSave,
}: QueueEditModalProps) {
  const [value, setValue] = useState(initialValue);
  const textColor = useThemeColor({}, 'text');
  const muted = useThemeColor({}, 'muted');
  const backgroundColor = useThemeColor({}, 'background');

  useEffect(() => {
    if (visible) setValue(initialValue);
  }, [visible, initialValue]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <RNView style={styles.backdrop}>
        <RNView style={[styles.card, { backgroundColor }]}>
          <Text style={[styles.title, { color: textColor }]}>
            {t('mobile.chat.queue.editTitle')}
          </Text>
          <Text style={[styles.body, { color: muted }]}>{t('mobile.chat.queue.editBody')}</Text>
          <TextInput
            value={value}
            onChangeText={setValue}
            multiline
            autoFocus
            style={[styles.input, { color: textColor, borderColor: 'rgba(127,127,127,0.35)' }]}
            placeholderTextColor={muted}
          />
          <RNView style={styles.actions}>
            <Pressable onPress={onCancel} style={styles.btn} accessibilityRole="button">
              <Text style={{ color: muted }}>{t('mobile.chat.attach.cancel')}</Text>
            </Pressable>
            <Pressable
              onPress={() => onSave(value)}
              style={[styles.btn, styles.save]}
              accessibilityRole="button"
            >
              <Text style={styles.saveText}>{t('mobile.chat.queue.editSave')}</Text>
            </Pressable>
          </RNView>
        </RNView>
      </RNView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  card: {
    borderRadius: 14,
    padding: 16,
    gap: 10,
  },
  title: {
    fontSize: 17,
    fontWeight: '600',
  },
  body: {
    fontSize: 13,
  },
  input: {
    minHeight: 88,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 15,
    textAlignVertical: 'top',
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
    marginTop: 4,
  },
  btn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  save: {
    backgroundColor: '#E87722',
    borderRadius: 8,
  },
  saveText: {
    color: '#fff',
    fontWeight: '600',
  },
});
