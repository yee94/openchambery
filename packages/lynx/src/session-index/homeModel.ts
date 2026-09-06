import { normalizePath } from '../path';
import type { SessionIndexSession, SessionIndexSnapshot } from './types';

export const formatHomeSessionSubtitle = (
  projectLabel: string,
  branch?: string | null,
): string => {
  const trimmedBranch = branch?.trim();
  return trimmedBranch ? `${projectLabel} · ${trimmedBranch}` : projectLabel;
};

export const getProjectLabel = (path: string, label?: string | null): string => {
  if (label?.trim()) return label.trim();
  const normalized = normalizePath(path);
  if (!normalized) return '';
  const segments = normalized.split('/').filter(Boolean);
  return segments[segments.length - 1] || normalized;
};

export const getSessionActivityUpdatedAt = (session: SessionIndexSession): number => {
  const activity = session.metadata?.openchamber?.titleRefresh?.activityUpdatedAt;
  if (typeof activity === 'number' && Number.isFinite(activity) && activity > 0) return activity;
  const updated = session.time.updated;
  if (typeof updated === 'number' && Number.isFinite(updated) && updated > 0) return updated;
  return typeof session.time.created === 'number' && Number.isFinite(session.time.created) ? session.time.created : 0;
};

const getParentId = (session: SessionIndexSession): string | null => session.parentID ?? null;

const isArchived = (session: SessionIndexSession): boolean =>
  typeof session.time.archived === 'number' && session.time.archived > 0;

const sessionStatus = (session: SessionIndexSession): string =>
  session.metadata?.openchamber?.sessionStatus?.type ?? 'idle';

export type LynxHomeSessionRow = {
  id: string;
  directory: string;
  title: string;
  subtitle?: string;
  activityAt: number;
  pinned: boolean;
  archived: boolean;
  inProgress: boolean;
};

export type LynxHomeWorktreeGroup = {
  id: string;
  name: string;
  path: string;
  /** Main workspace lists sessions flat; linked worktrees stay collapsible. */
  kind: 'main' | 'worktree';
  branch?: string | null;
  sessionCount: number;
  sessions: LynxHomeSessionRow[];
};

export type LynxHomeProject = {
  id: string;
  label: string;
  path: string;
  sessionCount: number;
  latestActivity: number;
  /** Flat sessions across worktree groups (Cap catalog spirit). */
  sessions: LynxHomeSessionRow[];
  worktrees: LynxHomeWorktreeGroup[];
};

export type LynxProjectsHomeModel = {
  projects: LynxHomeProject[];
  pinnedSessions: LynxHomeSessionRow[];
  inProgressSessions: LynxHomeSessionRow[];
  sessionById: Map<string, SessionIndexSession>;
};

export type ProjectSessionIndexHomeOptions = {
  untitledLabel?: string;
  projectLabels?: Record<string, string>;
  worktreeBranchByDirectory?: Record<string, string>;
  /**
   * Optional map of worktree directory → parent project path.
   * When set, directories nest as worktree groups under the parent card.
   * Absent entries become their own project with a single main group.
   */
  projectRootByDirectory?: Record<string, string>;
};

const toRow = (
  session: SessionIndexSession,
  pinnedIds: ReadonlySet<string>,
  options: ProjectSessionIndexHomeOptions,
  projectLabel: string,
): LynxHomeSessionRow => {
  const path = normalizePath(session.directory);
  const branch = options.worktreeBranchByDirectory?.[path];
  return {
    id: session.id,
    directory: path,
    title: session.title.trim() || options.untitledLabel || 'Untitled',
    subtitle: formatHomeSessionSubtitle(projectLabel, branch),
    activityAt: getSessionActivityUpdatedAt(session),
    pinned: pinnedIds.has(session.id),
    archived: isArchived(session),
    inProgress: sessionStatus(session) !== 'idle' && sessionStatus(session) !== '',
  };
};

type MutableProject = {
  id: string;
  label: string;
  path: string;
  worktrees: Map<string, LynxHomeWorktreeGroup>;
};

/**
 * Projects-home projection from an authoritative session-index snapshot.
 * Root rows only (no parentID). Order is activity descending — the index
 * already ranks that way; we re-apply so callers do not sort by id.
 */
export const projectSessionIndexHome = (
  snapshot: SessionIndexSnapshot,
  options: ProjectSessionIndexHomeOptions = {},
): LynxProjectsHomeModel => {
  const pinnedIds = new Set(snapshot.pinnedSessionIds ?? []);
  const sessionById = new Map<string, SessionIndexSession>();
  const projectsById = new Map<string, MutableProject>();

  const ensureProject = (projectPath: string): MutableProject => {
    const path = normalizePath(projectPath);
    let project = projectsById.get(path);
    if (!project) {
      project = {
        id: path,
        label: getProjectLabel(path, options.projectLabels?.[path]),
        path,
        worktrees: new Map(),
      };
      projectsById.set(path, project);
    }
    return project;
  };

  for (const directory of snapshot.directories) {
    const path = normalizePath(directory.directory);
    const rootPath = normalizePath(options.projectRootByDirectory?.[path] ?? path);
    const project = ensureProject(rootPath);
    const branch = options.worktreeBranchByDirectory?.[path];
    const isLinkedWorktree = rootPath !== path;
    const worktreeKey = path || '__root__';
    const projectLabel = project.label;
    const roots = directory.sessions
      .filter((session) => !getParentId(session) && !isArchived(session) && !pinnedIds.has(session.id))
      .slice()
      .sort((left, right) => getSessionActivityUpdatedAt(right) - getSessionActivityUpdatedAt(left));
    for (const session of directory.sessions) sessionById.set(session.id, session);
    const rows = roots.map((session) => toRow(session, pinnedIds, options, projectLabel));
    const existing = project.worktrees.get(worktreeKey);
    const group: LynxHomeWorktreeGroup = {
      id: worktreeKey,
      name: branch || (isLinkedWorktree ? getProjectLabel(path) : projectLabel),
      path,
      kind: isLinkedWorktree ? 'worktree' : 'main',
      branch: branch ?? null,
      sessionCount: rows.length + (existing?.sessionCount ?? 0),
      sessions: [...(existing?.sessions ?? []), ...rows],
    };
    project.worktrees.set(worktreeKey, group);
  }

  const projects: LynxHomeProject[] = [...projectsById.values()].map((project) => {
    const worktrees = [...project.worktrees.values()].sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'main' ? -1 : 1;
      return (right.sessions[0]?.activityAt ?? 0) - (left.sessions[0]?.activityAt ?? 0);
    });
    const sessions = worktrees.flatMap((worktree) => worktree.sessions);
    const latestActivity = sessions.reduce((max, row) => Math.max(max, row.activityAt), 0);
    return {
      id: project.id,
      label: project.label,
      path: project.path,
      sessionCount: sessions.length,
      latestActivity,
      sessions,
      worktrees,
    };
  }).sort((left, right) => right.latestActivity - left.latestActivity);

  const allRoots = projects.flatMap((project) => project.sessions);
  const pinnedSessions = (snapshot.pinnedSessionIds ?? [])
    .map((id) => {
      const session = sessionById.get(id);
      if (!session) return null;
      const path = normalizePath(session.directory);
      const rootPath = normalizePath(options.projectRootByDirectory?.[path] ?? path);
      const projectLabel = getProjectLabel(rootPath, options.projectLabels?.[rootPath]);
      return toRow(session, pinnedIds, options, projectLabel);
    })
    .filter((row): row is LynxHomeSessionRow => Boolean(row));
  const inProgressSessions = allRoots.filter((row) => row.inProgress && !row.pinned);

  return { projects, pinnedSessions, inProgressSessions, sessionById };
};
