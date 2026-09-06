/**
 * Cap-parity MobileSessionsSheet host for Expo Chat.
 * Session list + search + pin + open session + draft, wired from session-index / homeAttention.
 * Expo owns pixels — functional Modalsheet, not a Cap CSS clone.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  TextInput,
  View as RNView,
} from 'react-native';

import { HighlightedText } from '@/components/projects/HighlightedText';
import { Text, useThemeColor } from '@/components/Themed';
import { useConnection } from '@/context/ConnectionContext';
import { useHomeAttention } from '@/hooks/useHomeAttention';
import { useSessionHome } from '@/hooks/useSessionHome';
import { t } from '@/lib/i18n';
import {
  filterHomeCatalogForSearch,
  type HomeSessionRow,
} from '@/lib/sessionHomeModel';
import { togglePinnedSession } from '@/lib/sessionIndexPin';

export type MobileSessionsSheetProps = {
  visible: boolean;
  currentSessionId: string | null;
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
  onDraft: () => void;
};

type ListRow =
  | { kind: 'section'; key: string; title: string }
  | { kind: 'session'; key: string; session: HomeSessionRow }
  | { kind: 'empty'; key: string; message: string };

const formatRelativeShort = (timestamp: number): string => {
  if (timestamp <= 0) return '';
  const diffMs = Date.now() - timestamp;
  if (diffMs < 60_000) return 'now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(
    new Date(timestamp),
  );
};

export function MobileSessionsSheet({
  visible,
  currentSessionId,
  onClose,
  onOpenSession,
  onDraft,
}: MobileSessionsSheetProps) {
  const { state } = useConnection();
  const active = state.active;
  const attention = useHomeAttention({ enabled: Boolean(active), bridge: false });
  const home = useSessionHome({
    unseenBySession: attention.unseenBySession,
    runningSessionIds: attention.runningSessionIds,
    untitledLabel: t('mobile.sessions.untitled'),
  });
  const textColor = useThemeColor({}, 'text');
  const muted = useThemeColor({}, 'muted');
  const [query, setQuery] = useState('');
  const [pinBusyId, setPinBusyId] = useState<string | null>(null);
  const [pinOverrides, setPinOverrides] = useState<Record<string, boolean>>({});
  const [pinError, setPinError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) {
      setQuery('');
      setPinOverrides({});
      setPinError(null);
      setPinBusyId(null);
      return;
    }
    void home.refresh();
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps -- refresh on open only

  const applyPinOverride = useCallback((session: HomeSessionRow): HomeSessionRow => {
    const override = pinOverrides[session.id];
    if (override === undefined) return session;
    return { ...session, pinned: override };
  }, [pinOverrides]);

  const rows = useMemo((): ListRow[] => {
    const model = home.model;
    if (!model) return [];

    const withOverrides = (list: HomeSessionRow[]) => list.map(applyPinOverride);

    if (query.trim()) {
      const filtered = filterHomeCatalogForSearch(model, query);
      const sessions = withOverrides(filtered.sessions).sort((a, b) => b.activityMs - a.activityMs);
      if (sessions.length === 0) {
        return [{ kind: 'empty', key: 'search-empty', message: t('mobile.sessions.search.empty') }];
      }
      return [
        {
          kind: 'section',
          key: 'search',
          title: t('mobile.sessions.search.section.sessions'),
        },
        ...sessions.map((session) => ({
          kind: 'session' as const,
          key: `s:${session.id}`,
          session,
        })),
      ];
    }

    const pinned = withOverrides(model.pinned)
      .filter((s) => s.pinned)
      .sort((a, b) => b.activityMs - a.activityMs);
    const inProgress = withOverrides(model.inProgress)
      .filter((s) => !s.pinned)
      .sort((a, b) => b.activityMs - a.activityMs);
    const directoryRows: ListRow[] = [];
    for (const group of model.directories) {
      const sessions = withOverrides(group.sessions).filter((s) => !s.pinned);
      if (sessions.length === 0) continue;
      directoryRows.push({
        kind: 'section',
        key: `dir:${group.directory}`,
        title: group.label || group.directory,
      });
      for (const session of sessions) {
        directoryRows.push({ kind: 'session', key: `s:${session.id}`, session });
      }
    }

    const out: ListRow[] = [];
    if (pinned.length > 0) {
      out.push({ kind: 'section', key: 'pinned', title: t('mobile.sessions.section.pinned') });
      for (const session of pinned) {
        out.push({ kind: 'session', key: `s:${session.id}`, session });
      }
    }
    if (inProgress.length > 0) {
      out.push({
        kind: 'section',
        key: 'in-progress',
        title: t('mobile.sessions.section.inProgress'),
      });
      for (const session of inProgress) {
        out.push({ kind: 'session', key: `s:${session.id}`, session });
      }
    }
    out.push(...directoryRows);

    if (out.length === 0) {
      return [{ kind: 'empty', key: 'empty', message: t('mobile.sessions.emptyHome') }];
    }
    return out;
  }, [applyPinOverride, home.model, query]);

  const onTogglePin = useCallback(
    async (session: HomeSessionRow) => {
      if (!active || pinBusyId) return;
      setPinBusyId(session.id);
      setPinError(null);
      const nextPinned = !session.pinned;
      setPinOverrides((prev) => ({ ...prev, [session.id]: nextPinned }));
      try {
        await togglePinnedSession(active, session.id, session.pinned);
        await home.refresh();
        setPinOverrides((prev) => {
          const copy = { ...prev };
          delete copy[session.id];
          return copy;
        });
      } catch (err) {
        setPinOverrides((prev) => {
          const copy = { ...prev };
          delete copy[session.id];
          return copy;
        });
        setPinError(err instanceof Error ? err.message : t('mobile.sessions.pin.error'));
      } finally {
        setPinBusyId(null);
      }
    },
    [active, home, pinBusyId],
  );

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <RNView style={styles.root}>
        <RNView style={styles.header}>
          <Pressable onPress={onClose} accessibilityRole="button">
            <Text style={styles.headerAction}>{t('mobile.surface.close')}</Text>
          </Pressable>
          <Text style={[styles.title, { color: textColor }]} numberOfLines={1}>
            {t('mobile.sessions.sheet.title')}
          </Text>
          <Pressable onPress={onDraft} accessibilityRole="button">
            <Text style={styles.headerAction}>{t('mobile.sessions.newChat')}</Text>
          </Pressable>
        </RNView>

        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={t('mobile.sessions.search.placeholder')}
          placeholderTextColor={muted}
          style={[styles.search, { color: textColor, borderColor: muted }]}
          autoCorrect={false}
          autoCapitalize="none"
          clearButtonMode="while-editing"
        />

        {home.status === 'loading' && !home.model ? (
          <RNView style={styles.center}>
            <ActivityIndicator />
          </RNView>
        ) : home.status === 'error' ? (
          <RNView style={styles.center}>
            <Text style={styles.error}>{home.error ?? t('mobile.sessions.index.error')}</Text>
            <Pressable onPress={() => void home.refresh()}>
              <Text style={styles.headerAction}>{t('mobile.sessions.index.retry')}</Text>
            </Pressable>
          </RNView>
        ) : home.status === 'unsupported' ? (
          <Text style={[styles.empty, { color: muted }]}>
            {t('mobile.sessions.index.unsupported')}
          </Text>
        ) : (
          <FlatList
            data={rows}
            keyExtractor={(item) => item.key}
            keyboardShouldPersistTaps="handled"
            ListHeaderComponent={
              pinError ? <Text style={styles.error}>{pinError}</Text> : null
            }
            renderItem={({ item }) => {
              if (item.kind === 'section') {
                return (
                  <Text style={[styles.section, { color: muted }]}>{item.title}</Text>
                );
              }
              if (item.kind === 'empty') {
                return (
                  <Text style={[styles.empty, { color: muted }]}>{item.message}</Text>
                );
              }
              const { session } = item;
              const activeRow = currentSessionId === session.id;
              const highlight = query.trim() || undefined;
              return (
                <RNView
                  style={[
                    styles.row,
                    activeRow ? styles.rowActive : null,
                  ]}
                >
                  <Pressable
                    style={styles.rowMain}
                    onPress={() => onOpenSession(session.id)}
                    accessibilityRole="button"
                  >
                    <RNView style={styles.rowTitleLine}>
                      <RNView
                        style={[
                          styles.dot,
                          {
                            backgroundColor: session.unread || activeRow ? '#3b82f6' : 'rgba(127,127,127,0.35)',
                          },
                        ]}
                      />
                      <HighlightedText
                        text={session.title}
                        query={highlight}
                        style={[styles.rowTitle, { color: activeRow ? '#3b82f6' : textColor }]}
                        numberOfLines={1}
                      />
                      <Text style={[styles.time, { color: muted }]}>
                        {formatRelativeShort(session.activityMs)}
                      </Text>
                    </RNView>
                    {session.subtitle ? (
                      <HighlightedText
                        text={session.subtitle}
                        query={highlight}
                        style={[styles.subtitle, { color: muted }]}
                        numberOfLines={1}
                      />
                    ) : null}
                  </Pressable>
                  <Pressable
                    style={styles.pinBtn}
                    onPress={() => void onTogglePin(session)}
                    disabled={pinBusyId === session.id}
                    accessibilityRole="button"
                    accessibilityLabel={
                      session.pinned
                        ? t('mobile.sessions.unpinAria')
                        : t('mobile.sessions.pinAria')
                    }
                  >
                    <Text style={[styles.pinLabel, { color: session.pinned ? '#3b82f6' : muted }]}>
                      {session.pinned ? '★' : '☆'}
                    </Text>
                  </Pressable>
                </RNView>
              );
            }}
          />
        )}
      </RNView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingTop: 12 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 8,
    gap: 8,
  },
  title: { flex: 1, fontSize: 16, fontWeight: '600', textAlign: 'center' },
  headerAction: { color: '#3b82f6', fontSize: 15, fontWeight: '600', minWidth: 48 },
  search: {
    marginHorizontal: 16,
    marginBottom: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 15,
  },
  section: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 6,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(127,127,127,0.25)',
  },
  rowActive: {
    backgroundColor: 'rgba(59,130,246,0.08)',
  },
  rowMain: {
    flex: 1,
    paddingHorizontal: 16,
    paddingVertical: 12,
    minWidth: 0,
  },
  rowTitleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  rowTitle: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
  },
  time: {
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
  subtitle: {
    marginTop: 2,
    marginLeft: 14,
    fontSize: 12,
  },
  pinBtn: {
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  pinLabel: {
    fontSize: 18,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 24,
  },
  empty: {
    textAlign: 'center',
    marginTop: 24,
    paddingHorizontal: 24,
  },
  error: {
    color: '#dc2626',
    paddingHorizontal: 16,
    marginTop: 8,
    marginBottom: 4,
  },
});
