import type { ActiveRuntime } from '@/lib/connectionController';
import { openchamberFetch } from '@/lib/openchamberClient';

/** Minimal session row from GET /api/openchamber/session-index. */
export type SessionIndexSession = {
  id: string;
  title?: string;
  parentID?: string | null;
  directory?: string | null;
  time?: {
    created?: number | string | null;
    updated?: number | string | null;
    archived?: number | string | null;
    pinned?: string | number | null;
  };
  project?: {
    worktree?: string | null;
    branch?: string | null;
  } | null;
};

export type SessionIndexDirectory = {
  directory: string;
  cursor: number | null;
  hasMore: boolean;
  sessions: SessionIndexSession[];
};

export type SessionIndexSnapshot = {
  revision: number;
  available: true;
  sync: {
    active: boolean;
    completed: number;
    total: number;
    pendingDirectories: string[];
    completedDirectories: string[];
    failedDirectories: string[];
    enriching?: boolean;
  };
  directories: SessionIndexDirectory[];
  pinnedSessionIds?: string[];
};

export class SessionIndexError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'SessionIndexError';
    this.status = status;
  }
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

const asSessions = (value: unknown): SessionIndexSession[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const row = asRecord(entry);
    if (!row || typeof row.id !== 'string' || !row.id) return [];
    const time = asRecord(row.time) ?? undefined;
    const project = asRecord(row.project);
    return [
      {
        id: row.id,
        title: typeof row.title === 'string' ? row.title : undefined,
        parentID: (row.parentID as string | null | undefined) ?? null,
        directory: typeof row.directory === 'string' ? row.directory : undefined,
        time: time
          ? {
              created: (time.created as number | string | null | undefined) ?? null,
              updated: (time.updated as number | string | null | undefined) ?? null,
              archived: (time.archived as number | string | null | undefined) ?? null,
              pinned: (time.pinned as string | number | null | undefined) ?? null,
            }
          : undefined,
        project: project
          ? {
              worktree: typeof project.worktree === 'string' ? project.worktree : null,
              branch: typeof project.branch === 'string' ? project.branch : null,
            }
          : null,
      },
    ];
  });
};

/** Cap-compatible parse. `available !== true` or missing directories → null (unsupported), not empty success. */
export const parseSessionIndexSnapshot = (payload: unknown): SessionIndexSnapshot | null => {
  const record = asRecord(payload);
  if (!record || record.available !== true || !Array.isArray(record.directories)) return null;
  const pinnedSessionIds = Array.isArray(record.pinnedSessionIds)
    ? record.pinnedSessionIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : undefined;
  const syncRecord = asRecord(record.sync);
  return {
    available: true,
    revision: typeof record.revision === 'number' ? record.revision : 0,
    sync: {
      active: syncRecord?.active === true,
      completed: typeof syncRecord?.completed === 'number' ? syncRecord.completed : 0,
      total: typeof syncRecord?.total === 'number' ? syncRecord.total : 0,
      pendingDirectories: Array.isArray(syncRecord?.pendingDirectories)
        ? syncRecord.pendingDirectories.filter((d): d is string => typeof d === 'string')
        : [],
      completedDirectories: Array.isArray(syncRecord?.completedDirectories)
        ? syncRecord.completedDirectories.filter((d): d is string => typeof d === 'string')
        : [],
      failedDirectories: Array.isArray(syncRecord?.failedDirectories)
        ? syncRecord.failedDirectories.filter((d): d is string => typeof d === 'string')
        : [],
      enriching: syncRecord?.enriching === true,
    },
    directories: record.directories.flatMap((entry) => {
      const dir = asRecord(entry);
      if (!dir || typeof dir.directory !== 'string') return [];
      return [
        {
          directory: dir.directory,
          cursor: typeof dir.cursor === 'number' ? dir.cursor : null,
          hasMore: dir.hasMore === true,
          sessions: asSessions(dir.sessions),
        },
      ];
    }),
    ...(pinnedSessionIds ? { pinnedSessionIds } : {}),
  };
};

/**
 * Live GET /api/openchamber/session-index.
 * HTTP / transport failure throws SessionIndexError (UI must not paint empty success).
 * 501 / available≠true returns null (capability unsupported).
 */
export const loadSessionIndexSnapshot = async (
  active: ActiveRuntime,
  options?: { signal?: AbortSignal },
): Promise<SessionIndexSnapshot | null> => {
  let response;
  try {
    response = await openchamberFetch(active, '/api/openchamber/session-index', {
      method: 'GET',
      signal: options?.signal,
    });
  } catch (error) {
    throw new SessionIndexError(
      error instanceof Error ? error.message : 'session index request failed',
      null,
    );
  }
  if (response.status === 501) return null;
  if (!response.ok) {
    throw new SessionIndexError(`session index request failed (${response.status})`, response.status);
  }
  const payload = await response.json();
  return parseSessionIndexSnapshot(payload);
};
