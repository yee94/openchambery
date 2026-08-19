import { worktreeMapsEqual } from '@/lib/worktrees/worktreeManager';
import type { WorktreeMetadata } from '@/types/worktree';

/**
 * Initial visible root sessions per mobile bucket (home + sessions sheet).
 * Matches PC sidebar compact cold-start slice.
 */
export const getMobileSessionDefaultVisibleCount = (): number => 3;

/**
 * How many additional root sessions each "Show more" reveals.
 * Matches PC sidebar show-more step.
 */
export const getMobileSessionShowMoreIncrement = (): number => 7;

/**
 * @deprecated Prefer {@link getMobileSessionDefaultVisibleCount} and
 * {@link getMobileSessionShowMoreIncrement}. Kept as the default visible count
 * so older call sites that treated "page size" as the initial slice stay correct.
 */
export const getMobileSessionPageSize = (_hasWorktrees = false): number =>
  getMobileSessionDefaultVisibleCount();

type MobileWorktreeRefreshResult = {
  path: string;
  status: 'success' | 'failed';
  worktrees?: WorktreeMetadata[];
};

export const mergeMobileWorktreeRefreshResults = (
  previous: Map<string, WorktreeMetadata[]>,
  projectPaths: Set<string>,
  results: MobileWorktreeRefreshResult[],
): Map<string, WorktreeMetadata[]> => {
  const next = new Map<string, WorktreeMetadata[]>();
  for (const [path, worktrees] of previous) {
    if (projectPaths.has(path)) next.set(path, worktrees);
  }
  for (const result of results) {
    if (result.status === 'success') next.set(result.path, result.worktrees ?? []);
  }
  return worktreeMapsEqual(next, previous) ? previous : next;
};
