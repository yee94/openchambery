import { SymbolView } from 'expo-symbols';
import { useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  View as RNView,
} from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  MobileTabPageHeader,
  useCollapsingTabHeader,
} from '@/components/chrome/MobileTabPageHeader';
import { ScheduledTaskEditor } from '@/components/scheduled/ScheduledTaskEditor';
import { Text, useThemeColor } from '@/components/Themed';
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { useConnection } from '@/context/ConnectionContext';
import { useScheduledWorkspace } from '@/hooks/useScheduledWorkspace';
import { t } from '@/lib/i18n';
import {
  formatCompactRunDuration,
  formatRunDateTime,
  resolveRunDurationMs,
  statusTone,
} from '@/lib/scheduledFormat';
import type { GlobalScheduledTask, ScheduledTaskRun } from '@/lib/scheduledTasksApi';
import type { ScheduledTaskCardModel } from '@/lib/scheduledModel';

/** Cap --oc-mobile-surface-radius (1.5rem). */
const SURFACE_RADIUS = 24;
/** Cap segmented item height (2.5rem). */
const SEGMENT_ITEM_H = 40;
const SEGMENT_PAD = 4;
const OVERFLOW_HIT = 36;

function floatSurface(dark: boolean): string {
  return dark ? 'rgba(38,38,44,0.72)' : 'rgba(255,255,255,0.82)';
}

function cardSurface(dark: boolean): string {
  return dark ? '#171717' : '#ffffff';
}

type SegmentSymbol = React.ComponentProps<typeof SymbolView>['name'];

function Segmented({
  options,
  value,
  onChange,
  grow,
  trailing,
}: {
  options: { id: string; label: string; symbol?: SegmentSymbol }[];
  value: string;
  onChange: (id: string) => void;
  grow?: boolean;
  trailing?: React.ReactNode;
}) {
  const dark = useColorScheme() === 'dark';
  const text = useThemeColor({}, 'text');
  const muted = useThemeColor({}, 'muted');
  const track = floatSurface(dark);
  const pill = dark ? 'rgba(63,63,70,0.95)' : 'rgba(255,255,255,0.96)';
  const itemRadius = Math.max(0, SURFACE_RADIUS - SEGMENT_PAD);

  return (
    <RNView
      style={[
        styles.segmentTrack,
        {
          backgroundColor: track,
          borderRadius: SURFACE_RADIUS,
          padding: SEGMENT_PAD,
        },
        grow && { flex: 1 },
      ]}
    >
      <RNView style={styles.segmentGroup}>
        {options.map((opt) => {
          const selected = opt.id === value;
          const color = selected ? text : muted;
          return (
            <Pressable
              key={opt.id}
              onPress={() => onChange(opt.id)}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              style={[
                styles.segmentItem,
                {
                  height: SEGMENT_ITEM_H,
                  borderRadius: itemRadius,
                },
                selected && { backgroundColor: pill },
              ]}
            >
              <RNView style={styles.segmentLabel}>
                {opt.symbol ? (
                  <SymbolView name={opt.symbol} tintColor={color} size={15} />
                ) : null}
                <Text
                  style={{
                    color,
                    fontSize: 13,
                    fontWeight: selected ? '700' : '500',
                  }}
                  numberOfLines={1}
                >
                  {opt.label}
                </Text>
              </RNView>
            </Pressable>
          );
        })}
      </RNView>
      {trailing}
    </RNView>
  );
}

function statusColor(tone: ReturnType<typeof statusTone>, enabled: boolean): string {
  if (!enabled) return '#94a3b8';
  if (tone === 'success') return '#16a34a';
  if (tone === 'error') return '#dc2626';
  if (tone === 'warning') return '#d97706';
  return '#64748b';
}

function StatusDisc({ card }: { card: ScheduledTaskCardModel }) {
  const color = statusColor(card.statusTone, card.enabled);
  const glyph = !card.enabled ? '❚❚' : card.status === 'running' ? '↻' : card.status === 'error' ? '!' : '✓';
  return (
    <RNView style={[styles.statusDisc, { backgroundColor: `${color}22`, borderColor: `${color}55` }]}>
      <Text style={{ color, fontSize: 13, fontWeight: '700' }}>{glyph}</Text>
    </RNView>
  );
}

function TaskCard({
  card,
  muted,
  text,
  surface,
  busy,
  onPress,
  onMore,
}: {
  card: ScheduledTaskCardModel;
  muted: string;
  text: string;
  surface: string;
  busy: boolean;
  onPress: () => void;
  onMore: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      style={[
        styles.card,
        {
          backgroundColor: surface,
          opacity: card.enabled ? 1 : 0.72,
        },
      ]}
    >
      <StatusDisc card={card} />
      <RNView style={styles.cardBody}>
        <Text style={[styles.cardTitle, { color: text }]} numberOfLines={2}>
          {card.name}
        </Text>
        <Text style={[styles.cardMeta, { color: muted }]} numberOfLines={2}>
          {card.metaLine}
        </Text>
      </RNView>
      <Pressable
        onPress={(e) => {
          e.stopPropagation?.();
          onMore();
        }}
        hitSlop={10}
        style={styles.moreBtn}
        accessibilityLabel={t('sessions.scheduledTasks.dialog.actions.moreAria', {
          taskName: card.name,
        })}
      >
        <Text style={{ color: muted, fontSize: 18, fontWeight: '700', letterSpacing: 1 }}>···</Text>
      </Pressable>
    </Pressable>
  );
}

function RunCard({
  run,
  nowMs,
  muted,
  text,
  surface,
  onOpen,
}: {
  run: ScheduledTaskRun;
  nowMs: number;
  muted: string;
  text: string;
  surface: string;
  onOpen: () => void;
}) {
  const tone = statusTone(run.status);
  const color = statusColor(tone, true);
  const duration =
    formatCompactRunDuration(resolveRunDurationMs(run, nowMs)) ??
    (run.status === 'running' ? t('sessions.scheduledTasks.history.duration.pending') : null);
  const canOpen = Boolean(run.sessionId);
  return (
    <Pressable
      onPress={canOpen ? onOpen : undefined}
      style={[styles.card, { backgroundColor: surface }]}
    >
      <RNView style={[styles.statusDisc, { backgroundColor: `${color}22`, borderColor: `${color}55` }]}>
        <Text style={{ color, fontSize: 12, fontWeight: '700' }}>
          {run.status === 'running' ? '↻' : run.status === 'error' ? '!' : '✓'}
        </Text>
      </RNView>
      <RNView style={styles.cardBody}>
        <RNView style={styles.runTitleRow}>
          <Text style={[styles.cardTitle, { color: text, flex: 1 }]} numberOfLines={2}>
            {run.taskName}
          </Text>
          <Text style={{ color, fontSize: 12, fontWeight: '600' }}>
            {duration ? `${duration} · ` : ''}
            {t(`sessions.scheduledTasks.dialog.status.${run.status}`)}
          </Text>
        </RNView>
        <Text style={[styles.cardMeta, { color: muted }]} numberOfLines={2}>
          {formatRunDateTime(run.startedAt)} ·{' '}
          {t(`sessions.scheduledTasks.history.trigger.${run.trigger}`)}
        </Text>
        {run.error ? (
          <Text style={{ color: '#dc2626', fontSize: 12, marginTop: 4 }} numberOfLines={3}>
            {run.error}
          </Text>
        ) : null}
      </RNView>
    </Pressable>
  );
}

export function ScheduledHome() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { state } = useConnection();
  const scheme = useColorScheme();
  const dark = scheme === 'dark';
  const tint = Colors[scheme].tint;
  const text = useThemeColor({}, 'text');
  const muted = useThemeColor({}, 'muted');
  const background = useThemeColor({}, 'background');
  const surface = cardSurface(dark);
  const ws = useScheduledWorkspace();
  const [menuEntry, setMenuEntry] = useState<GlobalScheduledTask | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const { scrollY, onScroll, listTopPad } = useCollapsingTabHeader();

  useEffect(() => {
    if (ws.view !== 'history') return;
    const hasRunning = ws.runs.some((r) => r.status === 'running');
    if (!hasRunning) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ws.view, ws.runs]);

  useEffect(() => {
    if (!ws.toast) return;
    const message = ws.toast.startsWith('sessions.') ? t(ws.toast) : ws.toast;
    Alert.alert('', message);
    ws.clearToast();
  }, [ws.toast, ws]);

  const viewOptions = useMemo(
    () => [
      {
        id: 'tasks',
        label: t('sessions.scheduledTasks.workspace.views.tasks'),
        symbol: { ios: 'checklist', android: 'checklist', web: 'checklist' } as const,
      },
      {
        id: 'history',
        label: t('sessions.scheduledTasks.workspace.views.history'),
        symbol: {
          ios: 'clock.arrow.circlepath',
          android: 'history',
          web: 'history',
        } as const,
      },
    ],
    [],
  );
  const filterOptions = useMemo(
    () => [
      { id: 'all', label: t('sessions.scheduledTasks.workspace.filters.all') },
      { id: 'active', label: t('sessions.scheduledTasks.workspace.filters.active') },
      { id: 'paused', label: t('sessions.scheduledTasks.workspace.filters.paused') },
    ],
    [],
  );

  if (!state.active) {
    return (
      <RNView style={[styles.centered, { backgroundColor: background, paddingTop: insets.top }]}>
        <Text style={{ color: muted }}>{t('mobile.connect.welcome.title')}</Text>
      </RNView>
    );
  }

  const addBtnRadius = Math.max(0, SURFACE_RADIUS - SEGMENT_PAD);

  return (
    <RNView style={[styles.root, { backgroundColor: background }]}>
      <MobileTabPageHeader
        title={t('sessions.scheduledTasks.dialog.title')}
        scrollY={scrollY}
      />

      <Animated.ScrollView
        onScroll={onScroll}
        scrollEventThrottle={16}
        contentContainerStyle={{
          paddingTop: listTopPad,
          paddingHorizontal: 16,
          paddingBottom: insets.bottom + 88,
        }}
        refreshControl={
          <RefreshControl
            refreshing={ws.status === 'loading'}
            onRefresh={() => {
              void ws.refresh();
              if (ws.view === 'history') void ws.refreshRuns(true);
            }}
            tintColor={tint}
            progressViewOffset={listTopPad}
          />
        }
      >
        <Segmented
          options={viewOptions}
          value={ws.view}
          onChange={(id) => ws.setView(id as 'tasks' | 'history')}
        />

        {ws.view === 'tasks' ? (
          <Segmented
            options={filterOptions}
            value={ws.filter}
            onChange={(id) => ws.setFilter(id as 'all' | 'active' | 'paused')}
            trailing={
              <Pressable
                onPress={ws.openCreate}
                style={[
                  styles.addBtn,
                  {
                    width: SEGMENT_ITEM_H,
                    height: SEGMENT_ITEM_H,
                    borderRadius: addBtnRadius,
                    backgroundColor: dark ? '#e4e4e7' : '#18181b',
                  },
                ]}
                accessibilityLabel={t('sessions.scheduledTasks.dialog.actions.newTask')}
              >
                <Text style={{ color: dark ? '#18181b' : '#fafafa', fontSize: 22, fontWeight: '600' }}>
                  +
                </Text>
              </Pressable>
            }
          />
        ) : null}

        {/* Cap mobile tab has no search field — keep IA aligned with mobile_schedules.png */}

        {ws.view === 'history' && ws.historyFilterLabel ? (
          <RNView style={[styles.historyFilter, { backgroundColor: surface }]}>
            <Text style={{ color: text, flex: 1, fontWeight: '600' }} numberOfLines={1}>
              {ws.historyFilterLabel}
            </Text>
            <Pressable onPress={ws.clearHistoryTaskFilter} hitSlop={8}>
              <Text style={{ color: muted }}>
                {t('sessions.scheduledTasks.history.filter.clearAria')}
              </Text>
            </Pressable>
          </RNView>
        ) : null}

        {ws.failedProjectIds.length > 0 && ws.view === 'tasks' ? (
          <Text style={[styles.warn, { color: '#b45309' }]}>
            {t('sessions.scheduledTasks.workspace.partialLoadWarning')}
          </Text>
        ) : null}

        {ws.view === 'tasks' ? (
          ws.status === 'loading' && ws.cards.length === 0 ? (
            <RNView style={styles.rowCenter}>
              <ActivityIndicator color={tint} />
              <Text style={{ color: muted, marginLeft: 8 }}>
                {t('sessions.scheduledTasks.dialog.loading')}
              </Text>
            </RNView>
          ) : ws.status === 'error' ? (
            <RNView style={[styles.empty, { borderColor: muted }]}>
              <Text style={{ color: text, fontWeight: '600' }}>
                {ws.error || t('sessions.scheduledTasks.dialog.toast.loadFailed')}
              </Text>
              <Pressable onPress={() => void ws.refresh()} style={{ marginTop: 10 }}>
                <Text style={{ color: tint, fontWeight: '700' }}>
                  {t('sessions.scheduledTasks.history.retry')}
                </Text>
              </Pressable>
            </RNView>
          ) : ws.cards.length === 0 ? (
            <RNView style={[styles.empty, { borderColor: muted }]}>
              <Text style={{ color: muted }}>
                {ws.tasks.length > 0
                  ? t('sessions.scheduledTasks.workspace.search.noResults')
                  : t('sessions.scheduledTasks.dialog.empty.noTasks')}
              </Text>
            </RNView>
          ) : (
            <RNView style={styles.list}>
              {ws.cards.map((card) => {
                const entry = ws.tasks.find(
                  (e) => e.projectId === card.projectId && e.task.id === card.taskId,
                );
                if (!entry) return null;
                return (
                  <TaskCard
                    key={card.identityKey}
                    card={card}
                    muted={muted}
                    text={text}
                    surface={surface}
                    busy={ws.mutatingKey === card.identityKey}
                    onPress={() => ws.openEdit(entry)}
                    onMore={() => setMenuEntry(entry)}
                  />
                );
              })}
            </RNView>
          )
        ) : ws.runsLoading && ws.runs.length === 0 ? (
          <RNView style={styles.rowCenter}>
            <ActivityIndicator color={tint} />
            <Text style={{ color: muted, marginLeft: 8 }}>
              {t('sessions.scheduledTasks.history.loading')}
            </Text>
          </RNView>
        ) : ws.runsError && ws.runs.length === 0 ? (
          <RNView style={[styles.empty, { borderColor: muted }]}>
            <Text style={{ color: text, fontWeight: '600' }}>
              {t('sessions.scheduledTasks.history.error.title')}
            </Text>
            <Text style={{ color: muted, marginTop: 4 }}>{ws.runsError}</Text>
            <Pressable onPress={() => void ws.refreshRuns(true)} style={{ marginTop: 10 }}>
              <Text style={{ color: tint, fontWeight: '700' }}>
                {t('sessions.scheduledTasks.history.retry')}
              </Text>
            </Pressable>
          </RNView>
        ) : ws.runs.length === 0 ? (
          <RNView style={[styles.empty, { borderColor: muted }]}>
            <Text style={{ color: text, fontWeight: '600' }}>
              {t('sessions.scheduledTasks.history.empty.title')}
            </Text>
            <Text style={{ color: muted, marginTop: 4 }}>
              {t('sessions.scheduledTasks.history.empty.description')}
            </Text>
          </RNView>
        ) : (
          <RNView style={styles.list}>
            {ws.runs.map((run) => (
              <RunCard
                key={run.id}
                run={run}
                nowMs={nowMs}
                muted={muted}
                text={text}
                surface={surface}
                onOpen={() => {
                  if (run.sessionId) {
                    router.push(`/chat/${encodeURIComponent(run.sessionId)}`);
                  }
                }}
              />
            ))}
            {!ws.runsComplete ? (
              <Pressable
                onPress={() => void ws.loadMoreRuns()}
                style={[styles.loadMore, { borderColor: muted }]}
                disabled={ws.runsLoading}
              >
                <Text style={{ color: text, fontWeight: '600' }}>
                  {ws.runsLoading
                    ? t('sessions.scheduledTasks.history.loadingMore')
                    : t('sessions.scheduledTasks.history.loadMore')}
                </Text>
              </Pressable>
            ) : null}
          </RNView>
        )}
      </Animated.ScrollView>

      <Modal
        visible={menuEntry != null}
        transparent
        animationType="fade"
        onRequestClose={() => setMenuEntry(null)}
      >
        <Pressable style={styles.menuBackdrop} onPress={() => setMenuEntry(null)}>
          <RNView style={[styles.menuSheet, { backgroundColor: surface }]}>
            {menuEntry ? (
              <>
                <Text style={[styles.menuTitle, { color: text }]} numberOfLines={2}>
                  {menuEntry.task.name}
                </Text>
                <MenuItem
                  label={t('sessions.scheduledTasks.dialog.actions.runNow')}
                  onPress={() => {
                    const entry = menuEntry;
                    setMenuEntry(null);
                    void ws.runNow(entry);
                  }}
                  text={text}
                />
                <MenuItem
                  label={t('sessions.scheduledTasks.workspace.views.history')}
                  onPress={() => {
                    const entry = menuEntry;
                    setMenuEntry(null);
                    ws.openTaskHistory(entry);
                  }}
                  text={text}
                />
                <MenuItem
                  label={
                    menuEntry.task.enabled
                      ? t('sessions.scheduledTasks.dialog.actions.pause')
                      : t('sessions.scheduledTasks.dialog.actions.resume')
                  }
                  onPress={() => {
                    const entry = menuEntry;
                    setMenuEntry(null);
                    void ws.toggleEnabled(entry, !entry.task.enabled);
                  }}
                  text={text}
                />
                <MenuItem
                  label={t('sessions.scheduledTasks.dialog.actions.edit')}
                  onPress={() => {
                    const entry = menuEntry;
                    setMenuEntry(null);
                    ws.openEdit(entry);
                  }}
                  text={text}
                />
                <MenuItem
                  label={t('sessions.scheduledTasks.dialog.actions.delete')}
                  destructive
                  onPress={() => {
                    const entry = menuEntry;
                    setMenuEntry(null);
                    Alert.alert(
                      '',
                      t('sessions.scheduledTasks.dialog.confirm.deleteTask', {
                        taskName: entry.task.name,
                      }),
                      [
                        { text: t('sessions.scheduledTasks.editor.actions.cancel'), style: 'cancel' },
                        {
                          text: t('sessions.scheduledTasks.dialog.actions.delete'),
                          style: 'destructive',
                          onPress: () => void ws.removeTask(entry),
                        },
                      ],
                    );
                  }}
                  text="#dc2626"
                />
                <MenuItem
                  label={t('sessions.scheduledTasks.editor.actions.cancel')}
                  onPress={() => setMenuEntry(null)}
                  text={muted}
                />
              </>
            ) : null}
          </RNView>
        </Pressable>
      </Modal>

      <ScheduledTaskEditor
        open={ws.editorMode !== 'closed'}
        mode={ws.editorMode === 'edit' ? 'edit' : 'create'}
        task={ws.selectedEntry?.task ?? null}
        projects={ws.projects}
        projectId={ws.createProjectId}
        onProjectChange={ws.setCreateProjectId}
        onClose={ws.closeEditor}
        onSave={async (draft) => {
          await ws.saveTask(draft);
        }}
      />
    </RNView>
  );
}

function MenuItem({
  label,
  onPress,
  text,
  destructive,
}: {
  label: string;
  onPress: () => void;
  text: string;
  destructive?: boolean;
}) {
  return (
    <Pressable onPress={onPress} style={styles.menuItem}>
      <Text style={{ color: text, fontSize: 16, fontWeight: destructive ? '700' : '500' }}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  segmentTrack: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SEGMENT_PAD,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  segmentGroup: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SEGMENT_PAD,
    minWidth: 0,
  },
  segmentItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  segmentLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  addBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  historyFilter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 1,
  },
  warn: { fontSize: 12, marginBottom: 10 },
  list: { gap: 16, marginTop: 8 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: SURFACE_RADIUS,
    paddingHorizontal: 14,
    paddingVertical: 14,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  statusDisc: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardBody: { flex: 1, minWidth: 0 },
  cardTitle: { fontSize: 16, fontWeight: '700', letterSpacing: -0.2 },
  cardMeta: { fontSize: 12, marginTop: 4, lineHeight: 16 },
  moreBtn: {
    width: OVERFLOW_HIT,
    height: OVERFLOW_HIT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  runTitleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  empty: {
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: 'dashed',
    borderRadius: SURFACE_RADIUS,
    padding: 20,
    alignItems: 'center',
    marginTop: 8,
  },
  rowCenter: { flexDirection: 'row', alignItems: 'center', paddingVertical: 20 },
  loadMore: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    alignItems: 'center',
    paddingVertical: 12,
  },
  menuBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'flex-end',
  },
  menuSheet: {
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 28,
  },
  menuTitle: { fontSize: 15, fontWeight: '700', marginBottom: 8 },
  menuItem: { paddingVertical: 14 },
});
