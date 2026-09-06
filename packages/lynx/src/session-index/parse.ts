import type { SessionIndexSnapshot } from './types';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

const isSessionIndexSync = (value: unknown): value is SessionIndexSnapshot['sync'] => {
  if (!isRecord(value)) return false;
  if (typeof value.active !== 'boolean') return false;
  if (typeof value.completed !== 'number' || !Number.isFinite(value.completed)) return false;
  if (typeof value.total !== 'number' || !Number.isFinite(value.total)) return false;
  if (!isStringArray(value.pendingDirectories)) return false;
  if (!isStringArray(value.completedDirectories)) return false;
  if (!isStringArray(value.failedDirectories)) return false;
  if (value.enriching !== undefined && typeof value.enriching !== 'boolean') return false;
  return true;
};

const isSessionIndexSession = (value: unknown): boolean => (
  isRecord(value)
  && typeof value.id === 'string'
  && value.id.length > 0
  && typeof value.title === 'string'
  && typeof value.directory === 'string'
  && value.directory.length > 0
  && isRecord(value.time)
  && typeof value.time.created === 'number'
  && Number.isFinite(value.time.created)
  && typeof value.time.updated === 'number'
  && Number.isFinite(value.time.updated)
);

const isSessionIndexDirectory = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  if (typeof value.directory !== 'string' || !value.directory.trim()) return false;
  if (value.cursor !== null && (typeof value.cursor !== 'number' || !Number.isFinite(value.cursor))) return false;
  if (typeof value.hasMore !== 'boolean') return false;
  if (typeof value.lastSyncedAt !== 'number' || !Number.isFinite(value.lastSyncedAt)) return false;
  if (typeof value.lastFullSyncedAt !== 'number' || !Number.isFinite(value.lastFullSyncedAt)) return false;
  if (typeof value.lastAccessedAt !== 'number' || !Number.isFinite(value.lastAccessedAt)) return false;
  return Array.isArray(value.sessions) && value.sessions.every(isSessionIndexSession);
};

export const isSessionIndexSnapshot = (value: unknown): value is SessionIndexSnapshot => {
  if (!isRecord(value)) return false;
  if (typeof value.revision !== 'number' || !Number.isFinite(value.revision)) return false;
  if (!isSessionIndexSync(value.sync)) return false;
  if (!Array.isArray(value.directories)) return false;
  if (value.pinnedSessionIds !== undefined && !isStringArray(value.pinnedSessionIds)) return false;
  return value.directories.every(isSessionIndexDirectory);
};

export const parseSessionIndexSnapshot = (
  payload: Partial<SessionIndexSnapshot> & { available?: boolean },
): SessionIndexSnapshot | null => {
  if (payload.available !== true || !Array.isArray(payload.directories)) return null;
  const pinnedSessionIds = Array.isArray(payload.pinnedSessionIds)
    ? payload.pinnedSessionIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : undefined;
  const snapshot = {
    revision: typeof payload.revision === 'number' ? payload.revision : 0,
    sync: payload.sync ?? {
      active: false,
      completed: 0,
      total: 0,
      pendingDirectories: [],
      completedDirectories: [],
      failedDirectories: [],
      enriching: false,
    },
    directories: payload.directories,
    ...(pinnedSessionIds ? { pinnedSessionIds } : {}),
  };
  return isSessionIndexSnapshot(snapshot) ? snapshot : null;
};
