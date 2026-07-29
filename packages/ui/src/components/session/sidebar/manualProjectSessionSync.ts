import { normalizePath } from '@/lib/pathNormalization';

/**
 * Build session-index sync directories after a manual project sync.
 * Prefer freshly refreshed worktree paths (not a stale React catalog snapshot).
 * Includes project root (workspace root), optional current selection, and worktrees; deduped.
 */
export const buildManualProjectSessionSyncDirectories = (
  projectPath: string,
  worktrees: Array<{ path: string }>,
  options?: {
    currentDirectory?: string | null;
    workspaceRoot?: string | null;
    includeWorktrees?: boolean;
  },
): string[] => {
  const directories: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string | null | undefined) => {
    const directory = normalizePath(raw ?? null);
    if (!directory || seen.has(directory)) return;
    seen.add(directory);
    directories.push(directory);
  };

  // Project path is the registered root; workspaceRoot is the same when not
  // overridden (e.g. multi-root shells). Both are accepted so callers can pass either.
  add(projectPath);
  add(options?.workspaceRoot);
  add(options?.currentDirectory);
  if (options?.includeWorktrees !== false) {
    for (const worktree of worktrees) {
      add(worktree.path);
    }
  }
  return directories;
};
