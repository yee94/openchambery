import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { createSessionTurnPageService } from './service.js';

const TURNS_MIN = 1;
const TURNS_MAX = 10;
const TURNS_DEFAULT = 3;
const SCAN_LIMIT_MIN = 10;
const SCAN_LIMIT_MAX = 200;
const SCAN_LIMIT_DEFAULT = 100;

const PAGE_TIMEOUT_MS = 45_000;

/** Safe client-facing error strings — no paths, tokens, or upstream bodies. */
const SAFE_ERRORS = {
  invalid_turns: 'turns must be an integer between 1 and 10',
  invalid_scan_limit: 'scanLimit must be an integer between 10 and 200',
  invalid_session: 'sessionID is required',
  invalid_cursor: 'invalid cursor',
  upstream: 'upstream',
  aborted: 'aborted',
  empty_page_with_cursor: 'empty page with cursor',
  duplicate_cursor: 'duplicate cursor',
  missing_id: 'upstream record missing id',
  max_scan_pages: 'scan page limit exceeded',
  max_scan_messages: 'scan message limit exceeded',
  too_large: 'payload too large',
};

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

const createSdkFetchPage = ({ buildOpenCodeUrl, getOpenCodeAuthHeaders, logger }) => {
  return async ({ sessionID, directory, before, limit, signal }) => {
    const baseUrl = buildOpenCodeUrl('/', '').replace(/\/$/, '');
    const headers = typeof getOpenCodeAuthHeaders === 'function' ? getOpenCodeAuthHeaders() : {};
    const client = createOpencodeClient({ baseUrl, headers });

    const result = await client.session.messages({
      sessionID,
      ...(typeof directory === 'string' && directory.length > 0 ? { directory } : {}),
      ...(Number.isFinite(limit) ? { limit } : {}),
      ...(typeof before === 'string' && before.length > 0 ? { before } : {}),
    }, { signal });

    if (result?.error) {
      logger?.warn?.('[session-turn-pages] session.messages SDK error');
      const error = new Error('upstream');
      error.code = 'upstream';
      throw error;
    }

    const data = result?.data;
    const records = Array.isArray(data)
      ? data
      : Array.isArray(data?.items)
        ? data.items
        : null;
    if (!records) {
      logger?.warn?.('[session-turn-pages] session.messages malformed payload');
      const error = new Error('upstream');
      error.code = 'upstream';
      throw error;
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
  return { status: 502, body: { error: SAFE_ERRORS.upstream } };
};

/**
 * Register GET /api/openchamber/sessions/:sessionID/messages
 *
 * Global /api auth is enforced by core-routes requireApiAuth before feature
 * routes. This module does not add redundant auth middleware.
 *
 * Must be registered before the generic OpenCode proxy so the OpenChamber-owned
 * path is not forwarded upstream.
 */
export const registerSessionTurnPageRoutes = (app, dependencies = {}) => {
  const {
    sessionTurnPageService: injectedService,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    logger = console,
  } = dependencies;

  const service = injectedService ?? createSessionTurnPageService({
    fetchPage: createSdkFetchPage({ buildOpenCodeUrl, getOpenCodeAuthHeaders, logger }),
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

    const scanLimitResult = parseBoundedInt(req.query?.scanLimit, {
      min: SCAN_LIMIT_MIN,
      max: SCAN_LIMIT_MAX,
      fallback: SCAN_LIMIT_DEFAULT,
      whenMissing: SCAN_LIMIT_DEFAULT,
    });
    if (!scanLimitResult.ok) {
      return res.status(400).json({ error: SAFE_ERRORS.invalid_scan_limit });
    }

    const before = typeof req.query?.before === 'string' && req.query.before.length > 0
      ? req.query.before
      : undefined;
    const directory = typeof req.query?.directory === 'string' && req.query.directory.length > 0
      ? req.query.directory
      : undefined;

    const parentSignal = requestSignal(req, res);
    const timed = timeoutSignal(PAGE_TIMEOUT_MS, parentSignal);

    try {
      const result = await service.loadPage({
        sessionID,
        turns: turnsResult.value,
        scanLimit: scanLimitResult.value,
        before,
        directory,
        signal: timed.signal,
      });

      if (!result?.ok) {
        const mapped = mapServiceError(result?.error);
        return res.status(mapped.status).json(mapped.body);
      }

      return res.status(200).json({
        records: result.records,
        turnCount: result.turnCount,
        cursor: result.cursor ?? null,
        complete: result.complete === true,
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
};
