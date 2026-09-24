/**
 * VS Code Extension Host adapter for OpenChamber session metadata + Host archive.
 *
 * Reuses shared store / archive / projection from
 * `packages/web/server/lib/session-metadata/*`. Authority lives on the Extension
 * Host so multi-webview clients share one durable store, scoped by upstream
 * runtime identity (same isolation key as the global event watcher).
 *
 * Contracts (parity with Web proxy + DOCUMENTATION.md):
 * - List/get never silently return un-overlaid upstream when the Host store is
 *   wired: unavailable/not-ready → 503 `{ code: session_metadata_unavailable, retryable: true }`.
 * - Until committed snapshot is ready, session lifecycle SSE frames are suppressed
 *   (`hostReady: false`); transcript/message paths stay open.
 * - Successful DELETE /session/:id runs idempotent forget; session.deleted(.v2)
 *   remains compensatory cleanup.
 * - Runtime scope switch bumps a generation so late fetch/broadcast cannot apply
 *   to the new identity.
 * - Upstream session.get uses ensureOpenCodeApiUpstreamPath so origin-only
 *   getApiUrl() still hits official v2 `/api/session/:id`.
 * - Watcher/start waits for committed store readiness (controlled retry) before
 *   admitting lifecycle SSE, so a cold unknown window does not permanently drop
 *   unique created/updated/deleted frames.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { injectHostSseEvent } from './host-sse-fanout';
import type { OpenCodeManager } from './opencode';
import {
  createSessionArchiveService,
  createHttpSessionRecordClient,
  createSessionMetadataStore,
  startSideStoreMigration,
  extractSessionInfoFromPayload,
  isSessionArchiveError,
  isSessionLifecycleEventType,
  normalizeSessionEventType,
  projectSessionLifecyclePayload,
  projectSessionWithStoredMap,
  type SessionArchiveService,
  type SessionMetadataStore,
} from './session-metadata-shared-types';

type ApiProxyResponsePayload = {
  status: number;
  headers: Record<string, string>;
  bodyText?: string;
  bodyBase64?: string;
};

type MessageSink = { postMessage: (message: unknown) => void };

/** Result of applying Host overlay to a proxied session list/get response. */
export type SessionProxyOverlayResult =
  | { kind: 'pass' }
  | { kind: 'overlay'; bodyText: string }
  | { kind: 'unavailable'; error: string };

const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_DATA_ROOT = path.join(os.homedir(), '.config', 'openchamber');
const METADATA_UNAVAILABLE_CODE = 'session_metadata_unavailable';

let managerRef: OpenCodeManager | null = null;
let dataRootOverride: string | null = null;
let boundRuntimeScope: string | null = null;
/** Bumps on every scope dispose/create so late IO cannot touch a new identity. */
let runtimeGeneration = 0;
let storeRef: SessionMetadataStore | null = null;
let stopSessionRecordMigration: (() => void) | null = null;
let archiveRef: SessionArchiveService | null = null;
/** True once startSessionMetadataRuntime has bound a store for the active scope. */
let storeConfigured = false;
const eventSinks = new Set<MessageSink>();
/** Background readiness retry after a failed first load (generation-scoped). */
let readinessRetryTimer: ReturnType<typeof setTimeout> | null = null;

/** Test seam: force data root without touching user ~/.config. */
let dataRootForTests: string | null = null;

const READINESS_RETRY_BASE_MS = 250;
const READINESS_RETRY_MAX_MS = 8_000;
const DEFAULT_READINESS_WAIT_MS = 12_000;

const asTrimmedString = (value: unknown): string =>
  (typeof value === 'string' && value.trim() ? value.trim() : '');

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const jsonResponse = (status: number, body: unknown): ApiProxyResponsePayload => ({
  status,
  headers: { 'content-type': 'application/json' },
  bodyText: JSON.stringify(body),
});

const metadataUnavailablePayload = (error?: string): ApiProxyResponsePayload =>
  jsonResponse(503, {
    error: error || 'session metadata is unavailable',
    code: METADATA_UNAVAILABLE_CODE,
    retryable: true,
  });

const parseRequestBody = (bodyBase64: string | undefined): Record<string, unknown> | null => {
  if (typeof bodyBase64 !== 'string' || bodyBase64.length === 0) return null;
  try {
    const text = Buffer.from(bodyBase64, 'base64').toString('utf8');
    if (!text) return null;
    const parsed = JSON.parse(text) as unknown;
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const normalizeProxyPathname = (requestPath: string): string => {
  try {
    const parsed = new URL(requestPath, 'https://openchamber.invalid');
    let pathname = parsed.pathname || '/';
    if (pathname.startsWith('/api/')) pathname = pathname.slice(4);
    return pathname.replace(/\/+$/, '') || '/';
  } catch {
    let pathname = requestPath.split('?')[0] || '/';
    if (pathname.startsWith('/api/')) pathname = pathname.slice(4);
    return pathname.replace(/\/+$/, '') || '/';
  }
};

/**
 * Runtime isolation key (parity with sessionActivityWatcher endpoint binding).
 * Managed loopback restarts share one scope; external hosts are host:port.
 */
export const normalizeSessionMetadataRuntimeScope = (
  apiUrl: string | null | undefined,
): string | null => {
  const raw = typeof apiUrl === 'string' ? apiUrl.trim() : '';
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost' || host === '::1') {
      return `loopback:${url.protocol}`;
    }
    return `${url.protocol}//${url.host}`;
  } catch {
    return raw.replace(/\/+$/, '');
  }
};

const sanitizeScopeForPath = (scope: string): string =>
  scope.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'default';

const resolveDataRoot = (): string =>
  dataRootForTests
  ?? dataRootOverride
  ?? (typeof process.env.OPENCHAMBER_DATA_DIR === 'string' && process.env.OPENCHAMBER_DATA_DIR.trim()
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR.trim())
    : DEFAULT_DATA_ROOT);

const resolveScopedDataDir = (scope: string): string =>
  path.join(resolveDataRoot(), 'session-metadata', sanitizeScopeForPath(scope));

/** Exact on-disk data dir for a runtime scope (tests / diagnostics). */
export const resolveSessionMetadataDataDirForScope = (scope: string): string =>
  resolveScopedDataDir(scope);

/**
 * Build the official OpenCode v2 session.get URL from a manager base URL.
 * `getApiUrl()` is origin-only (`http://127.0.0.1:PORT`); paths must use the
 * same `/api` restore as bridge-proxy `ensureOpenCodeApiUpstreamPath`. If the
 * base already ends with `/api`, strip it once so we never produce `/api/api/...`.
 *
 * Pure + exported for focused URL contract tests (pathname + query + auth caller).
 */
export const buildUpstreamSessionGetUrl = (
  baseUrl: string,
  sessionID: string,
  directory?: string | null,
): string => {
  const id = asTrimmedString(sessionID);
  if (!id) throw new Error('a session id is required');
  let origin = asTrimmedString(baseUrl).replace(/\/+$/, '');
  if (!origin) throw new Error('OpenCode API unavailable');
  // External configs sometimes set `.../api` as the base; normalize to origin.
  if (origin.endsWith('/api')) origin = origin.slice(0, -4);
  // Parity with ensureOpenCodeApiUpstreamPath('/session/:id') → '/api/session/:id'.
  const upstreamPath = `/api/session/${encodeURIComponent(id)}`;
  const url = new URL(upstreamPath.replace(/^\/+/, ''), `${origin}/`);
  const dir = asTrimmedString(directory);
  if (dir) url.searchParams.set('directory', dir);
  return url.toString();
};

/** Explicit Host readiness: committed snapshot only (never empty-success). */
export const isHostSessionMetadataReady = (): boolean =>
  Boolean(storeRef && storeRef.isLoaded() && storeRef.getSnapshotSync() != null);

export const isSessionMetadataStoreConfigured = (): boolean => storeConfigured;

const clearReadinessRetry = (): void => {
  if (readinessRetryTimer != null) {
    clearTimeout(readinessRetryTimer);
    readinessRetryTimer = null;
  }
};

const scheduleReadinessRetry = (generation: number, attempt = 0): void => {
  if (generation !== runtimeGeneration) return;
  clearReadinessRetry();
  const delay = Math.min(
    READINESS_RETRY_BASE_MS * (2 ** Math.min(attempt, 5)),
    READINESS_RETRY_MAX_MS,
  );
  readinessRetryTimer = setTimeout(() => {
    readinessRetryTimer = null;
    // generation is closed over; runtimeGeneration bumps on scope dispose.
    if (generation !== runtimeGeneration || !storeRef) return;
    void storeRef.load().then((result) => {
      if (generation !== runtimeGeneration) return;
      if (result.ok && isHostSessionMetadataReady()) {
        // Committed snapshot is live — subsequent lifecycle frames overlay.
        // Clients that listed during the unavailable window must retry (503).
        return;
      }
      scheduleReadinessRetry(generation, attempt + 1);
    }).catch(() => {
      if (generation !== runtimeGeneration) return;
      scheduleReadinessRetry(generation, attempt + 1);
    });
  }, delay);
  readinessRetryTimer.unref?.();
};

export type SessionMetadataReadyResult =
  | { ok: true; skipped?: boolean }
  | { ok: false; error: string; retryable: true };

/**
 * Block until the Host store has a committed snapshot (or timeout).
 * Used by the global watcher and webview SSE connect so streams do not start
 * while lifecycle would be suppressed — avoiding a permanent miss of unique
 * created/updated/deleted frames.
 *
 * On persistent failure returns `{ ok: false }` (lifecycle stays suppressed and
 * background retry continues). Callers that must not open upstream (webview SSE)
 * should treat `ok: false` as a connect error and use their existing retry path.
 */
export const waitForSessionMetadataReady = async (options: {
  timeoutMs?: number;
  signal?: AbortSignal;
} = {}): Promise<SessionMetadataReadyResult> => {
  const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_READINESS_WAIT_MS;
  const signal = options.signal;
  const deadline = Date.now() + timeoutMs;
  const generationAtStart = runtimeGeneration;

  if (!storeConfigured || !storeRef) {
    return {
      ok: false,
      error: 'session metadata runtime unavailable',
      retryable: true,
    };
  }

  let attempt = 0;
  while (Date.now() <= deadline) {
    if (signal?.aborted) {
      return { ok: false, error: 'aborted', retryable: true };
    }
    if (generationAtStart !== runtimeGeneration) {
      return { ok: false, error: 'session metadata runtime switched', retryable: true };
    }
    if (!storeRef) {
      return { ok: false, error: 'session metadata runtime unavailable', retryable: true };
    }

    try {
      const result = await storeRef.load();
      if (generationAtStart !== runtimeGeneration) {
        return { ok: false, error: 'session metadata runtime switched', retryable: true };
      }
      if (result.ok && isHostSessionMetadataReady()) {
        clearReadinessRetry();
        return { ok: true };
      }
      // Explicit load failure (corrupt / unreadable) — do not treat as empty ok.
      if (result.ok === false) {
        const reason = result.reason || storeRef.getLoadFailureReason?.() || 'session metadata is unavailable';
        scheduleReadinessRetry(generationAtStart, attempt);
        // Keep trying until deadline.
        attempt += 1;
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          return { ok: false, error: reason, retryable: true };
        }
        await new Promise<void>((resolve) => {
          const wait = Math.min(
            READINESS_RETRY_BASE_MS * (2 ** Math.min(attempt - 1, 4)),
            remaining,
            1_000,
          );
          setTimeout(resolve, wait);
        });
        continue;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'session metadata is unavailable';
      scheduleReadinessRetry(generationAtStart, attempt);
      attempt += 1;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return { ok: false, error: message, retryable: true };
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(500, remaining));
      });
      continue;
    }

    // Loaded but snapshot still null — brief pause then recheck.
    attempt += 1;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(100, remaining));
    });
  }

  const error = storeRef?.getLoadFailureReason?.()
    || 'session metadata is unavailable: readiness wait timed out';
  scheduleReadinessRetry(generationAtStart, attempt);
  return { ok: false, error, retryable: true };
};

/**
 * Outbound SSE / stream gate used by webview `openSseProxy` connect+reconnect.
 *
 * - Store never started → `{ ok: true, skipped: true }` (no Host authority wired;
 *   lifecycle overlay is a no-op; do not block fetch).
 * - Already ready → immediate `{ ok: true }`.
 * - Wired but unknown/unavailable → `waitForSessionMetadataReady` (respects signal
 *   for stop/runtime switch cancellation). Failure is retryable connect error.
 */
export const ensureSessionMetadataReadyForOutboundSse = async (options: {
  timeoutMs?: number;
  signal?: AbortSignal;
} = {}): Promise<SessionMetadataReadyResult> => {
  if (!storeConfigured || !storeRef) {
    return { ok: true, skipped: true };
  }
  if (isHostSessionMetadataReady()) {
    return { ok: true };
  }
  return waitForSessionMetadataReady(options);
};

const readHostMetadataSync = (sessionID: string): Record<string, unknown> | null => {
  if (!storeRef) return null;
  const snap = storeRef.getSnapshotSync();
  if (!snap || typeof sessionID !== 'string') return null;
  const host = snap[sessionID];
  return isPlainObject(host) ? host : null;
};

/**
 * Read committed map for list/get overlay.
 * - unconfigured: store never started
 * - ok: committed snapshot
 * - unavailable: load/read failure (retryable)
 */
const readStoredSessionMetadata = async (): Promise<
  | { status: 'unconfigured' }
  | { status: 'ok'; stored: Record<string, Record<string, unknown>> }
  | { status: 'unavailable'; error: string }
> => {
  if (!storeConfigured || !storeRef) return { status: 'unconfigured' };
  try {
    const stored = await storeRef.getAll();
    if (!stored || typeof stored !== 'object') {
      return { status: 'unavailable', error: 'session metadata is unavailable' };
    }
    return { status: 'ok', stored };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'session metadata is unavailable';
    console.warn('[session-metadata] store read unavailable:', message);
    return { status: 'unavailable', error: message };
  }
};

const broadcastSessionUpdated = (
  projected: Record<string, unknown>,
  generation: number,
): void => {
  if (generation !== runtimeGeneration) return;
  const sessionID = asTrimmedString(projected.id);
  if (!sessionID) return;
  const event = {
    type: 'session.updated',
    properties: {
      info: projected,
      sessionID,
    },
  };
  for (const sink of eventSinks) {
    try {
      sink.postMessage(event);
    } catch {
      // One closed webview must not break archive fan-out.
    }
  }
  try {
    injectHostSseEvent(event);
  } catch (error) {
    console.warn(
      '[session-metadata] SSE inject failed after archive commit:',
      error instanceof Error ? error.message : error,
    );
  }
};

const buildFetchUpstreamSession = (scope: string, generation: number) => {
  return async ({
    sessionID,
    directory = null,
  }: {
    sessionID: string;
    directory?: string | null;
  }) => {
    if (generation !== runtimeGeneration || boundRuntimeScope !== scope) {
      const error = new Error('session metadata runtime switched') as Error & { status?: number };
      error.status = 503;
      throw error;
    }
    const id = asTrimmedString(sessionID);
    if (!id) return null;
    const baseUrl = asTrimmedString(managerRef?.getApiUrl());
    if (!baseUrl) {
      const error = new Error('OpenCode API unavailable') as Error & { status?: number };
      error.status = 503;
      throw error;
    }
    // Official v2 path: origin + /api/session/:id (never bare /session/:id).
    const targetUrl = buildUpstreamSessionGetUrl(baseUrl, id, directory);
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(managerRef?.getOpenCodeAuthHeaders() ?? {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (generation !== runtimeGeneration || boundRuntimeScope !== scope) {
      const error = new Error('session metadata runtime switched') as Error & { status?: number };
      error.status = 503;
      throw error;
    }
    if (response.status === 404) {
      const error = new Error('session not found') as Error & { status?: number };
      error.status = 404;
      throw error;
    }
    if (!response.ok) {
      const error = new Error(`OpenCode session.get failed (${response.status})`) as Error & {
        status?: number;
      };
      error.status = response.status;
      throw error;
    }
    const payload = await response.json().catch(() => null);
    if (isPlainObject(payload)) {
      if (isPlainObject(payload.data) && typeof payload.data.id === 'string') {
        return payload.data;
      }
      if (typeof payload.id === 'string') return payload;
    }
    return null;
  };
};

const disposeScopedRuntime = (): void => {
  clearReadinessRetry();
  stopArchiveService();
  if (stopSessionRecordMigration) {
    stopSessionRecordMigration();
    stopSessionRecordMigration = null;
  }
  runtimeGeneration += 1;
  storeRef = null;
  archiveRef = null;
  boundRuntimeScope = null;
  storeConfigured = false;
};

const ensureScopedRuntime = (scope: string): { store: SessionMetadataStore; archive: SessionArchiveService } => {
  if (storeRef && archiveRef && boundRuntimeScope === scope && storeConfigured) {
    return { store: storeRef, archive: archiveRef };
  }

  disposeScopedRuntime();
  const generation = runtimeGeneration;
  const dataDir = resolveScopedDataDir(scope);
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch {
    // store persist will mkdir again; ignore here
  }

  const recordClient = createHttpSessionRecordClient({
    buildSessionUrl: (sessionID, directory) => {
      const baseUrl = asTrimmedString(managerRef?.getApiUrl());
      if (!baseUrl) {
        const error = new Error('OpenCode API unavailable') as Error & { status?: number };
        error.status = 503;
        throw error;
      }
      return buildUpstreamSessionGetUrl(baseUrl, sessionID, directory);
    },
    getHeaders: () => managerRef?.getOpenCodeAuthHeaders() ?? {},
  });
  const store = createSessionMetadataStore({
    dataDir,
    recordReader: (sessionID, directory) => recordClient.read(sessionID, directory),
    recordWriter: (sessionID, metadata, directory) => recordClient.write({
      sessionID,
      metadata: { ...metadata },
      directory,
    }),
  });
  stopSessionRecordMigration = startSideStoreMigration({
    load: async () => {
      const result = await store.load();
      return result.ok ? result : { ok: false };
    },
    readSession: (sessionID) => recordClient.read(sessionID),
    writeMetadata: async (sessionID, metadata, record) => {
      const directory = typeof record === 'object' && record && 'directory' in record
        ? (record as { directory?: string | null }).directory
        : undefined;
      await recordClient.write({ sessionID, metadata: { ...metadata }, directory });
    },
  });
  void store.load().then((result) => {
    if (generation !== runtimeGeneration) return;
    if (result.ok && store.isLoaded()) return;
    console.warn(
      '[session-metadata] initial load failed:',
      result.reason || 'unavailable',
    );
    // Keep retrying so a transient/corrupt window can recover without a full restart.
    scheduleReadinessRetry(generation, 0);
  }).catch((error: unknown) => {
    if (generation !== runtimeGeneration) return;
    console.warn(
      '[session-metadata] initial load failed:',
      error instanceof Error ? error.message : error,
    );
    scheduleReadinessRetry(generation, 0);
  });

  const archive = createSessionArchiveService({
    sessionMetadataStore: store,
    fetchUpstreamSession: buildFetchUpstreamSession(scope, generation),
    broadcastSessionEvent: (event: { type: string; properties: object }) => {
      if (generation !== runtimeGeneration) return;
      if (!event || typeof event !== 'object') return;
      if (event.type !== 'session.updated') return;
      const properties = event.properties;
      if (!isPlainObject(properties)) return;
      const info = properties.info;
      if (!isPlainObject(info)) return;
      broadcastSessionUpdated(info, generation);
    },
  });

  storeRef = store;
  archiveRef = archive;
  boundRuntimeScope = scope;
  storeConfigured = true;
  return { store, archive };
};

const stopArchiveService = (): void => {
  if (archiveRef && typeof archiveRef.stop === 'function') {
    try {
      archiveRef.stop();
    } catch {
      // ignore
    }
  }
};

const ensureRuntimeOrNull = (): { store: SessionMetadataStore; archive: SessionArchiveService } | null => {
  const scope = normalizeSessionMetadataRuntimeScope(managerRef?.getApiUrl())
    ?? boundRuntimeScope
    ?? 'unbound';
  try {
    return ensureScopedRuntime(scope);
  } catch (error) {
    console.warn(
      '[session-metadata] failed to start runtime:',
      error instanceof Error ? error.message : error,
    );
    return null;
  }
};

/**
 * Configure optional data root (e.g. extension globalStorage). Call before start.
 */
export const configureSessionMetadataDataRoot = (dataRoot: string | null): void => {
  dataRootOverride = typeof dataRoot === 'string' && dataRoot.trim() ? dataRoot.trim() : null;
};

/**
 * Bind manager + ensure store for the current OpenCode endpoint.
 * Different endpoint keys swap the durable store (runtime isolation).
 */
export const startSessionMetadataRuntime = (manager: OpenCodeManager): void => {
  managerRef = manager;
  const nextScope = normalizeSessionMetadataRuntimeScope(manager.getApiUrl());
  if (
    boundRuntimeScope
    && nextScope
    && boundRuntimeScope !== nextScope
  ) {
    disposeScopedRuntime();
  }
  if (nextScope) {
    ensureScopedRuntime(nextScope);
  } else if (!storeRef) {
    // No URL yet — keep unbound scope so routes can still answer 503 cleanly
    // after start once the URL appears.
    ensureScopedRuntime('unbound');
  }
};

/** Full dispose (deactivate or intentional teardown). */
export const stopSessionMetadataRuntime = (): void => {
  disposeScopedRuntime();
  managerRef = null;
};

export const addSessionMetadataEventSink = (sink: MessageSink): (() => void) => {
  eventSinks.add(sink);
  return () => {
    eventSinks.delete(sink);
  };
};

/**
 * Idempotent Host metadata cleanup after authoritative session delete.
 * Call only after upstream DELETE success (or compensatory session.deleted).
 * Returns whether a metadata entry was removed (shared core may return
 * `{ ok, removed }` — normalized to boolean `removed` for callers/tests).
 */
export const forgetSessionMetadata = async (sessionID: string): Promise<boolean> => {
  const id = asTrimmedString(sessionID);
  if (!id || !archiveRef) return false;
  try {
    const result = await archiveRef.forgetSession(id);
    if (typeof result === 'boolean') return result;
    if (result && typeof result === 'object') {
      if (result.ok === false) {
        console.warn(
          '[session-metadata] forget after delete failed (retryable):',
          result.error || 'cleanup failed',
        );
        return false;
      }
      return result.removed === true;
    }
    return false;
  } catch (error: unknown) {
    console.warn(
      '[session-metadata] forget after delete failed (retryable):',
      error instanceof Error ? error.message : error,
    );
    return false;
  }
};

/**
 * Extract session id from session.deleted(.v2) / properties / data shapes.
 */
export const resolveDeletedSessionId = (payload: unknown): string | null => {
  if (!isPlainObject(payload)) return null;
  const baseType = normalizeSessionEventType(payload.type);
  if (baseType !== 'session.deleted') return null;

  const fromInfo = extractSessionInfoFromPayload(payload);
  if (fromInfo?.id) return fromInfo.id;

  const properties = isPlainObject(payload.properties) ? payload.properties : null;
  const data = isPlainObject(payload.data) ? payload.data : null;
  for (const candidate of [
    properties?.sessionID,
    properties?.sessionId,
    data?.sessionID,
    data?.sessionId,
    payload.sessionID,
    payload.sessionId,
  ]) {
    const id = asTrimmedString(candidate);
    if (id) return id;
  }
  return null;
};

/**
 * Project session lifecycle payloads so upstream SSE cannot wipe Host archive.
 * When the store is configured but not ready, lifecycle frames are suppressed
 * (null → SSE filter drops). Message/transcript events pass through.
 */
export const projectOutboundSessionLifecycleEvent = (payload: unknown): unknown => {
  if (!storeConfigured) return payload;

  const snap = storeRef?.getSnapshotSync() ?? null;
  if (snap == null) {
    // Unknown / not ready: never leak bare upstream lifecycle as active authority.
    return projectSessionLifecyclePayload(payload, () => null, { hostReady: false });
  }

  return projectSessionLifecyclePayload(
    payload,
    (sessionId: string) => {
      const host = snap[sessionId];
      return isPlainObject(host) ? host : null;
    },
    { hostReady: true },
  );
};

/** Whether an SSE payload type is a session lifecycle frame (incl. .v2). */
export const isOutboundSessionLifecycleEvent = (payload: unknown): boolean => {
  if (!isPlainObject(payload)) return false;
  if (typeof payload.type === 'string' && isSessionLifecycleEventType(payload.type)) return true;
  if (isPlainObject(payload.payload) && typeof payload.payload.type === 'string') {
    return isSessionLifecycleEventType(payload.payload.type);
  }
  return false;
};

const sessionListRecords = (payload: unknown): unknown[] | null => {
  if (Array.isArray(payload)) return payload;
  if (isPlainObject(payload) && Array.isArray(payload.data)) return payload.data;
  return null;
};

const isSessionListPath = (pathname: string): boolean =>
  pathname === '/session'
  || pathname === '/experimental/session';

const isSessionDetailPath = (pathname: string): boolean =>
  /^\/session\/[^/]+$/.test(pathname);

/** Exact DELETE /session/:id (optional query; /api prefix optional). */
export const isSessionDeletePath = (requestPath: string): boolean => {
  const pathname = normalizeProxyPathname(requestPath);
  return /^\/session\/[^/]+$/.test(pathname);
};

export const readSessionIdFromSessionPath = (requestPath: string): string | null => {
  const pathname = normalizeProxyPathname(requestPath);
  const match = pathname.match(/^\/session\/([^/]+)$/);
  if (!match) return null;
  try {
    const id = decodeURIComponent(match[1]).trim();
    return id || null;
  } catch {
    return null;
  }
};

/**
 * Apply Host metadata/archive overlay onto a successful GET session list/detail
 * body. When the Host store is wired but unavailable, returns `unavailable` so
 * the proxy can answer 503 retryable (never silent un-overlaid upstream).
 */
export const resolveSessionProxyOverlay = async (
  method: string,
  requestPath: string,
  status: number,
  bodyText: string | undefined,
): Promise<SessionProxyOverlayResult> => {
  if (method.toUpperCase() !== 'GET') return { kind: 'pass' };
  if (status < 200 || status >= 300) return { kind: 'pass' };
  if (typeof bodyText !== 'string' || bodyText.length === 0) return { kind: 'pass' };

  const pathname = normalizeProxyPathname(requestPath);
  if (!isSessionListPath(pathname) && !isSessionDetailPath(pathname)) {
    return { kind: 'pass' };
  }

  const meta = await readStoredSessionMetadata();
  if (meta.status === 'unconfigured') return { kind: 'pass' };
  if (meta.status === 'unavailable') {
    return { kind: 'unavailable', error: meta.error };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { kind: 'pass' };
  }

  const snap = meta.stored;

  if (isSessionListPath(pathname)) {
    const records = sessionListRecords(parsed);
    if (!records) return { kind: 'pass' };
    // Always project when store is ready so explicit unarchive (0) clears
    // upstream historical time.archived even with no other host keys.
    const overlaid = records.map((session) => projectSessionWithStoredMap(session, snap));
    if (Array.isArray(parsed)) return { kind: 'overlay', bodyText: JSON.stringify(overlaid) };
    return { kind: 'overlay', bodyText: JSON.stringify({ ...(parsed as object), data: overlaid }) };
  }

  const record = isPlainObject(parsed) ? parsed : null;
  if (!record) return { kind: 'pass' };
  const session = isPlainObject(record.data) && typeof record.data.id === 'string'
    ? record.data
    : (typeof record.id === 'string' ? record : null);
  if (!session) return { kind: 'pass' };
  const overlaid = projectSessionWithStoredMap(session, snap);
  if (isPlainObject(record.data) && typeof record.data.id === 'string') {
    return { kind: 'overlay', bodyText: JSON.stringify({ ...record, data: overlaid }) };
  }
  return { kind: 'overlay', bodyText: JSON.stringify(overlaid) };
};

/**
 * @deprecated Prefer resolveSessionProxyOverlay (async, 503-aware).
 * Sync helper retained for tests that only exercise ready-store overlay.
 */
export const overlaySessionProxyBodyText = (
  method: string,
  requestPath: string,
  status: number,
  bodyText: string | undefined,
): string | null => {
  if (method.toUpperCase() !== 'GET') return null;
  if (status < 200 || status >= 300) return null;
  if (typeof bodyText !== 'string' || bodyText.length === 0) return null;
  if (!storeRef) return null;
  const snap = storeRef.getSnapshotSync();
  if (!snap) return null;

  const pathname = normalizeProxyPathname(requestPath);
  if (!isSessionListPath(pathname) && !isSessionDetailPath(pathname)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }

  if (isSessionListPath(pathname)) {
    const records = sessionListRecords(parsed);
    if (!records) return null;
    const overlaid = records.map((session) => projectSessionWithStoredMap(session, snap));
    if (Array.isArray(parsed)) return JSON.stringify(overlaid);
    return JSON.stringify({ ...(parsed as object), data: overlaid });
  }

  const record = isPlainObject(parsed) ? parsed : null;
  if (!record) return null;
  const session = isPlainObject(record.data) && typeof record.data.id === 'string'
    ? record.data
    : (typeof record.id === 'string' ? record : null);
  if (!session) return null;
  const overlaid = projectSessionWithStoredMap(session, snap);
  if (isPlainObject(record.data) && typeof record.data.id === 'string') {
    return JSON.stringify({ ...record, data: overlaid });
  }
  return JSON.stringify(overlaid);
};

/**
 * Handle OpenChamber-owned session metadata + archive routes inside api:proxy.
 * Returns null when the path is not owned by this module.
 */
export const tryHandleSessionMetadataProxy = async (
  method: string,
  requestPath: string,
  _headers?: Record<string, string>,
  bodyBase64?: string,
): Promise<ApiProxyResponsePayload | null> => {
  const pathname = normalizeProxyPathname(requestPath);
  const verb = method.toUpperCase();

  const metadataMatch = pathname.match(/^\/openchamber\/sessions\/([^/]+)\/metadata$/);
  const archiveMatch = pathname.match(/^\/openchamber\/sessions\/([^/]+)\/archive$/);
  if (!metadataMatch && !archiveMatch) return null;

  const runtime = ensureRuntimeOrNull();
  if (!runtime) {
    return metadataUnavailablePayload('session metadata runtime unavailable');
  }
  const { store, archive } = runtime;
  const generationAtStart = runtimeGeneration;

  if (metadataMatch && verb === 'PUT') {
    let sessionId: string;
    try {
      sessionId = decodeURIComponent(metadataMatch[1]).trim();
    } catch {
      sessionId = '';
    }
    if (!sessionId) {
      return jsonResponse(400, { error: 'a session id is required' });
    }
    const body = parseRequestBody(bodyBase64) ?? {};
    const patch = body.patch;
    if (!isPlainObject(patch)) {
      return jsonResponse(400, { error: 'patch must be an object' });
    }
    try {
      const metadata = await store.setSessionMetadata(sessionId, patch);
      if (generationAtStart !== runtimeGeneration) {
        return metadataUnavailablePayload('session metadata runtime switched');
      }
      return jsonResponse(200, { metadata });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to store session metadata';
      if (/could not be read|unavailable/i.test(message)) {
        return metadataUnavailablePayload(message);
      }
      return jsonResponse(500, { error: message });
    }
  }

  if (archiveMatch && verb === 'PUT') {
    let sessionId: string;
    try {
      sessionId = decodeURIComponent(archiveMatch[1]).trim();
    } catch {
      sessionId = '';
    }
    if (!sessionId) {
      return jsonResponse(400, { error: 'a session id is required' });
    }
    const body = parseRequestBody(bodyBase64) ?? {};
    if (typeof body.archivedAt !== 'number' || !Number.isFinite(body.archivedAt)) {
      return jsonResponse(400, { error: 'archivedAt must be a finite number' });
    }
    try {
      const result = await archive.setArchive({
        sessionID: sessionId,
        archivedAt: body.archivedAt,
        directory: asTrimmedString(body.directory) || undefined,
      });
      if (generationAtStart !== runtimeGeneration) {
        // Durable write may have landed on the prior scope file; do not claim
        // success against the new identity.
        return metadataUnavailablePayload('session metadata runtime switched');
      }
      return jsonResponse(200, {
        session: result.session,
        ...(result.index ? { index: result.index } : {}),
      });
    } catch (error: unknown) {
      if (isSessionArchiveError(error)) {
        return jsonResponse(error.status || 400, {
          error: error.message,
          code: error.code,
        });
      }
      const message = error instanceof Error ? error.message : 'Failed to archive session';
      if (/could not be read|unavailable|runtime switched/i.test(message)) {
        return metadataUnavailablePayload(message);
      }
      return jsonResponse(500, { error: message });
    }
  }

  // Owned path but wrong method
  return jsonResponse(405, { error: 'method not allowed' });
};

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

export const __setSessionMetadataDataRootForTests = (dataRoot: string | null): void => {
  dataRootForTests = dataRoot;
};

export const __getSessionMetadataBoundScopeForTests = (): string | null => boundRuntimeScope;

export const __getSessionMetadataStoreForTests = (): SessionMetadataStore | null => storeRef;

export const __getSessionMetadataArchiveForTests = (): SessionArchiveService | null => archiveRef;

export const __getSessionMetadataRuntimeGenerationForTests = (): number => runtimeGeneration;

export const __readHostMetadataSyncForTests = readHostMetadataSync;

export const __resetSessionMetadataRuntimeForTests = (): void => {
  disposeScopedRuntime();
  managerRef = null;
  dataRootOverride = null;
  dataRootForTests = null;
  eventSinks.clear();
};

export const __clearReadinessRetryForTests = (): void => {
  clearReadinessRetry();
};

export {
  isSessionArchiveError,
  isSessionLifecycleEventType,
  normalizeSessionEventType,
  METADATA_UNAVAILABLE_CODE,
};
