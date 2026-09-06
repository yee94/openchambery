import React, { memo } from 'react';
import { Pressable, ScrollView, StyleSheet, View as RNView } from 'react-native';

import { Text, useThemeColor } from '@/components/Themed';
import type { ComposerAutocompleteRow } from '@/lib/composerAutocomplete';
import { t } from '@/lib/i18n';

export type ComposerAutocompleteListProps = {
  rows: ComposerAutocompleteRow[];
  onSelect: (row: ComposerAutocompleteRow) => void;
  loading?: boolean;
};

function ComposerAutocompleteListImpl({
  rows,
  onSelect,
  loading,
}: ComposerAutocompleteListProps) {
  const textColor = useThemeColor({}, 'text');
  const muted = useThemeColor({}, 'muted');

  if (!loading && rows.length === 0) return null;

  return (
    <RNView style={styles.wrap} accessibilityRole="menu">
      {loading && rows.length === 0 ? (
        <Text style={[styles.empty, { color: muted }]}>
          {t('mobile.chat.autocomplete.loading')}
        </Text>
      ) : null}
      <ScrollView
        keyboardShouldPersistTaps="handled"
        style={styles.list}
        contentContainerStyle={styles.listContent}
      >
        {rows.map((row) => (
          <Pressable
            key={row.id}
            onPress={() => onSelect(row)}
            style={styles.row}
            accessibilityRole="menuitem"
            accessibilityLabel={row.title}
          >
            <RNView style={styles.rowMain}>
              <Text style={[styles.title, { color: textColor }]} numberOfLines={1}>
                {row.title}
              </Text>
              {row.subtitle ? (
                <Text style={[styles.subtitle, { color: muted }]} numberOfLines={1}>
                  {row.subtitle}
                </Text>
              ) : null}
            </RNView>
            {row.badge ? (
              <Text style={[styles.badge, { color: muted }]} numberOfLines={1}>
                {row.badge}
              </Text>
            ) : null}
          </Pressable>
        ))}
      </ScrollView>
    </RNView>
  );
}

export const ComposerAutocompleteList = memo(ComposerAutocompleteListImpl);

const styles = StyleSheet.create({
  wrap: {
    marginHorizontal: 12,
    marginBottom: 4,
    borderRadius: 14,
    maxHeight: 220,
    backgroundColor: 'rgba(30,30,30,0.92)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.12)',
    overflow: 'hidden',
  },
  list: {
    maxHeight: 220,
  },
  listContent: {
    paddingVertical: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  rowMain: {
    flex: 1,
    gap: 2,
    minWidth: 0,
  },
  title: {
    fontSize: 14,
    fontWeight: '600',
  },
  subtitle: {
    fontSize: 12,
  },
  badge: {
    fontSize: 11,
    maxWidth: 72,
  },
  empty: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13,
  },
});
