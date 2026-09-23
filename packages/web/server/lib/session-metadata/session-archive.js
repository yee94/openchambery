/**
 * Host-owned session archive domain operations.
 *
 * Persists `metadata.openchamber.archive.archivedAt` in the session-metadata
 * store, projects full Session records for HTTP/SSE consumers, and schedules
 * bounded index repair after durable metadata commit when SQLite apply fails.
 */

import {
  isSessionArchived,
  projectSessionWithHostMetadata,
  readHostArchivedAt,
  resolveSessionDirectory,
} from './session-projection.js';

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeDirectory = (value) => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized || null;
};

/** Bounded backoff for index repair and metadata cleanup (ms). */
const REPAIR_DELAYS_MS = [250, 750, 1_500, 3_000, 6_000];
const CLEANUP_DELAYS_MS = [200, 600, 1_200, 2_500, 5_000];

export class SessionArchiveError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} [status]
   */
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'SessionArchiveError';
    this.code = code;
    this.status = status;
  }
}

/**
 * @param {object} deps
 * @param {{ setSessionMetadata: Function, get: Function, removeSession?: Function, getSnapshotSync?: Function }} deps.sessionMetadataStore
 * @param {(input: { sessionID: string, directory?: string | null }) => Promise<object | null>} deps.fetchUpstreamSession
 * @param {{ upsert?: Function, upsertAndReportChange?: Function, remove?: Function } | null} [deps.sessionIndexService]
 * @param {(event: { type: string, properties: object }, options?: object) => void} [deps.broadcastSessionEvent]
 * @param {(sessionID: string) => void} [deps.onIndexChanged]
 * @param {() => number} [deps.now]
 * @param {typeof setTimeout} [deps.setTimer]
 * @param {typeof clearTimeout} [deps.clearTimer]
 */
export const createSessionArchiveService = (deps = {}) => {
  const {
    sessionMetadataStore = null,
    fetchUpstreamSession = null,
    sessionIndexService = null,
    broadcastSessionEvent = null,
    onIndexChanged = null,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = deps;

  if (!sessionMetadataStore || typeof sessionMetadataStore.setSessionMetadata !== 'function') {
    throw new Error('createSessionArchiveService requires sessionMetadataStore');
  }
  if (typeof fetchUpstreamSession !== 'function') {
    throw new Error('createSessionArchiveService requires fetchUpstreamSession');
  }

  /**
   * Per-session operation generation. Bumped on every successful Host mutation
   * (archive/unarchive), forget/delete, and stop. In-flight repairs capture the
   * generation at start and abort after await if a newer operation won.
   * @type {Map<string, number>}
   */
  const operationGeneration = new Map();
  /** @type {Map<string, { sessionID: string, directory: string | null, archivedAt: number, generation: number, attempts: number, error?: string, failedAt?: number, timer?: ReturnType<typeof setTimeout> }>} */
  const pendingIndexRepair = new Map();
  /** @type {Map<string, { sessionID: string, attempts: number, error?: string, failedAt?: number, timer?: ReturnType<typeof setTimeout> }>} */
  const pendingCleanup = new Map();
  let stopped = false;

  const getOperationGeneration = (sessionID) => operationGeneration.get(sessionID) ?? 0;

  const bumpOperationGeneration = (sessionID) => {
    const next = getOperationGeneration(sessionID) + 1;
    operationGeneration.set(sessionID, next);
    return next;
  };

  const clearRepairTimer = (entry) => {
    if (entry?.timer) {
      clearTimer(entry.timer);
      entry.timer = undefined;
    }
  };

  /**
   * Invalidate in-flight repair for this session: bump generation + clear timer.
   * Does not delete a *newer* pending that already carries the bumped generation.
   */
  const invalidateSessionRepairs = (sessionID, { clearPending = false } = {}) => {
    const id = asNonEmptyString(sessionID);
    if (!id) return 0;
    const gen = bumpOperationGeneration(id);
    const pending = pendingIndexRepair.get(id);
    if (pending) {
      clearRepairTimer(pending);
      if (clearPending || pending.generation < gen) {
        // Only drop pending when explicitly clearing or it belongs to an older op.
        if (pending.generation < gen) pendingIndexRepair.delete(id);
        else if (clearPending) pendingIndexRepair.delete(id);
      }
    }
    return gen;
  };

  const readHostMetadataSync = (sessionID) => {
    if (typeof sessionMetadataStore.getSnapshotSync === 'function') {
      const snap = sessionMetadataStore.getSnapshotSync();
      if (snap && isPlainObject(snap[sessionID])) return snap[sessionID];
      return null;
    }
    return null;
  };

  const projectSession = (session, hostMetadata = null) => {
    const host = hostMetadata ?? (
      session?.id && typeof sessionMetadataStore.getSnapshotSync === 'function'
        ? readHostMetadataSync(session.id)
        : null
    );
    return projectSessionWithHostMetadata(session, host);
  };

  const applyIndexRows = (projected) => {
    if (!sessionIndexService || !projected?.id) {
      return { ok: true, skipped: true };
    }
    try {
      if (typeof sessionIndexService.upsertAndReportChange === 'function') {
        const changed = sessionIndexService.upsertAndReportChange(projected);
        if (changed && typeof onIndexChanged === 'function') onIndexChanged(projected.id);
      } else if (typeof sessionIndexService.upsert === 'function') {
        sessionIndexService.upsert(projected);
        if (typeof onIndexChanged === 'function') onIndexChanged(projected.id);
      }
      return { ok: true };
    } catch (error) {
      const message = error?.message ?? String(error);
      console.warn('[session-archive] session index update failed after commit:', message);
      return { ok: false, error: message, retryable: true };
    }
  };

  const isRepairStillCurrent = (sessionID, generation) => {
    if (stopped) return false;
    return getOperationGeneration(sessionID) === generation;
  };

  /**
   * Fetch upstream first (may hang), then read the *latest* committed Host
   * snapshot and apply — never use metadata captured before the await.
   * Aborts without writing if generation was superseded (unarchive/delete/stop).
   */
  const rebuildAndApplyIndex = async ({ sessionID, directory, archivedAt, generation }) => {
    const capturedGen = typeof generation === 'number' ? generation : getOperationGeneration(sessionID);

    let upstream = null;
    let fetchError = null;
    try {
      upstream = await fetchUpstreamSession({
        sessionID,
        directory: directory || undefined,
      });
    } catch (error) {
      fetchError = error;
    }

    // Generation check AFTER the hangable await — stale repairs stop here.
    if (!isRepairStillCurrent(sessionID, capturedGen)) {
      return { ok: true, stale: true, projected: null };
    }

    // Latest committed Host authority — after upstream returns.
    let metadata = {};
    try {
      metadata = await sessionMetadataStore.get(sessionID);
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error), retryable: true };
    }
    if (!isRepairStillCurrent(sessionID, capturedGen)) {
      return { ok: true, stale: true, projected: null };
    }

    const hostArchived = readHostArchivedAt(metadata);
    const effectiveArchived = typeof hostArchived === 'number' ? hostArchived : archivedAt;

    if (fetchError) {
      if (Number(fetchError?.status) === 404 || Number(fetchError?.statusCode) === 404) {
        if (typeof effectiveArchived === 'number' && effectiveArchived > 0 && sessionIndexService?.remove) {
          if (!isRepairStillCurrent(sessionID, capturedGen)) {
            return { ok: true, stale: true, projected: null };
          }
          try {
            sessionIndexService.remove(sessionID);
            if (typeof onIndexChanged === 'function') onIndexChanged(sessionID);
            return { ok: true, projected: null };
          } catch (removeError) {
            return { ok: false, error: removeError?.message ?? String(removeError), retryable: true };
          }
        }
        return { ok: true, projected: null };
      }
      return { ok: false, error: fetchError?.message ?? String(fetchError), retryable: true };
    }

    if (!upstream || typeof upstream !== 'object' || upstream.id !== sessionID) {
      return { ok: false, error: 'upstream session unavailable for index repair', retryable: true };
    }

    const projected = projectSessionWithHostMetadata(
      {
        ...upstream,
        directory: resolveSessionDirectory(upstream) || directory || upstream.directory,
      },
      metadata,
    );

    if (!isRepairStillCurrent(sessionID, capturedGen)) {
      return { ok: true, stale: true, projected: null };
    }

    const applied = applyIndexRows(projected);
    if (!isRepairStillCurrent(sessionID, capturedGen)) {
      return { ok: true, stale: true, projected: null };
    }
    return applied.ok
      ? { ok: true, projected }
      : { ok: false, error: applied.error, retryable: true, projected };
  };

  const scheduleIndexRepair = (sessionID, directory, archivedAt, priorError = null, generation = null) => {
    if (stopped) return;
    const id = asNonEmptyString(sessionID);
    if (!id) return;
    const gen = typeof generation === 'number' ? generation : getOperationGeneration(id);
    // A newer mutation already owns this session — do not reschedule an old op.
    if (gen !== getOperationGeneration(id)) return;

    const existing = pendingIndexRepair.get(id);
    if (existing && existing.generation > gen) {
      // Newer repair already pending — leave it alone.
      return;
    }
    if (existing && existing.generation === gen) {
      clearRepairTimer(existing);
    } else if (existing) {
      clearRepairTimer(existing);
    }

    const entry = {
      sessionID: id,
      directory: directory || existing?.directory || null,
      archivedAt,
      generation: gen,
      attempts: existing?.generation === gen ? existing.attempts : 0,
      error: priorError || existing?.error,
      failedAt: now(),
    };
    pendingIndexRepair.set(id, entry);

    if (entry.attempts >= REPAIR_DELAYS_MS.length) {
      console.warn(`[session-archive] index repair exhausted for ${id}: ${entry.error}`);
      return;
    }

    const delay = REPAIR_DELAYS_MS[entry.attempts];
    entry.attempts += 1;
    entry.timer = setTimer(() => {
      entry.timer = undefined;
      return (async () => {
        if (!isRepairStillCurrent(id, gen)) {
          // Only drop pending if it still matches this superseded generation.
          const current = pendingIndexRepair.get(id);
          if (current && current.generation === gen) pendingIndexRepair.delete(id);
          return;
        }
        const result = await rebuildAndApplyIndex(entry);
        if (result.stale) {
          const current = pendingIndexRepair.get(id);
          if (current && current.generation === gen) pendingIndexRepair.delete(id);
          return;
        }
        if (result.ok) {
          const current = pendingIndexRepair.get(id);
          if (current && current.generation === gen) pendingIndexRepair.delete(id);
          return;
        }
        if (!isRepairStillCurrent(id, gen)) return;
        entry.error = result.error;
        entry.failedAt = now();
        scheduleIndexRepair(id, entry.directory, entry.archivedAt, result.error, gen);
      })();
    }, delay);
  };

  const applyIndexAfterCommit = (projected, { directory, archivedAt, generation } = {}) => {
    const gen = typeof generation === 'number' ? generation : getOperationGeneration(projected?.id);
    const result = applyIndexRows(projected);
    if (result.ok) {
      if (projected?.id) {
        const pending = pendingIndexRepair.get(projected.id);
        // Clear only pending belonging to this operation — not a newer repair.
        if (pending && pending.generation === gen) {
          clearRepairTimer(pending);
          pendingIndexRepair.delete(projected.id);
        }
      }
      return { ok: true };
    }
    if (projected?.id) {
      scheduleIndexRepair(
        projected.id,
        directory ?? projected.directory ?? null,
        archivedAt,
        result.error,
        gen,
      );
    }
    return { ok: false, error: result.error, retryable: true };
  };

  const broadcastAfterCommit = (projected) => {
    if (typeof broadcastSessionEvent !== 'function' || !projected?.id) return;
    try {
      broadcastSessionEvent({
        type: 'session.updated',
        properties: {
          info: projected,
          sessionID: projected.id,
        },
      }, {
        directory: typeof projected.directory === 'string' ? projected.directory : undefined,
      });
    } catch (error) {
      console.warn('[session-archive] broadcast failed after commit:', error?.message ?? error);
    }
  };

  /**
   * Manual / status retry: rebuild from latest authority (not stale pending blob).
   */
  const retryIndexUpdate = async (sessionID) => {
    const id = asNonEmptyString(sessionID);
    if (!id) return { ok: false, error: 'session id required' };
    const pending = pendingIndexRepair.get(id);
    const directory = pending?.directory ?? null;
    const archivedAt = pending?.archivedAt ?? 0;
    const gen = pending?.generation ?? getOperationGeneration(id);
    const result = await rebuildAndApplyIndex({
      sessionID: id,
      directory,
      archivedAt,
      generation: gen,
    });
    if (result.stale) return { ok: true, stale: true };
    if (result.ok) {
      const current = pendingIndexRepair.get(id);
      if (current && current.generation === gen) pendingIndexRepair.delete(id);
      return { ok: true };
    }
    scheduleIndexRepair(id, directory, archivedAt, result.error, gen);
    return { ok: false, error: result.error, retryable: true };
  };

  const getIndexRepairStatus = (sessionID) => {
    const id = asNonEmptyString(sessionID);
    if (!id) return null;
    const pending = pendingIndexRepair.get(id);
    if (!pending) return { ok: true, pending: false };
    return {
      ok: false,
      pending: true,
      retryable: pending.attempts < REPAIR_DELAYS_MS.length,
      attempts: pending.attempts,
      error: pending.error,
      failedAt: pending.failedAt,
    };
  };

  const setArchive = async (input = {}) => {
    const sessionID = asNonEmptyString(input.sessionID);
    if (!sessionID) {
      throw new SessionArchiveError('validation_error', 'a session id is required', 400);
    }
    if (typeof input.archivedAt !== 'number' || !Number.isFinite(input.archivedAt)) {
      throw new SessionArchiveError('validation_error', 'archivedAt must be a finite number', 400);
    }
    if (input.archivedAt < 0) {
      throw new SessionArchiveError('validation_error', 'archivedAt must be >= 0', 400);
    }
    const archivedAt = input.archivedAt > 0 ? Math.trunc(input.archivedAt) : 0;
    const directoryHint = normalizeDirectory(input.directory);

    let upstream;
    try {
      upstream = await fetchUpstreamSession({
        sessionID,
        directory: directoryHint,
      });
    } catch (error) {
      const status = Number(error?.status) || Number(error?.statusCode) || 502;
      if (status === 404) {
        throw new SessionArchiveError('not_found', `session ${sessionID} was not found`, 404);
      }
      throw new SessionArchiveError(
        'upstream_error',
        error?.message || 'failed to read upstream session',
        status >= 400 && status < 600 ? status : 502,
      );
    }
    if (!upstream || typeof upstream !== 'object' || typeof upstream.id !== 'string') {
      throw new SessionArchiveError('not_found', `session ${sessionID} was not found`, 404);
    }
    if (upstream.id !== sessionID) {
      throw new SessionArchiveError(
        'id_mismatch',
        'upstream session id does not match the requested session id',
        502,
      );
    }

    const upstreamDirectory = normalizeDirectory(resolveSessionDirectory(upstream));
    if (directoryHint && upstreamDirectory && directoryHint !== upstreamDirectory) {
      throw new SessionArchiveError(
        'directory_mismatch',
        'directory does not match the upstream session',
        403,
      );
    }

    const metadata = await sessionMetadataStore.setSessionMetadata(
      sessionID,
      { openchamber: { archive: { archivedAt } } },
      { allowArchive: true },
    );

    // New Host mutation wins: bump generation and cancel older repair timers
    // without wiping a pending that will be scheduled for *this* generation.
    const gen = bumpOperationGeneration(sessionID);
    const priorPending = pendingIndexRepair.get(sessionID);
    if (priorPending && priorPending.generation < gen) {
      clearRepairTimer(priorPending);
      pendingIndexRepair.delete(sessionID);
    }

    const projected = projectSessionWithHostMetadata(
      {
        ...upstream,
        directory: upstreamDirectory || directoryHint || upstream.directory,
      },
      metadata,
    );

    const index = applyIndexAfterCommit(projected, {
      directory: upstreamDirectory || directoryHint,
      archivedAt,
      generation: gen,
    });
    broadcastAfterCommit(projected);

    return {
      session: projected,
      metadata,
      archivedAt,
      index: index.ok
        ? { ok: true }
        : { ok: false, error: index.error, retryable: true },
    };
  };

  const archiveSession = (sessionID, directory = null, archivedAt = now()) => setArchive({
    sessionID,
    directory: directory ?? undefined,
    archivedAt: typeof archivedAt === 'number' && Number.isFinite(archivedAt) && archivedAt > 0
      ? archivedAt
      : now(),
  });

  const unarchiveSession = (sessionID, directory = null) => setArchive({
    sessionID,
    directory: directory ?? undefined,
    archivedAt: 0,
  });

  const scheduleCleanup = (sessionID, priorError = null) => {
    if (stopped) return;
    const id = asNonEmptyString(sessionID);
    if (!id) return;
    const existing = pendingCleanup.get(id) ?? { sessionID: id, attempts: 0 };
    clearRepairTimer(existing);
    existing.error = priorError || existing.error;
    existing.failedAt = now();
    pendingCleanup.set(id, existing);

    if (existing.attempts >= CLEANUP_DELAYS_MS.length) {
      console.warn(`[session-archive] metadata cleanup exhausted for ${id}: ${existing.error}`);
      return;
    }

    const delay = CLEANUP_DELAYS_MS[existing.attempts];
    existing.attempts += 1;
    existing.timer = setTimer(() => {
      existing.timer = undefined;
      return (async () => {
        if (stopped) return;
        const result = await runCleanupOnce(id);
        if (result.ok) {
          pendingCleanup.delete(id);
          return;
        }
        existing.error = result.error;
        existing.failedAt = now();
        scheduleCleanup(id, result.error);
      })();
    }, delay);
  };

  const runCleanupOnce = async (sessionID) => {
    if (typeof sessionMetadataStore.removeSession !== 'function') {
      return { ok: true, removed: false };
    }
    try {
      const removed = await sessionMetadataStore.removeSession(sessionID);
      pendingIndexRepair.delete(sessionID);
      // false = already absent → idempotent success
      return { ok: true, removed: removed === true };
    } catch (error) {
      const message = error?.message ?? String(error);
      console.warn('[session-archive] metadata cleanup write failed (retryable):', message);
      return { ok: false, error: message, retryable: true };
    }
  };

  /**
   * Idempotent Host metadata cleanup after authoritative session delete.
   * Not-found is success. Write failures schedule bounded retry and return
   * observable retryable status — HTTP delete success is not reversed.
   */
  const forgetSession = async (sessionID) => {
    const id = asNonEmptyString(sessionID);
    if (!id) return { ok: true, removed: false };
    // Supersede any in-flight index repair for this session (late GET must not write).
    invalidateSessionRepairs(id, { clearPending: true });
    const result = await runCleanupOnce(id);
    if (result.ok) {
      pendingCleanup.delete(id);
      return result;
    }
    scheduleCleanup(id, result.error);
    return { ok: false, removed: false, retryable: true, error: result.error };
  };

  const getCleanupStatus = (sessionID) => {
    const id = asNonEmptyString(sessionID);
    if (!id) return null;
    const pending = pendingCleanup.get(id);
    if (!pending) return { ok: true, pending: false };
    return {
      ok: false,
      pending: true,
      retryable: pending.attempts < CLEANUP_DELAYS_MS.length,
      attempts: pending.attempts,
      error: pending.error,
      failedAt: pending.failedAt,
    };
  };

  const stop = () => {
    stopped = true;
    // Bump every known session generation so late repair awaits refuse to write.
    for (const id of new Set([
      ...operationGeneration.keys(),
      ...pendingIndexRepair.keys(),
      ...pendingCleanup.keys(),
    ])) {
      bumpOperationGeneration(id);
    }
    for (const entry of pendingIndexRepair.values()) clearRepairTimer(entry);
    for (const entry of pendingCleanup.values()) clearRepairTimer(entry);
    pendingIndexRepair.clear();
    pendingCleanup.clear();
  };

  return {
    setArchive,
    archiveSession,
    unarchiveSession,
    forgetSession,
    retryIndexUpdate,
    getIndexRepairStatus,
    getCleanupStatus,
    projectSession,
    readHostArchivedAt: (metadata) => readHostArchivedAt(metadata),
    isSessionArchived,
    readHostMetadataSync,
    stop,
  };
};

export const createUpstreamSessionFetcher = ({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  fetchFn = globalThis.fetch,
}) => async ({ sessionID, directory = null }) => {
  const id = asNonEmptyString(sessionID);
  if (!id) return null;
  const url = new URL(buildOpenCodeUrl(`/session/${encodeURIComponent(id)}`));
  if (directory) url.searchParams.set('directory', directory);
  const response = await fetchFn(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      ...(typeof getOpenCodeAuthHeaders === 'function' ? getOpenCodeAuthHeaders() : {}),
    },
  });
  if (response.status === 404) {
    const error = new Error('session not found');
    error.status = 404;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(`OpenCode session.get failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  const payload = await response.json();
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    if (payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) {
      return payload.data;
    }
    if (typeof payload.id === 'string') return payload;
  }
  return null;
};
