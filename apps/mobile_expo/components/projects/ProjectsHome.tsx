import { useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Pressable,
  RefreshControl,
  StyleSheet,
  TextInput,
  View as RNView,
} from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { HighlightedText } from '@/components/projects/HighlightedText';
import {
  NewProjectSheet,
  NewWorktreeSheet,
  ProjectEditSheet,
  ProjectOverflowSheet,
  removeWorktreeAction,
  type ProjectOverflowTarget,
} from '@/components/projects/ProjectsActionSheets';
import { GlassDisc, GLASS_DISC_SIZE } from '@/components/chrome/GlassDisc';
import { Text, View, useThemeColor } from '@/components/Themed';
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { useConnection } from '@/context/ConnectionContext';
import { useHomeAttention } from '@/hooks/useHomeAttention';
import { useProjectsHome } from '@/hooks/useProjectsHome';
import { dispatchMarkSessionViewed } from '@/lib/homeAttention';
import { t } from '@/lib/i18n';
import {
  filterProjectsHomeForSearch,
  toHomeSessionRow,
  type ProjectsHomeProjectItem,
  type ProjectsHomeWorktreeGroup,
} from '@/lib/projectsHomeModel';
import { DRAFT_ROUTE_ID, type HomeSessionRow } from '@/lib/sessionHomeModel';

/** Cap MobileTabPageHeader collapse distance — layout height stays fixed. */
const TITLE_COLLAPSE_DISTANCE = 48;
/** Expanded title sits slightly below sticky chrome; spacer scrolls away natively. */
const EXPAND_SHIFT = 10;
const SHELL_ICON = 38;
const SHELL_GLYPH = 32;
const OVERFLOW_HIT = 36;
const GLASS_DISC = GLASS_DISC_SIZE;

function formatRelativeShort(timestamp: number): string {
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
}

function formatPathHint(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/g, '');
  if (!normalized) return '';
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length <= 1) return normalized;
  if (segments.length === 2) return segments[0];
  return segments.slice(-3, -1).join('/');
}

function sessionCountLabel(count: number): string {
  return count === 1
    ? t('mobile.sessions.project.sessionsSingle')
    : t('mobile.sessions.project.sessionsPlural', { count });
}

/** Project shell icon wash — solid fill, not claimed as UIGlassEffect. */
function shellIconFill(dark: boolean): string {
  return dark ? 'rgba(38,38,44,0.66)' : 'rgba(255,255,255,0.68)';
}

function cardSurface(dark: boolean): string {
  return dark ? '#171717' : '#ffffff';
}

function SessionRow({
  session,
  query,
  onPress,
  tint,
  muted,
  text,
  inset,
}: {
  session: HomeSessionRow;
  query?: string;
  onPress: (session: HomeSessionRow) => void;
  tint: string;
  muted: string;
  text: string;
  inset?: boolean;
}) {
  const activity = formatRelativeShort(session.activityMs);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={session.title}
      onPress={() => onPress(session)}
      style={[styles.sessionRow, inset ? styles.sessionRowInset : null]}
    >
      <RNView style={styles.sessionMain}>
        <RNView style={styles.titleRow}>
          {session.unread ? (
            <RNView
              style={[styles.unreadDot, { backgroundColor: tint }]}
              accessibilityLabel="unread"
            />
          ) : (
            <RNView style={[styles.idleDot, { backgroundColor: muted }]} />
          )}
          <HighlightedText
            text={session.title}
            query={query}
            style={[styles.rowTitle, { color: text, fontWeight: session.unread ? '700' : '500' }]}
            numberOfLines={1}
          />
        </RNView>
        {session.subtitle && !inset ? (
          <HighlightedText
            text={session.subtitle}
            query={query}
            style={[styles.rowSubtitle, { color: muted }]}
            numberOfLines={1}
          />
        ) : null}
      </RNView>
      {activity ? (
        <Text style={[styles.activityLabel, { color: muted }]}>{activity}</Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('mobile.projects.menu.label')}
        hitSlop={8}
        onPress={(event) => {
          event.stopPropagation?.();
        }}
        style={styles.overflowHit}
      >
        <Text style={[styles.overflowGlyph, { color: muted }]}>···</Text>
      </Pressable>
    </Pressable>
  );
}

function BranchRow({
  label,
  count,
  expanded,
  onToggle,
  muted,
  text,
  onOpenActions,
}: {
  label: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  muted: string;
  text: string;
  onOpenActions?: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      onPress={onToggle}
      style={styles.branchRow}
    >
      <Text style={[styles.branchGlyph, { color: muted }]}>⑂</Text>
      <RNView style={styles.branchMain}>
        <Text style={[styles.branchTitle, { color: text }]} numberOfLines={1}>
          {label}
        </Text>
        <Text style={[styles.branchMeta, { color: muted }]}>{sessionCountLabel(count)}</Text>
      </RNView>
      <Text style={[styles.chevron, { color: muted }]}>{expanded ? '▾' : '▸'}</Text>
      {onOpenActions ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('mobile.projects.menu.label')}
          hitSlop={8}
          onPress={(event) => {
            event.stopPropagation?.();
            onOpenActions();
          }}
          style={styles.overflowHit}
        >
          <Text style={[styles.overflowGlyph, { color: muted }]}>···</Text>
        </Pressable>
      ) : (
        <RNView style={styles.overflowHit}>
          <Text style={[styles.overflowGlyph, { color: muted }]}>···</Text>
        </RNView>
      )}
    </Pressable>
  );
}

function ProjectCardShell({
  title,
  meta,
  iconGlyph,
  expanded,
  onToggle,
  onOpenActions,
  children,
  dark,
  muted,
  text,
  query,
}: {
  title: string;
  meta: string;
  iconGlyph: string;
  expanded: boolean;
  onToggle: () => void;
  onOpenActions?: () => void;
  children?: React.ReactNode;
  dark: boolean;
  muted: string;
  text: string;
  query?: string;
}) {
  return (
    <RNView style={[styles.projectShell, { backgroundColor: cardSurface(dark) }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={onToggle}
        style={styles.projectHeader}
      >
        <RNView style={[styles.shellIcon, { backgroundColor: shellIconFill(dark) }]}>
          <Text style={[styles.shellGlyph, { color: muted }]}>{iconGlyph}</Text>
        </RNView>
        <RNView style={styles.projectHeaderMain}>
          <HighlightedText
            text={title}
            query={query}
            style={[styles.projectTitle, { color: text }]}
            numberOfLines={1}
          />
          <Text style={[styles.projectMeta, { color: muted }]} numberOfLines={1}>
            {meta}
          </Text>
        </RNView>
        <Text style={[styles.chevron, { color: muted }]}>{expanded ? '▾' : '▸'}</Text>
        {onOpenActions ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('mobile.projects.menu.label')}
            onPress={(event) => {
              event.stopPropagation?.();
              onOpenActions();
            }}
            style={styles.overflowHit}
          >
            <Text style={[styles.overflowGlyph, { color: muted }]}>···</Text>
          </Pressable>
        ) : (
          <RNView style={styles.overflowHit} />
        )}
      </Pressable>
      {expanded ? <RNView style={styles.projectBody}>{children}</RNView> : null}
    </RNView>
  );
}

function ProjectCard({
  project,
  query,
  onOpenSession,
  onOpenActions,
  onOpenWorktreeActions,
  onToggle,
  onToggleWorktree,
  onShowMore,
  onShowFewer,
  dark,
  muted,
  text,
  tint,
}: {
  project: ProjectsHomeProjectItem;
  query?: string;
  onOpenSession: (session: HomeSessionRow) => void;
  onOpenActions: () => void;
  onOpenWorktreeActions: (worktree: ProjectsHomeWorktreeGroup) => void;
  onToggle: () => void;
  onToggleWorktree: (bucketKey: string) => void;
  onShowMore: (bucketKey: string) => void;
  onShowFewer: (bucketKey: string) => void;
  dark: boolean;
  muted: string;
  text: string;
  tint: string;
}) {
  const pathHint = formatPathHint(project.path);
  const metaParts = [sessionCountLabel(project.sessionCount)];
  if (project.activityLabel) metaParts.push(project.activityLabel);
  if (pathHint) metaParts.push(pathHint);

  return (
    <ProjectCardShell
      title={project.name}
      meta={metaParts.join(' · ')}
      iconGlyph="</>"
      expanded={project.expanded}
      onToggle={onToggle}
      onOpenActions={onOpenActions}
      dark={dark}
      muted={muted}
      text={text}
      query={query}
    >
      {project.worktrees.every((group) => group.sessionCount === 0) ? (
        <Text style={[styles.empty, { color: muted }]}>{t('mobile.sessions.emptyDirectory')}</Text>
      ) : (
        project.worktrees.map((group) => {
          const body = (
            <>
              {group.sessions.map((session) => (
                <SessionRow
                  key={session.id}
                  session={toHomeSessionRow(session)}
                  query={query}
                  onPress={onOpenSession}
                  tint={tint}
                  muted={muted}
                  text={text}
                  inset
                />
              ))}
              {group.hasMore ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => onShowMore(group.id)}
                  style={styles.moreRow}
                >
                  <Text style={[styles.moreLabel, { color: muted }]}>
                    {t('mobile.sessions.sidebar.group.showMore')}
                  </Text>
                  <Text style={[styles.chevron, { color: muted }]}>▸</Text>
                </Pressable>
              ) : null}
              {group.canShowFewer ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => onShowFewer(group.id)}
                  style={styles.moreRow}
                >
                  <Text style={[styles.moreLabel, { color: muted }]}>
                    {t('mobile.sessions.sidebar.group.showFewer')}
                  </Text>
                </Pressable>
              ) : null}
            </>
          );

          if (group.kind === 'main') {
            return <RNView key={group.id}>{body}</RNView>;
          }

          return (
            <RNView key={group.id}>
              <BranchRow
                label={group.name}
                count={group.sessionCount}
                expanded={group.expanded}
                onToggle={() => onToggleWorktree(group.id)}
                muted={muted}
                text={text}
                onOpenActions={() => onOpenWorktreeActions(group)}
              />
              {group.expanded ? body : null}
            </RNView>
          );
        })
      )}
    </ProjectCardShell>
  );
}

export function ProjectsHome() {
  const colorScheme = useColorScheme();
  const dark = colorScheme === 'dark';
  const colors = Colors[colorScheme];
  const muted = useThemeColor({}, 'muted');
  const text = useThemeColor({}, 'text');
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { controller, statusLabel, state } = useConnection();
  const active = state.active;
  const attention = useHomeAttention({ enabled: Boolean(active), bridge: false });
  const {
    status,
    model,
    projects,
    error,
    refresh,
    setProjectExpanded,
    setWorktreeExpanded,
    showMoreBucket,
    showFewerBucket,
    saveProjects,
    refreshProjectWorktrees,
    probeGitRepo,
  } = useProjectsHome({
    untitledLabel: t('mobile.sessions.untitled'),
    unseenBySession: attention.unseenBySession,
    runningSessionIds: attention.runningSessionIds,
  });

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [pinnedExpanded, setPinnedExpanded] = useState(true);
  const [overflowTarget, setOverflowTarget] = useState<ProjectOverflowTarget>(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newWorktreeProject, setNewWorktreeProject] = useState<ProjectsHomeProjectItem | null>(null);
  const [editProject, setEditProject] = useState<ProjectsHomeProjectItem | null>(null);

  const scrollY = useSharedValue(0);
  const headerChrome = Math.max(insets.top, 12) + 12 + GLASS_DISC;
  const listTopPad = headerChrome + EXPAND_SHIFT;

  const searching = searchQuery.trim().length > 0;
  const filtered = useMemo(
    () => (model ? filterProjectsHomeForSearch(model, searchQuery) : { sessions: [], projects: [] }),
    [model, searchQuery],
  );

  const openSession = useCallback(
    (session: HomeSessionRow) => {
      setSearchOpen(false);
      setSearchQuery('');
      dispatchMarkSessionViewed(session.id);
      router.push(`/chat/${encodeURIComponent(session.id)}`);
    },
    [router],
  );

  const openDraft = useCallback(() => {
    setMenuOpen(false);
    setOverflowTarget(null);
    router.push(`/chat/${DRAFT_ROUTE_ID}`);
  }, [router]);

  const openDraftForDirectory = useCallback(
    (directory: string) => {
      setOverflowTarget(null);
      router.push({
        pathname: `/chat/${DRAFT_ROUTE_ID}`,
        params: { directory },
      } as never);
    },
    [router],
  );

  const openScan = useCallback(() => {
    setMenuOpen(false);
    router.push('/qr-scan');
  }, [router]);

  const switchInstance = useCallback(() => {
    setMenuOpen(false);
    controller.disconnectToOnboarding();
  }, [controller]);

  const openNewProject = useCallback(() => {
    setMenuOpen(false);
    setNewProjectOpen(true);
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      scrollY.value = event.nativeEvent.contentOffset.y;
    },
    [scrollY],
  );

  const headerInnerStyle = useAnimatedStyle(() => {
    const collapse = interpolate(
      scrollY.value,
      [0, TITLE_COLLAPSE_DISTANCE],
      [0, 1],
      Extrapolation.CLAMP,
    );
    return {
      transform: [{ translateY: EXPAND_SHIFT * (1 - collapse) }],
    };
  });

  const titleStyle = useAnimatedStyle(() => {
    const collapse = interpolate(
      scrollY.value,
      [0, TITLE_COLLAPSE_DISTANCE],
      [0, 1],
      Extrapolation.CLAMP,
    );
    const scale = 1 - 0.375 * collapse;
    return {
      transform: [{ scale }],
    };
  });

  const fadeStyle = useAnimatedStyle(() => {
    const collapse = interpolate(
      scrollY.value,
      [0, TITLE_COLLAPSE_DISTANCE],
      [0, 1],
      Extrapolation.CLAMP,
    );
    return { opacity: collapse };
  });

  const highlight = searching ? searchQuery.trim() : undefined;
  const attentionSessions = model
    ? [...model.pinnedSessions, ...model.inProgressSessions]
    : [];
  const fadeColor = dark ? 'rgba(10,10,10,0.92)' : 'rgba(250,250,250,0.92)';
  const editEntry = editProject
    ? projects.find((entry) => entry.id === editProject.id) ?? null
    : null;

  const renderProjectCard = (project: ProjectsHomeProjectItem, query?: string) => (
    <ProjectCard
      key={project.id}
      project={project}
      query={query}
      onOpenSession={openSession}
      onOpenActions={() => {
        setOverflowTarget({ kind: 'project', project });
        void probeGitRepo(project.id, project.path);
      }}
      onOpenWorktreeActions={(worktree) =>
        setOverflowTarget({ kind: 'worktree', project, worktree })
      }
      onToggle={() => setProjectExpanded(project.id, !project.expanded)}
      onToggleWorktree={(bucketKey) => {
        const group = project.worktrees.find((entry) => entry.id === bucketKey);
        setWorktreeExpanded(project.id, bucketKey, !(group?.expanded ?? false));
      }}
      onShowMore={(bucketKey) => showMoreBucket(project.id, bucketKey)}
      onShowFewer={(bucketKey) => showFewerBucket(project.id, bucketKey)}
      dark={dark}
      muted={muted}
      text={text}
      tint={colors.tint}
    />
  );

  return (
    <View style={styles.screen}>
      <RNView
        pointerEvents="box-none"
        style={[styles.stickyHeader, { height: headerChrome, paddingTop: Math.max(insets.top, 12) }]}
      >
        <Animated.View
          pointerEvents="none"
          style={[styles.headerFade, { height: headerChrome + 28, backgroundColor: fadeColor }, fadeStyle]}
        />
        <Animated.View style={[styles.headerInner, headerInnerStyle]}>
          <Animated.View style={[styles.titleBlock, titleStyle]}>
            <Text style={styles.title} numberOfLines={1}>
              {t('mobile.sessions.section.projects')}
            </Text>
            {statusLabel ? (
              <Text style={[styles.status, { color: muted }]} numberOfLines={1}>
                {statusLabel}
              </Text>
            ) : null}
          </Animated.View>
          <RNView style={styles.headerActions}>
            <GlassDisc
              colorScheme={dark ? 'dark' : 'light'}
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
            >
              <Text style={{ color: colors.text, fontWeight: '600', fontSize: 18 }}>
                {searchOpen ? '×' : '⌕'}
              </Text>
            </GlassDisc>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('mobile.projects.menu.label')}
              onPress={() => setMenuOpen(true)}
              style={[styles.primaryDisc, { backgroundColor: colors.tint }]}
            >
              <Text style={styles.plusLabel}>+</Text>
            </Pressable>
          </RNView>
        </Animated.View>
      </RNView>

      {status === 'loading' && !model ? (
        <RNView style={[styles.centered, { paddingTop: listTopPad }]}>
          <ActivityIndicator color={colors.tint} />
        </RNView>
      ) : null}

      {status === 'error' ? (
        <RNView style={[styles.centered, { paddingTop: listTopPad }]}>
          <Text style={styles.errorTitle}>{t('mobile.sessions.index.error')}</Text>
          <Text style={[styles.errorBody, { color: muted }]}>{error}</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => void refresh()}
            style={[styles.retryButton, { borderColor: colors.tint }]}
          >
            <Text style={{ color: colors.tint, fontWeight: '600' }}>
              {t('mobile.sessions.index.retry')}
            </Text>
          </Pressable>
        </RNView>
      ) : null}

      {status === 'unsupported' ? (
        <RNView style={[styles.centered, { paddingTop: listTopPad }]}>
          <Text style={[styles.errorBody, { color: muted }]}>
            {t('mobile.sessions.index.unsupported')}
          </Text>
        </RNView>
      ) : null}

      {status === 'ready' && model ? (
        <Animated.ScrollView
          onScroll={onScroll}
          scrollEventThrottle={16}
          contentContainerStyle={[styles.listContent, { paddingTop: listTopPad }]}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => void onRefresh()}
              tintColor={colors.tint}
              progressViewOffset={listTopPad}
            />
          }
        >
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
                  backgroundColor: cardSurface(dark),
                },
              ]}
            />
          ) : null}

          {searching ? (
            <>
              {filtered.sessions.length === 0 && filtered.projects.length === 0 ? (
                <Text style={[styles.empty, { color: muted }]}>
                  {t('mobile.sessions.search.empty')}
                </Text>
              ) : null}
              {filtered.sessions.map((session) => (
                <SessionRow
                  key={`search-${session.id}`}
                  session={toHomeSessionRow(session)}
                  query={highlight}
                  onPress={openSession}
                  tint={colors.tint}
                  muted={muted}
                  text={text}
                />
              ))}
              {filtered.projects.map((project) => renderProjectCard(project, highlight))}
            </>
          ) : (
            <>
              {attentionSessions.length > 0 ? (
                <ProjectCardShell
                  title={t('mobile.sessions.section.pinned')}
                  meta={sessionCountLabel(attentionSessions.length)}
                  iconGlyph="📌"
                  expanded={pinnedExpanded}
                  onToggle={() => setPinnedExpanded((v) => !v)}
                  dark={dark}
                  muted={muted}
                  text={text}
                >
                  {model.pinnedSessions.length > 0 ? (
                    <Text style={[styles.bucketLabel, { color: muted }]}>
                      {t('mobile.sessions.section.pinned')}
                    </Text>
                  ) : null}
                  {model.pinnedSessions.map((session) => (
                    <SessionRow
                      key={`pin-${session.id}`}
                      session={toHomeSessionRow(session)}
                      onPress={openSession}
                      tint={colors.tint}
                      muted={muted}
                      text={text}
                      inset
                    />
                  ))}
                  {model.inProgressSessions.length > 0 ? (
                    <Text style={[styles.bucketLabel, { color: muted }]}>
                      {t('mobile.sessions.section.inProgress')}
                    </Text>
                  ) : null}
                  {model.inProgressSessions.map((session) => (
                    <SessionRow
                      key={`prog-${session.id}`}
                      session={toHomeSessionRow(session)}
                      onPress={openSession}
                      tint={colors.tint}
                      muted={muted}
                      text={text}
                      inset
                    />
                  ))}
                </ProjectCardShell>
              ) : null}

              {model.projects.map((project) => renderProjectCard(project))}

              {model.projects.length === 0 && model.pinnedSessions.length === 0 ? (
                <Text style={[styles.empty, { color: muted }]}>
                  {t('mobile.sessions.emptyHome')}
                </Text>
              ) : null}
            </>
          )}
        </Animated.ScrollView>
      ) : null}

      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable style={styles.menuBackdrop} onPress={() => setMenuOpen(false)}>
          <RNView
            style={[
              styles.menuCard,
              {
                backgroundColor: cardSurface(dark),
                top: Math.max(insets.top, 12) + 52,
              },
            ]}
          >
            <Pressable accessibilityRole="button" style={styles.menuItem} onPress={openDraft}>
              <Text style={styles.menuItemLabel}>{t('mobile.projects.menu.newChat')}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" style={styles.menuItem} onPress={openNewProject}>
              <Text style={styles.menuItemLabel}>{t('mobile.projects.menu.newProject')}</Text>
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

      <ProjectOverflowSheet
        target={overflowTarget}
        dark={dark}
        tint={colors.tint}
        onClose={() => setOverflowTarget(null)}
        onNewSession={() => {
          if (!overflowTarget) return;
          if (overflowTarget.kind === 'project') {
            openDraftForDirectory(overflowTarget.project.path);
          } else {
            openDraftForDirectory(overflowTarget.worktree.path);
          }
        }}
        onNewWorktree={() => {
          if (overflowTarget?.kind === 'project') {
            setNewWorktreeProject(overflowTarget.project);
          }
        }}
        onEditProject={() => {
          if (overflowTarget?.kind === 'project') {
            setEditProject(overflowTarget.project);
          }
        }}
        onCloseProject={() => {
          if (overflowTarget?.kind !== 'project') return;
          const id = overflowTarget.project.id;
          void saveProjects(projects.filter((entry) => entry.id !== id));
        }}
        onDeleteWorktree={() => {
          if (overflowTarget?.kind !== 'worktree' || !active) return;
          const { project, worktree } = overflowTarget;
          void (async () => {
            await removeWorktreeAction(active, project.path, worktree.path);
            await refreshProjectWorktrees(project.path);
            await refresh();
          })();
        }}
      />

      <NewProjectSheet
        visible={newProjectOpen}
        dark={dark}
        tint={colors.tint}
        existing={projects}
        onClose={() => setNewProjectOpen(false)}
        onCreated={async (next) => {
          await saveProjects(next);
          await refresh();
        }}
      />

      <NewWorktreeSheet
        visible={!!newWorktreeProject}
        dark={dark}
        tint={colors.tint}
        project={newWorktreeProject}
        onClose={() => setNewWorktreeProject(null)}
        onCreated={async (worktreePath) => {
          if (newWorktreeProject) {
            await refreshProjectWorktrees(newWorktreeProject.path);
          }
          await refresh();
          openDraftForDirectory(worktreePath);
        }}
      />

      <ProjectEditSheet
        visible={!!editProject}
        dark={dark}
        tint={colors.tint}
        project={editProject}
        entry={editEntry}
        onClose={() => setEditProject(null)}
        onSave={async (patch) => {
          if (!editProject) return;
          const next = projects.map((entry) =>
            entry.id === editProject.id
              ? {
                  ...entry,
                  label: patch.label,
                  icon: patch.icon,
                  color: patch.color,
                }
              : entry,
          );
          // If settings lacked this synthetic project, append it.
          const exists = next.some((entry) => entry.id === editProject.id);
          const payload = exists
            ? next
            : [
                ...projects,
                {
                  id: editProject.id,
                  path: editProject.path,
                  label: patch.label,
                  icon: patch.icon,
                  color: patch.color,
                },
              ];
          await saveProjects(payload);
          await refresh();
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  stickyHeader: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 30,
    paddingHorizontal: 16,
    backgroundColor: 'transparent',
    overflow: 'visible',
  },
  headerFade: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
  headerInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: GLASS_DISC,
    gap: 12,
  },
  titleBlock: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
    transformOrigin: 'left center',
  },
  title: {
    fontSize: 32,
    fontWeight: '700',
    letterSpacing: -0.6,
  },
  status: {
    fontSize: 12,
    marginTop: 2,
  },
  headerActions: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
  },
  primaryDisc: {
    width: GLASS_DISC,
    height: GLASS_DISC,
    borderRadius: GLASS_DISC / 2,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#c2410c',
    shadowOpacity: 0.28,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 6 },
    elevation: 4,
  },
  plusLabel: {
    color: '#fff',
    fontSize: 24,
    fontWeight: '600',
    marginTop: -2,
  },
  searchInput: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 22,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 16,
    marginBottom: 8,
  },
  listContent: {
    paddingHorizontal: 12,
    paddingBottom: 32,
    gap: 12,
  },
  projectShell: {
    borderRadius: 18,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  projectHeader: {
    minHeight: 74,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 10,
  },
  shellIcon: {
    width: SHELL_ICON,
    height: SHELL_ICON,
    borderRadius: SHELL_ICON / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shellGlyph: {
    fontSize: 13,
    fontWeight: '700',
    width: SHELL_GLYPH,
    textAlign: 'center',
  },
  projectHeaderMain: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  projectTitle: {
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  projectMeta: {
    fontSize: 12,
    lineHeight: 15,
  },
  projectBody: {
    paddingBottom: 6,
    gap: 0,
  },
  bucketLabel: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    paddingHorizontal: 14,
    paddingTop: 6,
    paddingBottom: 2,
  },
  sessionRow: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 6,
  },
  sessionRowInset: {
    paddingLeft: 14,
  },
  sessionMain: {
    flex: 1,
    minWidth: 0,
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
  },
  idleDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    opacity: 0.35,
  },
  rowTitle: {
    flex: 1,
    fontSize: 15,
  },
  rowSubtitle: {
    fontSize: 12,
    marginLeft: 14,
  },
  activityLabel: {
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    marginRight: 2,
  },
  overflowHit: {
    width: OVERFLOW_HIT,
    height: OVERFLOW_HIT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  overflowGlyph: {
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 1,
  },
  branchRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    gap: 8,
  },
  branchGlyph: {
    fontSize: 16,
    width: 20,
    textAlign: 'center',
  },
  branchMain: {
    flex: 1,
    minWidth: 0,
    gap: 1,
  },
  branchTitle: {
    fontSize: 13,
    fontWeight: '600',
  },
  branchMeta: {
    fontSize: 11,
  },
  chevron: {
    fontSize: 14,
    width: 16,
    textAlign: 'center',
  },
  moreRow: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  moreLabel: {
    fontSize: 14,
    fontWeight: '500',
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
