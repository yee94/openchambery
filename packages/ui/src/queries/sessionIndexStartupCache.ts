import type { SessionIndexSnapshot } from '@/lib/session-index-api';

export type SessionIndexStartupStorage = Pick<Storage, 'getItem' | 'setItem'>;

const CACHE_VERSION = 1;
const STORAGE_KEY = 'oc.sessionIndexStartupCache';
const MAX_RUNTIME_ENTRIES = 8;
const MAX_CACHE_BYTES = 1_000_000;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const isStringArray = (value: unknown): value is string[] => (
  Array.isArray(value) && value.every((entry) => typeof entry === 'string')
);

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
  return value.directories.every(isSessionIndexDirectory);
};

type SessionIndexCache = {
  version: 1;
  entries: Record<string, SessionIndexSnapshot>;
};

const isSessionIndexCache = (value: unknown): value is SessionIndexCache => (
  isRecord(value)
  && value.version === CACHE_VERSION
  && isRecord(value.entries)
);

const parseCache = (raw: string | null): SessionIndexCache | null => {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isSessionIndexCache(parsed)) return null;
    return { version: CACHE_VERSION, entries: parsed.entries as Record<string, SessionIndexSnapshot> };
  } catch {
    return null;
  }
};

const writeCache = (storage: SessionIndexStartupStorage, cache: SessionIndexCache): void => {
  try {
    const serialized = JSON.stringify(cache);
    if (serialized.length > MAX_CACHE_BYTES) return;
    storage.setItem(STORAGE_KEY, serialized);
  } catch {
    // Storage availability does not affect the live Query result.
  }
};

/** Reads a cold-start session-index snapshot scoped by runtimeKey (LAN↔relay share). */
export const readSessionIndexStartupSnapshot = (
  runtimeKey: string,
  storage: SessionIndexStartupStorage,
): SessionIndexSnapshot | null => {
  if (!runtimeKey) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  const parsed = parseCache(raw);
  if (!parsed) return null;
  const entry = parsed.entries[runtimeKey];
  return isSessionIndexSnapshot(entry) ? entry : null;
};

/** Persists a successful session-index response under the runtimeKey scope. */
export const writeSessionIndexStartupSnapshot = (
  runtimeKey: string,
  snapshot: SessionIndexSnapshot,
  storage: SessionIndexStartupStorage,
): void => {
  if (!runtimeKey || !isSessionIndexSnapshot(snapshot)) return;
  let raw: string | null = null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return;
  }
  const parsed = parseCache(raw);
  const entries = { ...(parsed?.entries ?? {}), [runtimeKey]: snapshot };
  const retainedKeys = Object.keys(entries).slice(-MAX_RUNTIME_ENTRIES);
  const retainedEntries = Object.fromEntries(
    retainedKeys.map((key) => [key, entries[key]!]),
  ) as Record<string, SessionIndexSnapshot>;
  writeCache(storage, {
    version: CACHE_VERSION,
    entries: retainedEntries,
  });
};
