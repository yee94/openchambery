import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  TextInput,
  View as RNView,
} from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  MobileTabPageHeader,
  useCollapsingTabHeader,
} from '@/components/chrome/MobileTabPageHeader';
import {
  SETTINGS_CONTROL_RADIUS,
  SETTINGS_PAGE_INSET,
  SETTINGS_ROW_INSET,
  SETTINGS_ROW_MIN_HEIGHT,
  SETTINGS_SECTION_GAP,
  SETTINGS_SECTION_STACK_GAP,
  SURFACE_RADIUS,
  SettingsChevron,
  settingsRowDivider,
  useSettingsTheme,
} from '@/components/settings/SettingsChrome';
import { Text, View } from '@/components/Themed';
import { t } from '@/lib/i18n';
import {
  buildSettingsHomeGroups,
  searchSettingsPages,
} from '@/lib/settings/settingsHomeModel';
import type { SettingsPageSlug } from '@/lib/settings/metadata';

export function SettingsHome() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
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
        contentContainerStyle={{
          paddingTop: listTopPad,
          paddingBottom: insets.bottom + 88,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <RNView
          style={[
            styles.searchWrap,
            { backgroundColor: theme.field },
          ]}
        >
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
          <RNView
            style={[
              styles.card,
              { backgroundColor: theme.surface, borderColor: theme.border },
            ]}
          >
            {hits.length === 0 ? (
              <Text style={[styles.empty, { color: theme.muted }]}>
                {t('settings.home.searchEmpty')}
              </Text>
            ) : (
              hits.map((hit, index) => (
                <Pressable
                  key={hit.slug}
                  onPress={() => openPage(hit.slug)}
                  style={[
                    styles.row,
                    settingsRowDivider(theme.border, index === hits.length - 1),
                  ]}
                  testID={`settings-search-${hit.slug}`}
                >
                  <RNView style={styles.rowText}>
                    <Text style={[styles.rowTitle, { color: theme.text }]}>
                      {t(hit.titleKey)}
                    </Text>
                    <Text style={[styles.rowSub, { color: theme.muted }]}>
                      {t(hit.groupTitleKey)}
                    </Text>
                  </RNView>
                  <SettingsChevron color={theme.muted} />
                </Pressable>
              ))
            )}
          </RNView>
        ) : (
          <RNView style={styles.navList}>
            {groups.map((group) => (
              <RNView key={group.group} style={styles.groupBlock}>
                <Text style={[styles.groupTitle, { color: theme.muted }]}>
                  {t(group.titleKey)}
                </Text>
                <RNView
                  style={[
                    styles.card,
                    {
                      backgroundColor: theme.surface,
                      borderColor: theme.border,
                      marginBottom: 0,
                    },
                  ]}
                >
                  {group.pages.map((page, index) => (
                    <Pressable
                      key={page.slug}
                      onPress={() => openPage(page.slug)}
                      style={[
                        styles.row,
                        settingsRowDivider(
                          theme.border,
                          index === group.pages.length - 1,
                        ),
                      ]}
                      testID={`settings-nav-${page.slug}`}
                    >
                      <Text style={[styles.rowTitle, { color: theme.text }]}>
                        {t(page.titleKey)}
                      </Text>
                      <SettingsChevron color={theme.muted} />
                    </Pressable>
                  ))}
                </RNView>
              </RNView>
            ))}
          </RNView>
        )}
      </Animated.ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  searchWrap: {
    marginHorizontal: SETTINGS_PAGE_INSET,
    marginBottom: 4,
    borderRadius: SETTINGS_CONTROL_RADIUS,
    paddingHorizontal: 12,
    minHeight: 44,
    justifyContent: 'center',
  },
  search: { height: 44, fontSize: 15 },
  navList: {
    marginTop: SETTINGS_SECTION_STACK_GAP,
    gap: SETTINGS_SECTION_STACK_GAP,
  },
  groupBlock: {
    gap: SETTINGS_SECTION_GAP,
  },
  groupTitle: {
    marginHorizontal: SETTINGS_PAGE_INSET + 8,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '400',
  },
  card: {
    marginHorizontal: SETTINGS_PAGE_INSET,
    marginBottom: 12,
    borderRadius: SURFACE_RADIUS,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
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
  rowTitle: { fontSize: 15, fontWeight: '400' },
  rowSub: { fontSize: 12, marginTop: 2, lineHeight: 16 },
  empty: { padding: 16, textAlign: 'center', fontSize: 14 },
});
