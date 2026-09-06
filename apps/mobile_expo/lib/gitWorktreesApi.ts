import type { ActiveRuntime } from '@/lib/connectionController';
import { openchamberFetch } from '@/lib/openchamberClient';

export type GitWorktreeInfo = {
  head: string;
  name: string;
  branch: string;
  path: string;
};

export type CreateGitWorktreePayload = {
  mode?: 'new' | 'existing';
  worktreeName?: string;
  name?: string;
  branchName?: string;
  existingBranch?: string;
  startRef?: string;
  startCommand?: string;
  setUpstream?: boolean;
  upstreamRemote?: string;
  upstreamBranch?: string;
  returnAfterDirectoryCreated?: boolean;
};

export type GitWorktreeCreateResult = {
  head: string;
  name: string;
  branch: string;
  path: string;
  directoryCreated?: boolean;
};

export type RemoveGitWorktreePayload = {
  directory: string;
  deleteLocalBranch?: boolean;
};

export class GitWorktreesApiError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'GitWorktreesApiError';
    this.status = status;
  }
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

const withDirectory = (path: string, directory: string): string => {
  const params = new URLSearchParams({ directory });
  return `${path}?${params.toString()}`;
};

const parseWorktree = (value: unknown): GitWorktreeInfo | null => {
  const row = asRecord(value);
  if (!row || typeof row.path !== 'string' || !row.path) return null;
  return {
    head: typeof row.head === 'string' ? row.head : '',
    name: typeof row.name === 'string' ? row.name : '',
    branch: typeof row.branch === 'string' ? row.branch : '',
    path: row.path,
  };
};

/** GET /api/git/worktrees?directory= */
export const listGitWorktrees = async (
  active: ActiveRuntime,
  directory: string,
  options?: { signal?: AbortSignal },
): Promise<GitWorktreeInfo[]> => {
  const response = await openchamberFetch(active, withDirectory('/api/git/worktrees', directory), {
    method: 'GET',
    signal: options?.signal,
  });
  if (!response.ok) {
    const payload = asRecord(await response.json());
    throw new GitWorktreesApiError(
      typeof payload?.error === 'string' ? payload.error : 'Failed to list worktrees',
      response.status,
    );
  }
  const payload = await response.json();
  if (!Array.isArray(payload)) return [];
  return payload.flatMap((entry) => {
    const parsed = parseWorktree(entry);
    return parsed ? [parsed] : [];
  });
};

/** POST /api/git/worktrees?directory= — essentials create. */
export const createGitWorktree = async (
  active: ActiveRuntime,
  directory: string,
  payload: CreateGitWorktreePayload,
  options?: { signal?: AbortSignal },
): Promise<GitWorktreeCreateResult> => {
  const response = await openchamberFetch(active, withDirectory('/api/git/worktrees', directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload ?? {}),
    signal: options?.signal,
  });
  const body = asRecord(await response.json());
  if (!response.ok) {
    // Cap may return 503 message_queue_activation_pending with a created worktree.
    if (response.status === 503 && body?.code === 'message_queue_activation_pending') {
      const worktree = parseWorktree(body.worktree);
      if (worktree) {
        return {
          head: worktree.head,
          name: worktree.name,
          branch: worktree.branch,
          path: worktree.path,
        };
      }
    }
    throw new GitWorktreesApiError(
      typeof body?.error === 'string' ? body.error : 'Failed to create worktree',
      response.status,
    );
  }
  const worktree = parseWorktree(body);
  if (!worktree) {
    throw new GitWorktreesApiError('Malformed worktree create response', response.status);
  }
  return {
    head: worktree.head,
    name: worktree.name,
    branch: worktree.branch,
    path: worktree.path,
    directoryCreated: body?.directoryCreated === true,
  };
};

/** DELETE /api/git/worktrees?directory= */
export const deleteGitWorktree = async (
  active: ActiveRuntime,
  directory: string,
  payload: RemoveGitWorktreePayload,
  options?: { signal?: AbortSignal },
): Promise<{ success: boolean }> => {
  const response = await openchamberFetch(active, withDirectory('/api/git/worktrees', directory), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload ?? {}),
    signal: options?.signal,
  });
  if (!response.ok) {
    const body = asRecord(await response.json());
    throw new GitWorktreesApiError(
      typeof body?.error === 'string' ? body.error : 'Failed to delete worktree',
      response.status,
    );
  }
  const body = asRecord(await response.json());
  return { success: body?.success !== false };
};

/** GET /api/git/check?directory= */
export const checkIsGitRepository = async (
  active: ActiveRuntime,
  directory: string,
  options?: { signal?: AbortSignal },
): Promise<boolean> => {
  const response = await openchamberFetch(active, withDirectory('/api/git/check', directory), {
    method: 'GET',
    signal: options?.signal,
  });
  if (!response.ok) return false;
  const body = asRecord(await response.json());
  return body?.isGitRepository === true || body?.ok === true || body?.isRepo === true;
};
