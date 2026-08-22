/**
 * Bridge handler for `api:session-turn-changes`.
 *
 * Reads OpenCode base URL + auth from the manager:
 * - L2 (no file): GET `/session/:id/message/:messageID`
 * - L3 (with file): GET `/session/:id/diff?messageID=`
 * Filters on Extension Host and returns `{ files }` or `{ diff }`.
 *
 * Never logs message contents, tokens, or secrets.
 */

import type { BridgeContext, BridgeResponse } from './bridge';
import {
  createSessionChangesService,
} from './session-turn-changes-runtime';

const MESSAGE_ID_MIN = 1;
const MESSAGE_ID_MAX = 512;
const SESSION_ID_MIN = 1;
const SESSION_ID_MAX = 512;
const FILE_PATH_MIN = 1;
const FILE_PATH_MAX = 4096;
const CHANGES_TIMEOUT_MS = 45_000;

const SAFE_ERRORS: Record<string, string> = {
  invalid_session: 'sessionID is required',
  invalid_message: 'messageID is required',
  invalid_file: 'file is invalid',
  invalid_params: 'messageID is required',
  change_not_found: 'change file not found',
  unavailable: 'OpenCode manager is unavailable',
  upstream: 'upstream',
  aborted: 'aborted',
  not_found: 'not found',
};

type BridgeMessageInput = {
  id: string;
  type: string;
  payload?: unknown;
};

type ChangesPayload = {
  sessionID?: unknown;
  messageID?: unknown;
  directory?: unknown;
  file?: unknown;
};

const hasControlOrNul = (value: string): boolean => {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    // Align with Web Host: NUL, C0 controls, and DEL (0x7f).
    if (code === 0 || (code >= 1 && code <= 31) || code === 127) return true;
  }
  return false;
};

const isBoundedId = (
  value: unknown,
  { min, max }: { min: number; max: number },
): value is string => (
  typeof value === 'string'
  && value.length >= min
  && value.length <= max
  && !hasControlOrNul(value)
);

const timeoutSignal = (ms: number) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  (timer as { unref?: () => void }).unref?.();
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
    },
  };
};

const createManagerFetchers = (ctx: BridgeContext | undefined) => {
  const resolveBase = () => {
    const apiUrl = ctx?.manager?.getApiUrl?.();
    if (typeof apiUrl !== 'string' || apiUrl.length === 0) {
      const error = new Error('unavailable');
      (error as Error & { code?: string }).code = 'unavailable';
      throw error;
    }
    return apiUrl.replace(/\/+$/, '');
  };

  const authHeaders = () => (
    typeof ctx?.manager?.getOpenCodeAuthHeaders === 'function'
      ? ctx.manager.getOpenCodeAuthHeaders()
      : {}
  );

  const fetchMessage = async ({
    sessionID,
    messageID,
    directory,
    signal,
  }: {
    sessionID: string;
    messageID: string;
    directory?: string;
    signal?: AbortSignal;
  }): Promise<unknown> => {
    const base = resolveBase();
    const url = new URL(
      `${base}/session/${encodeURIComponent(sessionID)}/message/${encodeURIComponent(messageID)}`,
    );
    if (typeof directory === 'string' && directory.length > 0) {
      url.searchParams.set('directory', directory);
    }

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...authHeaders(),
      },
      signal,
    });

    if (response.status === 404) {
      const error = new Error('not_found');
      (error as Error & { code?: string }).code = 'not_found';
      throw error;
    }
    if (!response.ok) {
      const error = new Error('upstream');
      (error as Error & { code?: string }).code = 'upstream';
      throw error;
    }

    try {
      return await response.json();
    } catch {
      const error = new Error('upstream');
      (error as Error & { code?: string }).code = 'upstream';
      throw error;
    }
  };

  const fetchDiff = async ({
    sessionID,
    messageID,
    directory,
    signal,
  }: {
    sessionID: string;
    messageID: string;
    directory?: string;
    signal?: AbortSignal;
  }): Promise<unknown> => {
    const base = resolveBase();
    const url = new URL(`${base}/session/${encodeURIComponent(sessionID)}/diff`);
    url.searchParams.set('messageID', messageID);
    if (typeof directory === 'string' && directory.length > 0) {
      url.searchParams.set('directory', directory);
    }

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...authHeaders(),
      },
      signal,
    });

    if (!response.ok) {
      const error = new Error('upstream');
      (error as Error & { code?: string }).code = 'upstream';
      throw error;
    }

    try {
      return await response.json();
    } catch {
      const error = new Error('upstream');
      (error as Error & { code?: string }).code = 'upstream';
      throw error;
    }
  };

  return { fetchMessage, fetchDiff };
};

const mapServiceError = (error: string): { statusHint?: number; message: string; code: string } => {
  if (error === 'change_not_found') {
    return { statusHint: 404, message: SAFE_ERRORS.change_not_found, code: 'change_not_found' };
  }
  if (error === 'not_found') {
    return { statusHint: 404, message: SAFE_ERRORS.not_found, code: 'not_found' };
  }
  if (error === 'invalid_params' || error === 'invalid_message') {
    return { statusHint: 400, message: SAFE_ERRORS.invalid_message, code: 'invalid_message' };
  }
  if (error === 'invalid_file') {
    return { statusHint: 400, message: SAFE_ERRORS.invalid_file, code: 'invalid_file' };
  }
  if (error === 'invalid_session') {
    return { statusHint: 400, message: SAFE_ERRORS.invalid_session, code: 'invalid_session' };
  }
  if (error === 'unavailable') {
    return { statusHint: 503, message: SAFE_ERRORS.unavailable, code: 'unavailable' };
  }
  if (error === 'aborted') {
    return { statusHint: 499, message: SAFE_ERRORS.aborted, code: 'aborted' };
  }
  return { statusHint: 502, message: SAFE_ERRORS.upstream, code: 'upstream' };
};

/**
 * Handle `api:session-turn-changes` bridge messages.
 * Returns null for all other types (no side effects).
 */
export async function handleSessionTurnChangesBridgeMessage(
  message: BridgeMessageInput,
  ctx: BridgeContext | undefined,
): Promise<BridgeResponse | null> {
  const { id, type, payload } = message;

  if (type !== 'api:session-turn-changes') {
    return null;
  }

  const body = (payload || {}) as ChangesPayload;

  if (!isBoundedId(body.sessionID, { min: SESSION_ID_MIN, max: SESSION_ID_MAX })) {
    return {
      id,
      type,
      success: false,
      error: SAFE_ERRORS.invalid_session,
      data: { code: 'invalid_session', status: 400 },
    };
  }

  if (!isBoundedId(body.messageID, { min: MESSAGE_ID_MIN, max: MESSAGE_ID_MAX })) {
    return {
      id,
      type,
      success: false,
      error: SAFE_ERRORS.invalid_message,
      data: { code: 'invalid_message', status: 400 },
    };
  }

  let file: string | undefined;
  if (body.file !== undefined && body.file !== null && body.file !== '') {
    if (
      typeof body.file !== 'string'
      || body.file.length < FILE_PATH_MIN
      || body.file.length > FILE_PATH_MAX
      || hasControlOrNul(body.file)
    ) {
      return {
        id,
        type,
        success: false,
        error: SAFE_ERRORS.invalid_file,
        data: { code: 'invalid_file', status: 400 },
      };
    }
    file = body.file;
  }

  const directory =
    typeof body.directory === 'string' && body.directory.length > 0
      ? body.directory
      : undefined;

  const apiUrl = ctx?.manager?.getApiUrl?.();
  if (typeof apiUrl !== 'string' || apiUrl.length === 0) {
    return {
      id,
      type,
      success: false,
      error: SAFE_ERRORS.unavailable,
      data: { code: 'unavailable', status: 503 },
    };
  }

  const timed = timeoutSignal(CHANGES_TIMEOUT_MS);
  try {
    const fetchers = createManagerFetchers(ctx);
    const service = createSessionChangesService(fetchers);
    const result = await service.loadChanges({
      sessionID: body.sessionID,
      messageID: body.messageID,
      directory,
      file,
      signal: timed.signal,
    });

    if (!result.ok) {
      const mapped = mapServiceError(result.error);
      return {
        id,
        type,
        success: false,
        error: mapped.message,
        data: { code: mapped.code, status: mapped.statusHint },
      };
    }

    return {
      id,
      type,
      success: true,
      data: result.body,
    };
  } catch {
    return {
      id,
      type,
      success: false,
      error: SAFE_ERRORS.upstream,
      data: { code: 'upstream', status: 502 },
    };
  } finally {
    timed.clear();
  }
}
