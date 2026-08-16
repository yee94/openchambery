/**
 * Bridge handler for `api:session-turn-page`.
 *
 * Reads OpenCode base URL + auth from the manager, requests official
 * `/session/:id/message?limit=&before=&directory=`, reads `x-next-cursor`,
 * and aggregates via session-turn-page-runtime into unified JSON
 * `{ records, cursor, complete, turnCount }`.
 *
 * Never logs message contents, tokens, or secrets.
 */

import type { BridgeContext, BridgeResponse } from './bridge';
import {
  createSessionTurnPageService,
  projectSlimParts,
  type SessionTurnPageFetchInput,
  type SessionTurnPageFetchResult,
  SLIM_PARTS_PROJECTION,
} from './session-turn-page-runtime';

const DEFAULT_TURNS = 3;
const DEFAULT_SCAN_LIMIT = 100;
const TURNS_MIN = 1;
const TURNS_MAX = 10;
const SCAN_LIMIT_MIN = 10;
const SCAN_LIMIT_MAX = 200;
/**
 * Explicit operator override from env, or null when unset/invalid.
 * Kept separate from the resolved default so per-path policy can tell
 * "operator chose 100" apart from "nobody chose anything".
 */
const _inner_scanLimitEnv = (() => {
  const raw = typeof process !== 'undefined' ? process.env?.OPENCHAMBER_SESSION_TURN_SCAN_LIMIT : undefined;
  if (raw === undefined || raw === null || raw === '') return null;
  const parsed = Number(String(raw).trim());
  if (!Number.isInteger(parsed) || parsed < SCAN_LIMIT_MIN || parsed > SCAN_LIMIT_MAX) {
    return null;
  }
  return parsed;
})();

/** Whole aggregation timeout — matches web host PAGE_TIMEOUT_MS. */
const PAGE_TIMEOUT_MS = 45_000;

/** Safe client-facing error strings — no paths, tokens, or upstream bodies. */
const SAFE_ERRORS: Record<string, string> = {
  invalid_session: 'sessionID is required',
  invalid_turns: 'turns must be an integer between 1 and 10',
  invalid_scan_limit: 'scanLimit must be an integer between 10 and 200',
  invalid_cursor: 'invalid cursor',
  unavailable: 'OpenCode manager is unavailable',
  upstream: 'upstream',
  aborted: 'aborted',
  empty_page_with_cursor: 'empty page with cursor',
  duplicate_cursor: 'duplicate cursor',
  max_scan_pages: 'scan page limit exceeded',
  max_scan_messages: 'scan message limit exceeded',
  too_large: 'payload too large',
};

type BridgeMessageInput = {
  id: string;
  type: string;
  payload?: unknown;
};

type TurnPagePayload = {
  sessionID?: unknown;
  directory?: unknown;
  turns?: unknown;
  scanLimit?: unknown;
  before?: unknown;
};

const parsePositiveInt = (value: unknown): number | null => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isInteger(value) ? value : null;
  }
  if (typeof value !== 'string') return null;
  if (!/^-?\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
};

const parseBoundedInt = (
  raw: unknown,
  { min, max, fallback }: { min: number; max: number; fallback: number },
): { ok: true; value: number } | { ok: false } => {
  if (raw === undefined || raw === null) {
    return { ok: true, value: fallback };
  }
  const parsed = parsePositiveInt(raw);
  if (parsed === null || parsed < min || parsed > max) {
    return { ok: false };
  }
  return { ok: true, value: parsed };
};

const timeoutSignal = (ms: number) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  // Avoid keeping the process alive solely for this timer in Node/Electron.
  (timer as { unref?: () => void }).unref?.();
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
    },
  };
};

const createManagerFetchPage = (ctx: BridgeContext | undefined) => {
  return async ({
    sessionID,
    directory,
    before,
    limit,
    signal,
  }: SessionTurnPageFetchInput): Promise<SessionTurnPageFetchResult> => {
    const apiUrl = ctx?.manager?.getApiUrl?.();
    if (typeof apiUrl !== 'string' || apiUrl.length === 0) {
      const error = new Error('unavailable');
      (error as Error & { code?: string }).code = 'unavailable';
      throw error;
    }

    const base = apiUrl.replace(/\/+$/, '');
    const url = new URL(`${base}/session/${encodeURIComponent(sessionID)}/message`);
    if (Number.isFinite(limit)) {
      url.searchParams.set('limit', String(Math.floor(limit as number)));
    }
    if (typeof before === 'string' && before.length > 0) {
      url.searchParams.set('before', before);
    }
    if (typeof directory === 'string' && directory.length > 0) {
      url.searchParams.set('directory', directory);
    }

    const authHeaders =
      typeof ctx?.manager?.getOpenCodeAuthHeaders === 'function'
        ? ctx.manager.getOpenCodeAuthHeaders()
        : {};

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...authHeaders,
      },
      signal,
    });

    if (!response.ok) {
      const error = new Error('upstream');
      (error as Error & { code?: string }).code = 'upstream';
      throw error;
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      const error = new Error('upstream');
      (error as Error & { code?: string }).code = 'upstream';
      throw error;
    }

    const records = Array.isArray(data)
      ? data
      : data && typeof data === 'object' && Array.isArray((data as { items?: unknown }).items)
        ? (data as { items: unknown[] }).items
        : null;
    if (!records) {
      const error = new Error('upstream');
      (error as Error & { code?: string }).code = 'upstream';
      throw error;
    }

    const headerCursor = response.headers.get('x-next-cursor');
    const nextCursor =
      typeof headerCursor === 'string' && headerCursor.length > 0 ? headerCursor : null;

    return {
      records,
      nextCursor,
      complete: nextCursor == null,
    };
  };
};

const mapServiceError = (error: string): string => {
  if (error === 'max_scan_pages' || error === 'max_scan_messages' || error === 'too_large') {
    return SAFE_ERRORS[error] ?? SAFE_ERRORS.too_large;
  }
  if (error === 'duplicate_cursor' || error === 'empty_page_with_cursor') {
    return SAFE_ERRORS[error] ?? SAFE_ERRORS.upstream;
  }
  if (error === 'invalid_cursor') {
    return SAFE_ERRORS.invalid_cursor;
  }
  if (error === 'invalid_session') {
    return SAFE_ERRORS.invalid_session;
  }
  if (error === 'aborted') {
    return SAFE_ERRORS.aborted;
  }
  if (error === 'unavailable') {
    return SAFE_ERRORS.unavailable;
  }
  return SAFE_ERRORS.upstream;
};

/**
 * Handle `api:session-turn-page` bridge messages.
 * Returns null for all other types (no side effects).
 */
export async function handleSessionTurnPageBridgeMessage(
  message: BridgeMessageInput,
  ctx: BridgeContext | undefined,
): Promise<BridgeResponse | null> {
  const { id, type, payload } = message;

  if (type !== 'api:session-turn-page') {
    return null;
  }

  const body = (payload || {}) as TurnPagePayload;

  const sessionID = typeof body.sessionID === 'string' ? body.sessionID : '';
  if (!sessionID) {
    return {
      id,
      type,
      success: false,
      error: SAFE_ERRORS.invalid_session,
    };
  }

  const turnsResult = parseBoundedInt(body.turns, {
    min: TURNS_MIN,
    max: TURNS_MAX,
    fallback: DEFAULT_TURNS,
  });
  if (!turnsResult.ok) {
    return {
      id,
      type,
      success: false,
      error: SAFE_ERRORS.invalid_turns,
    };
  }

  const before =
    typeof body.before === 'string' && body.before.length > 0 ? body.before : undefined;
  const directory =
    typeof body.directory === 'string' && body.directory.length > 0
      ? body.directory
      : undefined;

  // Width resolves as: explicit client override → env override → default.
  const scanLimitResult = parseBoundedInt(body.scanLimit, {
    min: SCAN_LIMIT_MIN,
    max: SCAN_LIMIT_MAX,
    fallback: _inner_scanLimitEnv ?? DEFAULT_SCAN_LIMIT,
  });
  if (!scanLimitResult.ok) {
    return {
      id,
      type,
      success: false,
      error: SAFE_ERRORS.invalid_scan_limit,
    };
  }
  const _inner_scanLimit_resolved = scanLimitResult.value;

  const apiUrl = ctx?.manager?.getApiUrl?.();
  if (typeof apiUrl !== 'string' || apiUrl.length === 0) {
    return {
      id,
      type,
      success: false,
      error: SAFE_ERRORS.unavailable,
    };
  }

  const timed = timeoutSignal(PAGE_TIMEOUT_MS);
  try {
    const service = createSessionTurnPageService({
      fetchPage: createManagerFetchPage(ctx),
    });

    const result = await service.loadPage({
      sessionID,
      turns: turnsResult.value,
      scanLimit: _inner_scanLimit_resolved,
      before,
      directory,
      signal: timed.signal,
    });

    if (!result.ok) {
      return {
        id,
        type,
        success: false,
        error: mapServiceError(result.error),
      };
    }

    // Projection is first-packet only; prepend keeps full parts.
    const isFirstPacket = before === undefined;
    return {
      id,
      type,
      success: true,
      data: {
        records: isFirstPacket ? projectSlimParts(result.records) : result.records,
        turnCount: result.turnCount,
        cursor: result.cursor ?? null,
        complete: result.complete === true,
        partsProjection: isFirstPacket ? SLIM_PARTS_PROJECTION : null,
      },
    };
  } catch {
    return {
      id,
      type,
      success: false,
      error: SAFE_ERRORS.upstream,
    };
  } finally {
    timed.clear();
  }
}
