import React from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, View as RNView } from 'react-native';

import { Text } from '@/components/Themed';
import { t } from '@/lib/i18n';
import Colors from '@/constants/Colors';

type Props = {
  visible: boolean;
  name: string;
  pending: boolean;
  dark: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

export function AssistantDeleteConfirm({
  visible,
  name,
  pending,
  dark,
  onCancel,
  onConfirm,
}: Props) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable style={styles.backdrop} onPress={pending ? undefined : onCancel}>
        <Pressable
          style={[styles.card, { backgroundColor: dark ? Colors.dark.card : Colors.light.card }]}
          onPress={(e) => e.stopPropagation?.()}
        >
          <Text style={styles.title}>{t('assistants.settings.delete')}</Text>
          <Text style={styles.body}>{t('assistants.settings.deleteConfirm', { name })}</Text>
          <RNView style={styles.row}>
            <Pressable
              accessibilityRole="button"
              disabled={pending}
              onPress={onCancel}
              style={[styles.btn, styles.cancel]}
            >
              <Text style={styles.cancelLabel}>{t('assistants.actions.cancel')}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={pending}
              onPress={onConfirm}
              style={[styles.btn, styles.destructive]}
            >
              {pending ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.destructiveLabel}>{t('assistants.actions.delete')}</Text>
              )}
            </Pressable>
          </RNView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  card: {
    borderRadius: 16,
    padding: 20,
    gap: 12,
  },
  title: {
    fontSize: 17,
    fontWeight: '600',
  },
  body: {
    fontSize: 14,
    lineHeight: 20,
    opacity: 0.75,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    marginTop: 8,
  },
  btn: {
    minHeight: 40,
    minWidth: 88,
    paddingHorizontal: 14,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancel: {
    backgroundColor: 'transparent',
  },
  cancelLabel: {
    fontSize: 15,
    fontWeight: '500',
    opacity: 0.8,
  },
  destructive: {
    backgroundColor: '#dc2626',
  },
  destructiveLabel: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
});
