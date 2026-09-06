/**
 * Cap MobileChangesSurface data path — `GET /api/git/status?directory=`.
 * failure ≠ empty changes success.
 */
import type { LynxRuntimeFetch } from '../runtime/fetch';

export type LynxGitChangeEntry = {
  path: string;
  status: string;
  staged: boolean;
};

export type LynxGitDiffStat = {
  insertions: number;
  deletions: number;
};

export type LynxGitStatusResult =
  | {
      status: 'ok';
      directory: string;
      branch: string | null;
      entries: LynxGitChangeEntry[];
      /** Cap `GitStatus.diffStats` — path → +/- counts for ChangeRow chips. */
      diffStats: Record<string, LynxGitDiffStat>;
    }
  | { status: 'no-runtime' }
  | { status: 'no-directory' }
  | { status: 'failed'; error: Error; httpStatus?: number };

const asRecord = (data: unknown): Record<string, unknown> => (
  data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {}
);

const pushFiles = (
  target: LynxGitChangeEntry[],
  files: unknown,
  staged: boolean,
  fallbackStatus: string,
) => {
  if (!Array.isArray(files)) return;
  for (const file of files) {
    if (typeof file === 'string' && file.trim()) {
      target.push({ path: file.trim(), status: fallbackStatus, staged });
      continue;
    }
    if (!file || typeof file !== 'object') continue;
    const record = file as Record<string, unknown>;
    const path = typeof record.path === 'string' && record.path.trim()
      ? record.path.trim()
      : typeof record.file === 'string' && record.file.trim()
        ? record.file.trim()
        : '';
    if (!path) continue;
    const status = typeof record.status === 'string' && record.status.trim()
      ? record.status.trim()
      : fallbackStatus;
    target.push({ path, status, staged });
  }
};


const parseDiffStats = (raw: unknown): Record<string, LynxGitDiffStat> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, LynxGitDiffStat> = {};
  for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!path.trim() || !value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    const insertions = typeof record.insertions === 'number' && Number.isFinite(record.insertions)
      ? Math.max(0, Math.floor(record.insertions))
      : 0;
    const deletions = typeof record.deletions === 'number' && Number.isFinite(record.deletions)
      ? Math.max(0, Math.floor(record.deletions))
      : 0;
    out[path] = { insertions, deletions };
  }
  return out;
};

/** Cap `GET /api/git/status?directory=` (gitApiHttp). */
export const loadLynxGitStatus = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  directory: string | null | undefined,
  options?: { signal?: AbortSignal; mode?: 'light' },
): Promise<LynxGitStatusResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const trimmed = directory?.trim();
  if (!trimmed) return { status: 'no-directory' };
  try {
    const params = new URLSearchParams({ directory: trimmed });
    if (options?.mode) params.set('mode', options.mode);
    const response = await runtimeFetch(`/api/git/status?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: options?.signal,
    });
    if (response.status === 0) return { status: 'no-runtime' };
    if (!response.ok) {
      return {
        status: 'failed',
        error: new Error(`git/status failed (${response.status})`),
        httpStatus: response.status,
      };
    }
    const payload = asRecord(await response.json());
    const branch = typeof payload.branch === 'string'
      ? payload.branch
      : typeof payload.currentBranch === 'string'
        ? payload.currentBranch
        : null;
    const entries: LynxGitChangeEntry[] = [];
    pushFiles(entries, payload.stagedFiles ?? payload.staged, true, 'staged');
    pushFiles(entries, payload.unstagedFiles ?? payload.unstaged ?? payload.files, false, 'modified');
    pushFiles(entries, payload.untrackedFiles ?? payload.untracked, false, 'untracked');
    // Cap sometimes returns a flat `changes` array with staged flags.
    if (Array.isArray(payload.changes) && entries.length === 0) {
      for (const change of payload.changes) {
        if (!change || typeof change !== 'object') continue;
        const record = change as Record<string, unknown>;
        const path = typeof record.path === 'string' ? record.path.trim() : '';
        if (!path) continue;
        entries.push({
          path,
          status: typeof record.status === 'string' ? record.status : 'modified',
          staged: record.staged === true,
        });
      }
    }
    const diffStats = parseDiffStats(payload.diffStats);
    return { status: 'ok', directory: trimmed, branch, entries, diffStats };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
};


const gitQuery = (
  directory: string,
  extra?: Record<string, string | undefined>,
): string => {
  const params = new URLSearchParams({ directory });
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined && value !== '') params.set(key, value);
    }
  }
  return params.toString();
};

export type LynxGitFileDiffResult =
  | {
      status: 'ok';
      path: string;
      staged: boolean;
      original: string;
      modified: string;
      isBinary: boolean;
      /** Unified patch from `/api/git/diff` when available. */
      unifiedDiff: string | null;
    }
  | { status: 'no-runtime' }
  | { status: 'no-directory' }
  | { status: 'failed'; error: Error; httpStatus?: number };

/**
 * Cap MobileChangesSurface file diff — `GET /api/git/file-diff` (+ optional
 * unified `GET /api/git/diff` for turn/patch text).
 */
export const loadLynxGitFileDiff = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  directory: string | null | undefined,
  path: string,
  options?: { staged?: boolean; signal?: AbortSignal },
): Promise<LynxGitFileDiffResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const trimmedDir = directory?.trim();
  if (!trimmedDir) return { status: 'no-directory' };
  const trimmedPath = path.trim();
  if (!trimmedPath) {
    return { status: 'failed', error: new Error('path is required to fetch git file diff') };
  }
  const staged = options?.staged === true;
  try {
    const fileDiffQs = gitQuery(trimmedDir, {
      path: trimmedPath,
      staged: staged ? 'true' : undefined,
    });
    const fileDiffRes = await runtimeFetch(`/api/git/file-diff?${fileDiffQs}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: options?.signal,
    });
    if (fileDiffRes.status === 0) return { status: 'no-runtime' };
    if (!fileDiffRes.ok) {
      return {
        status: 'failed',
        error: new Error(`git/file-diff failed (${fileDiffRes.status})`),
        httpStatus: fileDiffRes.status,
      };
    }
    const payload = asRecord(await fileDiffRes.json());
    const original = typeof payload.original === 'string' ? payload.original : '';
    const modified = typeof payload.modified === 'string' ? payload.modified : '';
    const isBinary = payload.isBinary === true;

    let unifiedDiff: string | null = null;
    try {
      const diffQs = gitQuery(trimmedDir, {
        path: trimmedPath,
        staged: staged ? 'true' : undefined,
      });
      const diffRes = await runtimeFetch(`/api/git/diff?${diffQs}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: options?.signal,
      });
      if (diffRes.ok) {
        const diffPayload = asRecord(await diffRes.json());
        if (typeof diffPayload.diff === 'string') unifiedDiff = diffPayload.diff;
      }
    } catch {
      // Unified turn-diff is best-effort; file-diff alone is enough for preview.
    }

    return {
      status: 'ok',
      path: trimmedPath,
      staged,
      original,
      modified,
      isBinary,
      unifiedDiff,
    };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
};

export type LynxGitMutationResult =
  | { status: 'ok' }
  | { status: 'no-runtime' }
  | { status: 'no-directory' }
  | { status: 'failed'; error: Error; httpStatus?: number };

const postGitJson = async (
  runtimeFetch: LynxRuntimeFetch,
  path: string,
  directory: string,
  body: Record<string, unknown>,
  options?: { signal?: AbortSignal },
): Promise<LynxGitMutationResult> => {
  try {
    const qs = gitQuery(directory);
    const response = await runtimeFetch(`${path}?${qs}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    });
    if (response.status === 0) return { status: 'no-runtime' };
    if (!response.ok) {
      const payload = asRecord(await response.json().catch(() => null));
      const message = typeof payload.error === 'string' && payload.error.trim()
        ? payload.error.trim()
        : `${path} failed (${response.status})`;
      return { status: 'failed', error: new Error(message), httpStatus: response.status };
    }
    return { status: 'ok' };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
};

/** Cap `POST /api/git/commit` — MobileChangesSurface CommitSection. */
export const commitLynxGitChanges = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  directory: string | null | undefined,
  message: string,
  options?: { addAll?: boolean; signal?: AbortSignal },
): Promise<LynxGitMutationResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const trimmedDir = directory?.trim();
  if (!trimmedDir) return { status: 'no-directory' };
  const trimmedMessage = message.trim();
  if (!trimmedMessage) {
    return { status: 'failed', error: new Error('commit message required') };
  }
  return postGitJson(runtimeFetch, '/api/git/commit', trimmedDir, {
    message: trimmedMessage,
    addAll: options?.addAll ?? false,
  }, options);
};

export type LynxGitSyncAction = 'fetch' | 'pull' | 'push';

/**
 * Cap MobileChangesSurface SyncActions — clear HTTP endpoints exist:
 * `POST /api/git/fetch|pull|push`.
 */
export const syncLynxGit = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  directory: string | null | undefined,
  action: LynxGitSyncAction,
  options?: { remote?: string; branch?: string; signal?: AbortSignal },
): Promise<LynxGitMutationResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const trimmedDir = directory?.trim();
  if (!trimmedDir) return { status: 'no-directory' };
  const body: Record<string, unknown> = {};
  if (options?.remote) body.remote = options.remote;
  if (options?.branch) body.branch = options.branch;
  return postGitJson(runtimeFetch, `/api/git/${action}`, trimmedDir, body, options);
};

/**
 * Cap `POST /api/git/stage` — MobileChangesSurface moveChangePaths('stage').
 * Body: `{ paths: string[] }`. Failure ≠ fake-success.
 */
export const stageLynxGitFiles = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  directory: string | null | undefined,
  paths: readonly string[],
  options?: { signal?: AbortSignal },
): Promise<LynxGitMutationResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const trimmedDir = directory?.trim();
  if (!trimmedDir) return { status: 'no-directory' };
  const cleaned = paths.map((p) => p.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    return { status: 'failed', error: new Error('path is required to stage git changes') };
  }
  return postGitJson(runtimeFetch, '/api/git/stage', trimmedDir, { paths: cleaned }, options);
};

/**
 * Cap `POST /api/git/unstage` — MobileChangesSurface moveChangePaths('unstage').
 * Body: `{ paths: string[] }`. Failure ≠ fake-success.
 */
export const unstageLynxGitFiles = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  directory: string | null | undefined,
  paths: readonly string[],
  options?: { signal?: AbortSignal },
): Promise<LynxGitMutationResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const trimmedDir = directory?.trim();
  if (!trimmedDir) return { status: 'no-directory' };
  const cleaned = paths.map((p) => p.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    return { status: 'failed', error: new Error('path is required to unstage git changes') };
  }
  return postGitJson(runtimeFetch, '/api/git/unstage', trimmedDir, { paths: cleaned }, options);
};
