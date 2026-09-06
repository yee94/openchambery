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

export type LynxGitStatusResult =
  | {
      status: 'ok';
      directory: string;
      branch: string | null;
      entries: LynxGitChangeEntry[];
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
    return { status: 'ok', directory: trimmed, branch, entries };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
};
