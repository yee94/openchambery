import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { projectMessageSummaryDiffCounts } from '../event-stream/diff-summary.js';
import {
  createSessionChangesService,
} from './changes.service.js';
import {
  createSessionReconcileService,
  MAX_ANCHOR_LENGTH,
  MAX_CONTINUATION_LENGTH,
} from './reconcile.service.js';
import {
  createSessionTurnPageService,
  projectMessageDiffSummaries,
  projectSlimParts,
  SLIM_PARTS_PROJECTION,
} from './service.js';

const TURNS_MIN = 1;
const TURNS_MAX = 10;
const TURNS_DEFAULT = 3;
const SCAN_LIMIT_MIN = 10;
const SCAN_LIMIT_MAX = 200;
/** Fallback when env is unset / invalid — Host→OpenCode local page size only. */
const SCAN_LIMIT_DEFAULT = 100;

/**
 * Explicit operator override from env, or null when unset/invalid.
 * Kept separate from the resolved default so per-path policy can tell
 * "operator chose 100" apart from "nobody chose anything".
 */
const _inner_scanLimitEnv = (() => {
  const raw = process.env.OPENCHAMBER_SESSION_TURN_SCAN_LIMIT;
  if (raw === undefined || raw === null || raw === '') {
    return null;
  }
  const parsed = Number(String(raw).trim());
  if (!Number.isInteger(parsed) || parsed < SCAN_LIMIT_MIN || parsed > SCAN_LIMIT_MAX) {
    return null;
  }
  return parsed;
})();

/**
 * Server-owned upstream OpenCode scan chunk (messages per page).
 * Host always calls OpenCode locally; this is not a client-network concern.
 * Override via env `OPENCHAMBER_SESSION_TURN_SCAN_LIMIT` (10..200).
 * Clients may still pass `scanLimit` as an optional override; when omitted,
 * this inner default is used.
 */
const _inner_scanLimit = _inner_scanLimitEnv ?? SCAN_LIMIT_DEFAULT;

const PAGE_TIMEOUT_MS = 45_000;
const RECONCILE_TIMEOUT_MS = 45_000;

/** Host reconcile page budgets (records / JSON bytes per HTTP response page). */
const RECONCILE_PAGE_RECORD_LIMIT = (() => {
  const raw = process.env.OPENCHAMBER_SESSION_RECONCILE_PAGE_RECORDS;
  const parsed = Number(String(raw ?? '').trim());
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 500) return parsed;
  return 100;
})();
const RECONCILE_PAGE_BYTE_LIMIT = (() => {
  const raw = process.env.OPENCHAMBER_SESSION_RECONCILE_PAGE_BYTES;
  const parsed = Number(String(raw ?? '').trim());
  if (Number.isInteger(parsed) && parsed >= 1024 && parsed <= 4 * 1024 * 1024) return parsed;
  return 512 * 1024;
})();
const RECONCILE_TOTAL_PAGE_LIMIT = (() => {
  const raw = process.env.OPENCHAMBER_SESSION_RECONCILE_TOTAL_PAGES;
  const parsed = Number(String(raw ?? '').trim());
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 100) return parsed;
  return 20;
})();
const RECONCILE_TOTAL_BYTE_LIMIT = (() => {
  const raw = process.env.OPENCHAMBER_SESSION_RECONCILE_TOTAL_BYTES;
  const parsed = Number(String(raw ?? '').trim());
  if (Number.isInteger(parsed) && parsed >= 1024 && parsed <= 50 * 1024 * 1024) return parsed;
  return 5 * 1024 * 1024;
})();

/** Test/inspect helper — resolved host-local scan chunk. */
export const getInnerSessionTurnScanLimit = () => _inner_scanLimit;

const MESSAGE_ID_MIN = 1;
const MESSAGE_ID_MAX = 512;
const SESSION_ID_MIN = 1;
const SESSION_ID_MAX = 512;
const FILE_PATH_MIN = 1;
const FILE_PATH_MAX = 4096;
const EXACT_MESSAGE_TIMEOUT_MS = 45_000;
const CHANGES_TIMEOUT_MS = 45_000;

/** Safe client-facing error strings — no paths, tokens, or upstream bodies. */
const SAFE_ERRORS = {
  invalid_turns: 'turns must be an integer between 1 and 10',
  invalid_scan_limit: 'scanLimit must be an integer between 10 and 200',
  invalid_session: 'sessionID is required',
  invalid_message: 'messageID is required',
  invalid_file: 'file is invalid',
  invalid_cursor: 'invalid cursor',
  invalid_anchor: 'anchor is required and must be a non-empty message id',
  invalid_continuation: 'invalid continuation',
  invalid_reconcile_params: 'provide exactly one of anchor or continuation',
  change_not_found: 'change file not found',
  upstream: 'upstream',
  unavailable: 'upstream unavailable',
  aborted: 'aborted',
  empty_page_with_cursor: 'empty page with cursor',
  duplicate_cursor: 'duplicate cursor',
  missing_id: 'upstream record missing id',
  max_scan_pages: 'scan page limit exceeded',
  max_scan_messages: 'scan message limit exceeded',
  too_large: 'payload too large',
  internal: 'internal error',
};

/** Reject control characters / NUL in change file selectors. */
const hasControlOrNul = (value) => {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0 || (code >= 1 && code <= 31) || code === 127) {
      return true;
    }
  }
  return false;
};

const isBoundedId = (value, { min = MESSAGE_ID_MIN, max = MESSAGE_ID_MAX } = {}) => (
  typeof value === 'string'
  && value.length >= min
  && value.length <= max
);

const parsePositiveInt = (value) => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isInteger(value) ? value : null;
  }
  if (typeof value !== 'string') return null;
  if (!/^-?\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
};

const parseBoundedInt = (raw, { min, max, fallback, whenMissing }) => {
  // Only truly omitted params use the default; empty string is invalid.
  if (raw === undefined || raw === null) {
    return { ok: true, value: whenMissing ?? fallback };
  }
  const parsed = parsePositiveInt(raw);
  if (parsed === null || parsed < min || parsed > max) {
    return { ok: false };
  }
  return { ok: true, value: parsed };
};

const timeoutSignal = (ms, parent) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  timer.unref?.();

  const onParentAbort = () => controller.abort();
  if (parent) {
    if (parent.aborted) {
      controller.abort();
    } else {
      parent.addEventListener('abort', onParentAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
      if (parent) parent.removeEventListener('abort', onParentAbort);
    },
  };
};

/**
 * Abort only when the client truly disconnects mid-flight:
 * - req aborted (or req.signal abort)
 * - res 'close' while the response has not ended (client hung up)
 *
 * A normal GET request 'close' after a completed response must not abort.
 */
const requestSignal = (req, res) => {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
  };

  if (req?.signal && typeof req.signal.aborted === 'boolean') {
    if (req.signal.aborted) {
      abort();
    } else {
      req.signal.addEventListener('abort', abort, { once: true });
    }
  }

  req?.once?.('aborted', abort);
  res?.once?.('close', () => {
    if (!res.writableEnded) abort();
  });

  return controller.signal;
};

const createSdkClient = ({ buildOpenCodeUrl, getOpenCodeAuthHeaders }) => {
  const baseUrl = buildOpenCodeUrl('/', '').replace(/\/$/, '');
  const headers = typeof getOpenCodeAuthHeaders === 'function' ? getOpenCodeAuthHeaders() : {};
  return createOpencodeClient({ baseUrl, headers });
};

const throwUpstream = (logger, label) => {
  logger?.warn?.(label);
  const error = new Error('upstream');
  error.code = 'upstream';
  throw error;
};

const createSdkFetchPage = ({ buildOpenCodeUrl, getOpenCodeAuthHeaders, logger }) => {
  return async ({ sessionID, directory, before, limit, signal }) => {
    const client = createSdkClient({ buildOpenCodeUrl, getOpenCodeAuthHeaders });

    const result = await client.session.messages({
      sessionID,
      ...(typeof directory === 'string' && directory.length > 0 ? { directory } : {}),
      ...(Number.isFinite(limit) ? { limit } : {}),
      ...(typeof before === 'string' && before.length > 0 ? { before } : {}),
    }, { signal });

    if (result?.error) {
      throwUpstream(logger, '[session-turn-pages] session.messages SDK error');
    }

    const data = result?.data;
    const records = Array.isArray(data)
      ? data
      : Array.isArray(data?.items)
        ? data.items
        : null;
    if (!records) {
      throwUpstream(logger, '[session-turn-pages] session.messages malformed payload');
    }

    const headerCursor = result?.response?.headers?.get?.('x-next-cursor');
    const nextCursor = typeof headerCursor === 'string' && headerCursor.length > 0
      ? headerCursor
      : null;

    return {
      records,
      nextCursor,
      complete: nextCursor == null,
    };
  };
};

const createSdkFetchMessage = ({ buildOpenCodeUrl, getOpenCodeAuthHeaders, logger }) => {
  return async ({ sessionID, messageID, directory, signal }) => {
    const client = createSdkClient({ buildOpenCodeUrl, getOpenCodeAuthHeaders });
    const result = await client.session.message({
      sessionID,
      messageID,
      ...(typeof directory === 'string' && directory.length > 0 ? { directory } : {}),
    }, { signal });

    if (result?.error) {
      const status = result?.response?.status;
      if (status === 404) {
        const error = new Error('not_found');
        error.code = 'not_found';
        throw error;
      }
      throwUpstream(logger, '[session-turn-pages] session.message SDK error');
    }

    const data = result?.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throwUpstream(logger, '[session-turn-pages] session.message malformed payload');
    }
    return data;
  };
};

const createSdkFetchDiff = ({ buildOpenCodeUrl, getOpenCodeAuthHeaders, logger }) => {
  return async ({ sessionID, messageID, directory, signal }) => {
    const client = createSdkClient({ buildOpenCodeUrl, getOpenCodeAuthHeaders });
    const result = await client.session.diff({
      sessionID,
      messageID,
      ...(typeof directory === 'string' && directory.length > 0 ? { directory } : {}),
    }, { signal });

    if (result?.error) {
      throwUpstream(logger, '[session-changes] session.diff SDK error');
    }

    const data = result?.data;
    if (!Array.isArray(data)) {
      throwUpstream(logger, '[session-changes] session.diff malformed payload');
    }
    return data;
  };
};

/**
 * Project exact message GET payload: keep original `{ info, parts }` shape,
 * only L1-project `info.summary.diffs` → diffCount/hasDiffs.
 */
export const projectExactMessagePayload = (payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }
  if (payload.info && typeof payload.info === 'object' && !Array.isArray(payload.info)) {
    const nextInfo = projectMessageSummaryDiffCounts(payload.info);
    if (nextInfo === payload.info) return payload;
    return { ...payload, info: nextInfo };
  }
  return projectMessageSummaryDiffCounts(payload);
};

const mapServiceError = (error) => {
  const code = typeof error === 'string' ? error : String(error ?? 'upstream');
  if (
    code === 'max_scan_pages'
    || code === 'max_scan_messages'
    || code === 'too_large'
    || code === 'scan_limit'
  ) {
    return {
      status: 413,
      body: {
        error: SAFE_ERRORS[code] ?? SAFE_ERRORS.too_large,
        code,
      },
    };
  }
  if (code === 'aborted') {
    return { status: 499, body: { error: SAFE_ERRORS.aborted } };
  }
  if (code === 'unavailable') {
    return { status: 503, body: { error: SAFE_ERRORS.unavailable } };
  }
  if (
    code === 'duplicate_cursor'
    || code === 'empty_page_with_cursor'
    || code === 'missing_id'
  ) {
    return {
      status: 502,
      body: { error: SAFE_ERRORS[code] ?? SAFE_ERRORS.upstream },
    };
  }
  if (code === 'invalid_session') {
    return { status: 400, body: { error: SAFE_ERRORS.invalid_session } };
  }
  if (code === 'invalid_cursor') {
    return { status: 400, body: { error: SAFE_ERRORS.invalid_cursor } };
  }
  if (code === 'invalid_anchor') {
    return { status: 400, body: { error: SAFE_ERRORS.invalid_anchor } };
  }
  if (code === 'invalid_continuation') {
    return { status: 400, body: { error: SAFE_ERRORS.invalid_continuation } };
  }
  if (code === 'invalid_reconcile_params') {
    return { status: 400, body: { error: SAFE_ERRORS.invalid_reconcile_params } };
  }
  if (code === 'invalid_message' || code === 'invalid_params') {
    return { status: 400, body: { error: SAFE_ERRORS.invalid_message, code: 'invalid_message' } };
  }
  if (code === 'invalid_file') {
    return { status: 400, body: { error: SAFE_ERRORS.invalid_file, code: 'invalid_file' } };
  }
  if (code === 'change_not_found') {
    return {
      status: 404,
      body: { error: SAFE_ERRORS.change_not_found, code: 'change_not_found' },
    };
  }
  if (code === 'not_found') {
    return { status: 404, body: { error: 'not found', code: 'not_found' } };
  }
  return { status: 502, body: { error: SAFE_ERRORS.upstream } };
};

/**
 * Safe server-error log: full stack, no auth headers, no message/parts content.
 */
const logInternalError = (logger, error, context = {}) => {
  const stack = typeof error?.stack === 'string'
    ? error.stack
    : String(error?.message ?? error ?? 'unknown');
  const safeContext = {
    sessionID: typeof context.sessionID === 'string' ? context.sessionID : undefined,
    hasAnchor: context.hasAnchor === true,
    hasContinuation: context.hasContinuation === true,
    hasDirectory: context.hasDirectory === true,
  };
  logger?.error?.('[session-turn-pages] reconcile internal error', {
    ...safeContext,
    stack,
  });
};

/**
 * Register OpenChamber-owned session message routes:
 * - GET /api/openchamber/sessions/:sessionID/messages
 * - GET /api/openchamber/sessions/:sessionID/messages/reconcile
 * - GET /api/openchamber/sessions/:sessionID/changes
 * - GET /api/session/:sessionID/message/:messageID  (L1 exact message; before proxy)
 *
 * Global /api auth is enforced by core-routes requireApiAuth before feature
 * routes. This module does not add redundant auth middleware.
 *
 * Must be registered before the generic OpenCode proxy so the OpenChamber-owned
 * paths are not forwarded upstream. The more-specific reconcile path is
 * registered first for match-order clarity.
 */
export const registerSessionTurnPageRoutes = (app, dependencies = {}) => {
  const {
    sessionTurnPageService: injectedService,
    sessionReconcileService: injectedReconcileService,
    sessionChangesService: injectedChangesService,
    fetchExactMessage: injectedFetchExactMessage,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    logger = console,
    runtimeKey,
  } = dependencies;

  const resolvedRuntimeKey = typeof runtimeKey === 'string' && runtimeKey.length > 0
    ? runtimeKey
    : (process.env.OPENCHAMBER_RUNTIME || 'web');

  const needsDefaultFetch = !injectedService || !injectedReconcileService;
  const defaultFetchPage = needsDefaultFetch
    ? createSdkFetchPage({ buildOpenCodeUrl, getOpenCodeAuthHeaders, logger })
    : null;

  const service = injectedService ?? createSessionTurnPageService({
    fetchPage: defaultFetchPage,
  });

  const reconcileService = injectedReconcileService ?? createSessionReconcileService({
    fetchPage: defaultFetchPage,
    runtimeKey: resolvedRuntimeKey,
    pageRecordLimit: RECONCILE_PAGE_RECORD_LIMIT,
    pageByteLimit: RECONCILE_PAGE_BYTE_LIMIT,
    totalPageLimit: RECONCILE_TOTAL_PAGE_LIMIT,
    totalByteLimit: RECONCILE_TOTAL_BYTE_LIMIT,
    scanLimit: _inner_scanLimit,
  });

  const fetchExactMessage = injectedFetchExactMessage
    ?? createSdkFetchMessage({ buildOpenCodeUrl, getOpenCodeAuthHeaders, logger });

  const changesService = injectedChangesService ?? createSessionChangesService({
    fetchMessage: fetchExactMessage,
    fetchDiff: createSdkFetchDiff({ buildOpenCodeUrl, getOpenCodeAuthHeaders, logger }),
    logger,
  });

  // More-specific path first (before generic messages route).
  app.get('/api/openchamber/sessions/:sessionID/messages/reconcile', async (req, res) => {
    const sessionID = req.params?.sessionID;
    if (typeof sessionID !== 'string' || sessionID.length === 0) {
      return res.status(400).json({ error: SAFE_ERRORS.invalid_session });
    }

    const anchorRaw = req.query?.anchor;
    const continuationRaw = req.query?.continuation;
    const hasAnchor = typeof anchorRaw === 'string' && anchorRaw.length > 0;
    const hasContinuation = typeof continuationRaw === 'string' && continuationRaw.length > 0;

    if (hasAnchor && hasContinuation) {
      return res.status(400).json({ error: SAFE_ERRORS.invalid_reconcile_params });
    }
    if (!hasAnchor && !hasContinuation) {
      return res.status(400).json({ error: SAFE_ERRORS.invalid_reconcile_params });
    }
    if (hasAnchor && anchorRaw.length > MAX_ANCHOR_LENGTH) {
      return res.status(400).json({ error: SAFE_ERRORS.invalid_anchor });
    }
    if (hasContinuation && continuationRaw.length > MAX_CONTINUATION_LENGTH) {
      return res.status(400).json({ error: SAFE_ERRORS.invalid_continuation });
    }

    const directory = typeof req.query?.directory === 'string' && req.query.directory.length > 0
      ? req.query.directory
      : undefined;

    const parentSignal = requestSignal(req, res);
    const timed = timeoutSignal(RECONCILE_TIMEOUT_MS, parentSignal);

    try {
      const result = await reconcileService.reconcile({
        sessionID,
        directory,
        ...(hasAnchor ? { anchor: anchorRaw } : {}),
        ...(hasContinuation ? { continuation: continuationRaw } : {}),
        signal: timed.signal,
      });

      if (!result?.ok) {
        const mapped = mapServiceError(result?.error);
        return res.status(mapped.status).json(mapped.body);
      }

      return res.status(200).json({
        records: projectMessageDiffSummaries(Array.isArray(result.records) ? result.records : []),
        anchorFound: result.anchorFound === true,
        capturedHeadMessageID: result.capturedHeadMessageID ?? null,
        latestHeadMessageID: result.latestHeadMessageID ?? null,
        continuation: result.continuation ?? null,
        complete: result.complete === true,
        resetRequired: result.resetRequired === true,
        scannedRecords: Number.isFinite(result.scannedRecords) ? result.scannedRecords : 0,
        responseBytes: Number.isFinite(result.responseBytes) ? result.responseBytes : 0,
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        if (!res.headersSent) {
          return res.status(499).json({ error: SAFE_ERRORS.aborted });
        }
        return undefined;
      }
      logInternalError(logger, error, {
        sessionID,
        hasAnchor,
        hasContinuation,
        hasDirectory: directory != null,
      });
      if (!res.headersSent) {
        return res.status(500).json({ error: SAFE_ERRORS.internal });
      }
      return undefined;
    } finally {
      timed.clear();
    }
  });

  app.get('/api/openchamber/sessions/:sessionID/messages', async (req, res) => {
    const sessionID = req.params?.sessionID;
    if (typeof sessionID !== 'string' || sessionID.length === 0) {
      return res.status(400).json({ error: SAFE_ERRORS.invalid_session });
    }

    const turnsResult = parseBoundedInt(req.query?.turns, {
      min: TURNS_MIN,
      max: TURNS_MAX,
      fallback: TURNS_DEFAULT,
      whenMissing: TURNS_DEFAULT,
    });
    if (!turnsResult.ok) {
      return res.status(400).json({ error: SAFE_ERRORS.invalid_turns });
    }

    const before = typeof req.query?.before === 'string' && req.query.before.length > 0
      ? req.query.before
      : undefined;
    const directory = typeof req.query?.directory === 'string' && req.query.directory.length > 0
      ? req.query.directory
      : undefined;

    // Width resolves as: explicit client override → env override → default.
    // Invalid explicit value → 400; empty string is invalid (not "missing").
    const scanLimitRaw = req.query?.scanLimit;
    const scanLimitResult = parseBoundedInt(scanLimitRaw, {
      min: SCAN_LIMIT_MIN,
      max: SCAN_LIMIT_MAX,
      fallback: _inner_scanLimit,
      whenMissing: _inner_scanLimit,
    });
    if (!scanLimitResult.ok) {
      return res.status(400).json({ error: SAFE_ERRORS.invalid_scan_limit });
    }
    const _inner_scanLimit_resolved = scanLimitResult.value;

    const parentSignal = requestSignal(req, res);
    const timed = timeoutSignal(PAGE_TIMEOUT_MS, parentSignal);

    try {
      const result = await service.loadPage({
        sessionID,
        turns: turnsResult.value,
        scanLimit: _inner_scanLimit_resolved,
        before,
        directory,
        signal: timed.signal,
      });

      if (!result?.ok) {
        const mapped = mapServiceError(result?.error);
        return res.status(mapped.status).json(mapped.body);
      }

      // Turn-page responses (first packet and prepend) share slim-v1.
      // Reconcile stays on the other route and keeps full parts.
      return res.status(200).json({
        records: projectSlimParts(result.records),
        turnCount: result.turnCount,
        cursor: result.cursor ?? null,
        complete: result.complete === true,
        partsProjection: SLIM_PARTS_PROJECTION,
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        if (!res.headersSent) {
          return res.status(499).json({ error: SAFE_ERRORS.aborted });
        }
        return undefined;
      }
      logger?.warn?.('[session-turn-pages] loadPage failed');
      if (!res.headersSent) {
        return res.status(502).json({ error: SAFE_ERRORS.upstream });
      }
      return undefined;
    } finally {
      timed.clear();
    }
  });

  /**
   * Exact message GET — registered before generic `/api` proxy so materialize /
   * recovery never relay a raw 14MB `summary.diffs` array. Returns the official
   * `{ info, parts }` shape with L1 summary projection only.
   */
  app.get('/api/session/:sessionID/message/:messageID', async (req, res) => {
    const sessionID = req.params?.sessionID;
    const messageID = req.params?.messageID;
    if (!isBoundedId(sessionID, { min: SESSION_ID_MIN, max: SESSION_ID_MAX })) {
      return res.status(400).json({ error: SAFE_ERRORS.invalid_session, code: 'invalid_session' });
    }
    if (!isBoundedId(messageID, { min: MESSAGE_ID_MIN, max: MESSAGE_ID_MAX })) {
      return res.status(400).json({ error: SAFE_ERRORS.invalid_message, code: 'invalid_message' });
    }

    const directory = typeof req.query?.directory === 'string' && req.query.directory.length > 0
      ? req.query.directory
      : undefined;

    const parentSignal = requestSignal(req, res);
    const timed = timeoutSignal(EXACT_MESSAGE_TIMEOUT_MS, parentSignal);

    try {
      const payload = await fetchExactMessage({
        sessionID,
        messageID,
        directory,
        signal: timed.signal,
      });
      return res.status(200).json(projectExactMessagePayload(payload));
    } catch (error) {
      if (error?.name === 'AbortError' || error?.code === 'aborted') {
        if (!res.headersSent) {
          return res.status(499).json({ error: SAFE_ERRORS.aborted });
        }
        return undefined;
      }
      if (error?.code === 'not_found') {
        if (!res.headersSent) {
          return res.status(404).json({ error: 'not found', code: 'not_found' });
        }
        return undefined;
      }
      logger?.warn?.('[session-turn-pages] exact message failed', {
        sessionID,
        messageID,
        hasDirectory: directory != null,
      });
      if (!res.headersSent) {
        return res.status(502).json({ error: SAFE_ERRORS.upstream });
      }
      return undefined;
    } finally {
      timed.clear();
    }
  });

  /**
   * Changes API — L2 file list (no `file`) or L3 single-file patch (`file=`).
   * Never returns the full message envelope or unrelated file patches.
   */
  app.get('/api/openchamber/sessions/:sessionID/changes', async (req, res) => {
    const sessionID = req.params?.sessionID;
    if (!isBoundedId(sessionID, { min: SESSION_ID_MIN, max: SESSION_ID_MAX })) {
      return res.status(400).json({ error: SAFE_ERRORS.invalid_session, code: 'invalid_session' });
    }

    const messageIDRaw = req.query?.messageID;
    if (!isBoundedId(messageIDRaw, { min: MESSAGE_ID_MIN, max: MESSAGE_ID_MAX })) {
      return res.status(400).json({ error: SAFE_ERRORS.invalid_message, code: 'invalid_message' });
    }

    const fileRaw = req.query?.file;
    let file;
    if (fileRaw !== undefined && fileRaw !== null && fileRaw !== '') {
      if (
        typeof fileRaw !== 'string'
        || fileRaw.length < FILE_PATH_MIN
        || fileRaw.length > FILE_PATH_MAX
        || hasControlOrNul(fileRaw)
      ) {
        return res.status(400).json({ error: SAFE_ERRORS.invalid_file, code: 'invalid_file' });
      }
      file = fileRaw;
    }

    const directory = typeof req.query?.directory === 'string' && req.query.directory.length > 0
      ? req.query.directory
      : undefined;

    const parentSignal = requestSignal(req, res);
    const timed = timeoutSignal(CHANGES_TIMEOUT_MS, parentSignal);

    try {
      const result = await changesService.loadChanges({
        sessionID,
        messageID: messageIDRaw,
        directory,
        file,
        signal: timed.signal,
      });

      if (!result?.ok) {
        const mapped = mapServiceError(result?.error);
        return res.status(mapped.status).json(mapped.body);
      }

      return res.status(200).json(result.body);
    } catch (error) {
      if (error?.name === 'AbortError') {
        if (!res.headersSent) {
          return res.status(499).json({ error: SAFE_ERRORS.aborted });
        }
        return undefined;
      }
      logger?.warn?.('[session-changes] loadChanges failed', {
        sessionID,
        messageID: messageIDRaw,
        hasDirectory: directory != null,
        hasFile: file != null,
      });
      if (!res.headersSent) {
        return res.status(502).json({ error: SAFE_ERRORS.upstream });
      }
      return undefined;
    } finally {
      timed.clear();
    }
  });
};
