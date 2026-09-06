import React from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  View as RNView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text, View, useThemeColor } from '@/components/Themed';
import { useColorScheme } from '@/components/useColorScheme';
import { getAssistantPresentation } from '@/lib/assistantPresentation';
import { t } from '@/lib/i18n';
import type { ShareCatalogEntry } from '@/lib/systemShell/share';
import type { ShareDraft } from '@/lib/shareIn/drafts';

type Props = {
  draft: ShareDraft | null;
  entries: ShareCatalogEntry[];
  busy: boolean;
  onSelect: (draft: ShareDraft, entry: ShareCatalogEntry) => void;
  onCancel: (draft: ShareDraft) => void;
};

/**
 * Cap MobileShareRecipientPicker — exact instance+assistant pick for Android
 * share drafts without a pre-assigned target. No silent default.
 */
export function ShareRecipientPicker({ draft, entries, busy, onSelect, onCancel }: Props) {
  const insets = useSafeAreaInsets();
  const scheme = useColorScheme();
  const dark = scheme === 'dark';
  const text = useThemeColor({}, 'text');
  const muted = dark ? 'rgba(250,250,250,0.55)' : 'rgba(24,24,27,0.55)';
  const background = useThemeColor({}, 'background');
  const border = dark ? 'rgba(250,250,250,0.12)' : 'rgba(24,24,27,0.12)';
  const surface = dark ? '#171717' : '#ffffff';

  const handleCancel = () => {
    if (draft && !busy) onCancel(draft);
  };

  return (
    <Modal
      visible={Boolean(draft)}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={handleCancel}
    >
      <View style={[styles.root, { backgroundColor: background, paddingTop: insets.top }]}>
        <RNView style={[styles.header, { borderBottomColor: border }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('assistants.actions.cancel')}
            disabled={busy}
            onPress={handleCancel}
            hitSlop={12}
            style={styles.headerBtn}
          >
            <Text style={[styles.headerBtnText, { color: text, opacity: busy ? 0.4 : 1 }]}>
              {t('assistants.actions.cancel')}
            </Text>
          </Pressable>
          <Text style={[styles.headerTitle, { color: text }]} numberOfLines={1}>
            {t('assistants.guide.shareTitle')}
          </Text>
          <RNView style={styles.headerBtn} />
        </RNView>

        {entries.length === 0 ? (
          <Text style={[styles.empty, { color: muted }]}>{t('assistants.state.unavailable')}</Text>
        ) : (
          <FlatList
            data={entries}
            keyExtractor={(item) => `${item.connectionKey}:${item.assistantID}`}
            contentContainerStyle={{ paddingBottom: Math.max(12, insets.bottom) }}
            accessibilityLabel={t('assistants.listAria')}
            renderItem={({ item }) => {
              const presentation = getAssistantPresentation(item.name);
              const displayName = presentation.displayName || item.name;
              return (
                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() => {
                    if (draft) onSelect(draft, item);
                  }}
                  style={[
                    styles.row,
                    { borderBottomColor: border, opacity: busy ? 0.55 : 1 },
                  ]}
                >
                  <RNView
                    style={[
                      styles.avatar,
                      { backgroundColor: surface },
                    ]}
                  >
                    <Text style={[styles.avatarText, { color: text }]}>
                      {presentation.avatarEmoji ?? displayName.slice(0, 1).toUpperCase()}
                    </Text>
                  </RNView>
                  <RNView style={styles.rowBody}>
                    <Text style={[styles.rowTitle, { color: text }]} numberOfLines={1}>
                      {displayName}
                    </Text>
                    <Text style={[styles.rowSub, { color: muted }]} numberOfLines={1}>
                      {item.serverLabel}
                    </Text>
                  </RNView>
                  {busy ? <ActivityIndicator /> : null}
                </Pressable>
              );
            }}
          />
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerBtn: { minWidth: 64 },
  headerBtnText: { fontSize: 16 },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    fontSize: 17,
    fontWeight: '600',
  },
  empty: { paddingHorizontal: 20, paddingTop: 24, fontSize: 15 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontSize: 16, fontWeight: '600' },
  rowBody: { flex: 1, minWidth: 0 },
  rowTitle: { fontSize: 16, fontWeight: '600' },
  rowSub: { fontSize: 13, marginTop: 2 },
});
