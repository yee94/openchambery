import type { LynxKvStore } from '../connection/types';
import { isSessionIndexSnapshot } from './parse';
import type { SessionIndexSnapshot } from './types';

const CACHE_VERSION = 1;
const STORAGE_KEY = 'oc.sessionIndexStartupCache';
const MAX_RUNTIME_ENTRIES = 8;
const MAX_CACHE_BYTES = 1_000_000;

type SessionIndexCache = {
  version: 1;
  entries: Record<string, SessionIndexSnapshot>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const parseCache = (raw: string | null): SessionIndexCache | null => {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== CACHE_VERSION || !isRecord(parsed.entries)) return null;
    return { version: CACHE_VERSION, entries: parsed.entries as Record<string, SessionIndexSnapshot> };
  } catch {
    return null;
  }
};

export const readSessionIndexStartupSnapshot = (
  runtimeKey: string,
  storage: LynxKvStore,
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

export const writeSessionIndexStartupSnapshot = (
  runtimeKey: string,
  snapshot: SessionIndexSnapshot,
  storage: LynxKvStore,
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
  try {
    const serialized = JSON.stringify({ version: CACHE_VERSION, entries: retainedEntries });
    if (serialized.length > MAX_CACHE_BYTES) return;
    storage.setItem(STORAGE_KEY, serialized);
  } catch {
    // Cold-start cache is optional; live fetch result is authoritative.
  }
};
