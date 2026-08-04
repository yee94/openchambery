/**
 * Session turn-page aggregation over official OpenCode session.messages pages.
 *
 * Upstream pages are chronological old→new within each page (OpenCode current
 * order, including the latest slice). Older pages are prepended (deduped,
 * order-preserving) until N authored user turn boundaries are collected or
 * history is exhausted.
 *
 * Host response `cursor` is a versioned opaque token (`oc1.` + base64url JSON)
 * encoding only { before: string|null, boundaryID: string } — the upstream
 * request-before of the page that held the earliest returned authored user,
 * and that user's message id. Clients pass it as `before=` on the next request.
 * Raw OpenCode SDK cursors may still be passed through as the first `before`.
 *
 * complete = upstreamComplete && selected.length === accumulated.length
 * (true only when nothing older was trimmed from the scanned window).
 */

const ASSISTANT_SESSION_DIVIDER_PREFIX = 'oc_asst_session_divider:';

const DEFAULT_MAX_SCAN_PAGES = 50;
const DEFAULT_MAX_SCAN_MESSAGES = 5000;
const DEFAULT_SCAN_LIMIT = 100;

/** Host-owned cursor version prefix. */
export const HOST_CURSOR_PREFIX = 'oc1.';

/** Reject absurdly long before tokens (host or raw). */
export const MAX_BEFORE_LENGTH = 8192;

const isSyntheticPart = (part) => {
  if (!part || typeof part !== 'object') return false;
  return Boolean(part.synthetic);
};

const hasPartType = (parts, type) =>
  Array.isArray(parts) && parts.some((part) => part && typeof part === 'object' && part.type === type);

const isHostedSessionDivider = (record) => {
  const id = record?.info?.id;
  return typeof id === 'string' && id.startsWith(ASSISTANT_SESSION_DIVIDER_PREFIX);
};

/**
 * Authored user turn boundary for pagination.
 * Role: clientRole ?? role must be user.
 * Excludes fully synthetic, subtask, compaction, and hosted session dividers.
 * Empty parts on a user message still count as an authored boundary.
 */
export const isUserAuthoredTurnBoundary = (record) => {
  if (!record || typeof record !== 'object') return false;
  if (isHostedSessionDivider(record)) return false;

  const info = record.info ?? {};
  const role = typeof info.clientRole === 'string' ? info.clientRole : info.role;
  if (role !== 'user') return false;

  const parts = record.parts;
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
export const selectTurnRecords = (timeline, turnLimit) => {
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

const recordId = (record) => {
  const id = record?.info?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
};

const countAuthoredBoundaries = (records) =>
  records.reduce((count, entry) => (isUserAuthoredTurnBoundary(entry) ? count + 1 : count), 0);

const earliestAuthoredUser = (records) => {
  for (const entry of records) {
    if (isUserAuthoredTurnBoundary(entry)) return entry;
  }
  return null;
};

const fail = (error) => ({ ok: false, error });

/**
 * Encode host-owned opaque cursor. Payload is only boundary location metadata —
 * never message content.
 *
 * @param {{ before: string | null, boundaryID: string }} payload
 * @returns {string}
 */
export const encodeHostCursor = ({ before, boundaryID }) => {
  const body = {
    v: 1,
    before: before == null ? null : String(before),
    boundaryID: String(boundaryID),
  };
  return HOST_CURSOR_PREFIX + Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
};

/**
 * Decode host-owned cursor. Returns { ok:false } for non-host tokens or bad shape.
 *
 * @param {string} token
 * @returns {{ ok: true, value: { before: string | null, boundaryID: string } } | { ok: false, error: string }}
 */
export const decodeHostCursor = (token) => {
  if (typeof token !== 'string' || !token.startsWith(HOST_CURSOR_PREFIX)) {
    return { ok: false, error: 'invalid_cursor' };
  }
  const encoded = token.slice(HOST_CURSOR_PREFIX.length);
  if (encoded.length === 0 || token.length > MAX_BEFORE_LENGTH) {
    return { ok: false, error: 'invalid_cursor' };
  }
  let parsed;
  try {
    const json = Buffer.from(encoded, 'base64url').toString('utf8');
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: 'invalid_cursor' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'invalid_cursor' };
  }
  if (parsed.v !== 1) {
    return { ok: false, error: 'invalid_cursor' };
  }
  const { before, boundaryID } = parsed;
  if (typeof boundaryID !== 'string' || boundaryID.length === 0) {
    return { ok: false, error: 'invalid_cursor' };
  }
  if (before !== null && typeof before !== 'string') {
    return { ok: false, error: 'invalid_cursor' };
  }
  if (typeof before === 'string' && before.length === 0) {
    return { ok: false, error: 'invalid_cursor' };
  }
  // Reject unexpected keys that could smuggle content later — only allow known fields.
  const keys = Object.keys(parsed);
  for (const key of keys) {
    if (key !== 'v' && key !== 'before' && key !== 'boundaryID') {
      return { ok: false, error: 'invalid_cursor' };
    }
  }
  return { ok: true, value: { before: before ?? null, boundaryID } };
};

const isHostCursorToken = (token) =>
  typeof token === 'string' && token.startsWith(HOST_CURSOR_PREFIX);

/**
 * @param {{
 *   fetchPage: (input: {
 *     sessionID: string,
 *     directory?: string,
 *     before?: string,
 *     limit?: number,
 *     signal?: AbortSignal,
 *   }) => Promise<{ records: unknown[], nextCursor: string | null, complete?: boolean }>,
 *   maxScanPages?: number,
 *   maxScanMessages?: number,
 * }} options
 */
export const createSessionTurnPageService = ({
  fetchPage,
  maxScanPages = DEFAULT_MAX_SCAN_PAGES,
  maxScanMessages = DEFAULT_MAX_SCAN_MESSAGES,
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
  } = {}) => {
    if (typeof sessionID !== 'string' || sessionID.length === 0) {
      return fail('invalid_session');
    }

    const turnBudget = Number.isFinite(turns) ? Math.floor(turns) : 3;
    const pageLimit = Number.isFinite(scanLimit) ? Math.floor(scanLimit) : DEFAULT_SCAN_LIMIT;
    const pageCap = Number.isFinite(maxScanPages) ? Math.floor(maxScanPages) : DEFAULT_MAX_SCAN_PAGES;
    const messageCap = Number.isFinite(maxScanMessages) ? Math.floor(maxScanMessages) : DEFAULT_MAX_SCAN_MESSAGES;

    if (typeof initialBefore === 'string' && initialBefore.length > MAX_BEFORE_LENGTH) {
      return fail('invalid_cursor');
    }

    /** Host resume: first fetch uses token.raw before; keep only records before boundaryID. */
    let resumeBoundaryID = null;
    /** @type {string | undefined} upstream request-before for the next fetch */
    let before;
    if (typeof initialBefore === 'string' && initialBefore.length > 0) {
      if (isHostCursorToken(initialBefore)) {
        const decoded = decodeHostCursor(initialBefore);
        if (!decoded.ok) return fail('invalid_cursor');
        resumeBoundaryID = decoded.value.boundaryID;
        before = typeof decoded.value.before === 'string' && decoded.value.before.length > 0
          ? decoded.value.before
          : undefined;
      } else {
        // Raw OpenCode SDK cursor — pass through for the first request.
        before = initialBefore;
      }
    }

    /** @type {unknown[]} chronological oldest → newest */
    const accumulated = [];
    /** Parallel origin: request-before used when each accumulated record was fetched. */
    /** @type {(string | null)[]} */
    const accumulatedOrigins = [];
    const seen = new Set();
    let pagesFetched = 0;
    let messagesScanned = 0;
    let upstreamComplete = false;
    /** @type {Set<string>} cursors already requested — detect stalls */
    const requestedCursors = new Set();
    // Track requested before keys; host tokens are not re-used as fetch before.
    if (before) requestedCursors.add(before);
    // Also mark host token itself so a buggy nextCursor equal to it stalls cleanly.
    if (typeof initialBefore === 'string' && initialBefore.length > 0) {
      requestedCursors.add(initialBefore);
    }

    /** Whether the next fetch is the boundary-locate page (resume first round). */
    let pendingBoundarySlice = resumeBoundaryID != null;

    try {
      while (true) {
        if (pagesFetched >= pageCap) {
          return fail('max_scan_pages');
        }

        /** Origin for this page = the request-before used to fetch it (null = latest). */
        const pageOrigin = before ?? null;

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

        const records = Array.isArray(page.records) ? page.records : null;
        if (!records) {
          return fail('upstream');
        }

        const rawNext = page.nextCursor;
        const nextCursor = typeof rawNext === 'string' && rawNext.length > 0 ? rawNext : null;
        const pageComplete = page.complete === true || nextCursor == null;

        if (records.length === 0) {
          if (nextCursor) {
            return fail('empty_page_with_cursor');
          }
          // Empty exhausted page while still hunting a resume boundary → stale cursor.
          if (pendingBoundarySlice) {
            return fail('invalid_cursor');
          }
          upstreamComplete = true;
          break;
        }

        // Every upstream record must carry a non-empty info.id — no partial success.
        for (const entry of records) {
          if (!recordId(entry)) {
            return fail('missing_id');
          }
        }

        // No-progress: next cursor equals the request cursor, or re-offers a cursor we already requested.
        if (before && nextCursor === before) {
          return fail('duplicate_cursor');
        }
        if (nextCursor && requestedCursors.has(nextCursor) && nextCursor !== before) {
          // Cursor already used as a request — upstream is not advancing.
          return fail('duplicate_cursor');
        }

        /** @type {unknown[]} */
        let pageRecords = records;
        if (pendingBoundarySlice) {
          const boundaryIndex = records.findIndex((entry) => recordId(entry) === resumeBoundaryID);
          if (boundaryIndex < 0) {
            return fail('invalid_cursor');
          }
          // Keep only records strictly older than the boundary (old→new: slice(0, index)).
          // Boundary and everything newer are excluded (already returned to the client).
          pageRecords = records.slice(0, boundaryIndex);
          pendingBoundarySlice = false;
        }

        // Pages are already chronological old→new; prepend older pages after overlap dedupe.
        let added = 0;
        const prepend = [];
        const prependOrigins = [];
        for (const entry of pageRecords) {
          const id = recordId(entry);
          if (id && seen.has(id)) continue;
          if (id) seen.add(id);
          prepend.push(entry);
          prependOrigins.push(pageOrigin);
          added += 1;
        }

        // Overlap-only page that still claims more history is a stalled cursor.
        // Exception: after boundary slice the page may intentionally add 0 (boundary
        // was first on page) while nextCursor points at older history — continue.
        if (added === 0 && nextCursor && pageRecords.length === records.length) {
          return fail('duplicate_cursor');
        }

        messagesScanned += records.length;
        if (messagesScanned > messageCap) {
          return fail('max_scan_messages');
        }

        accumulated.unshift(...prepend);
        accumulatedOrigins.unshift(...prependOrigins);

        if (pageComplete) {
          upstreamComplete = true;
          break;
        }

        // Enough authored boundaries collected — stop without requiring exhaustion.
        if (countAuthoredBoundaries(accumulated) >= turnBudget) {
          break;
        }

        // Advance cursor to walk older history (nextCursor from upstream raw page).
        before = nextCursor;
        if (before) requestedCursors.add(before);
      }
    } catch (error) {
      if (error?.name === 'AbortError') {
        return fail('aborted');
      }
      return fail('upstream');
    }

    // Resume path still pending means we never successfully sliced the boundary page.
    if (pendingBoundarySlice) {
      return fail('invalid_cursor');
    }

    const selected = selectTurnRecords(accumulated, turnBudget);
    const turnCount = countAuthoredBoundaries(selected);
    // complete when upstream is exhausted and selectTurnRecords did not trim any
    // older scanned rows — nothing left for the client to request with before=.
    // If the scan window held more than N turns and older rows were dropped,
    // keep complete=false and expose a host cursor for the earliest selected user.
    const complete = upstreamComplete && selected.length === accumulated.length;

    let cursor = null;
    if (!complete) {
      const earliest = earliestAuthoredUser(selected);
      if (earliest) {
        const earliestId = recordId(earliest);
        // Find origin of the earliest selected authored user in accumulated.
        const accIndex = accumulated.findIndex((entry) => entry === earliest
          || recordId(entry) === earliestId);
        const origin = accIndex >= 0 ? accumulatedOrigins[accIndex] : null;
        if (earliestId) {
          cursor = encodeHostCursor({
            before: origin ?? null,
            boundaryID: earliestId,
          });
        }
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
