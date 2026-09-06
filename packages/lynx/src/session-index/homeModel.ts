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

export type LynxHomeProject = {
  id: string;
  label: string;
  path: string;
  sessionCount: number;
  latestActivity: number;
  sessions: LynxHomeSessionRow[];
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
};

const toRow = (
  session: SessionIndexSession,
  pinnedIds: ReadonlySet<string>,
  options: ProjectSessionIndexHomeOptions,
): LynxHomeSessionRow => {
  const path = normalizePath(session.directory);
  const projectLabel = getProjectLabel(path, options.projectLabels?.[path]);
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
  const projects: LynxHomeProject[] = [];

  for (const directory of snapshot.directories) {
    const path = normalizePath(directory.directory);
    const roots = directory.sessions
      .filter((session) => !getParentId(session) && !isArchived(session) && !pinnedIds.has(session.id))
      .slice()
      .sort((left, right) => getSessionActivityUpdatedAt(right) - getSessionActivityUpdatedAt(left));
    for (const session of directory.sessions) sessionById.set(session.id, session);
    const rows = roots.map((session) => toRow(session, pinnedIds, options));
    const latestActivity = rows.reduce((max, row) => Math.max(max, row.activityAt), 0);
    projects.push({
      id: path,
      label: getProjectLabel(path, options.projectLabels?.[path]),
      path,
      sessionCount: rows.length,
      latestActivity,
      sessions: rows,
    });
  }

  const allRoots = projects.flatMap((project) => project.sessions);
  const pinnedSessions = (snapshot.pinnedSessionIds ?? [])
    .map((id) => {
      const session = sessionById.get(id);
      return session ? toRow(session, pinnedIds, options) : null;
    })
    .filter((row): row is LynxHomeSessionRow => Boolean(row));
  const inProgressSessions = allRoots.filter((row) => row.inProgress && !row.pinned);

  return { projects, pinnedSessions, inProgressSessions, sessionById };
};
