import React, { memo } from 'react';
import { Pressable, ScrollView, StyleSheet, View as RNView } from 'react-native';

import { Text, useThemeColor } from '@/components/Themed';
import type { MessageQueueChipItem } from '@/lib/messageQueueApi';
import { previewQueueContent } from '@/lib/messageQueueApi';
import { t } from '@/lib/i18n';

export type QueuedMessageChipsProps = {
  items: MessageQueueChipItem[];
  onRemove?: (item: MessageQueueChipItem) => void;
  /** Move item earlier in queue (no DnD). */
  onMoveUp?: (item: MessageQueueChipItem) => void;
  /** Move item later in queue (no DnD). */
  onMoveDown?: (item: MessageQueueChipItem) => void;
  onEdit?: (item: MessageQueueChipItem) => void;
};

function QueuedMessageChipsImpl({
  items,
  onRemove,
  onMoveUp,
  onMoveDown,
  onEdit,
}: QueuedMessageChipsProps) {
  const textColor = useThemeColor({}, 'text');
  const muted = useThemeColor({}, 'muted');

  if (items.length === 0) return null;

  return (
    <RNView style={styles.wrap} accessibilityRole="summary">
      <Text style={[styles.caption, { color: muted }]}>
        {t('mobile.chat.queue.caption', { count: items.length })}
      </Text>
      <ScrollView
        horizontal={false}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        keyboardShouldPersistTaps="handled"
      >
        {items.map((item, index) => (
          <RNView key={item.queueItemID} style={styles.chip}>
            <Pressable
              style={styles.previewHit}
              onLongPress={onEdit ? () => onEdit(item) : undefined}
              accessibilityRole={onEdit ? 'button' : undefined}
              accessibilityLabel={
                onEdit ? t('mobile.chat.queue.editAria') : undefined
              }
            >
              <Text style={[styles.preview, { color: textColor }]} numberOfLines={1}>
                {previewQueueContent(item.content) || t('mobile.chat.queue.emptyPreview')}
              </Text>
            </Pressable>
            {onMoveUp ? (
              <Pressable
                onPress={() => onMoveUp(item)}
                disabled={index === 0}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel={t('mobile.chat.queue.moveUpAria')}
                style={index === 0 ? styles.disabledCtrl : undefined}
              >
                <Text style={[styles.ctrl, { color: muted }]}>↑</Text>
              </Pressable>
            ) : null}
            {onMoveDown ? (
              <Pressable
                onPress={() => onMoveDown(item)}
                disabled={index === items.length - 1}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel={t('mobile.chat.queue.moveDownAria')}
                style={index === items.length - 1 ? styles.disabledCtrl : undefined}
              >
                <Text style={[styles.ctrl, { color: muted }]}>↓</Text>
              </Pressable>
            ) : null}
            {onRemove ? (
              <Pressable
                onPress={() => onRemove(item)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={t('mobile.chat.queue.removeAria')}
              >
                <Text style={[styles.remove, { color: muted }]}>×</Text>
              </Pressable>
            ) : null}
          </RNView>
        ))}
      </ScrollView>
    </RNView>
  );
}

export const QueuedMessageChips = memo(QueuedMessageChipsImpl);

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: 2,
    gap: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(127,127,127,0.25)',
  },
  caption: {
    fontSize: 11,
  },
  list: {
    maxHeight: 96,
  },
  listContent: {
    gap: 4,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 7,
    backgroundColor: 'rgba(127,127,127,0.12)',
  },
  previewHit: {
    flex: 1,
    minWidth: 0,
  },
  preview: {
    fontSize: 13,
  },
  ctrl: {
    fontSize: 14,
    fontWeight: '700',
    paddingHorizontal: 2,
  },
  disabledCtrl: {
    opacity: 0.3,
  },
  remove: {
    fontSize: 18,
    lineHeight: 18,
    paddingHorizontal: 2,
  },
});
