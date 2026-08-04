/**
 * Webview local route for GET `/api/openchamber/sessions/:id/messages`.
 *
 * Identify this OpenChamber-owned path ahead of the generic OpenCode proxy,
 * parse query (directory, before, turns, scanLimit), dispatch
 * `api:session-turn-page` bridge, and return unified turn-page JSON.
 *
 * Non-GET → 405; illegal query → 400 (bridge not called).
 */

const TURNS_MIN = 1;
const TURNS_MAX = 10;
const TURNS_DEFAULT = 3;
const SCAN_LIMIT_MIN = 10;
const SCAN_LIMIT_MAX = 200;
const SCAN_LIMIT_DEFAULT = 100;

/** Safe client-facing error strings — no paths, tokens, or upstream bodies. */
const SAFE_ERRORS = {
  invalid_turns: 'turns must be an integer between 1 and 10',
  invalid_scan_limit: 'scanLimit must be an integer between 10 and 200',
  invalid_session: 'sessionID is required',
  method_not_allowed: 'method not allowed',
  upstream: 'upstream',
} as const;

const SESSION_TURN_PAGE_PATH =
  /^\/api\/openchamber\/sessions\/([^/]+)\/messages\/?$/;

export const isSessionTurnPageRoute = (pathname: string): boolean => {
  if (typeof pathname !== 'string' || pathname.length === 0) return false;
  const normalized = pathname.replace(/\/+$/, '') || '/';
  // Reject empty session segments like /sessions//messages
  const match = normalized.match(/^\/api\/openchamber\/sessions\/([^/]+)\/messages$/);
  return match != null && match[1].length > 0;
};

const parsePositiveInt = (value: string | null): number | null => {
  if (value === null || value === '') return null;
  if (!/^-?\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
};

const parseBoundedInt = (
  raw: string | null,
  { min, max, fallback }: { min: number; max: number; fallback: number },
): { ok: true; value: number } | { ok: false } => {
  // Only truly omitted params use the default; empty string is invalid.
  if (raw === null) {
    return { ok: true, value: fallback };
  }
  if (raw === '') {
    return { ok: false };
  }
  const parsed = parsePositiveInt(raw);
  if (parsed === null || parsed < min || parsed > max) {
    return { ok: false };
  }
  return { ok: true, value: parsed };
};

export type SessionTurnPageQuerySuccess = {
  ok: true;
  sessionID: string;
  directory?: string;
  before?: string;
  turns: number;
  scanLimit?: number;
};

export type SessionTurnPageQueryFailure = {
  ok: false;
  error: string;
};

export type SessionTurnPageQuery = SessionTurnPageQuerySuccess | SessionTurnPageQueryFailure;

export const parseSessionTurnPageQuery = (
  pathname: string,
  searchParams: URLSearchParams,
): SessionTurnPageQuery => {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  const match = normalized.match(SESSION_TURN_PAGE_PATH);
  if (!match || !match[1]) {
    return { ok: false, error: SAFE_ERRORS.invalid_session };
  }

  let sessionID: string;
  try {
    sessionID = decodeURIComponent(match[1]);
  } catch {
    return { ok: false, error: SAFE_ERRORS.invalid_session };
  }
  if (!sessionID) {
    return { ok: false, error: SAFE_ERRORS.invalid_session };
  }

  const turnsResult = parseBoundedInt(searchParams.get('turns'), {
    min: TURNS_MIN,
    max: TURNS_MAX,
    fallback: TURNS_DEFAULT,
  });
  if (!turnsResult.ok) {
    return { ok: false, error: SAFE_ERRORS.invalid_turns };
  }

  const scanLimitRaw = searchParams.get('scanLimit');
  const scanLimitResult = parseBoundedInt(scanLimitRaw, {
    min: SCAN_LIMIT_MIN,
    max: SCAN_LIMIT_MAX,
    fallback: SCAN_LIMIT_DEFAULT,
  });
  if (!scanLimitResult.ok) {
    return { ok: false, error: SAFE_ERRORS.invalid_scan_limit };
  }

  const beforeRaw = searchParams.get('before');
  const before =
    typeof beforeRaw === 'string' && beforeRaw.length > 0 ? beforeRaw : undefined;

  const directoryRaw = searchParams.get('directory');
  const directory =
    typeof directoryRaw === 'string' && directoryRaw.length > 0 ? directoryRaw : undefined;

  return {
    ok: true,
    sessionID,
    directory,
    before,
    turns: turnsResult.value,
    // Always include resolved scanLimit so callers / tests see a concrete value
    // when present in query; default is still within 10..200.
    scanLimit: scanLimitResult.value,
  };
};

export type SessionTurnPageRouteInput = {
  method: string;
  pathname: string;
  searchParams: URLSearchParams;
  sendBridgeMessage: (type: string, payload?: unknown) => Promise<unknown>;
};

const jsonResponse = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/**
 * Handle GET `/api/openchamber/sessions/:id/messages` in the webview fetch layer.
 * Callers must check `isSessionTurnPageRoute` before falling through to api:proxy.
 */
export const handleSessionTurnPageRoute = async (
  input: SessionTurnPageRouteInput,
): Promise<Response> => {
  const method = (input.method || 'GET').toUpperCase();
  if (method !== 'GET') {
    return jsonResponse({ error: SAFE_ERRORS.method_not_allowed }, 405);
  }

  const parsed = parseSessionTurnPageQuery(input.pathname, input.searchParams);
  if (!parsed.ok) {
    return jsonResponse({ error: parsed.error }, 400);
  }

  try {
    const data = await input.sendBridgeMessage('api:session-turn-page', {
      sessionID: parsed.sessionID,
      directory: parsed.directory,
      turns: parsed.turns,
      scanLimit: parsed.scanLimit,
      before: parsed.before,
    });

    return jsonResponse(data, 200);
  } catch {
    return jsonResponse({ error: SAFE_ERRORS.upstream }, 502);
  }
};
