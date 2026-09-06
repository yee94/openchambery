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

/** Deep-link / chat-header row from GET /api/openchamber/session-index/session/:id. */
export type SessionIndexLookupHit = {
  id: string;
  directory: string;
  title?: string;
  parentID?: string | null;
  branch?: string | null;
  assistantID?: string | null;
  assistantName?: string | null;
};

export type SessionIndexSessionHit = SessionIndexSession & {
  directory: string;
};

/** Find a session row inside an already-loaded snapshot (O(dirs × sessions)). */
export const findSessionInIndexSnapshot = (
  snapshot: SessionIndexSnapshot,
  sessionId: string,
): SessionIndexSessionHit | null => {
  const id = sessionId.trim();
  if (!id) return null;
  for (const dir of snapshot.directories) {
    const directory = typeof dir.directory === 'string' ? dir.directory : '';
    for (const session of dir.sessions) {
      if (session.id !== id) continue;
      return {
        ...session,
        directory:
          (typeof session.directory === 'string' && session.directory) ||
          (typeof session.project?.worktree === 'string' && session.project.worktree) ||
          directory,
      };
    }
  }
  return null;
};

const parseLookupHit = (payload: unknown, fallbackId: string): SessionIndexLookupHit | null => {
  const record = asRecord(payload);
  if (!record || record.available !== true) return null;
  const session = asRecord(record.session);
  if (!session) return null;
  const directory =
    typeof session.directory === 'string' ? session.directory.trim() : '';
  if (!directory) return null;
  const id = typeof session.id === 'string' && session.id ? session.id : fallbackId;
  const project = asRecord(session.project);
  return {
    id,
    directory,
    title: typeof session.title === 'string' ? session.title : undefined,
    parentID: (session.parentID as string | null | undefined) ?? null,
    branch:
      typeof session.branch === 'string'
        ? session.branch
        : typeof project?.branch === 'string'
          ? project.branch
          : null,
    assistantID: typeof session.assistantID === 'string' ? session.assistantID : null,
    assistantName: typeof session.assistantName === 'string' ? session.assistantName : null,
  };
};

/**
 * Live GET /api/openchamber/session-index/session/:id (Cap deep-link lookup).
 * 404 / 501 → null. Other HTTP failures throw SessionIndexError.
 */
export const lookupSessionIndexById = async (
  active: ActiveRuntime,
  sessionId: string,
  options?: { signal?: AbortSignal },
): Promise<SessionIndexLookupHit | null> => {
  const id = sessionId.trim();
  if (!id) return null;
  let response;
  try {
    response = await openchamberFetch(
      active,
      `/api/openchamber/session-index/session/${encodeURIComponent(id)}`,
      { method: 'GET', signal: options?.signal },
    );
  } catch (error) {
    throw new SessionIndexError(
      error instanceof Error ? error.message : 'session index lookup failed',
      null,
    );
  }
  if (response.status === 404 || response.status === 501) return null;
  if (!response.ok) {
    throw new SessionIndexError(`session index lookup failed (${response.status})`, response.status);
  }
  const payload = await response.json();
  return parseLookupHit(payload, id);
};

/** Minimal OpenCode session GET payload used for chat header title fallback. */
export type SessionGetHit = {
  id: string;
  title?: string;
  directory?: string | null;
  branch?: string | null;
};

/**
 * Live GET /api/session/:id — Cap session.get last resort when index misses the row.
 * 404 → null. Other HTTP failures throw SessionIndexError (shared transport error type).
 */
export const loadSessionGet = async (
  active: ActiveRuntime,
  sessionId: string,
  options?: { directory?: string | null; signal?: AbortSignal },
): Promise<SessionGetHit | null> => {
  const id = sessionId.trim();
  if (!id) return null;
  const params = new URLSearchParams();
  if (options?.directory) params.set('directory', options.directory);
  const qs = params.toString();
  const path = `/api/session/${encodeURIComponent(id)}${qs ? `?${qs}` : ''}`;
  let response;
  try {
    response = await openchamberFetch(active, path, {
      method: 'GET',
      signal: options?.signal,
    });
  } catch (error) {
    throw new SessionIndexError(
      error instanceof Error ? error.message : 'session get failed',
      null,
    );
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new SessionIndexError(`session get failed (${response.status})`, response.status);
  }
  const payload = await response.json();
  const record = asRecord(payload) ?? asRecord(asRecord(payload)?.data);
  if (!record) return null;
  const sid = typeof record.id === 'string' && record.id ? record.id : id;
  const project = asRecord(record.project);
  return {
    id: sid,
    title: typeof record.title === 'string' ? record.title : undefined,
    directory: typeof record.directory === 'string' ? record.directory : options?.directory ?? null,
    branch: typeof project?.branch === 'string' ? project.branch : null,
  };
};
