import type { Session } from '@opencode-ai/sdk/v2';

import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { runtimeFetch } from './runtime-fetch';

export type SessionIndexDirectory = {
  directory: string;
  cursor: number | null;
  hasMore: boolean;
  lastSyncedAt: number;
  lastFullSyncedAt: number;
  lastAccessedAt: number;
  sessions: Array<Session & { hasChildren?: boolean }>;
};

export type SessionIndexSnapshot = {
  revision: number;
  sync: {
    active: boolean;
    completed: number;
    total: number;
    pendingDirectories: string[];
    completedDirectories: string[];
    failedDirectories: string[];
    /** Low-priority child-session existence checks still running after root rows are ready. */
    enriching?: boolean;
  };
  directories: SessionIndexDirectory[];
};

/** Coalesce dense revision tips before the next full snapshot GET. */
const SESSION_INDEX_TIP_DEBOUNCE_MS = 100;
/**
 * Hang-break for tip waits: a completed background sync can publish its final
 * tip between POST /sync returning and the consumer attaching a tip listener.
 * Re-GET the authoritative snapshot on this timeout so manual / startup sync
 * cannot sit forever on a missed tip.
 */
const SESSION_INDEX_SAFETY_TIMEOUT_MS = 1_500;

const ensureOk = async (response: Response): Promise<void> => {
  if (response.ok) return;
  throw new Error(`session index request failed (${response.status})`);
};

const parseSessionIndexSnapshot = (payload: Partial<SessionIndexSnapshot> & { available?: boolean }): SessionIndexSnapshot | null => {
  if (payload.available !== true || !Array.isArray(payload.directories)) return null;
  return {
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
  };
};

let sessionIndexSnapshotInflight: Promise<SessionIndexSnapshot | null> | undefined;

/**
 * Authoritative session-index GET. Concurrent callers share one in-flight request
 * so hydrate + tip consumers cannot fan out identical snapshots.
 */
export const loadSessionIndexSnapshot = async (): Promise<SessionIndexSnapshot | null> => {
  if (typeof window === 'undefined') return null;
  if (sessionIndexSnapshotInflight) return sessionIndexSnapshotInflight;
  const flight = (async (): Promise<SessionIndexSnapshot | null> => {
    const response = await runtimeFetch('/api/openchamber/session-index');
    if (response.status === 501) return null;
    await ensureOk(response);
    const payload = await response.json() as Partial<SessionIndexSnapshot> & { available?: boolean };
    return parseSessionIndexSnapshot(payload);
  })();
  // Clear by the shared promise identity (the finally-wrapped handle), not the raw flight.
  const shared = flight.finally(() => {
    if (sessionIndexSnapshotInflight === shared) sessionIndexSnapshotInflight = undefined;
  });
  sessionIndexSnapshotInflight = shared;
  return shared;
};

export const startSessionIndexBackgroundSync = async (
  directories: string[],
): Promise<SessionIndexSnapshot | null> => {
  if (typeof window === 'undefined') return null;
  const response = await runtimeFetch('/api/openchamber/session-index/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ directories }),
  });
  if (response.status === 501) return null;
  await ensureOk(response);
  return response.json() as Promise<SessionIndexSnapshot>;
};

/**
 * Wait until a session-index tip arrives with revision > afterRevision, or the
 * OpenChamber event stream becomes ready (reconnect repair), or the signal aborts.
 *
 * Dense revision tips (server enrich/sync) are debounced so consumers issue one
 * snapshot GET after the tip burst settles instead of one GET per tip.
 *
 * `safetyTimeoutMs` is a hang-break for the race where the server finishes and
 * publishes tips between POST /sync returning and this subscription attaching.
 * Consumers treat `'timeout'` like a tip: GET the authoritative snapshot and
 * continue. Tips still win when they arrive first.
 */
export const waitForSessionIndexInvalidation = (
  afterRevision: number,
  signal: AbortSignal,
  options?: { safetyTimeoutMs?: number },
): Promise<'tip' | 'ready' | 'aborted' | 'timeout'> => new Promise((resolve) => {
  if (signal.aborted) {
    resolve('aborted');
    return;
  }
  const safetyTimeoutMs = typeof options?.safetyTimeoutMs === 'number' && options.safetyTimeoutMs > 0
    ? options.safetyTimeoutMs
    : SESSION_INDEX_SAFETY_TIMEOUT_MS;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let safetyTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingReason: 'tip' | 'ready' | undefined;
  const finish = (reason: 'tip' | 'ready' | 'aborted' | 'timeout') => {
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    if (safetyTimer !== undefined) clearTimeout(safetyTimer);
    unsubscribe();
    signal.removeEventListener('abort', onAbort);
    resolve(reason);
  };
  const schedule = (reason: 'tip' | 'ready') => {
    pendingReason = reason;
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      finish(pendingReason ?? reason);
    }, SESSION_INDEX_TIP_DEBOUNCE_MS);
  };
  const onAbort = () => finish('aborted');
  const unsubscribe = subscribeOpenchamberEvents((event) => {
    if (event.type === 'event-stream-ready') {
      // Reconnect repair: coalesce with any in-flight tip burst, otherwise wait
      // the same quiet window so a ready edge mid-sync does not force an extra GET.
      schedule('ready');
      return;
    }
    if (event.type === 'session-index-changed' && event.revision > afterRevision) {
      schedule('tip');
      return;
    }
  });
  signal.addEventListener('abort', onAbort, { once: true });
  safetyTimer = setTimeout(() => finish('timeout'), safetyTimeoutMs);
});

export const persistSessionIndexDirectory = async (input: {
  directory: string;
  sessions: Session[];
  cursor: number | null;
  hasMore: boolean;
  fullSync?: boolean;
}): Promise<void> => {
  if (typeof window === 'undefined') return;
  const response = await runtimeFetch('/api/openchamber/session-index/directory', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (response.status === 501) return;
  await ensureOk(response);
};

export const persistSessionIndexDirectories = async (directories: Array<{
  directory: string;
  sessions: Session[];
  cursor: number | null;
  hasMore: boolean;
  fullSync?: boolean;
}>): Promise<void> => {
  if (typeof window === 'undefined' || directories.length === 0) return;
  const response = await runtimeFetch('/api/openchamber/session-index/snapshot', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ directories }),
  });
  if (response.status === 501) return;
  await ensureOk(response);
};
