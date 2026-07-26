import { releaseSessionStartupBarrier } from '@/lib/session-startup-barrier';
import {
  hydrateGlobalSessionIndex,
  startGlobalSessionIndexStartup,
} from '@/stores/useGlobalSessionsStore';

type SessionStartupWorktree = { path: string };

const normalizeDirectory = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '') || '/';

export type SessionStartupPlan = {
  /** Every registered project root and known worktree path. */
  directories: string[];
  /**
   * First-screen directories: active directory's project root + that project's
   * known worktrees. Omitted when the active directory cannot be resolved —
   * callers then sync the full set (legacy cold-start behavior).
   */
  priorityDirectories?: string[];
};

export type SessionIndexStartupStart = (
  directories: Iterable<string>,
  options?: { priorityDirectories?: Iterable<string> },
) => Promise<{ activeSessions: unknown[]; archivedSessions: unknown[] }>;

export type SessionIndexHydrate = () => Promise<void>;

export const collectSessionStartupDirectories = (
  projectDirectories: Iterable<string>,
  worktreesByProject: ReadonlyMap<string, readonly SessionStartupWorktree[]>,
): string[] => {
  const directories = new Set<string>();

  for (const projectDirectory of projectDirectories) {
    if (!projectDirectory.trim()) continue;
    const normalizedProject = normalizeDirectory(projectDirectory);
    directories.add(normalizedProject);

    for (const [catalogProject, worktrees] of worktreesByProject) {
      if (normalizeDirectory(catalogProject) !== normalizedProject) continue;
      for (const worktree of worktrees) {
        if (worktree.path.trim()) directories.add(normalizeDirectory(worktree.path));
      }
    }
  }

  return [...directories];
};

/**
 * Build the cold-start directory plan.
 *
 * Priority (P0) is the project that owns `currentDirectory` (longest matching
 * registered project/worktree prefix) plus every known worktree under that
 * project. When `currentDirectory` is missing or unmatched, priority is
 * omitted so startup falls back to syncing the full set.
 */
export const planSessionStartupDirectories = (
  projectDirectories: Iterable<string>,
  worktreesByProject: ReadonlyMap<string, readonly SessionStartupWorktree[]>,
  options?: { currentDirectory?: string | null },
): SessionStartupPlan => {
  const directories = collectSessionStartupDirectories(projectDirectories, worktreesByProject);
  const currentRaw = options?.currentDirectory?.trim() ?? '';
  if (!currentRaw) {
    // No reliable active directory — keep legacy full-set startup.
    return { directories };
  }
  const current = normalizeDirectory(currentRaw);

  let priorityProject: string | null = null;
  for (const projectDirectory of projectDirectories) {
    if (!projectDirectory.trim()) continue;
    const normalizedProject = normalizeDirectory(projectDirectory);
    if (current === normalizedProject || current.startsWith(`${normalizedProject}/`)) {
      if (!priorityProject || normalizedProject.length > priorityProject.length) {
        priorityProject = normalizedProject;
      }
    }
  }
  for (const [catalogProject, worktrees] of worktreesByProject) {
    const normalizedProject = normalizeDirectory(catalogProject);
    for (const worktree of worktrees) {
      if (!worktree.path.trim()) continue;
      const worktreePath = normalizeDirectory(worktree.path);
      if (current === worktreePath || current.startsWith(`${worktreePath}/`)) {
        if (!priorityProject || normalizedProject.length > priorityProject.length) {
          priorityProject = normalizedProject;
        }
      }
    }
  }

  if (!priorityProject) {
    if (directories.includes(current)) {
      return { directories, priorityDirectories: [current] };
    }
    // Active path is outside the registered catalog — cannot narrow safely.
    return { directories };
  }

  const priority = new Set<string>([priorityProject]);
  for (const [catalogProject, worktrees] of worktreesByProject) {
    if (normalizeDirectory(catalogProject) !== priorityProject) continue;
    for (const worktree of worktrees) {
      if (worktree.path.trim()) priority.add(normalizeDirectory(worktree.path));
    }
  }
  if (directories.includes(current)) priority.add(current);

  const priorityDirectories = directories.filter((directory) => priority.has(directory));
  if (priorityDirectories.length === 0 || priorityDirectories.length >= directories.length) {
    return { directories };
  }
  return { directories, priorityDirectories };
};

export const runSessionStartup = async (
  directories: string[],
  start: SessionIndexStartupStart = startGlobalSessionIndexStartup,
  options?: { priorityDirectories?: Iterable<string> },
): Promise<void> => {
  try {
    await start(directories, options);
  } catch (error) {
    console.warn('[SessionStartup] Initial session index sync failed:', error);
  } finally {
    releaseSessionStartupBarrier();
  }
};

/**
 * Cold-start session-index restore + refresh with local-first paint.
 *
 * Hydrate starts immediately (does not wait for settings) so the last SQLite
 * snapshot can fill the sidebar before OpenCode/settings finish. Directory
 * planning and background sync still wait for settings so the catalog is
 * complete and the active directory is authoritative.
 */
export const runSessionStartupAfterSettingsHydration = async (
  settingsHydration: Promise<unknown> | null,
  getPlan: () => SessionStartupPlan,
  start: SessionIndexStartupStart = startGlobalSessionIndexStartup,
  hydrate: SessionIndexHydrate = hydrateGlobalSessionIndex,
): Promise<void> => {
  // Fire-and-forget early restore: startSessionIndexStartup reuses the same
  // coalesced hydrate when settings finish after (or during) this GET.
  void hydrate().catch((error) => {
    console.warn('[SessionStartup] Early session index hydrate failed:', error);
  });
  await settingsHydration;
  const plan = getPlan();
  await runSessionStartup(plan.directories, start, {
    priorityDirectories: plan.priorityDirectories,
  });
};
