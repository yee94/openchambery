/**
 * Host-owned anchor reconcile for session transcript recovery.
 *
 * Scans OpenCode session.messages from the current head toward older history
 * until the client anchor is found (or history/budget is exhausted). Returns
 * chronological gap records including the anchor's overlap turn so in-progress
 * assistant parts and finish updates can re-enter recovery merge.
 *
 * Continuation tokens bind runtime, directory, session, anchor, captured head,
 * and scan cursor — never message bodies or parts content. Tokens are HMAC-
 * signed (`ocr2`) with a short TTL so clients cannot forge scan progress.
 * Default secret is process-ephemeral: restart invalidates outstanding tokens.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Host-owned signed reconcile continuation version prefix. */
const CONTINUATION_PREFIX = 'ocr2.';

/** Legacy unsigned prefix — always rejected. */
const LEGACY_CONTINUATION_PREFIX = 'ocr1.';

/** Reject absurdly long continuation / before tokens. */
export const MAX_CONTINUATION_LENGTH = 8192;

/** Message id length guard for anchor query param. */
export const MAX_ANCHOR_LENGTH = 512;

const DEFAULT_SCAN_LIMIT = 100;
const DEFAULT_PAGE_RECORD_LIMIT = 100;
const DEFAULT_PAGE_BYTE_LIMIT = 512 * 1024;
const DEFAULT_TOTAL_PAGE_LIMIT = 20;
const DEFAULT_TOTAL_BYTE_LIMIT = 5 * 1024 * 1024;
/** Hard cap on upstream pages per single reconcile HTTP request. */
const DEFAULT_MAX_FETCH_PAGES_PER_REQUEST = 50;
/** Default continuation lifetime (ms). */
const DEFAULT_CONTINUATION_TTL_MS = 15 * 60 * 1000;

/**
 * Process-scoped signing key. Restart mints a new key → outstanding
 * continuations become invalid_continuation (client restarts from anchor).
 */
const PROCESS_CONTINUATION_SECRET = randomBytes(32);

const fail = (error) => ({ ok: false, error });

const recordId = (record) => {
  const id = record?.info?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
};

const measureRecordBytes = (record) => {
  try {
    return Buffer.byteLength(JSON.stringify(record), 'utf8');
  } catch {
    return 0;
  }
};

const measureRecordsBytes = (records) =>
  records.reduce((sum, entry) => sum + measureRecordBytes(entry), 0);

const normalizeDirectory = (directory) =>
  (typeof directory === 'string' && directory.length > 0 ? directory : null);

const resolveSecret = (secret) => {
  if (Buffer.isBuffer(secret) && secret.length > 0) return secret;
  if (typeof secret === 'string' && secret.length > 0) {
    return Buffer.from(secret, 'utf8');
  }
  return PROCESS_CONTINUATION_SECRET;
};

const resolveNowMs = (clock) => {
  if (typeof clock === 'function') {
    const value = clock();
    if (Number.isFinite(value)) return Math.floor(value);
  }
  return Date.now();
};

const resolveTtlMs = (ttlMs) => {
  if (Number.isFinite(ttlMs) && ttlMs > 0) return Math.floor(ttlMs);
  return DEFAULT_CONTINUATION_TTL_MS;
};

const signPayload = (encodedPayload, secret) =>
  createHmac('sha256', secret).update(encodedPayload, 'utf8').digest();

const macMatches = (expected, provided) => {
  if (!Buffer.isBuffer(expected) || !Buffer.isBuffer(provided)) return false;
  if (expected.length !== provided.length || expected.length === 0) return false;
  return timingSafeEqual(expected, provided);
};

/**
 * Encode host-owned signed opaque reconcile continuation.
 * Payload is only scan/binding metadata + iat/exp — never message content.
 *
 * Format: `ocr2.<base64url(json)>.<base64url(hmac-sha256)>`
 *
 * @param {{
 *   runtime: string,
 *   directory: string | null,
 *   sessionID: string,
 *   anchor: string,
 *   capturedHead: string,
 *   scanBefore: string | null,
 *   returnedThroughID: string | null,
 *   scannedRecords: number,
 *   scannedBytes: number,
 *   pagesEmitted: number,
 * }} payload
 * @param {{ secret?: Buffer | string, clock?: () => number, ttlMs?: number }} [options]
 * @returns {string}
 */
export const encodeReconcileContinuation = (payload, options = {}) => {
  const secret = resolveSecret(options.secret);
  const nowMs = resolveNowMs(options.clock);
  const ttlMs = resolveTtlMs(options.ttlMs);
  const iat = Math.floor(nowMs / 1000);
  const exp = Math.floor((nowMs + ttlMs) / 1000);

  const body = {
    v: 2,
    runtime: String(payload.runtime),
    directory: payload.directory == null ? null : String(payload.directory),
    sessionID: String(payload.sessionID),
    anchor: String(payload.anchor),
    capturedHead: String(payload.capturedHead),
    scanBefore: payload.scanBefore == null ? null : String(payload.scanBefore),
    returnedThroughID: payload.returnedThroughID == null
      ? null
      : String(payload.returnedThroughID),
    scannedRecords: Number(payload.scannedRecords) || 0,
    scannedBytes: Number(payload.scannedBytes) || 0,
    pagesEmitted: Number(payload.pagesEmitted) || 0,
    iat,
    exp,
  };
  const encodedPayload = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  const mac = signPayload(encodedPayload, secret).toString('base64url');
  return `${CONTINUATION_PREFIX}${encodedPayload}.${mac}`;
};

/**
 * Decode and verify host-owned signed reconcile continuation.
 * Rejects legacy `ocr1` (unsigned), bad MAC, wrong secret, expiry, and shape.
 *
 * @param {string} token
 * @param {{ secret?: Buffer | string, clock?: () => number }} [options]
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
export const decodeReconcileContinuation = (token, options = {}) => {
  if (typeof token !== 'string') {
    return { ok: false, error: 'invalid_continuation' };
  }
  if (token.length > MAX_CONTINUATION_LENGTH) {
    return { ok: false, error: 'invalid_continuation' };
  }
  // Explicitly reject legacy unsigned tokens.
  if (token.startsWith(LEGACY_CONTINUATION_PREFIX)) {
    return { ok: false, error: 'invalid_continuation' };
  }
  if (!token.startsWith(CONTINUATION_PREFIX)) {
    return { ok: false, error: 'invalid_continuation' };
  }

  const rest = token.slice(CONTINUATION_PREFIX.length);
  const lastDot = rest.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === rest.length - 1) {
    return { ok: false, error: 'invalid_continuation' };
  }
  const encodedPayload = rest.slice(0, lastDot);
  const encodedMac = rest.slice(lastDot + 1);
  if (encodedPayload.length === 0 || encodedMac.length === 0) {
    return { ok: false, error: 'invalid_continuation' };
  }

  let providedMac;
  try {
    providedMac = Buffer.from(encodedMac, 'base64url');
  } catch {
    return { ok: false, error: 'invalid_continuation' };
  }
  if (providedMac.length === 0) {
    return { ok: false, error: 'invalid_continuation' };
  }

  const secret = resolveSecret(options.secret);
  const expectedMac = signPayload(encodedPayload, secret);
  if (!macMatches(expectedMac, providedMac)) {
    return { ok: false, error: 'invalid_continuation' };
  }

  let parsed;
  try {
    const json = Buffer.from(encodedPayload, 'base64url').toString('utf8');
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: 'invalid_continuation' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'invalid_continuation' };
  }
  if (parsed.v !== 2) {
    return { ok: false, error: 'invalid_continuation' };
  }

  const requiredStrings = ['runtime', 'sessionID', 'anchor', 'capturedHead'];
  for (const key of requiredStrings) {
    if (typeof parsed[key] !== 'string' || parsed[key].length === 0) {
      return { ok: false, error: 'invalid_continuation' };
    }
  }

  const { directory, scanBefore, returnedThroughID } = parsed;
  if (directory !== null && typeof directory !== 'string') {
    return { ok: false, error: 'invalid_continuation' };
  }
  if (typeof directory === 'string' && directory.length === 0) {
    return { ok: false, error: 'invalid_continuation' };
  }
  if (scanBefore !== null && typeof scanBefore !== 'string') {
    return { ok: false, error: 'invalid_continuation' };
  }
  if (typeof scanBefore === 'string' && scanBefore.length === 0) {
    return { ok: false, error: 'invalid_continuation' };
  }
  if (returnedThroughID !== null && typeof returnedThroughID !== 'string') {
    return { ok: false, error: 'invalid_continuation' };
  }
  if (typeof returnedThroughID === 'string' && returnedThroughID.length === 0) {
    return { ok: false, error: 'invalid_continuation' };
  }

  const scannedRecords = parsed.scannedRecords;
  const scannedBytes = parsed.scannedBytes;
  const pagesEmitted = parsed.pagesEmitted;
  const iat = parsed.iat;
  const exp = parsed.exp;
  if (!Number.isInteger(scannedRecords) || scannedRecords < 0) {
    return { ok: false, error: 'invalid_continuation' };
  }
  if (!Number.isInteger(scannedBytes) || scannedBytes < 0) {
    return { ok: false, error: 'invalid_continuation' };
  }
  if (!Number.isInteger(pagesEmitted) || pagesEmitted < 0) {
    return { ok: false, error: 'invalid_continuation' };
  }
  if (!Number.isInteger(iat) || iat < 0) {
    return { ok: false, error: 'invalid_continuation' };
  }
  if (!Number.isInteger(exp) || exp < 0) {
    return { ok: false, error: 'invalid_continuation' };
  }
  if (exp < iat) {
    return { ok: false, error: 'invalid_continuation' };
  }

  const allowed = new Set([
    'v',
    'runtime',
    'directory',
    'sessionID',
    'anchor',
    'capturedHead',
    'scanBefore',
    'returnedThroughID',
    'scannedRecords',
    'scannedBytes',
    'pagesEmitted',
    'iat',
    'exp',
  ]);
  for (const key of Object.keys(parsed)) {
    if (!allowed.has(key)) {
      return { ok: false, error: 'invalid_continuation' };
    }
  }

  const nowMs = resolveNowMs(options.clock);
  const nowSec = Math.floor(nowMs / 1000);
  if (nowSec > exp) {
    return { ok: false, error: 'invalid_continuation' };
  }

  return {
    ok: true,
    value: {
      runtime: parsed.runtime,
      directory: directory ?? null,
      sessionID: parsed.sessionID,
      anchor: parsed.anchor,
      capturedHead: parsed.capturedHead,
      scanBefore: scanBefore ?? null,
      returnedThroughID: returnedThroughID ?? null,
      scannedRecords,
      scannedBytes,
      pagesEmitted,
      iat,
      exp,
    },
  };
};

/**
 * From a chronological timeline, keep only records strictly older than
 * `returnedThroughID` (already delivered to the client). When null, keep all.
 */
const sliceOlderThanReturned = (records, returnedThroughID) => {
  if (!returnedThroughID) return records.slice();
  const index = records.findIndex((entry) => recordId(entry) === returnedThroughID);
  if (index < 0) {
    // Boundary not on this page — if we are scanning older pages, all records
    // on older pages are older than the returned boundary when the boundary was
    // on a newer page. Caller handles cross-page filtering via id set.
    return records.slice();
  }
  // Keep strictly older (old→new: slice(0, index)).
  return records.slice(0, index);
};

/**
 * Select a newest-first page budget from chronological candidates.
 * Returns { pageRecords, remainingOlder }.
 */
const takeNewestWithinBudget = (chronological, pageRecordLimit, pageByteLimit) => {
  if (chronological.length === 0) {
    return { pageRecords: [], remainingOlder: [] };
  }
  const selected = [];
  let bytes = 0;
  for (let index = chronological.length - 1; index >= 0; index -= 1) {
    const entry = chronological[index];
    const entryBytes = measureRecordBytes(entry);
    if (selected.length > 0) {
      if (selected.length >= pageRecordLimit) break;
      if (bytes + entryBytes > pageByteLimit) break;
    }
    selected.push(entry);
    bytes += entryBytes;
  }
  selected.reverse();
  const cut = chronological.length - selected.length;
  return {
    pageRecords: selected,
    remainingOlder: chronological.slice(0, cut),
  };
};

/**
 * @param {{
 *   fetchPage: (input: {
 *     sessionID: string,
 *     directory?: string,
 *     before?: string,
 *     limit?: number,
 *     signal?: AbortSignal,
 *   }) => Promise<{ records: unknown[], nextCursor: string | null, complete?: boolean }>,
 *   runtimeKey?: string,
 *   pageRecordLimit?: number,
 *   pageByteLimit?: number,
 *   totalPageLimit?: number,
 *   totalByteLimit?: number,
 *   scanLimit?: number,
 *   maxFetchPagesPerRequest?: number,
 *   continuationSecret?: Buffer | string,
 *   clock?: () => number,
 *   continuationTtlMs?: number,
 * }} options
 */
export const createSessionReconcileService = ({
  fetchPage,
  runtimeKey = 'default',
  pageRecordLimit = DEFAULT_PAGE_RECORD_LIMIT,
  pageByteLimit = DEFAULT_PAGE_BYTE_LIMIT,
  totalPageLimit = DEFAULT_TOTAL_PAGE_LIMIT,
  totalByteLimit = DEFAULT_TOTAL_BYTE_LIMIT,
  scanLimit = DEFAULT_SCAN_LIMIT,
  maxFetchPagesPerRequest = DEFAULT_MAX_FETCH_PAGES_PER_REQUEST,
  continuationSecret,
  clock,
  continuationTtlMs,
} = {}) => {
  if (typeof fetchPage !== 'function') {
    throw new Error('createSessionReconcileService requires fetchPage');
  }

  const resolvedRuntime = typeof runtimeKey === 'string' && runtimeKey.length > 0
    ? runtimeKey
    : 'default';
  const tokenSecret = resolveSecret(continuationSecret);
  const tokenClock = typeof clock === 'function' ? clock : () => Date.now();
  const tokenTtlMs = resolveTtlMs(continuationTtlMs);
  const tokenOptions = {
    secret: tokenSecret,
    clock: tokenClock,
    ttlMs: tokenTtlMs,
  };
  const recordCap = Number.isFinite(pageRecordLimit)
    ? Math.max(1, Math.floor(pageRecordLimit))
    : DEFAULT_PAGE_RECORD_LIMIT;
  const byteCap = Number.isFinite(pageByteLimit)
    ? Math.max(1, Math.floor(pageByteLimit))
    : DEFAULT_PAGE_BYTE_LIMIT;
  const totalPages = Number.isFinite(totalPageLimit)
    ? Math.max(1, Math.floor(totalPageLimit))
    : DEFAULT_TOTAL_PAGE_LIMIT;
  const totalBytes = Number.isFinite(totalByteLimit)
    ? Math.max(1, Math.floor(totalByteLimit))
    : DEFAULT_TOTAL_BYTE_LIMIT;
  const pageLimit = Number.isFinite(scanLimit)
    ? Math.max(1, Math.floor(scanLimit))
    : DEFAULT_SCAN_LIMIT;
  const fetchCap = Number.isFinite(maxFetchPagesPerRequest)
    ? Math.max(1, Math.floor(maxFetchPagesPerRequest))
    : DEFAULT_MAX_FETCH_PAGES_PER_REQUEST;

  /**
   * Re-read latest head id after a reconcile page (for multi-round chase).
   */
  const readLatestHead = async ({ sessionID, directory, signal }) => {
    try {
      const page = await fetchPage({
        sessionID,
        ...(directory ? { directory } : {}),
        limit: 1,
        signal,
      });
      if (!page || !Array.isArray(page.records) || page.records.length === 0) {
        return null;
      }
      // limit=1 may still return a full page depending on upstream; take newest.
      const last = page.records[page.records.length - 1];
      return recordId(last);
    } catch {
      return null;
    }
  };

  const reconcile = async ({
    sessionID,
    directory: rawDirectory,
    anchor: rawAnchor,
    continuation: rawContinuation,
    signal,
  } = {}) => {
    if (typeof sessionID !== 'string' || sessionID.length === 0) {
      return fail('invalid_session');
    }

    const directory = normalizeDirectory(rawDirectory);
    const hasContinuation = typeof rawContinuation === 'string' && rawContinuation.length > 0;
    const hasAnchor = typeof rawAnchor === 'string' && rawAnchor.length > 0;

    /** @type {{
     *   anchor: string,
     *   capturedHead: string | null,
     *   scanBefore: string | null | undefined,
     *   returnedThroughID: string | null,
     *   scannedRecords: number,
     *   scannedBytes: number,
     *   pagesEmitted: number,
     * }} */
    let state;

    if (hasContinuation) {
      if (rawContinuation.length > MAX_CONTINUATION_LENGTH) {
        return fail('invalid_continuation');
      }
      const decoded = decodeReconcileContinuation(rawContinuation, tokenOptions);
      if (!decoded.ok) return fail('invalid_continuation');
      const value = decoded.value;

      if (value.runtime !== resolvedRuntime) {
        return fail('invalid_continuation');
      }
      if (value.sessionID !== sessionID) {
        return fail('invalid_continuation');
      }
      const tokenDir = value.directory ?? null;
      if (tokenDir !== directory) {
        return fail('invalid_continuation');
      }
      // Continuation carries anchor; explicit anchor query must not conflict.
      if (hasAnchor && rawAnchor !== value.anchor) {
        return fail('invalid_continuation');
      }

      state = {
        anchor: value.anchor,
        capturedHead: value.capturedHead,
        scanBefore: value.scanBefore,
        returnedThroughID: value.returnedThroughID,
        scannedRecords: value.scannedRecords,
        scannedBytes: value.scannedBytes,
        pagesEmitted: value.pagesEmitted,
      };
    } else {
      if (!hasAnchor) {
        return fail('invalid_anchor');
      }
      if (rawAnchor.length > MAX_ANCHOR_LENGTH) {
        return fail('invalid_anchor');
      }
      state = {
        anchor: rawAnchor,
        capturedHead: null,
        scanBefore: undefined,
        returnedThroughID: null,
        scannedRecords: 0,
        scannedBytes: 0,
        pagesEmitted: 0,
      };
    }

    /** Chronological buffer of candidate gap records not yet returned. */
    /** @type {unknown[]} */
    let candidates = [];
    const seen = new Set();
    // Already-returned ids on newer pages — skip if they reappear via overlap.
    if (state.returnedThroughID) {
      seen.add(state.returnedThroughID);
    }

    let anchorFound = false;
    let upstreamComplete = false;
    let before = state.scanBefore === null || state.scanBefore === undefined
      ? undefined
      : state.scanBefore;
    /** Origin request-before for the next older fetch after this request ends. */
    let nextScanBefore = before ?? null;
    let pagesFetched = 0;
    let capturedHead = state.capturedHead;
    /** Whether we still need the head-locate first page of a new round. */
    const isFreshRound = state.pagesEmitted === 0 && state.returnedThroughID == null;
    /** Cursors already requested within this HTTP call. */
    const requestedCursors = new Set();
    if (before) requestedCursors.add(before);

    /**
     * After locating returnedThroughID on a re-fetched page, drop that id and
     * everything newer from candidates; also mark those ids seen.
     */
    const applyReturnedBoundary = () => {
      if (!state.returnedThroughID) return;
      const boundaryIndex = candidates.findIndex(
        (entry) => recordId(entry) === state.returnedThroughID,
      );
      if (boundaryIndex >= 0) {
        // Drop boundary and everything newer (already returned).
        for (let i = boundaryIndex; i < candidates.length; i += 1) {
          const id = recordId(candidates[i]);
          if (id) seen.add(id);
        }
        candidates = candidates.slice(0, boundaryIndex);
      }
    };

    const trimToAnchor = () => {
      const index = candidates.findIndex((entry) => recordId(entry) === state.anchor);
      if (index < 0) return false;
      candidates = candidates.slice(index);
      anchorFound = true;
      return true;
    };

    try {
      while (true) {
        if (pagesFetched >= fetchCap) {
          return fail('max_scan_pages');
        }

        // Already hold a full response page of unreturned candidates — emit now.
        // Do not keep scanning older history within this HTTP request once the
        // per-page record/byte budget is filled (continuation continues the gap).
        if (candidates.length > 0) {
          const probe = takeNewestWithinBudget(candidates, recordCap, byteCap);
          if (probe.remainingOlder.length > 0 || candidates.length >= recordCap) {
            // When remainingOlder is empty but length === recordCap, the whole
            // buffer exactly fills one page; still stop if more upstream exists
            // so the client can continue (anchor may be further back).
            if (probe.remainingOlder.length > 0) break;
            if (candidates.length >= recordCap && !upstreamComplete && !anchorFound) {
              // Full page filled without anchor — emit and continue via token.
              // nextScanBefore already points at older history when available.
              break;
            }
            if (probe.remainingOlder.length > 0) break;
          }
        }

        if (upstreamComplete) break;

        // Round total budget: stop scanning further older history.
        if (state.pagesEmitted >= totalPages) break;
        if (state.scannedBytes >= totalBytes) break;

        const page = await fetchPage({
          sessionID,
          ...(directory ? { directory } : {}),
          ...(before ? { before } : {}),
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
          upstreamComplete = true;
          break;
        }

        for (const entry of records) {
          if (!recordId(entry)) {
            return fail('missing_id');
          }
        }

        if (before && nextCursor === before) {
          return fail('duplicate_cursor');
        }
        if (nextCursor && requestedCursors.has(nextCursor) && nextCursor !== before) {
          return fail('duplicate_cursor');
        }

        // Capture head from the first latest-page fetch of the round.
        if (capturedHead == null) {
          const headId = recordId(records[records.length - 1]);
          capturedHead = headId;
        }

        // Build page contribution: drop already-returned suffix when resuming.
        let pageRecords = records;
        if (state.returnedThroughID && pagesFetched === 1 && isFreshRound === false) {
          // First fetch of a continuation may re-hit the page that held the
          // previous returnedThroughID (scanBefore may point at that origin).
          pageRecords = sliceOlderThanReturned(records, state.returnedThroughID);
        }

        const prepend = [];
        for (const entry of pageRecords) {
          const id = recordId(entry);
          if (!id || seen.has(id)) continue;
          seen.add(id);
          prepend.push(entry);
        }

        // Track scanned volume from raw upstream page (not just selected).
        state.scannedRecords += records.length;
        state.scannedBytes += measureRecordsBytes(records);

        candidates.unshift(...prepend);

        if (state.returnedThroughID) {
          applyReturnedBoundary();
        }

        if (!anchorFound) {
          trimToAnchor();
        }

        nextScanBefore = nextCursor;
        if (pageComplete) {
          upstreamComplete = true;
          // Fall through to budget checks / loop end.
        }

        // Per-page budget filled → stop this HTTP request (even if more history).
        {
          const probe = takeNewestWithinBudget(candidates, recordCap, byteCap);
          if (probe.remainingOlder.length > 0) {
            break;
          }
          if (candidates.length >= recordCap && !pageComplete) {
            // Exactly one full page of candidates and older history remains.
            break;
          }
        }

        // Anchor found and remaining fits in one response page → done scanning.
        if (anchorFound) {
          break;
        }

        if (pageComplete) {
          break;
        }

        before = nextCursor;
        if (before) requestedCursors.add(before);
      }
    } catch (error) {
      if (error?.name === 'AbortError') {
        return fail('aborted');
      }
      if (error?.code === 'unavailable' || error?.status === 503) {
        return fail('unavailable');
      }
      if (error?.code === 'upstream' || error?.status === 502) {
        return fail('upstream');
      }
      // Treat other transport failures as temporary upstream issues.
      return fail('upstream');
    }

    // Select response page from candidates (newest within budget).
    const { pageRecords, remainingOlder } = takeNewestWithinBudget(
      candidates,
      recordCap,
      byteCap,
    );
    const responseBytes = measureRecordsBytes(pageRecords);
    const pagesEmitted = state.pagesEmitted + 1;

    // Determine whether more gap remains after this page.
    const moreInBuffer = remainingOlder.length > 0;
    // If we have not found the anchor and history is not exhausted, more to scan.
    const moreToScan = !anchorFound && !upstreamComplete;

    // Round total budget exhausted without completing the gap.
    const totalBudgetHit = pagesEmitted >= totalPages
      || state.scannedBytes >= totalBytes;

    let resetRequired = false;
    let complete = false;
    let continuation = null;

    if (!anchorFound && upstreamComplete) {
      // Scanned to history start without the anchor → client must reset.
      resetRequired = true;
      complete = true;
    } else if (!anchorFound && totalBudgetHit && (moreToScan || moreInBuffer)) {
      // Budget forces rebuild before anchor.
      resetRequired = true;
      complete = true;
    } else if (anchorFound && !moreInBuffer) {
      // Full gap delivered.
      complete = true;
    } else if (moreInBuffer || moreToScan) {
      // Need continuation — either more buffered older records or more history.
      // When moreInBuffer, next request re-scans from an origin that still contains
      // the returnedThroughID so it can slice older. Use the request-before of the
      // latest page that contributed to pageRecords' oldest entry.
      //
      // Simpler approach: next scanBefore stays at the upstream cursor for older
      // history when buffer is drained; when buffer still has older records that
      // came from pages we already fetched, we must re-fetch from the head of the
      // round with returnedThroughID advanced.
      //
      // Re-fetch strategy: always resume with scanBefore = null (latest) when
      // remainingOlder is non-empty and those records were from the latest pages,
      // OR with nextScanBefore when we need older upstream pages and buffer is empty.
      //
      // Unified: set returnedThroughID to oldest id of this page; set scanBefore to
      // the same origin used when we first encountered that boundary. For simplicity
      // and correctness with re-fetch+slice, use:
      // - scanBefore: null when the oldest returned id still lives on the latest
      //   upstream window (continuation re-fetches latest and slices)
      // - otherwise nextScanBefore after we have walked past a page
      //
      // Practical choice used here: always re-start from `before=undefined` (latest)
      // when remainingOlder is non-empty (all remaining is still "newer" than any
      // not-yet-fetched older page). When remainingOlder is empty and moreToScan,
      // use nextScanBefore to walk older.
      let contScanBefore = null;
      if (!moreInBuffer && moreToScan) {
        contScanBefore = nextScanBefore;
      } else if (moreInBuffer && moreToScan) {
        // Buffer still has records from already-fetched pages; re-fetch from latest
        // and slice by returnedThroughID. Older not-yet-fetched history is reached
        // after the buffer drains on a later continuation.
        contScanBefore = null;
      } else {
        contScanBefore = null;
      }

      const oldestReturned = pageRecords.length > 0
        ? recordId(pageRecords[0])
        : state.returnedThroughID;

      if (!capturedHead) {
        return fail('upstream');
      }

      continuation = encodeReconcileContinuation({
        runtime: resolvedRuntime,
        directory,
        sessionID,
        anchor: state.anchor,
        capturedHead,
        scanBefore: contScanBefore,
        returnedThroughID: oldestReturned,
        scannedRecords: state.scannedRecords,
        scannedBytes: state.scannedBytes,
        pagesEmitted,
      }, tokenOptions);
      complete = false;
    } else {
      complete = true;
    }

    // If we hit total budget on this page while still incomplete, promote to reset.
    if (!complete && !resetRequired && totalBudgetHit) {
      resetRequired = true;
      complete = true;
      continuation = null;
    }

    if (resetRequired) {
      continuation = null;
      complete = true;
    }

    // latest head: prefer a fresh probe when this page completes the round;
    // otherwise report captured head (stable for the round).
    let latestHeadMessageID = capturedHead;
    if (complete && !resetRequired) {
      const liveHead = await readLatestHead({
        sessionID,
        directory: directory ?? undefined,
        signal,
      });
      if (liveHead) latestHeadMessageID = liveHead;
    }

    return {
      ok: true,
      records: pageRecords,
      anchorFound,
      capturedHeadMessageID: capturedHead,
      latestHeadMessageID,
      continuation,
      complete,
      resetRequired,
      scannedRecords: state.scannedRecords,
      responseBytes,
    };
  };

  return { reconcile };
};
