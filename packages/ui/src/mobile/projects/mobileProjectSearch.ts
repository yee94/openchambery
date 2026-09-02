import type {
  MobileProjectHomeItem,
  MobileSessionTreeNode,
  MobileWorktreeGroup,
} from './MobileProjectsHome';

const matchesQuery = (query: string, ...values: Array<string | undefined>): boolean =>
  values.some((value) => value?.toLowerCase().includes(query));

const catalogForSearch = (worktree: MobileWorktreeGroup): MobileSessionTreeNode[] =>
  worktree.catalogSessions ?? worktree.sessions;

/** Flat match only — mobile home never surfaces nested subagents. */
const filterSessions = (
  sessions: MobileSessionTreeNode[],
  query: string,
): MobileSessionTreeNode[] => sessions.filter((session) => {
  if (session.kind === 'pagination') return false;
  return matchesQuery(query, session.title, session.subtitle, session.id);
});

const filterWorktree = (
  worktree: MobileWorktreeGroup,
  query: string,
): MobileWorktreeGroup | null => {
  const catalog = catalogForSearch(worktree);
  if (matchesQuery(query, worktree.name, worktree.path)) {
    return {
      ...worktree,
      sessions: catalog.filter((session) => session.kind !== 'pagination'),
    };
  }

  const sessions = filterSessions(catalog, query);
  return sessions.length > 0 ? { ...worktree, sessions } : null;
};

/** One bounded tree pass over the unpaginated mobile catalog whenever the query changes. */
export const filterMobileProjectsForSearch = (
  projects: MobileProjectHomeItem[],
  rawQuery: string,
): MobileProjectHomeItem[] => {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return projects;

  return projects.flatMap((project) => {
    if (matchesQuery(query, project.name, project.path)) {
      return [{ ...project, worktrees: [] }];
    }

    const worktrees = project.worktrees.flatMap((worktree) => {
      const match = filterWorktree(worktree, query);
      return match ? [match] : [];
    });
    return worktrees.length > 0 ? [{ ...project, worktrees }] : [];
  });
};
