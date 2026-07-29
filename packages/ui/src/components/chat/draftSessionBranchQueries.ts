/**
 * Pure helpers for DraftSessionBranchSelector branch Query scope.
 *
 * Branch *lists* are repo-wide and should stay keyed to the project root so
 * switching the selected worktree does not drop a warm list while the
 * worktree's `isGitRepo` probe is still null.
 *
 * Current-branch / checkout still target the selected directory.
 */

export const resolveDraftBranchListDirectory = (
  projectDirectory: string | null | undefined,
  selectedDirectory: string | null | undefined,
): string | null => projectDirectory ?? selectedDirectory ?? null;

/**
 * Enable branch list queries unless we authoritatively know the path is not a
 * git repo. Unknown (`null`) must stay enabled so a worktree switch cannot
 * clear lists while the store probe is still in-flight.
 */
export const canQueryDraftGitBranches = (
  directory: string | null | undefined,
  isGitRepo: boolean | null,
): boolean => Boolean(directory) && isGitRepo !== false;

export const splitGitBranchList = (all: string[] | null | undefined): {
  localBranches: string[];
  remoteBranches: string[];
} => {
  if (!all?.length) {
    return { localBranches: [], remoteBranches: [] };
  }
  const localBranches = all
    .filter((branchName) => !branchName.startsWith('remotes/'))
    .sort();
  const remoteBranches = all
    .filter((branchName) => branchName.startsWith('remotes/'))
    .map((branchName) => branchName.replace(/^remotes\//, ''))
    .sort();
  return { localBranches, remoteBranches };
};
