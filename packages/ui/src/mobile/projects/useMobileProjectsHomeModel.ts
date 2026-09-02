import * as React from 'react';
import type { Session } from '@opencode-ai/sdk/v2/client';

import {
  getMobileSessionDefaultVisibleCount,
  getMobileSessionShowMoreIncrement,
} from '@/apps/mobileSessionPagination';
import type { IconName } from '@/components/icon/icons';
import { useI18n } from '@/lib/i18n';
import { PROJECT_ICON_MAP } from '@/lib/projectMeta';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import {
  loadMoreGlobalSessionsForDirectory,
  mergeLiveSessionWithGlobalSession,
  useGlobalSessionsStore,
} from '@/stores/useGlobalSessionsStore';
import { useMobileSessionTreeStore } from '@/stores/useMobileSessionTreeStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { getSessionActivityUpdatedAt } from '@/lib/sessionActivity';
import { usePinnedSessionIds } from '@/queries/sessionIndexPinQueries';
import { orderWorktrees, useWorktreeOrderStore } from '@/stores/useWorktreeOrderStore';
import { useNotificationStore } from '@/sync/notification-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useAllLiveSessions } from '@/sync/sync-context';
import {
  mergeAlwaysVisibleSessionIds,
  useRunningSessionIds,
} from '@/components/session/sidebar/hooks/useAlwaysVisibleSessionIds';
import { derivePinnedSessions } from '@/components/session/sidebar/pinnedSessions';
import { createSessionOwnershipIndex } from '@/components/session/sidebar/sessionOwnership';
import { selectVisibleSessions } from '@/components/session/sidebar/sessionNavigationModel';
import { buildSessionTree } from '@/components/session/sidebar/sessionTree';
import type { WorktreeMetadata } from '@/types/worktree';

import type {
  MobileProjectHomeItem,
  MobileSessionTreeNode,
  MobileWorktreeGroup,
} from './MobileProjectsHome';

/** Sentinel session-row ids for bucket pagination (presentational tree has no dedicated slot). */
export const SHOW_MORE_ID_PREFIX = '__show_more__:';
export const SHOW_FEWER_ID_PREFIX = '__show_fewer__:';

export const isShowMoreNodeId = (id: string): boolean => id.startsWith(SHOW_MORE_ID_PREFIX);
export const isShowFewerNodeId = (id: string): boolean => id.startsWith(SHOW_FEWER_ID_PREFIX);
export const isPaginationNodeId = (id: string): boolean =>
  isShowMoreNodeId(id) || isShowFewerNodeId(id);

export const parsePaginationNodeId = (
  id: string,
): { kind: 'more' | 'fewer'; projectId: string; bucketKey: string } | null => {
  const prefix = isShowMoreNodeId(id)
    ? SHOW_MORE_ID_PREFIX
    : isShowFewerNodeId(id)
      ? SHOW_FEWER_ID_PREFIX
      : null;
  if (!prefix) return null;
  const rest = id.slice(prefix.length);
  const sep = rest.indexOf('::');
  if (sep <= 0) return null;
  return {
    kind: prefix === SHOW_MORE_ID_PREFIX ? 'more' : 'fewer',
    projectId: rest.slice(0, sep),
    bucketKey: rest.slice(sep + 2),
  };
};

const getParentId = (session: Session): string | null =>
  (session as Session & { parentID?: string | null }).parentID ?? null;

const normalizePath = (value?: string | null): string =>
  (value || '').replace(/\\/g, '/').replace(/\/+$/g, '');

const getSessionDirectory = (session: Session): string => {
  const sessionWithDirectory = session as Session & {
    directory?: string | null;
    project?: { worktree?: string | null } | null;
  };
  return normalizePath(sessionWithDirectory.directory ?? sessionWithDirectory.project?.worktree ?? null);
};

const getProjectLabel = (path: string, label?: string | null): string => {
  if (label?.trim()) return label.trim();
  const normalized = normalizePath(path);
  if (!normalized) return '';
  const segments = normalized.split('/').filter(Boolean);
  return segments[segments.length - 1] || normalized;
};

const getSessionTimestamp = (session: Session): number => {
  const raw = session.time?.updated ?? session.time?.created;
  const value = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
};

/** Same short relative labels as MobileSessionsSheet. */
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
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(timestamp));
};

const isSessionArchived = (session: Session): boolean => {
  const archived = session.time?.archived;
  return typeof archived === 'number' && archived > 0;
};

type ProjectMeta = {
  id: string;
  label: string;
  path: string;
  icon?: string | null;
  worktrees: WorktreeMetadata[];
};

type WorktreeBucket = {
  key: string;
  label: string;
  path: string;
  worktree: WorktreeMetadata | null;
  sessions: Session[];
};

type ProjectNode = {
  project: ProjectMeta;
  buckets: WorktreeBucket[];
  totalSessions: number;
  isActive: boolean;
  latestActivity: number;
};

const findExactWorktreeMatch = (
  project: ProjectMeta,
  normalizedDirectory: string,
): WorktreeMetadata | null => (
  project.worktrees.find((worktree) => normalizePath(worktree.path) === normalizedDirectory) ?? null
);

export const listProjectAreaRootSessions = (
  sessions: Session[],
  pinnedSessionIds: ReadonlySet<string>,
): Session[] => buildSessionTree(sessions, {
  pinnedSessionIds,
  omitPinnedSessions: true,
}).map((node) => node.session);

/**
 * Non-pinned home-attention rows: live busy/retry sessions, plus top-level
 * unread sessions (the blue completed-unread marker). Pinned ids stay in the
 * pinned group; archived sessions stay out of this ephemeral set.
 */
export const listInProgressHomeSessions = (
  sessions: Session[],
  pinnedSessionIds: ReadonlySet<string>,
  runningSessionIds: ReadonlySet<string>,
  unseenBySession: Readonly<Record<string, number>>,
): Session[] => {
  const active: Session[] = [];
  for (const session of sessions) {
    if (pinnedSessionIds.has(session.id) || isSessionArchived(session)) continue;
    const running = runningSessionIds.has(session.id);
    const unread = (unseenBySession[session.id] ?? 0) > 0 && !getParentId(session);
    if (!running && !unread) continue;
    active.push(session);
  }
  active.sort((a, b) => getSessionActivityUpdatedAt(b) - getSessionActivityUpdatedAt(a));
  return active;
};

export type MobileProjectsHomeModel = {
  projects: MobileProjectHomeItem[];
  pinnedSessions: MobileSessionTreeNode[];
  inProgressSessions: MobileSessionTreeNode[];
  sessionById: Map<string, Session>;
  projectMetaById: Map<string, ProjectMeta>;
  allSessions: Session[];
  /** True when project has secondary worktrees (affects page size). */
  projectHasWorktrees: (projectId: string) => boolean;
  getBucketRootCount: (projectId: string, bucketKey: string) => number;
  getBucketVisibleCount: (projectId: string, bucketKey: string) => number;
  getBucketPageSize: (projectId: string) => number;
  getBucketDirectory: (projectId: string, bucketKey: string) => string | null;
  showMoreBucketSessions: (projectId: string, bucketKey: string) => void;
  resetBucketVisibleCount: (projectId: string, bucketKey: string) => void;
};

/**
 * Builds the presentational model for MobileProjectsHome from live + global session
 * stores, project list, worktree buckets, pin/unread/busy overlays, and expansion stores.
 */
export function useMobileProjectsHomeModel(): MobileProjectsHomeModel {
  const { t } = useI18n();
  const liveSessions = useAllLiveSessions();
  const globalActiveSessions = useGlobalSessionsStore((state) => state.activeSessions);
  const activePaginationByDirectory = useGlobalSessionsStore((state) => state.activePaginationByDirectory);
  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  // Authoritative worktree catalog is owned by MobileApp (connect-time enumeration into
  // session-ui-store). Do not re-probe git/worktrees here — that was an unbounded cold-start cost.
  const worktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
  const worktreeOrderByProject = useWorktreeOrderStore((state) => state.orderByProject);
  const pinnedSessionIds = usePinnedSessionIds();
  const projectExpandedMap = useMobileSessionTreeStore((state) => state.projectExpanded);
  const worktreeExpandedMap = useMobileSessionTreeStore((state) => state.worktreeExpanded);
  const unseenBySession = useNotificationStore((state) => state.index.session.unseenCount);
  // Ephemeral per-bucket visible root count (mirrors MobileSessionsSheet).
  const [visibleCountByBucket, setVisibleCountByBucket] = React.useState<Map<string, number>>(new Map());
  const runningSessionIds = useRunningSessionIds();
  const alwaysVisibleSessionIds = React.useMemo(
    () => mergeAlwaysVisibleSessionIds(runningSessionIds, currentSessionId),
    [currentSessionId, runningSessionIds],
  );

  const projectsMeta = React.useMemo<ProjectMeta[]>(
    () =>
      projects.map((project) => {
        const path = normalizePath(project.path);
        return {
          id: project.id,
          label: getProjectLabel(path, project.label),
          path,
          icon: project.icon,
          worktrees: orderWorktrees(
            worktreeOrderByProject[project.id],
            worktreesByProject.get(path) ?? [],
          ),
        };
      }),
    [projects, worktreeOrderByProject, worktreesByProject],
  );

  /**
   * Global sessions cover all directories; live sessions overlay for fresher
   * data on bootstrapped directories (same merge as MobileSessionsSheet).
   */
  const sessions = React.useMemo(() => {
    const liveById = new Map(liveSessions.map((session) => [session.id, session]));
    const merged = globalActiveSessions.map((session) => {
      const liveSession = liveById.get(session.id);
      return liveSession ? mergeLiveSessionWithGlobalSession(liveSession, session) : session;
    });
    const seenIds = new Set(merged.map((session) => session.id));
    for (const session of liveSessions) {
      if (!seenIds.has(session.id)) merged.push(session);
    }
    return merged;
  }, [globalActiveSessions, liveSessions]);

  const ownership = React.useMemo(
    () => createSessionOwnershipIndex(
      sessions,
      projectsMeta.map((project) => ({ id: project.id, normalizedPath: project.path })),
      worktreesByProject,
      false,
    ),
    [projectsMeta, sessions, worktreesByProject],
  );

  const projectNodes = React.useMemo<ProjectNode[]>(() => {
    const nodes: ProjectNode[] = projectsMeta.map((project) => ({
      project,
      buckets: [] as WorktreeBucket[],
      totalSessions: 0,
      isActive: project.id === activeProjectId,
      latestActivity: 0,
    }));
    const nodesById = new Map(nodes.map((node) => [node.project.id, node]));

    const ensureBucket = (
      node: ProjectNode,
      path: string,
      worktree: WorktreeMetadata | null,
    ): WorktreeBucket => {
      const normalizedBucketPath = normalizePath(path) || node.project.path;
      const key = normalizedBucketPath || '__root__';
      let bucket = node.buckets.find((entry) => entry.key === key);
      if (!bucket) {
        bucket = {
          key,
          label: worktree?.branch || worktree?.label || getProjectLabel(normalizedBucketPath),
          path: normalizedBucketPath,
          worktree,
          sessions: [],
        };
        node.buckets.push(bucket);
      }
      return bucket;
    };

    for (const node of nodes) {
      ensureBucket(node, node.project.path, null);
      for (const worktree of node.project.worktrees) ensureBucket(node, worktree.path, worktree);
    }

    for (const session of sessions) {
      const owner = ownership.bySessionId.get(session.id);
      if (!owner) continue;
      const node = nodesById.get(owner.projectId);
      if (!node) continue;
      const matchedWorktree = owner.kind === 'worktree'
        ? findExactWorktreeMatch(node.project, owner.scopeDirectory)
        : null;
      const bucket = matchedWorktree
        ? ensureBucket(node, matchedWorktree.path, matchedWorktree)
        : ensureBucket(node, node.project.path, null);
      bucket.sessions.push(session);
    }

    for (const node of nodes) {
      for (const bucket of node.buckets) {
        bucket.sessions.sort((a, b) => getSessionActivityUpdatedAt(b) - getSessionActivityUpdatedAt(a));
        const visibleRoots = listProjectAreaRootSessions(bucket.sessions, pinnedSessionIds);
        node.totalSessions += visibleRoots.length;
        for (const session of bucket.sessions) {
          const ts = getSessionTimestamp(session);
          if (ts > node.latestActivity) node.latestActivity = ts;
        }
      }
    }

    return nodes;
  }, [activeProjectId, ownership, pinnedSessionIds, projectsMeta, sessions]);

  const sessionById = React.useMemo(() => {
    const map = new Map<string, Session>();
    for (const session of sessions) map.set(session.id, session);
    return map;
  }, [sessions]);

  const projectMetaById = React.useMemo(() => {
    const map = new Map<string, ProjectMeta>();
    for (const meta of projectsMeta) map.set(meta.id, meta);
    return map;
  }, [projectsMeta]);

  const { pinnedSessions, inProgressSessions } = React.useMemo(() => {
    const projectById = new Map(projectsMeta.map((project) => [project.id, project]));
    const untitled = t('mobile.sessions.untitled');
    const toNode = (session: Session, pinned: boolean): MobileSessionTreeNode[] => {
      const owner = ownership.bySessionId.get(session.id);
      const project = owner ? projectById.get(owner.projectId) : undefined;
      if (!project) return [];
      return [{
        id: session.id,
        directory: getSessionDirectory(session),
        title: session.title?.trim() || untitled,
        subtitle: pinned ? project.label : undefined,
        activityLabel: formatRelativeShort(getSessionTimestamp(session)) || undefined,
        unread: (unseenBySession[session.id] ?? 0) > 0,
        pinned,
        archived: isSessionArchived(session),
        active: currentSessionId === session.id,
      }];
    };
    return {
      pinnedSessions: derivePinnedSessions(sessions, pinnedSessionIds)
        .flatMap((session) => toNode(session, true)),
      inProgressSessions: listInProgressHomeSessions(
        sessions,
        pinnedSessionIds,
        runningSessionIds,
        unseenBySession,
      ).flatMap((session) => toNode(session, false)),
    };
  }, [
    currentSessionId,
    ownership,
    pinnedSessionIds,
    projectsMeta,
    runningSessionIds,
    sessions,
    t,
    unseenBySession,
  ]);

  const bucketIndex = React.useMemo(() => {
    const map = new Map<string, { path: string; rootCount: number; hasWorktrees: boolean }>();
    for (const node of projectNodes) {
      const hasWorktrees = node.project.worktrees.length > 0;
      for (const bucket of node.buckets) {
        const rootCount = listProjectAreaRootSessions(bucket.sessions, pinnedSessionIds).length;
        map.set(`${node.project.id}::${bucket.key}`, {
          path: bucket.path,
          rootCount,
          hasWorktrees,
        });
      }
    }
    return map;
  }, [pinnedSessionIds, projectNodes]);

  const homeProjects = React.useMemo<MobileProjectHomeItem[]>(() => {
    const normalizedDirectory = normalizePath(currentDirectory);

    return projectNodes.map((node) => {
      const projectExpanded = projectExpandedMap[node.project.id] ?? true;
      const defaultVisible = getMobileSessionDefaultVisibleCount();
      const iconName: IconName | undefined = node.project.icon
        ? PROJECT_ICON_MAP[node.project.icon]
        : undefined;

      const worktrees: MobileWorktreeGroup[] = node.buckets.map((bucket) => {
        const expandKey = `${node.project.id}::${bucket.key}`;
        const worktreeExpanded = worktreeExpandedMap[expandKey] ?? false;
        const visibleCount = visibleCountByBucket.get(expandKey) ?? defaultVisible;

        // Mobile home is a flat parent-session list only. Subagents stay off the
        // catalog (and off search) — never promote orphans when the parent is
        // missing from this bucket (archived/system parents). Archive cascade
        // still walks allSessions. Pinned roots leave the project area the same
        // way the sidebar forest does: omit after parent/child attachment.
        const rootSessions = listProjectAreaRootSessions(bucket.sessions, pinnedSessionIds);
        // Search must cover pinned roots too — they leave the project-area
        // display list, and the pinned group is hidden while searching.
        const catalogRoots = buildSessionTree(bucket.sessions, {
          pinnedSessionIds,
          omitPinnedSessions: false,
        }).map((node) => node.session);

        const toNode = (session: Session): MobileSessionTreeNode => {
          const parentId = getParentId(session);
          const unseen = unseenBySession[session.id] ?? 0;
          // Subagents are filtered out of roots; keep unread only for top-level rows.
          const unread = unseen > 0 && !parentId;
          return {
            id: session.id,
            directory: bucket.path,
            title: session.title?.trim() || t('mobile.sessions.untitled'),
            activityLabel: formatRelativeShort(getSessionTimestamp(session)) || undefined,
            unread,
            pinned: pinnedSessionIds.has(session.id),
            archived: isSessionArchived(session),
            active: currentSessionId === session.id,
          };
        };

        const visibleRoots = selectVisibleSessions(
          rootSessions,
          visibleCount,
          alwaysVisibleSessionIds,
        ).map(toNode);
        const remaining = rootSessions.length - visibleRoots.length;
        const pagination = activePaginationByDirectory.get(normalizePath(bucket.path));
        const hasRemoteSessions = pagination?.hasMore === true;
        // Match PC: Fewer only after the user expands past the default 3-row slice.
        const canShowFewer = rootSessions.length > defaultVisible
          && visibleCount > defaultVisible;

        const sessionsTree: MobileSessionTreeNode[] = [...visibleRoots];
        // Fewer sits above More when both appear (collapse before expand).
        if (canShowFewer) {
          sessionsTree.push({
            id: `${SHOW_FEWER_ID_PREFIX}${node.project.id}::${bucket.key}`,
            kind: 'pagination',
            title: t('sessions.sidebar.group.showFewer'),
          });
        }
        if (remaining > 0 || hasRemoteSessions) {
          sessionsTree.push({
            id: `${SHOW_MORE_ID_PREFIX}${node.project.id}::${bucket.key}`,
            kind: 'pagination',
            title: t('sessions.sidebar.group.showMore'),
            subtitle: pagination?.loadingMore ? '…' : undefined,
          });
        }

        const bucketPath = normalizePath(bucket.path);
        const isActiveWorktree = Boolean(
          node.isActive
          && normalizedDirectory
          && bucketPath
          && (
            normalizedDirectory === bucketPath
            || normalizedDirectory.startsWith(`${bucketPath}/`)
          ),
        );

        // Root path (no worktree metadata) is the project's main workspace —
        // sessions list flat under the project card. Linked worktrees stay
        // collapsible groups.
        const isMainWorkspace = bucket.worktree == null;

        return {
          id: bucket.key,
          name: isMainWorkspace
            ? t('mobile.sessions.mainWorkspace')
            : bucket.label,
          path: bucket.path,
          kind: isMainWorkspace ? 'main' as const : 'worktree' as const,
          active: isActiveWorktree,
          // Main workspace is always open when the project is expanded; only
          // linked worktrees remember an independent expand toggle.
          expanded: isMainWorkspace ? true : worktreeExpanded,
          sessionCount: rootSessions.length,
          sessions: sessionsTree,
          catalogSessions: catalogRoots.map(toNode),
        };
      });

      return {
        id: node.project.id,
        name: node.project.label,
        path: node.project.path,
        icon: iconName,
        sessionCount: node.totalSessions,
        activityLabel: formatRelativeShort(node.latestActivity) || undefined,
        active: node.isActive,
        expanded: projectExpanded,
        worktrees,
      };
    });
  }, [
    activePaginationByDirectory,
    alwaysVisibleSessionIds,
    currentDirectory,
    currentSessionId,
    pinnedSessionIds,
    projectExpandedMap,
    projectNodes,
    t,
    unseenBySession,
    visibleCountByBucket,
    worktreeExpandedMap,
  ]);

  const projectHasWorktrees = (projectId: string): boolean => {
    for (const [key, value] of bucketIndex) {
      if (key.startsWith(`${projectId}::`)) return value.hasWorktrees;
    }
    return false;
  };

  const getBucketRootCount = (projectId: string, bucketKey: string): number =>
    bucketIndex.get(`${projectId}::${bucketKey}`)?.rootCount ?? 0;

  // projectId is kept for the MobileProjectsHomeModel contract.
  const getBucketPageSize = (_projectId: string): number =>
    getMobileSessionDefaultVisibleCount();

  const getBucketVisibleCount = (projectId: string, bucketKey: string): number => {
    const fullKey = `${projectId}::${bucketKey}`;
    return visibleCountByBucket.get(fullKey) ?? getBucketPageSize(projectId);
  };

  const getBucketDirectory = (projectId: string, bucketKey: string): string | null =>
    bucketIndex.get(`${projectId}::${bucketKey}`)?.path ?? null;

  const showMoreBucketSessions = (projectId: string, bucketKey: string) => {
    const fullKey = `${projectId}::${bucketKey}`;
    const info = bucketIndex.get(fullKey);
    const defaultVisible = getMobileSessionDefaultVisibleCount();
    const showMoreStep = getMobileSessionShowMoreIncrement();
    const currentVisibleCount = visibleCountByBucket.get(fullKey) ?? defaultVisible;
    const totalRoots = info?.rootCount ?? 0;

    setVisibleCountByBucket((previous) => {
      const next = new Map(previous);
      const current = Math.max(
        defaultVisible,
        previous.get(fullKey) ?? defaultVisible,
        currentVisibleCount,
      );
      next.set(fullKey, current + showMoreStep);
      return next;
    });

    // Match PC: only request the next remote page once the expanded slice
    // reaches (or passes) the already-cached root count.
    const nextVisibleCount = Math.max(defaultVisible, currentVisibleCount) + showMoreStep;
    if (nextVisibleCount < totalRoots) return;
    const directory = info?.path;
    const normalizedBucketDirectory = normalizePath(directory);
    if (!normalizedBucketDirectory) return;
    const pagination = useGlobalSessionsStore
      .getState()
      .activePaginationByDirectory.get(normalizedBucketDirectory);
    if (pagination?.hasMore && !pagination.loadingMore) {
      void loadMoreGlobalSessionsForDirectory(normalizedBucketDirectory);
    }
  };

  const resetBucketVisibleCount = (projectId: string, bucketKey: string) => {
    const fullKey = `${projectId}::${bucketKey}`;
    setVisibleCountByBucket((previous) => {
      if (!previous.has(fullKey)) return previous;
      const next = new Map(previous);
      next.delete(fullKey);
      return next;
    });
  };

  return {
    projects: homeProjects,
    pinnedSessions,
    inProgressSessions,
    sessionById,
    projectMetaById,
    allSessions: sessions,
    projectHasWorktrees,
    getBucketRootCount,
    getBucketVisibleCount,
    getBucketPageSize,
    getBucketDirectory,
    showMoreBucketSessions,
    resetBucketVisibleCount,
  };
}

export {
  getParentId,
  getSessionDirectory,
  normalizePath,
  formatRelativeShort,
  getSessionTimestamp,
};

export type { ProjectMeta };
