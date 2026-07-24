import type {
  MobileProjectHomeItem,
  MobileSessionTreeNode,
  MobileWorktreeGroup,
} from './MobileProjectsHome';

const matchesQuery = (query: string, ...values: Array<string | undefined>): boolean =>
  values.some((value) => value?.toLowerCase().includes(query));

const filterSessionTree = (
  sessions: MobileSessionTreeNode[],
  query: string,
): MobileSessionTreeNode[] => sessions.flatMap((session) => {
  if (session.kind === 'pagination') return [];

  const children = filterSessionTree(session.children ?? [], query);
  if (!matchesQuery(query, session.title, session.subtitle, session.id) && children.length === 0) {
    return [];
  }

  return [{
    ...session,
    children: children.length > 0 ? children : undefined,
  }];
});

const filterWorktree = (
  worktree: MobileWorktreeGroup,
  query: string,
): MobileWorktreeGroup | null => {
  if (matchesQuery(query, worktree.name, worktree.path)) {
    return {
      ...worktree,
      sessions: worktree.sessions.filter((session) => session.kind !== 'pagination'),
    };
  }

  const sessions = filterSessionTree(worktree.sessions, query);
  return sessions.length > 0 ? { ...worktree, sessions } : null;
};

/** One bounded tree pass for the visible mobile catalog whenever the query changes. */
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
