/**
 * Cap Projects home project/worktree menus — sync / edit / close / worktree HTTP.
 * Never fake-success; labeled unavailable when Cap git/settings routes are unreachable.
 */
import type { LynxRuntimeFetch } from '../runtime/fetch';
import { startSessionIndexBackgroundSync } from '../session-index/api';
import { loadLynxSettings, saveLynxSettings } from '../settings/api';

export type LynxProjectMutationResult =
  | { status: 'ok' }
  | { status: 'no-runtime' }
  | { status: 'unavailable'; reason: string }
  | { status: 'failed'; error: string; httpStatus?: number };

export type LynxSyncProjectSessionsResult =
  | { status: 'ok'; directories: string[] }
  | { status: 'no-runtime' }
  | { status: 'unsupported' }
  | { status: 'failed'; error: string; httpStatus?: number };

export type LynxGitProbeResult =
  | { status: 'ok'; isGitRepository: boolean }
  | { status: 'no-runtime' }
  | { status: 'unavailable'; reason: string }
  | { status: 'failed'; error: string; httpStatus?: number };

export type LynxWorktreeCreateResult =
  | { status: 'ok'; path: string; branch?: string | null; name?: string | null }
  | { status: 'no-runtime' }
  | { status: 'unavailable'; reason: string }
  | { status: 'failed'; error: string; httpStatus?: number };

const directoryQuery = (directory?: string | null): string => {
  const value = directory?.trim();
  return value ? `?directory=${encodeURIComponent(value)}` : '';
};

const projectPathOf = (entry: { path?: unknown; id?: unknown } | null | undefined): string | null => {
  if (!entry || typeof entry !== 'object') return null;
  const path = typeof entry.path === 'string' ? entry.path.trim() : '';
  return path || null;
};

const projectIdOf = (entry: { id?: unknown; path?: unknown } | null | undefined): string | null => {
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.id === 'string' && entry.id.trim()) return entry.id.trim();
  return projectPathOf(entry);
};

/** Cap `syncGlobalSessionsForDirectories` spirit → POST session-index/sync. */
export async function syncLynxProjectSessions(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  directories: string[],
): Promise<LynxSyncProjectSessionsResult> {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const unique = [...new Set(directories.map((d) => d.trim()).filter(Boolean))];
  if (unique.length === 0) {
    return { status: 'failed', error: 'no directories to sync' };
  }
  try {
    const snapshot = await startSessionIndexBackgroundSync(runtimeFetch, unique);
    if (snapshot === null) return { status: 'unsupported' };
    return { status: 'ok', directories: unique };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Cap `checkIsGitRepository` → GET `/api/git/check?directory=`. */
export async function probeLynxGitRepository(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  directory: string,
): Promise<LynxGitProbeResult> {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const path = directory.trim();
  if (!path) return { status: 'failed', error: 'directory required' };
  try {
    const response = await runtimeFetch(`/api/git/check${directoryQuery(path)}`, { method: 'GET' });
    if (response.status === 0) return { status: 'no-runtime' };
    if (response.status === 501 || response.status === 404) {
      return { status: 'unavailable', reason: `git.check unavailable (${response.status})` };
    }
    if (!response.ok) {
      return {
        status: 'failed',
        error: `git.check failed (${response.status})`,
        httpStatus: response.status,
      };
    }
    const payload = await response.json().catch(() => null) as { isGitRepository?: unknown } | null;
    return { status: 'ok', isGitRepository: Boolean(payload?.isGitRepository) };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Cap MobileProjectEditSurface label save spirit — settings projects[] via
 * GET/PUT `/api/config/settings` (same path as DirectoryExplorer add).
 */
export async function updateLynxProjectLabel(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  input: { projectId: string; path: string; label: string },
): Promise<LynxProjectMutationResult> {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const label = input.label.trim();
  if (!label) return { status: 'failed', error: 'label required' };
  try {
    const loaded = await loadLynxSettings(runtimeFetch);
    if (loaded.status === 'no-runtime') return { status: 'no-runtime' };
    if (loaded.status === 'failed') {
      return {
        status: 'failed',
        error: loaded.error.message,
        httpStatus: loaded.httpStatus,
      };
    }
    const projects = Array.isArray(loaded.settings.projects) ? [...loaded.settings.projects] : [];
    const index = projects.findIndex((entry) => {
      const id = projectIdOf(entry);
      const path = projectPathOf(entry);
      return id === input.projectId || path === input.path;
    });
    if (index < 0) {
      // Cap edit can still open for session-index-only cards; be honest.
      return {
        status: 'unavailable',
        reason: 'project meta not in settings — labeled unavailable',
      };
    }
    projects[index] = {
      ...projects[index],
      name: label,
      label,
    };
    const saved = await saveLynxSettings(runtimeFetch, { projects });
    if (saved.status === 'ok') return { status: 'ok' };
    if (saved.status === 'no-runtime') return { status: 'no-runtime' };
    return {
      status: 'failed',
      error: saved.error.message,
      httpStatus: saved.httpStatus,
    };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Cap `removeProject` spirit — drop from settings projects[]. */
export async function closeLynxProject(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  input: { projectId: string; path: string },
): Promise<LynxProjectMutationResult> {
  if (!runtimeFetch) return { status: 'no-runtime' };
  try {
    const loaded = await loadLynxSettings(runtimeFetch);
    if (loaded.status === 'no-runtime') return { status: 'no-runtime' };
    if (loaded.status === 'failed') {
      return {
        status: 'failed',
        error: loaded.error.message,
        httpStatus: loaded.httpStatus,
      };
    }
    const projects = (Array.isArray(loaded.settings.projects) ? loaded.settings.projects : [])
      .filter((entry) => {
        const id = projectIdOf(entry);
        const path = projectPathOf(entry);
        return id !== input.projectId && path !== input.path;
      });
    const before = Array.isArray(loaded.settings.projects) ? loaded.settings.projects.length : 0;
    if (projects.length === before) {
      return {
        status: 'unavailable',
        reason: 'project not in settings — labeled unavailable',
      };
    }
    const saved = await saveLynxSettings(runtimeFetch, { projects });
    if (saved.status === 'ok') return { status: 'ok' };
    if (saved.status === 'no-runtime') return { status: 'no-runtime' };
    return {
      status: 'failed',
      error: saved.error.message,
      httpStatus: saved.httpStatus,
    };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Cap `POST /api/git/worktrees?directory=` — mode=new with branch/name. */
export async function createLynxWorktree(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  input: {
    projectDirectory: string;
    worktreeName?: string;
    branchName?: string;
  },
): Promise<LynxWorktreeCreateResult> {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const projectDirectory = input.projectDirectory.trim();
  if (!projectDirectory) return { status: 'failed', error: 'project directory required' };
  const worktreeName = input.worktreeName?.trim() || input.branchName?.trim() || '';
  const branchName = input.branchName?.trim() || worktreeName;
  if (!worktreeName && !branchName) {
    return { status: 'failed', error: 'worktree name required' };
  }
  try {
    const response = await runtimeFetch(
      `/api/git/worktrees${directoryQuery(projectDirectory)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'new',
          worktreeName: worktreeName || branchName,
          name: worktreeName || branchName,
          branchName: branchName || worktreeName,
        }),
      },
    );
    if (response.status === 0) return { status: 'no-runtime' };
    if (response.status === 501 || response.status === 404) {
      return {
        status: 'unavailable',
        reason: `git.worktrees create unavailable (${response.status})`,
      };
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: unknown } | null;
      const message = payload && typeof payload.error === 'string'
        ? payload.error
        : `git.worktrees create failed (${response.status})`;
      return { status: 'failed', error: message, httpStatus: response.status };
    }
    const payload = await response.json().catch(() => null) as {
      path?: unknown;
      branch?: unknown;
      name?: unknown;
    } | null;
    const path = payload && typeof payload.path === 'string' ? payload.path.trim() : '';
    if (!path) {
      return {
        status: 'failed',
        error: 'git.worktrees create returned no path',
        httpStatus: response.status,
      };
    }
    return {
      status: 'ok',
      path,
      branch: payload && typeof payload.branch === 'string' ? payload.branch : null,
      name: payload && typeof payload.name === 'string' ? payload.name : null,
    };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Cap `DELETE /api/git/worktrees?directory=` with `{ directory }` payload. */
export async function deleteLynxWorktree(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  input: {
    projectDirectory: string;
    worktreeDirectory: string;
    deleteLocalBranch?: boolean;
  },
): Promise<LynxProjectMutationResult> {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const projectDirectory = input.projectDirectory.trim();
  const worktreeDirectory = input.worktreeDirectory.trim();
  if (!projectDirectory || !worktreeDirectory) {
    return { status: 'failed', error: 'project and worktree directories required' };
  }
  try {
    const response = await runtimeFetch(
      `/api/git/worktrees${directoryQuery(projectDirectory)}`,
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          directory: worktreeDirectory,
          deleteLocalBranch: Boolean(input.deleteLocalBranch),
        }),
      },
    );
    if (response.status === 0) return { status: 'no-runtime' };
    if (response.status === 501 || response.status === 404) {
      return {
        status: 'unavailable',
        reason: `git.worktrees delete unavailable (${response.status})`,
      };
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: unknown } | null;
      const message = payload && typeof payload.error === 'string'
        ? payload.error
        : `git.worktrees delete failed (${response.status})`;
      return { status: 'failed', error: message, httpStatus: response.status };
    }
    return { status: 'ok' };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Heuristic when git.check is unavailable: linked worktree groups imply git repo. */
export const inferLynxProjectIsGit = (
  project: { worktrees: Array<{ kind: string; branch?: string | null }> },
): boolean => project.worktrees.some(
  (worktree) => worktree.kind === 'worktree' || Boolean(worktree.branch?.trim()),
);
