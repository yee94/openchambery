/**
 * Cap MobileChangesSurface subset — git status + per-file diff for Expo Chat.
 * GET /api/git/status?directory=… , GET /api/git/file-diff?directory=…&path=…
 */

import type { ActiveRuntime } from '@/lib/connectionController';
import { openchamberFetch } from '@/lib/openchamberClient';

export type GitStatusFile = {
  path: string;
  index: string;
  working_dir: string;
};

export type GitStatus = {
  current: string;
  tracking: string | null;
  ahead: number;
  behind: number;
  files: GitStatusFile[];
  isClean: boolean;
  oversized?: boolean;
};

export type GitFileDiff = {
  original: string;
  modified: string;
  path: string;
  isBinary?: boolean;
};

export class GitChangesApiError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'GitChangesApiError';
    this.status = status;
  }
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const withDirectory = (path: string, directory: string, extra?: Record<string, string | undefined>) => {
  const params = new URLSearchParams();
  if (directory.trim()) params.set('directory', directory.trim());
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value != null && value !== '') params.set(key, value);
    }
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
};

const parseFile = (value: unknown): GitStatusFile | null => {
  const row = asRecord(value);
  if (!row || typeof row.path !== 'string') return null;
  return {
    path: row.path,
    index: typeof row.index === 'string' ? row.index : '',
    working_dir: typeof row.working_dir === 'string' ? row.working_dir : '',
  };
};

export const parseGitStatus = (payload: unknown): GitStatus => {
  const row = asRecord(payload) ?? {};
  const files = Array.isArray(row.files)
    ? row.files.map(parseFile).filter((f): f is GitStatusFile => f != null)
    : [];
  return {
    current: typeof row.current === 'string' ? row.current : '',
    tracking: typeof row.tracking === 'string' ? row.tracking : null,
    ahead: typeof row.ahead === 'number' ? row.ahead : 0,
    behind: typeof row.behind === 'number' ? row.behind : 0,
    files,
    isClean: row.isClean === true || files.length === 0,
    oversized: row.oversized === true,
  };
};

export async function loadGitStatus(
  active: ActiveRuntime,
  directory: string,
  options?: { mode?: 'light'; signal?: AbortSignal },
): Promise<GitStatus> {
  const path = withDirectory('/api/git/status', directory, {
    mode: options?.mode,
  });
  const response = await openchamberFetch(active, path, {
    method: 'GET',
    signal: options?.signal,
  });
  if (!response.ok) {
    throw new GitChangesApiError(`git.status failed (${response.status})`, response.status);
  }
  return parseGitStatus(await response.json());
}

export async function loadGitFileDiff(
  active: ActiveRuntime,
  directory: string,
  filePath: string,
  options?: { staged?: boolean; signal?: AbortSignal },
): Promise<GitFileDiff> {
  const path = withDirectory('/api/git/file-diff', directory, {
    path: filePath,
    staged: options?.staged ? 'true' : undefined,
  });
  const response = await openchamberFetch(active, path, {
    method: 'GET',
    signal: options?.signal,
  });
  if (!response.ok) {
    throw new GitChangesApiError(`git.file-diff failed (${response.status})`, response.status);
  }
  const row = asRecord(await response.json()) ?? {};
  return {
    original: typeof row.original === 'string' ? row.original : '',
    modified: typeof row.modified === 'string' ? row.modified : '',
    path: typeof row.path === 'string' ? row.path : filePath,
    isBinary: row.isBinary === true,
  };
}

export const isStagedGitFile = (file: GitStatusFile): boolean => {
  const indexStatus = file.index?.trim();
  return Boolean(indexStatus && indexStatus !== '?');
};

export const isUnstagedGitFile = (file: GitStatusFile): boolean => {
  const workingStatus = file.working_dir?.trim();
  const indexStatus = file.index?.trim();
  return Boolean(workingStatus || indexStatus === '?');
};

/** Build a simple unified-ish text preview from original/modified (no Pierre). */
export const buildSimpleDiffText = (diff: GitFileDiff): string => {
  if (diff.isBinary) return '(binary file)';
  const originalLines = diff.original.split('\n');
  const modifiedLines = diff.modified.split('\n');
  if (originalLines.join('\n') === modifiedLines.join('\n')) return '(no textual changes)';
  const max = Math.max(originalLines.length, modifiedLines.length);
  const out: string[] = [];
  for (let i = 0; i < max; i += 1) {
    const a = originalLines[i];
    const b = modifiedLines[i];
    if (a === b) {
      if (a != null) out.push(` ${a}`);
      continue;
    }
    if (a != null) out.push(`-${a}`);
    if (b != null) out.push(`+${b}`);
  }
  const text = out.join('\n');
  return text.length > 80_000 ? `${text.slice(0, 80_000)}\n…` : text;
};
