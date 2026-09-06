import { useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  TextInput,
  View as RNView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { HighlightedText } from '@/components/projects/HighlightedText';
import { Text, View, useThemeColor } from '@/components/Themed';
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { useConnection } from '@/context/ConnectionContext';
import { useSessionHome } from '@/hooks/useSessionHome';
import { t } from '@/lib/i18n';
import {
  DRAFT_ROUTE_ID,
  filterHomeCatalogForSearch,
  type HomeSessionRow,
} from '@/lib/sessionHomeModel';

function SessionRow({
  session,
  query,
  onPress,
}: {
  session: HomeSessionRow;
  query?: string;
  onPress: (session: HomeSessionRow) => void;
}) {
  const muted = useThemeColor({}, 'muted');
  const text = useThemeColor({}, 'text');

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={session.title}
      onPress={() => onPress(session)}
      style={styles.row}
    >
      <RNView style={styles.rowMain}>
        <RNView style={styles.titleRow}>
          {session.unread ? <RNView style={styles.unreadDot} accessibilityLabel="unread" /> : null}
          <HighlightedText
            text={session.title}
            query={query}
            style={[styles.rowTitle, { color: text, fontWeight: session.unread ? '700' : '600' }]}
            numberOfLines={1}
          />
        </RNView>
        {session.subtitle ? (
          <HighlightedText
            text={session.subtitle}
            query={query}
            style={[styles.rowSubtitle, { color: muted }]}
            numberOfLines={1}
          />
        ) : null}
      </RNView>
    </Pressable>
  );
}

function SectionHeader({ title }: { title: string }) {
  const muted = useThemeColor({}, 'muted');
  return <Text style={[styles.sectionHeader, { color: muted }]}>{title}</Text>;
}

export function ProjectsHome() {
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme];
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { controller, statusLabel } = useConnection();
  const { status, model, error, refresh } = useSessionHome({
    untitledLabel: t('mobile.sessions.untitled'),
  });

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const searching = searchQuery.trim().length > 0;
  const filtered = useMemo(
    () => (model ? filterHomeCatalogForSearch(model, searchQuery) : { sessions: [], directories: [] }),
    [model, searchQuery],
  );

  const openSession = useCallback(
    (session: HomeSessionRow) => {
      setSearchOpen(false);
      setSearchQuery('');
      router.push(`/chat/${encodeURIComponent(session.id)}`);
    },
    [router],
  );

  const openDraft = useCallback(() => {
    setMenuOpen(false);
    router.push(`/chat/${DRAFT_ROUTE_ID}`);
  }, [router]);

  const openScan = useCallback(() => {
    setMenuOpen(false);
    router.push('/qr-scan');
  }, [router]);

  const switchInstance = useCallback(() => {
    setMenuOpen(false);
    controller.disconnectToOnboarding();
  }, [controller]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

  const highlight = searching ? searchQuery.trim() : undefined;

  return (
    <View style={styles.screen}>
      <RNView style={[styles.header, { paddingTop: Math.max(insets.top, 12) }]}>
        <RNView style={styles.headerTop}>
          <Text style={styles.title}>{t('mobile.sessions.section.projects')}</Text>
          <RNView style={styles.headerActions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                searchOpen ? t('mobile.sessions.clearSearchAria') : t('mobile.sessions.searchAria')
              }
              onPress={() => {
                if (searchOpen) {
                  setSearchQuery('');
                  setSearchOpen(false);
                } else {
                  setSearchOpen(true);
                }
              }}
              style={[styles.iconButton, { borderColor: colors.tabIconDefault }]}
            >
              <Text style={{ color: colors.tint, fontWeight: '600' }}>{searchOpen ? '×' : '⌕'}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('mobile.projects.menu.label')}
              onPress={() => setMenuOpen(true)}
              style={[styles.plusButton, { backgroundColor: colors.tint }]}
            >
              <Text style={styles.plusLabel}>+</Text>
            </Pressable>
          </RNView>
        </RNView>
        {statusLabel ? (
          <Text style={[styles.status, { color: colors.muted }]}>{statusLabel}</Text>
        ) : null}
        {searchOpen ? (
          <TextInput
            autoFocus
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder={t('mobile.sessions.search.placeholder')}
            placeholderTextColor={colors.tabIconDefault}
            accessibilityLabel={t('mobile.sessions.searchAria')}
            style={[
              styles.searchInput,
              {
                color: colors.text,
                borderColor: colors.tabIconDefault,
                backgroundColor: colorScheme === 'dark' ? '#171717' : '#fff',
              },
            ]}
          />
        ) : null}
      </RNView>

      {status === 'loading' && !model ? (
        <RNView style={styles.centered}>
          <ActivityIndicator color={colors.tint} />
        </RNView>
      ) : null}

      {status === 'error' ? (
        <RNView style={styles.centered}>
          <Text style={styles.errorTitle}>{t('mobile.sessions.index.error')}</Text>
          <Text style={[styles.errorBody, { color: colors.muted }]}>{error}</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => void refresh()}
            style={[styles.retryButton, { borderColor: colors.tint }]}
          >
            <Text style={{ color: colors.tint, fontWeight: '600' }}>{t('mobile.sessions.index.retry')}</Text>
          </Pressable>
        </RNView>
      ) : null}

      {status === 'unsupported' ? (
        <RNView style={styles.centered}>
          <Text style={[styles.errorBody, { color: colors.muted }]}>
            {t('mobile.sessions.index.unsupported')}
          </Text>
        </RNView>
      ) : null}

      {status === 'ready' && model ? (
        <ScrollView
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={colors.tint} />
          }
        >
          {searching ? (
            <>
              {filtered.sessions.length === 0 && filtered.directories.every((d) => d.sessions.length === 0) ? (
                <Text style={[styles.empty, { color: colors.muted }]}>
                  {t('mobile.sessions.search.empty')}
                </Text>
              ) : null}
              {filtered.sessions.map((session) => (
                <SessionRow key={`search-${session.id}`} session={session} query={highlight} onPress={openSession} />
              ))}
              {filtered.directories.map((group) => (
                <RNView key={`search-dir-${group.directory}`} style={styles.group}>
                  <SectionHeader title={group.label} />
                  {group.sessions.map((session) => (
                    <SessionRow
                      key={session.id}
                      session={session}
                      query={highlight}
                      onPress={openSession}
                    />
                  ))}
                </RNView>
              ))}
            </>
          ) : (
            <>
              {model.pinned.length > 0 ? (
                <RNView style={styles.group}>
                  <SectionHeader title={t('mobile.sessions.section.pinned')} />
                  {model.pinned.map((session) => (
                    <SessionRow key={`pin-${session.id}`} session={session} onPress={openSession} />
                  ))}
                </RNView>
              ) : null}
              {model.inProgress.length > 0 ? (
                <RNView style={styles.group}>
                  <SectionHeader title={t('mobile.sessions.section.inProgress')} />
                  {model.inProgress.map((session) => (
                    <SessionRow key={`prog-${session.id}`} session={session} onPress={openSession} />
                  ))}
                </RNView>
              ) : null}
              {model.directories.map((group) => (
                <RNView key={group.directory} style={styles.group}>
                  <SectionHeader title={group.label} />
                  {group.sessions.length === 0 ? (
                    <Text style={[styles.empty, { color: colors.muted }]}>
                      {t('mobile.sessions.emptyDirectory')}
                    </Text>
                  ) : (
                    group.sessions.map((session) => (
                      <SessionRow key={session.id} session={session} onPress={openSession} />
                    ))
                  )}
                </RNView>
              ))}
              {model.directories.length === 0 && model.pinned.length === 0 ? (
                <Text style={[styles.empty, { color: colors.muted }]}>
                  {t('mobile.sessions.emptyHome')}
                </Text>
              ) : null}
            </>
          )}
        </ScrollView>
      ) : null}

      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable style={styles.menuBackdrop} onPress={() => setMenuOpen(false)}>
          <RNView
            style={[
              styles.menuCard,
              {
                backgroundColor: colorScheme === 'dark' ? '#171717' : '#fff',
                top: Math.max(insets.top, 12) + 52,
              },
            ]}
          >
            <Pressable accessibilityRole="button" style={styles.menuItem} onPress={openDraft}>
              <Text style={styles.menuItemLabel}>{t('mobile.projects.menu.newChat')}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" style={styles.menuItem} onPress={openScan}>
              <Text style={styles.menuItemLabel}>{t('mobile.projects.menu.scanQr')}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" style={styles.menuItem} onPress={switchInstance}>
              <Text style={styles.menuItemLabel}>{t('mobile.projects.menu.switchInstance')}</Text>
            </Pressable>
          </RNView>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 16,
    paddingBottom: 8,
    gap: 8,
  },
  headerTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
  },
  status: {
    fontSize: 13,
  },
  headerActions: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  plusButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  plusLabel: {
    color: '#fff',
    fontSize: 24,
    fontWeight: '600',
    marginTop: -2,
  },
  searchInput: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  listContent: {
    paddingHorizontal: 12,
    paddingBottom: 32,
    gap: 4,
  },
  group: {
    marginTop: 12,
    gap: 2,
  },
  sectionHeader: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  row: {
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  rowMain: {
    gap: 2,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#3b82f6',
  },
  rowTitle: {
    flex: 1,
    fontSize: 16,
  },
  rowSubtitle: {
    fontSize: 13,
    marginLeft: 16,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    gap: 12,
  },
  errorTitle: {
    fontSize: 17,
    fontWeight: '600',
  },
  errorBody: {
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  retryButton: {
    marginTop: 4,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  empty: {
    paddingHorizontal: 12,
    paddingVertical: 16,
    fontSize: 14,
  },
  menuBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  menuCard: {
    position: 'absolute',
    right: 16,
    minWidth: 180,
    borderRadius: 14,
    paddingVertical: 6,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  menuItem: {
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  menuItemLabel: {
    fontSize: 16,
    fontWeight: '500',
  },
});
