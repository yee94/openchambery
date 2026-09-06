import type { ActiveRuntime } from '@/lib/connectionController';
import { openchamberFetch } from '@/lib/openchamberClient';
import { normalizePath } from '@/lib/sessionHomeModel';

export type WorktreeOrder = {
  projectDirectory: string;
  orderedPaths: string[];
  revision: number;
};

export class WorktreeOrderApiError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'WorktreeOrderApiError';
    this.status = status;
  }
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

export const parseWorktreeOrder = (value: unknown): WorktreeOrder | null => {
  const row = asRecord(value);
  if (!row || typeof row.projectDirectory !== 'string') return null;
  if (!Array.isArray(row.orderedPaths)) return null;
  const orderedPaths = row.orderedPaths.filter((p): p is string => typeof p === 'string');
  const revision = typeof row.revision === 'number' ? row.revision : 0;
  return {
    projectDirectory: normalizePath(row.projectDirectory),
    orderedPaths: orderedPaths.map(normalizePath),
    revision,
  };
};

/** GET /api/openchamber/message-queue/worktrees/order?projectDirectory= */
export const fetchWorktreeOrder = async (
  active: ActiveRuntime,
  projectDirectory: string,
  options?: { signal?: AbortSignal },
): Promise<WorktreeOrder | null> => {
  const params = new URLSearchParams({ projectDirectory });
  const response = await openchamberFetch(
    active,
    `/api/openchamber/message-queue/worktrees/order?${params.toString()}`,
    { method: 'GET', signal: options?.signal },
  );
  if (response.status === 501 || response.status === 404) return null;
  if (!response.ok) {
    throw new WorktreeOrderApiError('Failed to fetch worktree order', response.status);
  }
  return parseWorktreeOrder(await response.json());
};

/** PUT /api/openchamber/message-queue/worktrees/order */
export const setWorktreeOrder = async (
  active: ActiveRuntime,
  input: {
    requestID: string;
    projectDirectory: string;
    expectedRevision: number;
    orderedPaths: string[];
  },
  options?: { signal?: AbortSignal },
): Promise<{ revision: number; worktreeOrder?: WorktreeOrder }> => {
  const response = await openchamberFetch(
    active,
    '/api/openchamber/message-queue/worktrees/order',
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(input),
      signal: options?.signal,
    },
  );
  if (!response.ok) {
    throw new WorktreeOrderApiError('Failed to set worktree order', response.status);
  }
  const payload = asRecord(await response.json());
  const revision = typeof payload?.revision === 'number' ? payload.revision : input.expectedRevision + 1;
  const worktreeOrder = payload?.worktreeOrder ? parseWorktreeOrder(payload.worktreeOrder) : undefined;
  return { revision, ...(worktreeOrder ? { worktreeOrder } : {}) };
};

/** Cap `orderWorktrees` — stable display order for secondary worktrees. */
export const orderWorktrees = <T extends { path: string }>(
  orderedPaths: string[] | undefined,
  worktrees: T[],
): T[] => {
  if (!orderedPaths || orderedPaths.length === 0) return worktrees;
  const rank = new Map(orderedPaths.map((path, index) => [normalizePath(path), index] as const));
  return worktrees
    .map((worktree, index) => ({ worktree, index }))
    .sort((left, right) => {
      const byRank =
        (rank.get(normalizePath(left.worktree.path)) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(normalizePath(right.worktree.path)) ?? Number.MAX_SAFE_INTEGER);
      return byRank || left.index - right.index;
    })
    .map((entry) => entry.worktree);
};
