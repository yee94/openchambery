import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  TextInput,
  View as RNView,
} from 'react-native';
import Animated from 'react-native-reanimated';

import {
  MobileTabPageHeader,
  useCollapsingTabHeader,
} from '@/components/chrome/MobileTabPageHeader';
import { SURFACE_RADIUS, useSettingsTheme } from '@/components/settings/SettingsChrome';
import { Text, View } from '@/components/Themed';
import { t } from '@/lib/i18n';
import {
  buildSettingsHomeGroups,
  searchSettingsPages,
} from '@/lib/settings/settingsHomeModel';
import type { SettingsPageSlug } from '@/lib/settings/metadata';

export function SettingsHome() {
  const router = useRouter();
  const theme = useSettingsTheme();
  const { scrollY, onScroll, listTopPad } = useCollapsingTabHeader();
  const [query, setQuery] = useState('');
  const groups = useMemo(() => buildSettingsHomeGroups(), []);
  const hits = useMemo(
    () => searchSettingsPages(query, { translate: t }),
    [query],
  );

  const openPage = (slug: SettingsPageSlug) => {
    router.push({ pathname: '/(tabs)/settings', params: { slug } });
  };

  return (
    <View style={styles.root}>
      <MobileTabPageHeader title={t('mobile.tabs.settings')} scrollY={scrollY} />
      <Animated.ScrollView
        onScroll={onScroll}
        scrollEventThrottle={16}
        contentContainerStyle={{ paddingTop: listTopPad, paddingBottom: 32 }}
        keyboardShouldPersistTaps="handled"
      >
        <RNView style={[styles.searchWrap, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={t('settings.home.searchPlaceholder')}
            placeholderTextColor={theme.muted}
            style={[styles.search, { color: theme.text }]}
            autoCapitalize="none"
            autoCorrect={false}
            testID="settings-search"
          />
        </RNView>

        {query.trim() ? (
          <RNView style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            {hits.length === 0 ? (
              <Text style={[styles.empty, { color: theme.muted }]}>{t('settings.home.searchEmpty')}</Text>
            ) : (
              hits.map((hit) => (
                <Pressable
                  key={hit.slug}
                  onPress={() => openPage(hit.slug)}
                  style={[styles.row, { borderBottomColor: theme.border }]}
                  testID={`settings-search-${hit.slug}`}
                >
                  <RNView style={{ flex: 1 }}>
                    <Text style={[styles.rowTitle, { color: theme.text }]}>{t(hit.titleKey)}</Text>
                    <Text style={[styles.rowSub, { color: theme.muted }]}>{t(hit.groupTitleKey)}</Text>
                  </RNView>
                  <Text style={{ color: theme.muted }}>›</Text>
                </Pressable>
              ))
            )}
          </RNView>
        ) : (
          groups.map((group) => (
            <RNView key={group.group} style={styles.groupBlock}>
              <Text style={[styles.groupTitle, { color: theme.muted }]}>{t(group.titleKey)}</Text>
              <RNView style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                {group.pages.map((page) => (
                  <Pressable
                    key={page.slug}
                    onPress={() => openPage(page.slug)}
                    style={[styles.row, { borderBottomColor: theme.border }]}
                    testID={`settings-nav-${page.slug}`}
                  >
                    <Text style={[styles.rowTitle, { color: theme.text }]}>{t(page.titleKey)}</Text>
                    <Text style={{ color: theme.muted }}>›</Text>
                  </Pressable>
                ))}
              </RNView>
            </RNView>
          ))
        )}
      </Animated.ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  searchWrap: {
    marginHorizontal: 16,
    marginBottom: 12,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
  },
  search: { height: 42, fontSize: 15 },
  groupBlock: { marginBottom: 8 },
  groupTitle: {
    marginHorizontal: 20,
    marginBottom: 6,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  card: {
    marginHorizontal: 16,
    marginBottom: 12,
    borderRadius: SURFACE_RADIUS,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowTitle: { fontSize: 15, fontWeight: '600' },
  rowSub: { fontSize: 12, marginTop: 2 },
  empty: { padding: 16, textAlign: 'center' },
});
