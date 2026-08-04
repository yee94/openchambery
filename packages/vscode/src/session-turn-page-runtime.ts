/**
 * Session turn-page aggregation over official OpenCode session.messages pages.
 *
 * Parity with packages/web/server/lib/session-turn-pages/service.js:
 * OpenCode pages are chronological within the page (oldest → newest). This
 * service prepends older pages (deduped, order-preserving) until N authored
 * user turn boundaries are collected or history is exhausted. complete is true
 * only when upstream is exhausted and selectTurnRecords did not trim overscan
 * (selected.length === accumulated.length).
 *
 * Client-facing `cursor` is an opaque Host token (`oc1.` + base64url JSON)
 * carrying the upstream request `before` of the page that held the boundary
 * plus `boundaryID`. Raw OpenCode cursors on the first request are passed
 * through. Resuming with a Host token re-fetches that origin page and keeps
 * only records strictly older than the boundary (slice(0, index)).
 */

const ASSISTANT_SESSION_DIVIDER_PREFIX = 'oc_asst_session_divider:';

const DEFAULT_MAX_SCAN_PAGES = 50;
const DEFAULT_MAX_SCAN_MESSAGES = 5000;
const DEFAULT_SCAN_LIMIT = 100;

/** Client `before` / Host token length cap (raw or encoded). */
const MAX_BEFORE_LENGTH = 4096;

const HOST_CURSOR_PREFIX = 'oc1.';

const isSyntheticPart = (part: unknown): boolean => {
  if (!part || typeof part !== 'object') return false;
  return Boolean((part as { synthetic?: unknown }).synthetic);
};

const hasPartType = (parts: unknown, type: string): boolean =>
  Array.isArray(parts)
  && parts.some((part) => part && typeof part === 'object' && (part as { type?: unknown }).type === type);

const isHostedSessionDivider = (record: unknown): boolean => {
  const id = (record as { info?: { id?: unknown } } | null)?.info?.id;
  return typeof id === 'string' && id.startsWith(ASSISTANT_SESSION_DIVIDER_PREFIX);
};

/**
 * Authored user turn boundary for pagination.
 * Role: clientRole ?? role must be user.
 * Excludes fully synthetic, subtask, compaction, and hosted session dividers.
 * Empty parts on a user message still count as an authored boundary.
 */
export const isUserAuthoredTurnBoundary = (record: unknown): boolean => {
  if (!record || typeof record !== 'object') return false;
  if (isHostedSessionDivider(record)) return false;

  const info = (record as { info?: Record<string, unknown> }).info ?? {};
  const role = typeof info.clientRole === 'string' ? info.clientRole : info.role;
  if (role !== 'user') return false;

  const parts = (record as { parts?: unknown }).parts;
  if (!Array.isArray(parts) || parts.length === 0) return true;

  if (hasPartType(parts, 'subtask')) return false;
  if (hasPartType(parts, 'compaction')) return false;

  // Fully synthetic (loop / plan / shell injection) is not a turn boundary.
  if (parts.every((part) => isSyntheticPart(part))) return false;

  return true;
};

/**
 * From a chronological (oldest→newest) timeline, return records starting at the
 * Nth-from-last authored user boundary through the end (keeps intermediate rows).
 */
export const selectTurnRecords = <T>(timeline: T[], turnLimit: number): T[] => {
  if (!Array.isArray(timeline) || timeline.length === 0) return [];
  const limit = Number.isFinite(turnLimit) && turnLimit > 0 ? Math.floor(turnLimit) : 0;
  if (limit <= 0) return [];

  let remaining = limit;
  let startIndex = 0;
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    if (!isUserAuthoredTurnBoundary(timeline[index])) continue;
    remaining -= 1;
    if (remaining === 0) {
      startIndex = index;
      break;
    }
  }
  // turnLimit exceeded available boundaries → full timeline
  if (remaining > 0) return timeline.slice();
  return timeline.slice(startIndex);
};

/** Require non-empty info.id — malformed records fail the whole aggregation. */
const recordInfoId = (record: unknown): string | null => {
  const id = (record as { info?: { id?: unknown } } | null)?.info?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
};

const countAuthoredBoundaries = (records: unknown[]): number =>
  records.reduce<number>((count, entry) => (isUserAuthoredTurnBoundary(entry) ? count + 1 : count), 0);

const earliestAuthoredUserId = (records: unknown[]): string | null => {
  for (const entry of records) {
    if (isUserAuthoredTurnBoundary(entry)) return recordInfoId(entry);
  }
  return null;
};

const fail = (error: string) => ({ ok: false as const, error });

export type HostCursorPayload = {
  /** Upstream request `before` of the page that contained the boundary (null = first page). */
  before: string | null;
  /** Authored user message id that is the turn-window start boundary. */
  boundaryID: string;
};

/**
 * Encode a versioned opaque Host cursor (`oc1.` + base64url JSON).
 * Exported for bridge/tests that need to assert token shape.
 */
export const encodeHostCursor = (payload: HostCursorPayload): string => {
  const body = JSON.stringify({
    before: payload.before ?? null,
    boundaryID: payload.boundaryID,
  });
  return `${HOST_CURSOR_PREFIX}${Buffer.from(body, 'utf8').toString('base64url')}`;
};

/**
 * Decode `oc1.` Host token. Returns null when the token is not a Host cursor
 * (caller should treat as raw OpenCode cursor). Returns `{ ok: false }` for
 * malformed Host tokens.
 */
export const decodeHostCursor = (
  token: string,
): { ok: true; payload: HostCursorPayload } | { ok: false; error: 'invalid_cursor' } | null => {
  if (typeof token !== 'string' || !token.startsWith(HOST_CURSOR_PREFIX)) {
    return null;
  }
  const encoded = token.slice(HOST_CURSOR_PREFIX.length);
  if (encoded.length === 0) {
    return { ok: false, error: 'invalid_cursor' };
  }
  try {
    const json = Buffer.from(encoded, 'base64url').toString('utf8');
    if (!json || json.length === 0) {
      return { ok: false, error: 'invalid_cursor' };
    }
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'invalid_cursor' };
    }
    const body = parsed as Record<string, unknown>;
    if (typeof body.boundaryID !== 'string' || body.boundaryID.length === 0) {
      return { ok: false, error: 'invalid_cursor' };
    }
    if (body.before !== null && typeof body.before !== 'string') {
      return { ok: false, error: 'invalid_cursor' };
    }
    if (typeof body.before === 'string' && body.before.length === 0) {
      return { ok: false, error: 'invalid_cursor' };
    }
    return {
      ok: true,
      payload: {
        before: body.before === null ? null : body.before,
        boundaryID: body.boundaryID,
      },
    };
  } catch {
    return { ok: false, error: 'invalid_cursor' };
  }
};

export type SessionTurnPageFetchInput = {
  sessionID: string;
  directory?: string;
  before?: string;
  limit?: number;
  signal?: AbortSignal;
};

export type SessionTurnPageFetchResult = {
  records: unknown[];
  nextCursor: string | null;
  complete?: boolean;
};

export type SessionTurnPageLoadInput = {
  sessionID?: string;
  turns?: number;
  scanLimit?: number;
  before?: string;
  directory?: string;
  signal?: AbortSignal;
};

export type SessionTurnPageSuccess = {
  ok: true;
  records: unknown[];
  turnCount: number;
  cursor: string | null;
  complete: boolean;
};

export type SessionTurnPageFailure = {
  ok: false;
  error: string;
};

export type SessionTurnPageResult = SessionTurnPageSuccess | SessionTurnPageFailure;

/**
 * @param options.fetchPage - loads one chronological OpenCode session.messages page
 * @param options.maxScanPages - hard page cap (default 50); no partial success
 * @param options.maxScanMessages - hard message cap (default 5000); no partial success
 */
export const createSessionTurnPageService = ({
  fetchPage,
  maxScanPages = DEFAULT_MAX_SCAN_PAGES,
  maxScanMessages = DEFAULT_MAX_SCAN_MESSAGES,
}: {
  fetchPage?: (input: SessionTurnPageFetchInput) => Promise<SessionTurnPageFetchResult>;
  maxScanPages?: number;
  maxScanMessages?: number;
} = {}) => {
  if (typeof fetchPage !== 'function') {
    throw new Error('createSessionTurnPageService requires fetchPage');
  }

  const loadPage = async ({
    sessionID,
    turns = 3,
    scanLimit = DEFAULT_SCAN_LIMIT,
    before: initialBefore,
    directory,
    signal,
  }: SessionTurnPageLoadInput = {}): Promise<SessionTurnPageResult> => {
    if (typeof sessionID !== 'string' || sessionID.length === 0) {
      return fail('invalid_session');
    }

    const turnBudget = Number.isFinite(turns) ? Math.floor(turns as number) : 3;
    const pageLimit = Number.isFinite(scanLimit) ? Math.floor(scanLimit as number) : DEFAULT_SCAN_LIMIT;
    const pageCap = Number.isFinite(maxScanPages) ? Math.floor(maxScanPages) : DEFAULT_MAX_SCAN_PAGES;
    const messageCap = Number.isFinite(maxScanMessages) ? Math.floor(maxScanMessages) : DEFAULT_MAX_SCAN_MESSAGES;

    /** chronological oldest → newest */
    const accumulated: unknown[] = [];
    const seen = new Set<string>();
    /** Per-record origin: the upstream request `before` used when the record was fetched. */
    const origins = new Map<string, string | null>();

    /** Host-token resume: re-fetch origin page and slice strictly older than boundary. */
    let hostResume: HostCursorPayload | null = null;
    let before: string | undefined;

    if (typeof initialBefore === 'string' && initialBefore.length > 0) {
      if (initialBefore.length > MAX_BEFORE_LENGTH) {
        return fail('invalid_cursor');
      }
      const decoded = decodeHostCursor(initialBefore);
      if (decoded && !decoded.ok) {
        return fail('invalid_cursor');
      }
      if (decoded?.ok) {
        hostResume = decoded.payload;
        before = decoded.payload.before ?? undefined;
      } else {
        // Raw OpenCode cursor — pass through on the first upstream request.
        before = initialBefore;
      }
    }

    let pagesFetched = 0;
    let messagesScanned = 0;
    let upstreamComplete = false;
    /** cursors already requested — detect stalls */
    const requestedCursors = new Set<string>();
    if (before) requestedCursors.add(before);
    let applyHostResume = hostResume != null;

    try {
      while (true) {
        if (pagesFetched >= pageCap) {
          return fail('max_scan_pages');
        }

        const requestBefore = before ?? null;

        const page = await fetchPage({
          sessionID,
          directory,
          before,
          limit: pageLimit,
          signal,
        });
        pagesFetched += 1;

        if (!page || typeof page !== 'object') {
          return fail('upstream');
        }

        const rawRecords = Array.isArray(page.records) ? page.records : null;
        if (!rawRecords) {
          return fail('upstream');
        }

        const rawNext = page.nextCursor;
        const nextCursor = typeof rawNext === 'string' && rawNext.length > 0 ? rawNext : null;
        const pageComplete = page.complete === true || nextCursor == null;

        if (rawRecords.length === 0) {
          if (nextCursor) {
            return fail('empty_page_with_cursor');
          }
          upstreamComplete = true;
          break;
        }

        // No-progress: next cursor equals the request cursor, or re-offers a cursor we already requested.
        if (before && nextCursor === before) {
          return fail('duplicate_cursor');
        }
        if (nextCursor && requestedCursors.has(nextCursor) && nextCursor !== before) {
          // Cursor already used as a request — upstream is not advancing.
          return fail('duplicate_cursor');
        }

        // Validate every raw upstream record has a non-empty info.id.
        for (const entry of rawRecords) {
          if (!recordInfoId(entry)) {
            return fail('upstream');
          }
        }

        // Host resume: keep only records strictly older than the boundary on this origin page.
        let records = rawRecords;
        if (applyHostResume && hostResume) {
          const boundaryIndex = rawRecords.findIndex(
            (entry) => recordInfoId(entry) === hostResume!.boundaryID,
          );
          if (boundaryIndex < 0) {
            return fail('invalid_cursor');
          }
          records = rawRecords.slice(0, boundaryIndex);
          applyHostResume = false;
        }

        // Empty after boundary slice is fine when more upstream history remains.
        if (records.length === 0) {
          messagesScanned += rawRecords.length;
          if (messagesScanned > messageCap) {
            return fail('max_scan_messages');
          }
          if (pageComplete) {
            upstreamComplete = true;
            break;
          }
          before = nextCursor ?? undefined;
          if (before) requestedCursors.add(before);
          continue;
        }

        // OpenCode page is already chronological (oldest → newest). Prepend into
        // the global timeline after dedupe by info.id.
        let added = 0;
        const prepend: unknown[] = [];
        for (const entry of records) {
          const id = recordInfoId(entry);
          if (!id) {
            return fail('upstream');
          }
          if (seen.has(id)) continue;
          seen.add(id);
          origins.set(id, requestBefore);
          prepend.push(entry);
          added += 1;
        }

        if (added === 0 && nextCursor) {
          // Overlap-only page that still claims more history is a stalled cursor.
          return fail('duplicate_cursor');
        }

        messagesScanned += rawRecords.length;
        if (messagesScanned > messageCap) {
          return fail('max_scan_messages');
        }

        accumulated.unshift(...prepend);

        if (pageComplete) {
          upstreamComplete = true;
          break;
        }

        // Enough authored boundaries collected — stop without requiring exhaustion.
        if (countAuthoredBoundaries(accumulated) >= turnBudget) {
          break;
        }

        // Advance cursor via raw upstream nextCursor (not Host token).
        before = nextCursor ?? undefined;
        if (before) requestedCursors.add(before);
      }
    } catch (error) {
      if (error && typeof error === 'object' && (error as { name?: string }).name === 'AbortError') {
        return fail('aborted');
      }
      return fail('upstream');
    }

    const selected = selectTurnRecords(accumulated, turnBudget);
    const turnCount = countAuthoredBoundaries(selected);
    // complete when upstream is exhausted and selectTurnRecords kept the full
    // accumulated window (no overscan trim). Overscan trim leaves older history
    // addressable via cursor even if the last upstream page reported complete.
    const complete = upstreamComplete && selected.length === accumulated.length;
    let cursor: string | null = null;
    if (!complete) {
      const boundaryID = earliestAuthoredUserId(selected);
      if (boundaryID) {
        const origin = origins.has(boundaryID) ? origins.get(boundaryID)! : null;
        cursor = encodeHostCursor({ before: origin, boundaryID });
      }
    }

    return {
      ok: true,
      records: selected,
      turnCount,
      cursor,
      complete,
    };
  };

  return { loadPage };
};
