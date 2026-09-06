import type { GitWorktreeInfo } from '@/lib/gitWorktreesApi';
import {
  getMobileSessionDefaultVisibleCount,
  getMobileSessionShowMoreIncrement,
} from '@/lib/mobileSessionPagination';
import { createProjectIdFromPath } from '@/lib/projectId';
import {
  projectLabelFromPath,
  type ProjectEntry,
} from '@/lib/projectsSettingsApi';
import {
  derivePinnedSessionIds,
  formatHomeSessionSubtitle,
  getSessionActivityMs,
  getSessionDirectory,
  isSessionArchived,
  listInProgressHomeSessions,
  normalizePath,
  type HomeSessionRow,
} from '@/lib/sessionHomeModel';
import type { SessionIndexSession, SessionIndexSnapshot } from '@/lib/sessionIndex';
import { orderWorktrees } from '@/lib/worktreeOrderApi';

export type ProjectTone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

export type ProjectsHomeSessionNode = {
  id: string;
  title: string;
  subtitle?: string;
  directory: string;
  activityMs: number;
  activityLabel?: string;
  unread: boolean;
  pinned: boolean;
  archived: boolean;
  active?: boolean;
  parentID: string | null;
  branch?: string | null;
};

export type ProjectsHomeWorktreeGroup = {
  id: string;
  name: string;
  path: string;
  kind: 'main' | 'worktree';
  branch?: string | null;
  active?: boolean;
  expanded: boolean;
  sessionCount: number;
  sessions: ProjectsHomeSessionNode[];
  /** Unpaginated top-level sessions for search (Cap catalogSessions). */
  catalogSessions: ProjectsHomeSessionNode[];
  hasMore: boolean;
  canShowFewer: boolean;
};

export type ProjectsHomeProjectItem = {
  id: string;
  name: string;
  path: string;
  icon?: string | null;
  color?: string | null;
  tone?: ProjectTone;
  sessionCount: number;
  activityLabel?: string;
  active: boolean;
  expanded: boolean;
  isGitRepository: boolean;
  worktrees: ProjectsHomeWorktreeGroup[];
};

export type ProjectsHomeModel = {
  projects: ProjectsHomeProjectItem[];
  pinnedSessions: ProjectsHomeSessionNode[];
  inProgressSessions: ProjectsHomeSessionNode[];
  /** Flat catalog for search (all non-archived top-level rows). */
  catalog: ProjectsHomeSessionNode[];
};

export type WorktreeMetadataLite = {
  path: string;
  branch: string;
  label: string;
  name?: string;
  projectDirectory: string;
};

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

export const formatRelativeShort = (timestamp: number, now = Date.now()): string => {
  if (timestamp <= 0) return '';
  const diffMs = now - timestamp;
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

export const gitWorktreesToMetadata = (
  projectDirectory: string,
  worktrees: GitWorktreeInfo[],
): WorktreeMetadataLite[] => {
  const root = normalizePath(projectDirectory);
  const result: WorktreeMetadataLite[] = [];
  for (const wt of worktrees) {
    const path = normalizePath(wt.path);
    if (!path || path === root) continue;
    result.push({
      path,
      branch: wt.branch || '',
      label: wt.branch || wt.name || path.split('/').filter(Boolean).pop() || path,
      ...(wt.name ? { name: wt.name } : {}),
      projectDirectory: root,
    });
  }
  return result;
};

type DirectoryOwner = {
  projectId: string;
  projectRoot: string;
  scopeDirectory: string;
  kind: 'project' | 'worktree';
};

type FlatSession = SessionIndexSession & { directory: string };

const getParentDirectory = (directory: string): string | null => {
  if (directory === '/' || /^[A-Z]:$/i.test(directory)) return null;
  const separator = directory.lastIndexOf('/');
  if (separator < 0) return null;
  if (separator === 0) return '/';
  if (separator === 2 && /^[A-Z]:\//i.test(directory)) return directory.slice(0, 2);
  return directory.slice(0, separator);
};

/**
 * Cap `createSessionOwnershipIndex` (mobile subset): exact directory owners for
 * project roots + linked worktrees, with parent-walk fallback.
 */
export const createSessionOwnershipIndex = (
  sessions: FlatSession[],
  projects: { id: string; path: string }[],
  worktreesByProjectPath: ReadonlyMap<string, WorktreeMetadataLite[]>,
): Map<string, DirectoryOwner> => {
  const ownerByDirectory = new Map<string, DirectoryOwner>();
  const projectByRoot = new Map<string, { id: string; path: string }>();

  for (const project of projects) {
    const projectRoot = normalizePath(project.path);
    if (!projectRoot) continue;
    projectByRoot.set(projectRoot, { id: project.id, path: projectRoot });
    ownerByDirectory.set(projectRoot, {
      projectId: project.id,
      projectRoot,
      scopeDirectory: projectRoot,
      kind: 'project',
    });
  }

  for (const [projectPath, worktrees] of worktreesByProjectPath) {
    const projectRoot = normalizePath(projectPath);
    const project = projectRoot ? projectByRoot.get(projectRoot) : undefined;
    if (!project || !projectRoot) continue;
    for (const worktree of worktrees) {
      const directory = normalizePath(worktree.path);
      if (!directory) continue;
      ownerByDirectory.set(directory, {
        projectId: project.id,
        projectRoot,
        scopeDirectory: directory,
        kind: 'worktree',
      });
    }
  }

  const resolved = new Map<string, DirectoryOwner | null>();
  const resolveOwner = (directory: string | null): DirectoryOwner | null => {
    if (!directory) return null;
    if (resolved.has(directory)) return resolved.get(directory) ?? null;
    let cursor: string | null = directory;
    while (cursor) {
      const hit = ownerByDirectory.get(cursor);
      if (hit) {
        resolved.set(directory, hit);
        return hit;
      }
      cursor = getParentDirectory(cursor);
    }
    resolved.set(directory, null);
    return null;
  };

  const bySessionId = new Map<string, DirectoryOwner>();
  for (const session of sessions) {
    const owner = resolveOwner(session.directory);
    if (owner) bySessionId.set(session.id, owner);
  }
  return bySessionId;
};

/** Top-level roots only; omit pinned from project-area lists (Cap listProjectAreaRootSessions). */
export const listProjectAreaRootSessions = <T extends { id: string; parentID?: string | null }>(
  sessions: T[],
  pinnedSessionIds: ReadonlySet<string>,
): T[] =>
  sessions.filter((session) => !session.parentID && !pinnedSessionIds.has(session.id));

export type BuildProjectsHomeOptions = {
  untitledLabel?: string;
  unseenBySession?: Readonly<Record<string, number>>;
  runningSessionIds?: ReadonlySet<string>;
  activeProjectId?: string | null;
  currentSessionId?: string | null;
  /** projectId -> expanded (default true). */
  projectExpanded?: Readonly<Record<string, boolean>>;
  /** `${projectId}::${bucketKey}` -> expanded (main defaults true, worktree false). */
  worktreeExpanded?: Readonly<Record<string, boolean>>;
  /** `${projectId}::${bucketKey}` -> visible root count. */
  visibleCountByBucket?: ReadonlyMap<string, number>;
  /** project path -> worktrees. */
  worktreesByProjectPath?: ReadonlyMap<string, WorktreeMetadataLite[]>;
  /** projectId -> ordered worktree paths. */
  worktreeOrderByProjectId?: Readonly<Record<string, string[]>>;
  gitRepoByProjectId?: Readonly<Record<string, boolean>>;
  now?: number;
};

const toNode = (
  session: FlatSession,
  options: {
    untitled: string;
    projectLabel: string;
    branch?: string | null;
    pinned: boolean;
    unseenBySession: Readonly<Record<string, number>>;
    currentSessionId?: string | null;
    now: number;
    directoryOverride?: string;
  },
): ProjectsHomeSessionNode => {
  const parentID = session.parentID ?? null;
  const unread = (options.unseenBySession[session.id] ?? 0) > 0 && !parentID;
  const activityMs = getSessionActivityMs(session);
  return {
    id: session.id,
    title: session.title?.trim() || options.untitled,
    subtitle: formatHomeSessionSubtitle(options.projectLabel, options.branch),
    directory: options.directoryOverride ?? session.directory,
    activityMs,
    activityLabel: formatRelativeShort(activityMs, options.now) || undefined,
    unread,
    pinned: options.pinned,
    archived: isSessionArchived(session),
    active: options.currentSessionId === session.id,
    parentID,
    branch: options.branch ?? session.project?.branch ?? null,
  };
};

/**
 * Cap MobileProjectsHomeModel builder: project shell + inset worktree groups + session rows.
 * Data model drives UI even when Expo restyles pixels later.
 */
export const buildProjectsHomeModel = (
  snapshot: SessionIndexSnapshot,
  projectsInput: ProjectEntry[],
  options: BuildProjectsHomeOptions = {},
): ProjectsHomeModel => {
  const untitled = options.untitledLabel ?? 'Untitled';
  const unseenBySession = options.unseenBySession ?? {};
  const runningSessionIds = options.runningSessionIds ?? new Set<string>();
  const now = options.now ?? Date.now();
  const pinnedIds = derivePinnedSessionIds(snapshot);
  const defaultVisible = getMobileSessionDefaultVisibleCount();
  const worktreesByProjectPath = options.worktreesByProjectPath ?? new Map();
  const worktreeOrderByProjectId = options.worktreeOrderByProjectId ?? {};
  const projectExpanded = options.projectExpanded ?? {};
  const worktreeExpanded = options.worktreeExpanded ?? {};
  const visibleCountByBucket = options.visibleCountByBucket ?? new Map<string, number>();
  const gitRepoByProjectId = options.gitRepoByProjectId ?? {};

  const flat: FlatSession[] = [];
  for (const dir of snapshot.directories) {
    const directory = normalizePath(dir.directory);
    for (const session of dir.sessions) {
      flat.push({
        ...session,
        directory: getSessionDirectory(session, directory),
      });
    }
  }

  // Synthesize projects from session directories when settings list is empty.
  const projects: ProjectEntry[] =
    projectsInput.length > 0
      ? projectsInput.map((project) => ({
          ...project,
          path: normalizePath(project.path),
          id: project.id || createProjectIdFromPath(project.path),
        }))
      : Array.from(
          new Set(
            flat
              .map((session) => session.directory)
              .filter(Boolean)
              .map(normalizePath),
          ),
        ).map((path) => ({
          id: createProjectIdFromPath(path),
          path,
          label: projectLabelFromPath(path),
        }));

  const ownership = createSessionOwnershipIndex(
    flat,
    projects.map((p) => ({ id: p.id, path: p.path })),
    worktreesByProjectPath,
  );

  // Orphan sessions (no project owner) → synthetic project per directory.
  const orphanDirs = new Set<string>();
  for (const session of flat) {
    if (isSessionArchived(session)) continue;
    if (!ownership.has(session.id) && session.directory) {
      orphanDirs.add(session.directory);
    }
  }
  const syntheticProjects: ProjectEntry[] = [...orphanDirs]
    .filter((path) => !projects.some((p) => normalizePath(p.path) === path))
    .map((path) => ({
      id: createProjectIdFromPath(path),
      path,
      label: projectLabelFromPath(path),
    }));
  const allProjects = [...projects, ...syntheticProjects];
  if (syntheticProjects.length > 0) {
    const refreshed = createSessionOwnershipIndex(
      flat,
      allProjects.map((p) => ({ id: p.id, path: p.path })),
      worktreesByProjectPath,
    );
    ownership.clear();
    for (const [id, owner] of refreshed) ownership.set(id, owner);
  }

  const sessionsById = new Map(flat.map((session) => [session.id, session]));

  const homeProjects: ProjectsHomeProjectItem[] = allProjects.map((project) => {
    const projectPath = normalizePath(project.path);
    const label = projectLabelFromPath(projectPath, project.label);
    const ordered: WorktreeMetadataLite[] = orderWorktrees(
      worktreeOrderByProjectId[project.id],
      worktreesByProjectPath.get(projectPath) ?? [],
    );

    type Bucket = {
      key: string;
      path: string;
      kind: 'main' | 'worktree';
      name: string;
      branch: string | null;
      sessions: FlatSession[];
    };

    const buckets: Bucket[] = [
      {
        key: projectPath || '__root__',
        path: projectPath,
        kind: 'main',
        name: label,
        branch: null,
        sessions: [],
      },
    ];
    for (const wt of ordered) {
      buckets.push({
        key: wt.path,
        path: wt.path,
        kind: 'worktree',
        name: wt.branch || wt.label || projectLabelFromPath(wt.path),
        branch: wt.branch || null,
        sessions: [],
      });
    }
    const bucketByKey = new Map(buckets.map((b) => [b.key, b]));

    for (const session of flat) {
      if (isSessionArchived(session)) continue;
      const owner = ownership.get(session.id);
      if (!owner || owner.projectId !== project.id) continue;
      const key =
        owner.kind === 'worktree' ? owner.scopeDirectory : projectPath || '__root__';
      const bucket = bucketByKey.get(key) ?? bucketByKey.get(projectPath || '__root__');
      if (!bucket) continue;
      bucket.sessions.push(session);
    }

    for (const bucket of buckets) {
      bucket.sessions.sort((a, b) => getSessionActivityMs(b) - getSessionActivityMs(a));
    }

    let latestActivity = 0;
    let totalSessions = 0;
    const worktreeGroups: ProjectsHomeWorktreeGroup[] = buckets.map((bucket) => {
      const expandKey = `${project.id}::${bucket.key}`;
      const expandedDefault = bucket.kind === 'main';
      const expanded = worktreeExpanded[expandKey] ?? expandedDefault;
      const visibleCount = visibleCountByBucket.get(expandKey) ?? defaultVisible;

      const roots = listProjectAreaRootSessions(bucket.sessions, pinnedIds);
      const catalogRoots = bucket.sessions.filter((session) => !session.parentID);

      const mapNode = (session: FlatSession, pinned: boolean): ProjectsHomeSessionNode =>
        toNode(session, {
          untitled,
          projectLabel: label,
          branch: bucket.branch ?? session.project?.branch ?? null,
          pinned,
          unseenBySession,
          currentSessionId: options.currentSessionId,
          now,
          directoryOverride: bucket.path,
        });

      const catalogSessions = catalogRoots.map((session) =>
        mapNode(session, pinnedIds.has(session.id)),
      );
      const visibleSessions = roots.slice(0, visibleCount).map((session) => mapNode(session, false));
      totalSessions += roots.length;
      for (const session of bucket.sessions) {
        const ts = getSessionActivityMs(session);
        if (ts > latestActivity) latestActivity = ts;
      }

      return {
        id: bucket.key,
        name: bucket.name,
        path: bucket.path,
        kind: bucket.kind,
        branch: bucket.branch,
        expanded,
        sessionCount: roots.length,
        sessions: visibleSessions,
        catalogSessions,
        hasMore: roots.length > visibleSessions.length,
        canShowFewer: visibleCount > defaultVisible && roots.length > defaultVisible,
      };
    });

    // Drop empty secondary worktree buckets that have zero sessions (keep main always).
    const visibleWorktrees = worktreeGroups.filter(
      (group) => group.kind === 'main' || group.sessionCount > 0 || ordered.some((wt) => wt.path === group.path),
    );

    return {
      id: project.id,
      name: label,
      path: projectPath,
      icon: project.icon ?? null,
      color: project.color ?? null,
      sessionCount: totalSessions,
      activityLabel: formatRelativeShort(latestActivity, now) || undefined,
      active: options.activeProjectId === project.id,
      expanded: projectExpanded[project.id] ?? true,
      isGitRepository: gitRepoByProjectId[project.id] === true || ordered.length > 0,
      worktrees: visibleWorktrees,
    };
  });

  const pinnedSessions: ProjectsHomeSessionNode[] = [];
  for (const id of pinnedIds) {
    const session = sessionsById.get(id);
    if (!session || isSessionArchived(session)) continue;
    const owner = ownership.get(id);
    const project = allProjects.find((p) => p.id === owner?.projectId);
    const label = project
      ? projectLabelFromPath(project.path, project.label)
      : projectLabelFromPath(session.directory);
    const worktrees = project ? worktreesByProjectPath.get(normalizePath(project.path)) ?? [] : [];
    const wt =
      owner?.kind === 'worktree'
        ? worktrees.find((entry: WorktreeMetadataLite) => entry.path === owner.scopeDirectory)
        : null;
    pinnedSessions.push(
      toNode(session, {
        untitled,
        projectLabel: label,
        branch: wt?.branch ?? session.project?.branch ?? null,
        pinned: true,
        unseenBySession,
        currentSessionId: options.currentSessionId,
        now,
      }),
    );
  }

  const inProgressSource = listInProgressHomeSessions(
    flat,
    pinnedIds,
    runningSessionIds,
    unseenBySession,
    isSessionArchived,
  );
  const inProgressSessions = inProgressSource.map((session) => {
    const owner = ownership.get(session.id);
    const project = allProjects.find((p) => p.id === owner?.projectId);
    const label = project
      ? projectLabelFromPath(project.path, project.label)
      : projectLabelFromPath(session.directory);
    const worktrees = project ? worktreesByProjectPath.get(normalizePath(project.path)) ?? [] : [];
    const wt =
      owner?.kind === 'worktree'
        ? worktrees.find((entry: WorktreeMetadataLite) => entry.path === owner.scopeDirectory)
        : null;
    return toNode(session, {
      untitled,
      projectLabel: label,
      branch: wt?.branch ?? session.project?.branch ?? null,
      pinned: false,
      unseenBySession,
      currentSessionId: options.currentSessionId,
      now,
    });
  });

  const catalog: ProjectsHomeSessionNode[] = [];
  for (const project of homeProjects) {
    for (const group of project.worktrees) {
      for (const session of group.catalogSessions) {
        if (!session.archived && !session.parentID) catalog.push(session);
      }
    }
  }
  for (const session of pinnedSessions) {
    if (!catalog.some((row) => row.id === session.id)) catalog.push(session);
  }

  return {
    projects: homeProjects,
    pinnedSessions,
    inProgressSessions,
    catalog,
  };
};

export const nextBucketVisibleCount = (current: number): number =>
  current + getMobileSessionShowMoreIncrement();

export const resetBucketVisibleCount = (): number => getMobileSessionDefaultVisibleCount();

/** Flat search over Cap project catalog (titles + project/worktree labels). */
export const filterProjectsHomeForSearch = (
  model: ProjectsHomeModel,
  rawQuery: string,
): {
  sessions: ProjectsHomeSessionNode[];
  projects: ProjectsHomeProjectItem[];
} => {
  const query = rawQuery.trim().toLowerCase();
  if (!query) {
    return { sessions: [], projects: model.projects };
  }

  const matches = (...values: (string | undefined | null)[]): boolean =>
    values.some((value) => value?.toLowerCase().includes(query));

  const sessions = model.catalog.filter((session) =>
    matches(session.title, session.subtitle, session.id, session.directory, session.branch),
  );

  const projects = model.projects.flatMap((project) => {
    if (matches(project.name, project.path)) {
      return [
        {
          ...project,
          expanded: true,
          worktrees: project.worktrees.map((group) => ({
            ...group,
            expanded: true,
            sessions: group.catalogSessions,
          })),
        },
      ];
    }
    const worktrees = project.worktrees.flatMap((group) => {
      if (matches(group.name, group.path, group.branch)) {
        return [{ ...group, expanded: true, sessions: group.catalogSessions }];
      }
      const filtered = group.catalogSessions.filter((session) =>
        matches(session.title, session.subtitle, session.id),
      );
      return filtered.length > 0 ? [{ ...group, expanded: true, sessions: filtered }] : [];
    });
    return worktrees.length > 0 ? [{ ...project, expanded: true, worktrees }] : [];
  });

  return { sessions, projects };
};

/** Bridge HomeSessionRow consumers still used by draft routing. */
export const toHomeSessionRow = (node: ProjectsHomeSessionNode): HomeSessionRow => ({
  id: node.id,
  title: node.title,
  subtitle: node.subtitle ?? '',
  directory: node.directory,
  activityMs: node.activityMs,
  pinned: node.pinned,
  unread: node.unread,
  archived: node.archived,
  parentID: node.parentID,
  branch: node.branch,
});
