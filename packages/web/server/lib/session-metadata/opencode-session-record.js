/**
 * OpenCode session-record ownership for OpenChamber metadata.
 *
 * OpenCode 2.0.15 `PATCH /api/session/:id` (`session.update`) replaces
 * `metadata` wholesale and can set `title`. Archive stays in
 * `metadata.openchamber.archive` on that same record, then projects onto
 * `time.archived`. This module is the only place that knows that call.
 *
 * A client whose types do not yet expose `session.update` metadata still goes
 * through `writeSessionRecordViaClient` / `createHttpSessionRecordClient`.
 * Missing the API throws — it is never an empty success.
 *
 * The side store is a migration source. A failed load is not an empty catalog.
 * One session's migration failure does not delete other sessions or their rows.
 */

import { mergeOwnedMetadata, projectSessionWithStoredMap } from './session-projection.js';

export { mergeOwnedMetadata };

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const isSessionNotFoundError = (error) => {
  const status = Number(error?.status ?? error?.statusCode);
  if (status === 404) return true;
  const tag = error?._tag || error?.name;
  return tag === 'SessionNotFoundError' || tag === 'Session.NotFoundError';
};

const deepEqual = (left, right) => {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => deepEqual(item, right[index]));
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => deepEqual(left[key], right[key]));
};

const unwrapSession = (payload) => {
  if (!isPlainObject(payload)) return null;
  if (isPlainObject(payload.data) && typeof payload.data.id === 'string') return payload.data;
  if (typeof payload.id === 'string') return payload;
  return null;
};

/**
 * Structural adapter for `@opencode/client` session.update.
 * Throws when the method is absent — never pretends the write landed.
 *
 * @param {{ session?: { update?: Function } } | null | undefined} client
 * @param {{ sessionID: string, metadata?: object, title?: string, requestOptions?: object }} input
 */
export const writeSessionRecordViaClient = async (client, input) => {
  const update = client?.session?.update;
  if (typeof update !== 'function') {
    const error = new Error('session.update is unavailable');
    error.code = 'session_update_unavailable';
    throw error;
  }
  const sessionID = asNonEmptyString(input?.sessionID);
  if (!sessionID) throw new Error('a session id is required to update the OpenCode session record');
  const body = { sessionID };
  if (input.metadata !== undefined) body.metadata = input.metadata;
  if (input.title !== undefined) body.title = input.title;
  await update(body, input.requestOptions);
};

/**
 * @param {{ session?: { get?: Function } } | null | undefined} client
 * @param {{ sessionID: string, requestOptions?: object }} input
 * @returns {Promise<object | null>} null only when OpenCode confirms the session is gone
 */
export const readSessionRecordViaClient = async (client, input) => {
  const get = client?.session?.get;
  if (typeof get !== 'function') {
    const error = new Error('session.get is unavailable');
    error.code = 'session_get_unavailable';
    throw error;
  }
  const sessionID = asNonEmptyString(input?.sessionID);
  if (!sessionID) throw new Error('a session id is required to read the OpenCode session record');
  try {
    const session = await get({ sessionID }, input.requestOptions);
    return unwrapSession(session) || (isPlainObject(session) ? session : null);
  } catch (error) {
    if (isSessionNotFoundError(error)) return null;
    throw error;
  }
};

/**
 * HTTP owner of `GET` / `PATCH /api/session/:id`. Callers supply the URL so
 * web and VS Code keep their own prefix rules.
 *
 * @param {{
 *   buildSessionUrl: (sessionID: string, directory?: string | null) => string,
 *   getHeaders?: () => Record<string, string>,
 *   fetchFn?: typeof fetch,
 * }} options
 */
export const createHttpSessionRecordClient = ({
  buildSessionUrl,
  getHeaders = () => ({}),
  fetchFn = null,
}) => {
  if (typeof buildSessionUrl !== 'function') {
    throw new Error('createHttpSessionRecordClient requires buildSessionUrl');
  }

  const request = async (sessionID, { method, directory, body }) => {
    const fetchImpl = fetchFn || globalThis.fetch;
    const id = asNonEmptyString(sessionID);
    if (!id) throw new Error('a session id is required');
    const url = buildSessionUrl(id, directory);
    const response = await fetchImpl(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(typeof getHeaders === 'function' ? getHeaders() : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return response;
  };

  const read = async (sessionID, directory) => {
    const response = await request(sessionID, { method: 'GET', directory });
    if (response.status === 404) return null;
    if (!response.ok) {
      const error = new Error(`OpenCode session.get failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    const payload = await response.json().catch(() => null);
    const session = unwrapSession(payload);
    if (!session) {
      const error = new Error('OpenCode session.get returned an unreadable record');
      error.status = 502;
      throw error;
    }
    return session;
  };

  const write = async ({ sessionID, directory, metadata, title } = {}) => {
    const body = {};
    if (metadata !== undefined) body.metadata = metadata;
    if (title !== undefined) body.title = title;
    if (Object.keys(body).length === 0) {
      throw new Error('session record write requires metadata or title');
    }
    const response = await request(sessionID, { method: 'PATCH', directory, body });
    if (response.status === 404) {
      const error = new Error(`session ${sessionID} was not found`);
      error.status = 404;
      throw error;
    }
    if (!response.ok) {
      const error = new Error(`OpenCode session.update failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
  };

  return { read, write };
};

/**
 * Copy side-store rows onto OpenCode records. Refuses a failed load instead of
 * treating it as an empty catalog. A failed session is reported and skipped;
 * other sessions, including ones OpenCode has and the side store does not, are
 * left in place.
 *
 * @param {{
 *   loadResult: { ok?: boolean, entries?: Record<string, object> | null } | null,
 *   readSession: (sessionID: string) => Promise<object | null>,
 *   writeMetadata: (sessionID: string, metadata: object, record: object) => Promise<void>,
 * }} input
 */
export const migrateLoadedSideStore = async ({ loadResult, readSession, writeMetadata }) => {
  if (!loadResult || loadResult.ok !== true || !isPlainObject(loadResult.entries)) {
    return { status: 'unavailable', migrated: [], failed: [], absent: [] };
  }
  if (typeof readSession !== 'function' || typeof writeMetadata !== 'function') {
    throw new Error('side-store migration requires readSession and writeMetadata');
  }

  const migrated = [];
  const failed = [];
  const absent = [];

  for (const [sessionID, sideMetadata] of Object.entries(loadResult.entries)) {
    if (!isPlainObject(sideMetadata)) continue;
    try {
      const record = await readSession(sessionID);
      if (record == null) {
        absent.push(sessionID);
        continue;
      }
      const merged = mergeOwnedMetadata(record.metadata, sideMetadata);
      if (!deepEqual(merged, isPlainObject(record.metadata) ? record.metadata : {})) {
        await writeMetadata(sessionID, merged, record);
      }
      migrated.push(sessionID);
    } catch (error) {
      failed.push({
        id: sessionID,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    status: failed.length > 0 ? 'partial' : 'complete',
    migrated,
    failed,
    absent,
  };
};

/**
 * Membership comes from OpenCode. A missing side-store row does not drop the
 * session. A null side map is an unread store, not an empty catalog.
 *
 * @param {unknown} openCodeSessions
 * @param {Record<string, object> | null | undefined} sideById
 */
export const retainOpenCodeSessions = (openCodeSessions, sideById) => {
  if (!Array.isArray(openCodeSessions)) {
    throw new Error('OpenCode session list is unavailable');
  }
  if (sideById == null || typeof sideById !== 'object' || Array.isArray(sideById)) {
    throw new Error('session metadata is unavailable');
  }
  return openCodeSessions.map((session) => projectSessionWithStoredMap(session, sideById));
};

const MIGRATION_RETRY_MS = 2_000;

/**
 * Retry until every loaded side-store row is copied or confirmed absent.
 * A failed load schedules another attempt and does not write empty metadata.
 *
 * @param {{
 *   load: () => Promise<{ ok?: boolean, entries?: Record<string, object> }>,
 *   readSession: (sessionID: string) => Promise<object | null>,
 *   writeMetadata: (sessionID: string, metadata: object, record: object) => Promise<void>,
 *   setTimer?: typeof setTimeout,
 *   clearTimer?: typeof clearTimeout,
 * }} options
 * @returns {() => void} stop
 */
export const startSideStoreMigration = ({
  load,
  readSession,
  writeMetadata,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) => {
  const finished = new Set();
  let stopped = false;
  let timer = null;

  const schedule = () => {
    if (stopped || timer) return;
    timer = setTimer(() => {
      timer = null;
      void attempt();
    }, MIGRATION_RETRY_MS);
  };

  const attempt = async () => {
    if (stopped) return;
    let loadResult;
    try {
      loadResult = await load();
    } catch {
      schedule();
      return;
    }
    if (!loadResult || loadResult.ok !== true || !isPlainObject(loadResult.entries)) {
      schedule();
      return;
    }
    const pending = {};
    for (const [id, metadata] of Object.entries(loadResult.entries)) {
      if (!finished.has(id)) pending[id] = metadata;
    }
    if (Object.keys(pending).length === 0) return;
    const result = await migrateLoadedSideStore({
      loadResult: { ok: true, entries: pending },
      readSession,
      writeMetadata,
    });
    for (const id of result.migrated) finished.add(id);
    for (const id of result.absent) finished.add(id);
    if (result.failed.length > 0) schedule();
  };

  void attempt();
  return () => {
    stopped = true;
    if (timer) clearTimer(timer);
    timer = null;
  };
};
