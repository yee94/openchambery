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

/** Worktree delete may remove the tree then fail remote-branch delete honestly. */
export type LynxDeleteWorktreeResult =
  | { status: 'ok' }
  | { status: 'no-runtime' }
  | { status: 'unavailable'; reason: string }
  | { status: 'failed'; error: string; httpStatus?: number; worktreeRemoved?: boolean };

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

export type LynxProjectIconImage = {
  mime: string;
  updatedAt: number;
  source: 'custom' | 'auto';
};

export type LynxProjectMeta = {
  id: string;
  path: string;
  label: string;
  icon: string | null;
  color: string | null;
  iconBackground: string | null;
  iconImage: LynxProjectIconImage | null;
};

export type LynxLoadProjectMetaResult =
  | { status: 'ok'; meta: LynxProjectMeta }
  | { status: 'no-runtime' }
  | { status: 'unavailable'; reason: string }
  | { status: 'failed'; error: string; httpStatus?: number };

export type LynxProjectIconMutationResult =
  | { status: 'ok'; skipped?: boolean; reason?: string; settingsProjects?: unknown[] }
  | { status: 'no-runtime' }
  | { status: 'unavailable'; reason: string }
  | { status: 'failed'; error: string; httpStatus?: number };

export type LynxWorktreeOrderResult =
  | { status: 'ok'; orderedPaths: string[]; revision: number }
  | { status: 'no-runtime' }
  | { status: 'unavailable'; reason: string }
  | { status: 'failed'; error: string; httpStatus?: number };

const sanitizeIconImage = (value: unknown): LynxProjectIconImage | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const mime = typeof record.mime === 'string' ? record.mime.trim() : '';
  const updatedAt = typeof record.updatedAt === 'number' ? record.updatedAt : NaN;
  const source = record.source === 'custom' || record.source === 'auto' ? record.source : null;
  if (!mime || !Number.isFinite(updatedAt) || updatedAt <= 0 || !source) return null;
  return { mime, updatedAt, source };
};

const stringOrNull = (value: unknown): string | null => {
  if (value === null) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
};

const findSettingsProjectIndex = (
  projects: Array<Record<string, unknown>>,
  input: { projectId: string; path: string },
): number => projects.findIndex((entry) => {
  const id = projectIdOf(entry);
  const path = projectPathOf(entry);
  return id === input.projectId || path === input.path
    || (path != null && path === input.projectId)
    || (id != null && id === input.path);
});

/**
 * Cap MobileProjectEditSurface load spirit — settings projects[] entry for
 * label/icon/color/iconBackground/iconImage. Unavailable when not in settings.
 */
export async function loadLynxProjectMeta(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  input: { projectId: string; path: string; fallbackLabel?: string },
): Promise<LynxLoadProjectMetaResult> {
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
    const projects = Array.isArray(loaded.settings.projects)
      ? loaded.settings.projects as Array<Record<string, unknown>>
      : [];
    const index = findSettingsProjectIndex(projects, input);
    if (index < 0) {
      return {
        status: 'unavailable',
        reason: 'project meta not in settings — labeled unavailable',
      };
    }
    const entry = projects[index]!;
    const path = projectPathOf(entry) || input.path;
    const id = projectIdOf(entry) || input.projectId || path;
    const label = stringOrNull(entry.label)
      || stringOrNull(entry.name)
      || input.fallbackLabel
      || path;
    return {
      status: 'ok',
      meta: {
        id,
        path,
        label,
        icon: stringOrNull(entry.icon),
        color: stringOrNull(entry.color),
        iconBackground: stringOrNull(entry.iconBackground),
        iconImage: sanitizeIconImage(entry.iconImage),
      },
    };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Cap `updateProjectMeta` / MobileProjectEditSurface save — settings projects[]
 * via GET/PUT `/api/config/settings`. Persists label + icon + color (+ optional
 * iconBackground). iconImage uses discover/remove Cap icon routes separately.
 */
export async function updateLynxProjectMeta(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  input: {
    projectId: string;
    path: string;
    label: string;
    icon?: string | null;
    color?: string | null;
    iconBackground?: string | null;
  },
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
    const projects = Array.isArray(loaded.settings.projects)
      ? [...loaded.settings.projects] as Array<Record<string, unknown>>
      : [];
    const index = findSettingsProjectIndex(projects, input);
    if (index < 0) {
      // Cap edit can still open for session-index-only cards; be honest.
      return {
        status: 'unavailable',
        reason: 'project meta not in settings — labeled unavailable',
      };
    }
    const next: Record<string, unknown> = {
      ...projects[index],
      name: label,
      label,
    };
    if (input.icon !== undefined) next.icon = input.icon;
    if (input.color !== undefined) next.color = input.color;
    if (input.iconBackground !== undefined) next.iconBackground = input.iconBackground;
    projects[index] = next;
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

/** Cap MobileProjectEditSurface label-only save — thin wrapper over meta. */
export async function updateLynxProjectLabel(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  input: { projectId: string; path: string; label: string },
): Promise<LynxProjectMutationResult> {
  return updateLynxProjectMeta(runtimeFetch, input);
}

/**
 * Cap `discoverProjectIcon` → POST `/api/projects/:id/icon/discover`.
 * Uses settings project id when available (Cap `path_*` ids).
 */
export async function discoverLynxProjectIcon(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  input: { projectId: string; path: string; force?: boolean },
): Promise<LynxProjectIconMutationResult> {
  if (!runtimeFetch) return { status: 'no-runtime' };
  try {
    const loaded = await loadLynxProjectMeta(runtimeFetch, input);
    if (loaded.status !== 'ok') return loaded;
    const id = loaded.meta.id;
    const response = await runtimeFetch(`/api/projects/${encodeURIComponent(id)}/icon/discover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ force: input.force === true }),
    });
    if (response.status === 0) return { status: 'no-runtime' };
    if (response.status === 501 || response.status === 404) {
      return {
        status: 'unavailable',
        reason: `project icon discover unavailable (${response.status})`,
      };
    }
    const payload = await response.json().catch(() => null) as {
      error?: unknown;
      skipped?: unknown;
      reason?: unknown;
      settings?: { projects?: unknown };
    } | null;
    if (!response.ok) {
      return {
        status: 'failed',
        error: payload && typeof payload.error === 'string'
          ? payload.error
          : `project icon discover failed (${response.status})`,
        httpStatus: response.status,
      };
    }
    const projects = payload?.settings && typeof payload.settings === 'object'
      && Array.isArray((payload.settings as { projects?: unknown }).projects)
      ? (payload.settings as { projects: unknown[] }).projects
      : undefined;
    return {
      status: 'ok',
      skipped: payload?.skipped === true,
      reason: typeof payload?.reason === 'string' ? payload.reason : undefined,
      settingsProjects: projects,
    };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Cap `removeProjectIcon` → DELETE `/api/projects/:id/icon`. */
export async function removeLynxProjectIcon(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  input: { projectId: string; path: string },
): Promise<LynxProjectIconMutationResult> {
  if (!runtimeFetch) return { status: 'no-runtime' };
  try {
    const loaded = await loadLynxProjectMeta(runtimeFetch, input);
    if (loaded.status !== 'ok') return loaded;
    const id = loaded.meta.id;
    const response = await runtimeFetch(`/api/projects/${encodeURIComponent(id)}/icon`, {
      method: 'DELETE',
      headers: { Accept: 'application/json' },
    });
    if (response.status === 0) return { status: 'no-runtime' };
    if (response.status === 501 || response.status === 404) {
      return {
        status: 'unavailable',
        reason: `project icon remove unavailable (${response.status})`,
      };
    }
    const payload = await response.json().catch(() => null) as {
      error?: unknown;
      settings?: { projects?: unknown };
    } | null;
    if (!response.ok) {
      return {
        status: 'failed',
        error: payload && typeof payload.error === 'string'
          ? payload.error
          : `project icon remove failed (${response.status})`,
        httpStatus: response.status,
      };
    }
    const projects = payload?.settings && typeof payload.settings === 'object'
      && Array.isArray((payload.settings as { projects?: unknown }).projects)
      ? (payload.settings as { projects: unknown[] }).projects
      : undefined;
    return { status: 'ok', settingsProjects: projects };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const WORKTREE_ORDER_ROUTE = '/api/openchamber/message-queue/worktrees/order';

/**
 * Cap `fetchWorktreeOrder` → GET message-queue worktrees/order.
 * Cap also keeps Zustand local order; Lynx is honest when HTTP is missing.
 */
export async function fetchLynxWorktreeOrder(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  projectDirectory: string,
): Promise<LynxWorktreeOrderResult> {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const directory = projectDirectory.trim();
  if (!directory) return { status: 'failed', error: 'project directory required' };
  try {
    const response = await runtimeFetch(
      `${WORKTREE_ORDER_ROUTE}?projectDirectory=${encodeURIComponent(directory)}`,
      { method: 'GET' },
    );
    if (response.status === 0) return { status: 'no-runtime' };
    if (response.status === 501 || response.status === 404) {
      return {
        status: 'unavailable',
        reason: `worktree order unavailable (${response.status})`,
      };
    }
    if (!response.ok) {
      return {
        status: 'failed',
        error: `worktree order fetch failed (${response.status})`,
        httpStatus: response.status,
      };
    }
    const payload = await response.json().catch(() => null) as {
      orderedPaths?: unknown;
      revision?: unknown;
      worktreeOrder?: { orderedPaths?: unknown; revision?: unknown };
    } | null;
    const source = payload?.worktreeOrder && typeof payload.worktreeOrder === 'object'
      ? payload.worktreeOrder
      : payload;
    const orderedPaths = Array.isArray(source?.orderedPaths)
      ? source!.orderedPaths.filter((entry): entry is string => typeof entry === 'string')
      : null;
    const revision = typeof source?.revision === 'number' ? source.revision : null;
    if (!orderedPaths || revision == null || !Number.isFinite(revision)) {
      return {
        status: 'failed',
        error: 'worktree order response malformed',
        httpStatus: response.status,
      };
    }
    return { status: 'ok', orderedPaths, revision };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Cap `setWorktreeOrder` → PUT message-queue worktrees/order.
 * Never fake-success when Cap MQ route is unreachable.
 */
export async function setLynxWorktreeOrder(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  input: {
    projectDirectory: string;
    orderedPaths: string[];
    expectedRevision?: number;
    requestID?: string;
  },
): Promise<LynxWorktreeOrderResult> {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const projectDirectory = input.projectDirectory.trim();
  if (!projectDirectory) return { status: 'failed', error: 'project directory required' };
  const requestID = input.requestID?.trim()
    || (typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `worktree-order-${Date.now()}`);
  const expectedRevision = typeof input.expectedRevision === 'number' && Number.isFinite(input.expectedRevision)
    ? input.expectedRevision
    : 0;
  try {
    const response = await runtimeFetch(WORKTREE_ORDER_ROUTE, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        requestID,
        projectDirectory,
        expectedRevision,
        orderedPaths: input.orderedPaths,
      }),
    });
    if (response.status === 0) return { status: 'no-runtime' };
    if (response.status === 501 || response.status === 404) {
      return {
        status: 'unavailable',
        reason: `worktree order persist unavailable (${response.status})`,
      };
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: unknown; code?: unknown } | null;
      const message = payload && typeof payload.error === 'string'
        ? payload.error
        : payload && typeof payload.code === 'string'
          ? payload.code
          : `worktree order persist failed (${response.status})`;
      return { status: 'failed', error: message, httpStatus: response.status };
    }
    const payload = await response.json().catch(() => null) as {
      revision?: unknown;
      worktreeOrder?: { orderedPaths?: unknown; revision?: unknown };
      orderedPaths?: unknown;
    } | null;
    const revision = typeof payload?.revision === 'number'
      ? payload.revision
      : typeof payload?.worktreeOrder?.revision === 'number'
        ? payload.worktreeOrder.revision
        : expectedRevision + 1;
    const orderedPaths = Array.isArray(payload?.worktreeOrder?.orderedPaths)
      ? payload!.worktreeOrder!.orderedPaths!.filter((entry): entry is string => typeof entry === 'string')
      : Array.isArray(payload?.orderedPaths)
        ? payload!.orderedPaths!.filter((entry): entry is string => typeof entry === 'string')
        : input.orderedPaths;
    return { status: 'ok', orderedPaths, revision };
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

/** Cap branch name for remote delete — strip `refs/heads/` like Cap removeProjectWorktree. */
export const normalizeLynxWorktreeBranchName = (branch?: string | null): string =>
  (branch || '').replace(/^refs\/heads\//, '').trim();

/**
 * Cap `DELETE /api/git/remote-branches?directory=` with `{ branch, remote? }`.
 * Real Cap contract — never fake-success.
 */
export async function deleteLynxRemoteBranch(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  input: {
    projectDirectory: string;
    branch: string;
    remote?: string | null;
  },
): Promise<LynxProjectMutationResult> {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const projectDirectory = input.projectDirectory.trim();
  const branch = normalizeLynxWorktreeBranchName(input.branch);
  if (!projectDirectory) {
    return { status: 'failed', error: 'project directory required' };
  }
  if (!branch) {
    return { status: 'failed', error: 'branch is required to delete remote branch' };
  }
  const remote = typeof input.remote === 'string' ? input.remote.trim() : '';
  const payload: { branch: string; remote?: string } = { branch };
  if (remote) payload.remote = remote;
  try {
    const response = await runtimeFetch(
      `/api/git/remote-branches${directoryQuery(projectDirectory)}`,
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    );
    if (response.status === 0) return { status: 'no-runtime' };
    if (response.status === 501 || response.status === 404) {
      return {
        status: 'unavailable',
        reason: `git.remote-branches delete unavailable (${response.status})`,
      };
    }
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: unknown } | null;
      const message = body && typeof body.error === 'string'
        ? body.error
        : `git.remote-branches delete failed (${response.status})`;
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

/**
 * Cap `DELETE /api/git/worktrees?directory=` with `{ directory, deleteLocalBranch }`,
 * then optional Cap `deleteRemoteBranch` (same order as Cap removeProjectWorktree).
 * Remote failure after worktree removal is reported honestly (never fake-success).
 */
export async function deleteLynxWorktree(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  input: {
    projectDirectory: string;
    worktreeDirectory: string;
    deleteLocalBranch?: boolean;
    deleteRemoteBranch?: boolean;
    branch?: string | null;
    remote?: string | null;
  },
): Promise<LynxDeleteWorktreeResult> {
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

    const branchName = normalizeLynxWorktreeBranchName(input.branch);
    if (input.deleteRemoteBranch && branchName) {
      const remoteResult = await deleteLynxRemoteBranch(runtimeFetch, {
        projectDirectory,
        branch: branchName,
        remote: input.remote,
      });
      if (remoteResult.status === 'ok') return { status: 'ok' };
      if (remoteResult.status === 'no-runtime') {
        return {
          status: 'failed',
          error: 'worktree removed but remote branch delete lost runtime',
          worktreeRemoved: true,
        };
      }
      if (remoteResult.status === 'unavailable') {
        return {
          status: 'failed',
          error: `worktree removed but ${remoteResult.reason}`,
          worktreeRemoved: true,
        };
      }
      return {
        status: 'failed',
        error: `worktree removed but remote branch delete failed: ${remoteResult.error}`,
        httpStatus: remoteResult.httpStatus,
        worktreeRemoved: true,
      };
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
