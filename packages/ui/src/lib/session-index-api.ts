import type { Session } from '@opencode-ai/sdk/v2';

import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { runtimeFetch } from './runtime-fetch';

/** Session-index summary row. `time.pinned` is ISO/null (null or absent = unpinned). */
export type SessionIndexSession = Session & {
  hasChildren?: boolean;
  time: Session['time'] & {
    pinned?: string | number | null;
  };
};

export type SessionIndexDirectory = {
  directory: string;
  cursor: number | null;
  hasMore: boolean;
  lastSyncedAt: number;
  lastFullSyncedAt: number;
  lastAccessedAt: number;
  sessions: SessionIndexSession[];
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
  /**
   * Authoritative pin membership. Survives the newest-20 summary bound, so a
   * pinned id may be absent from `directories[].sessions`.
   */
  pinnedSessionIds?: string[];
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
  const pinnedSessionIds = Array.isArray(payload.pinnedSessionIds)
    ? payload.pinnedSessionIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : undefined;
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
    ...(pinnedSessionIds ? { pinnedSessionIds } : {}),
  };
};

let sessionIndexSnapshotInflight: Promise<SessionIndexSnapshot | null> | undefined;

/**
 * Authoritative session-index GET. Concurrent callers share one in-flight request
 * so hydrate + tip consumers cannot fan out identical snapshots.
 */
export type SessionIndexLookupHit = {
  id: string;
  directory: string;
  title?: string;
  parentID?: string | null;
};

/**
 * Resolve a session's workspace directory by id from the server index.
 * Used when the in-memory sidebar list has not hydrated the row yet (deep links).
 */
export const lookupSessionIndexById = async (
  sessionId: string,
  options?: { signal?: AbortSignal },
): Promise<SessionIndexLookupHit | null> => {
  if (typeof window === 'undefined') return null;
  const id = sessionId.trim();
  if (!id) return null;
  try {
    const response = await runtimeFetch(
      `/api/openchamber/session-index/session/${encodeURIComponent(id)}`,
      { signal: options?.signal },
    );
    if (response.status === 404 || response.status === 501) return null;
    await ensureOk(response);
    const payload = await response.json() as {
      available?: boolean;
      session?: { id?: string; directory?: string; title?: string; parentID?: string | null };
    };
    if (payload.available !== true || !payload.session) return null;
    const directory = typeof payload.session.directory === 'string'
      ? payload.session.directory.trim()
      : '';
    const sid = typeof payload.session.id === 'string' ? payload.session.id : id;
    if (!directory) return null;
    return {
      id: sid,
      directory,
      title: typeof payload.session.title === 'string' ? payload.session.title : undefined,
      parentID: payload.session.parentID ?? null,
    };
  } catch {
    return null;
  }
};

export const loadSessionIndexSnapshot = async (
  options?: { signal?: AbortSignal },
): Promise<SessionIndexSnapshot | null> => {
  if (typeof window === 'undefined') return null;
  if (sessionIndexSnapshotInflight) return sessionIndexSnapshotInflight;
  const flight = (async (): Promise<SessionIndexSnapshot | null> => {
    const response = await runtimeFetch('/api/openchamber/session-index', {
      signal: options?.signal,
    });
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
 *
 * Pass `safetyTimeoutMs: null` to disable the hang-break and wait purely on
 * tips, stream-ready edges, or abort. A long-lived observer that re-enters this
 * wait after every resolution turns the hang-break into a fixed-interval poll,
 * so callers that keep watching an idle index must opt out — there is no
 * pending tip to rescue, and each timeout costs a full snapshot GET plus the
 * sidebar re-render it triggers.
 */
export const waitForSessionIndexInvalidation = (
  afterRevision: number,
  signal: AbortSignal,
  options?: { safetyTimeoutMs?: number | null },
): Promise<'tip' | 'ready' | 'aborted' | 'timeout'> => new Promise((resolve) => {
  if (signal.aborted) {
    resolve('aborted');
    return;
  }
  const safetyTimeoutMs = options?.safetyTimeoutMs === null
    ? null
    : typeof options?.safetyTimeoutMs === 'number' && options.safetyTimeoutMs > 0
      ? options.safetyTimeoutMs
      : SESSION_INDEX_SAFETY_TIMEOUT_MS;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
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
  const safetyTimer = safetyTimeoutMs === null
    ? undefined
    : setTimeout(() => finish('timeout'), safetyTimeoutMs);
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
});

/**
 * Pin a session in the server session-index.
 * 404 = pin rejected; 501 = capability unsupported.
 */
export const pinSession = async (
  sessionId: string,
  options?: { signal?: AbortSignal },
): Promise<void> => {
  const id = sessionId.trim();
  if (!id) throw new Error('session index pin requires a session id');
  const response = await runtimeFetch(
    `/api/openchamber/session-index/session/${encodeURIComponent(id)}/pin`,
    { method: 'POST', signal: options?.signal },
  );
  if (response.status === 501) {
    throw new Error('session index pin is unsupported');
  }
  await ensureOk(response);
};

/**
 * Unpin a session in the server session-index.
 * 404 = session not in the index; 501 = capability unsupported.
 */
export const unpinSession = async (
  sessionId: string,
  options?: { signal?: AbortSignal },
): Promise<void> => {
  const id = sessionId.trim();
  if (!id) throw new Error('session index unpin requires a session id');
  const response = await runtimeFetch(
    `/api/openchamber/session-index/session/${encodeURIComponent(id)}/pin`,
    { method: 'DELETE', signal: options?.signal },
  );
  if (response.status === 501) {
    throw new Error('session index unpin is unsupported');
  }
  await ensureOk(response);
};

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
