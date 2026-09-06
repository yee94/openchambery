import React, { memo } from 'react';
import { Pressable, ScrollView, StyleSheet, View as RNView } from 'react-native';

import { Text, useThemeColor } from '@/components/Themed';
import type { MessageQueueChipItem } from '@/lib/messageQueueApi';
import { previewQueueContent } from '@/lib/messageQueueApi';
import { t } from '@/lib/i18n';

export type QueuedMessageChipsProps = {
  items: MessageQueueChipItem[];
  onRemove?: (item: MessageQueueChipItem) => void;
};

function QueuedMessageChipsImpl({ items, onRemove }: QueuedMessageChipsProps) {
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
        {items.map((item) => (
          <RNView key={item.queueItemID} style={styles.chip}>
            <Text style={[styles.preview, { color: textColor }]} numberOfLines={1}>
              {previewQueueContent(item.content) || t('mobile.chat.queue.emptyPreview')}
            </Text>
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
    gap: 8,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 7,
    backgroundColor: 'rgba(127,127,127,0.12)',
  },
  preview: {
    flex: 1,
    fontSize: 13,
  },
  remove: {
    fontSize: 18,
    lineHeight: 18,
    paddingHorizontal: 2,
  },
});
