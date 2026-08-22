/**
 * Webview local route for GET `/api/openchamber/sessions/:id/changes`.
 *
 * Identify this OpenChamber-owned path ahead of the generic OpenCode proxy,
 * parse query (messageID, directory, optional file), dispatch
 * `api:session-turn-changes` bridge, and return `{ files }` or `{ diff }`.
 *
 * Non-GET → 405; illegal query → 400.
 */

const MESSAGE_ID_MIN = 1;
const MESSAGE_ID_MAX = 512;
const SESSION_ID_MIN = 1;
const SESSION_ID_MAX = 512;
const FILE_PATH_MIN = 1;
const FILE_PATH_MAX = 4096;

const SAFE_ERRORS = {
  invalid_session: 'sessionID is required',
  invalid_message: 'messageID is required',
  invalid_file: 'file is invalid',
  method_not_allowed: 'method not allowed',
  upstream: 'upstream',
  change_not_found: 'change file not found',
  not_found: 'not found',
  unavailable: 'OpenCode manager is unavailable',
  aborted: 'aborted',
} as const;

const ALLOWED_BRIDGE_ERROR_CODES = new Set<keyof typeof SAFE_ERRORS>([
  'invalid_session',
  'invalid_message',
  'invalid_file',
  'change_not_found',
  'not_found',
  'unavailable',
  'aborted',
  'upstream',
]);

const SESSION_TURN_CHANGES_PATH =
  /^\/api\/openchamber\/sessions\/([^/]+)\/changes\/?$/;

const hasControlOrNul = (value: string): boolean => {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    // Align with Web Host: NUL, C0 controls, and DEL (0x7f).
    if (code === 0 || (code >= 1 && code <= 31) || code === 127) return true;
  }
  return false;
};

const jsonResponse = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const isAbortError = (error: unknown): boolean => (
  (error instanceof DOMException && error.name === 'AbortError')
  || (error instanceof Error && error.name === 'AbortError')
);

const readBridgeFailureData = (
  error: unknown,
): { code?: string; status?: number } | undefined => {
  if (!error || typeof error !== 'object' || !('data' in error)) return undefined;
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  const code = typeof record.code === 'string' ? record.code : undefined;
  const status = typeof record.status === 'number' && Number.isFinite(record.status)
    ? record.status
    : undefined;
  if (code === undefined && status === undefined) return undefined;
  return { code, status };
};

const statusForBridgeErrorCode = (code: keyof typeof SAFE_ERRORS): number => {
  switch (code) {
    case 'invalid_session':
    case 'invalid_message':
    case 'invalid_file':
      return 400;
    case 'change_not_found':
    case 'not_found':
      return 404;
    case 'unavailable':
      return 503;
    case 'aborted':
      return 499;
    default:
      return 502;
  }
};

const mapBridgeRejectToResponse = (error: unknown): Response => {
  if (isAbortError(error)) {
    return jsonResponse({ error: SAFE_ERRORS.aborted, code: 'aborted' }, 499);
  }

  const failure = readBridgeFailureData(error);
  const rawCode = failure?.code;
  const code = rawCode && ALLOWED_BRIDGE_ERROR_CODES.has(rawCode as keyof typeof SAFE_ERRORS)
    ? (rawCode as keyof typeof SAFE_ERRORS)
    : 'upstream';
  const message = SAFE_ERRORS[code];
  const expectedStatus = statusForBridgeErrorCode(code);
  const status = typeof failure?.status === 'number' && failure.status === expectedStatus
    ? failure.status
    : expectedStatus;

  return jsonResponse({ error: message, code }, status);
};

const isBoundedId = (
  value: string,
  { min, max }: { min: number; max: number },
): boolean => (
  value.length >= min
  && value.length <= max
  && !hasControlOrNul(value)
);

export const isSessionTurnChangesRoute = (pathname: string): boolean => {
  if (typeof pathname !== 'string' || pathname.length === 0) return false;
  const normalized = pathname.replace(/\/+$/, '') || '/';
  const match = normalized.match(/^\/api\/openchamber\/sessions\/([^/]+)\/changes$/);
  return match != null && match[1].length > 0;
};

export type SessionTurnChangesQuerySuccess = {
  ok: true;
  sessionID: string;
  messageID: string;
  directory?: string;
  file?: string;
};

export type SessionTurnChangesQueryFailure = {
  ok: false;
  error: string;
  code: string;
};

export type SessionTurnChangesQuery =
  | SessionTurnChangesQuerySuccess
  | SessionTurnChangesQueryFailure;

export const parseSessionTurnChangesQuery = (
  pathname: string,
  searchParams: URLSearchParams,
): SessionTurnChangesQuery => {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  const match = normalized.match(SESSION_TURN_CHANGES_PATH);
  if (!match || !match[1]) {
    return { ok: false, error: SAFE_ERRORS.invalid_session, code: 'invalid_session' };
  }

  let sessionID: string;
  try {
    sessionID = decodeURIComponent(match[1]);
  } catch {
    return { ok: false, error: SAFE_ERRORS.invalid_session, code: 'invalid_session' };
  }
  if (!isBoundedId(sessionID, { min: SESSION_ID_MIN, max: SESSION_ID_MAX })) {
    return { ok: false, error: SAFE_ERRORS.invalid_session, code: 'invalid_session' };
  }

  const messageIDRaw = searchParams.get('messageID');
  if (messageIDRaw === null || messageIDRaw === '') {
    return { ok: false, error: SAFE_ERRORS.invalid_message, code: 'invalid_message' };
  }
  if (!isBoundedId(messageIDRaw, { min: MESSAGE_ID_MIN, max: MESSAGE_ID_MAX })) {
    return { ok: false, error: SAFE_ERRORS.invalid_message, code: 'invalid_message' };
  }

  const fileRaw = searchParams.get('file');
  let file: string | undefined;
  if (fileRaw !== null && fileRaw !== '') {
    if (
      fileRaw.length < FILE_PATH_MIN
      || fileRaw.length > FILE_PATH_MAX
      || hasControlOrNul(fileRaw)
    ) {
      return { ok: false, error: SAFE_ERRORS.invalid_file, code: 'invalid_file' };
    }
    file = fileRaw;
  }

  const directoryRaw = searchParams.get('directory');
  const directory =
    typeof directoryRaw === 'string' && directoryRaw.length > 0 ? directoryRaw : undefined;

  return {
    ok: true,
    sessionID,
    messageID: messageIDRaw,
    directory,
    ...(file !== undefined ? { file } : {}),
  };
};

export type SessionTurnChangesRouteInput = {
  method: string;
  pathname: string;
  searchParams: URLSearchParams;
  sendBridgeMessage: (type: string, payload?: unknown) => Promise<unknown>;
};

/**
 * Handle GET `/api/openchamber/sessions/:id/changes` in the webview fetch layer.
 * Callers must check `isSessionTurnChangesRoute` before falling through to api:proxy.
 */
export const handleSessionTurnChangesRoute = async (
  input: SessionTurnChangesRouteInput,
): Promise<Response> => {
  const method = (input.method || 'GET').toUpperCase();
  if (method !== 'GET') {
    return jsonResponse({ error: SAFE_ERRORS.method_not_allowed }, 405);
  }

  const parsed = parseSessionTurnChangesQuery(input.pathname, input.searchParams);
  if (!parsed.ok) {
    return jsonResponse({ error: parsed.error, code: parsed.code }, 400);
  }

  try {
    const data = await input.sendBridgeMessage('api:session-turn-changes', {
      sessionID: parsed.sessionID,
      messageID: parsed.messageID,
      directory: parsed.directory,
      file: parsed.file,
    });
    return jsonResponse(data, 200);
  } catch (error) {
    return mapBridgeRejectToResponse(error);
  }
};
