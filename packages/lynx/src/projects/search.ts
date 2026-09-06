import type { LynxHomeProject, LynxHomeSessionRow, LynxHomeWorktreeGroup, LynxProjectsHomeModel } from '../session-index/homeModel';

const matchesQuery = (query: string, ...values: Array<string | undefined | null>): boolean =>
  values.some((value) => value?.toLowerCase().includes(query));

const filterSessions = (
  sessions: LynxHomeSessionRow[],
  query: string,
): LynxHomeSessionRow[] =>
  sessions.filter((session) => matchesQuery(query, session.title, session.subtitle, session.id));

const filterWorktree = (
  worktree: LynxHomeWorktreeGroup,
  query: string,
): LynxHomeWorktreeGroup | null => {
  if (matchesQuery(query, worktree.name, worktree.path, worktree.branch)) {
    return { ...worktree, sessions: [...worktree.sessions] };
  }
  const sessions = filterSessions(worktree.sessions, query);
  return sessions.length > 0
    ? { ...worktree, sessions, sessionCount: sessions.length }
    : null;
};

const filterProject = (
  project: LynxHomeProject,
  query: string,
): LynxHomeProject | null => {
  if (matchesQuery(query, project.label, project.path)) {
    return { ...project };
  }
  const worktrees = project.worktrees.flatMap((worktree) => {
    const match = filterWorktree(worktree, query);
    return match ? [match] : [];
  });
  if (worktrees.length === 0) return null;
  const sessions = worktrees.flatMap((worktree) => worktree.sessions);
  return {
    ...project,
    worktrees,
    sessions,
    sessionCount: sessions.length,
  };
};

/**
 * Cap `filterMobileProjectsForSearch` spirit: one pass over project / worktree /
 * session catalog. Empty query returns the input model unchanged.
 */
export const filterLynxProjectsHomeForSearch = (
  model: LynxProjectsHomeModel,
  rawQuery: string,
): LynxProjectsHomeModel => {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return model;

  const projects = model.projects.flatMap((project) => {
    const match = filterProject(project, query);
    return match ? [match] : [];
  });
  const pinnedSessions = filterSessions(model.pinnedSessions, query);
  const inProgressSessions = filterSessions(model.inProgressSessions, query);

  return {
    projects,
    pinnedSessions,
    inProgressSessions,
    sessionById: model.sessionById,
  };
};
