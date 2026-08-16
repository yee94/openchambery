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
 * Host response `cursor` is a versioned opaque token (`oc1.` + base64url JSON)
 * encoding only { before: string|null, boundaryID: string } — the upstream
 * request-before of the page that held the earliest returned authored user,
 * and that user's message id. Clients pass it as `before=` on the next request.
 * Raw OpenCode SDK cursors may still be passed through as the first `before`.
 */

const ASSISTANT_SESSION_DIVIDER_PREFIX = 'oc_asst_session_divider:';

const DEFAULT_MAX_SCAN_PAGES = 50;
const DEFAULT_MAX_SCAN_MESSAGES = 5000;
const DEFAULT_SCAN_LIMIT = 100;

/** Host-owned cursor version prefix. */
export const HOST_CURSOR_PREFIX = 'oc1.';

/** Reject absurdly long before tokens (host or raw). */
export const MAX_BEFORE_LENGTH = 8192;

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

const earliestAuthoredUser = (records: unknown[]): unknown | null => {
  for (const entry of records) {
    if (isUserAuthoredTurnBoundary(entry)) return entry;
  }
  return null;
};

const fail = (error: string) => ({ ok: false as const, error });

/** Marker stamped on every projected part; clients treat unstamped as full. */
export const SLIM_PARTS_PROJECTION = 'slim-v1';

type LoosePart = Record<string, unknown>;

/** Identity/status fields kept on a projected tool part — never the output body. */
const projectToolPart = (part: LoosePart): LoosePart => {
  const state = part.state && typeof part.state === 'object'
    ? (part.state as LoosePart)
    : undefined;
  return {
    ...(part.id === undefined ? {} : { id: part.id }),
    ...(part.sessionID === undefined ? {} : { sessionID: part.sessionID }),
    ...(part.messageID === undefined ? {} : { messageID: part.messageID }),
    ...(part.callID === undefined ? {} : { callID: part.callID }),
    ...(part.tool === undefined ? {} : { tool: part.tool }),
    type: 'tool',
    ...(state
      ? {
        state: {
          ...(state.status === undefined ? {} : { status: state.status }),
          ...(state.title === undefined ? {} : { title: state.title }),
          ...(state.time === undefined ? {} : { time: state.time }),
        },
      }
      : {}),
    slim: true,
  };
};

/** Reasoning keeps identity and timing only; the trace body is dropped. */
const projectReasoningPart = (part: LoosePart): LoosePart => ({
  ...(part.id === undefined ? {} : { id: part.id }),
  ...(part.sessionID === undefined ? {} : { sessionID: part.sessionID }),
  ...(part.messageID === undefined ? {} : { messageID: part.messageID }),
  type: 'reasoning',
  ...(part.time === undefined ? {} : { time: part.time }),
  slim: true,
});

const positiveDimension = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return undefined;
};

const nonNegativeInt = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
};

const metadataNumber = (
  part: LoosePart,
  key: string,
  parse: (value: unknown) => number | undefined,
): number | undefined => {
  const top = parse(part[key]);
  if (top !== undefined) return top;
  const metadata = part.metadata;
  if (metadata && typeof metadata === 'object') return parse((metadata as LoosePart)[key]);
  return undefined;
};

const decodeDataUrlBytes = (url: unknown): Buffer | null => {
  if (typeof url !== 'string' || !url.startsWith('data:')) return null;
  const comma = url.indexOf(',');
  if (comma < 5) return null;
  const meta = url.slice(5, comma);
  const payload = url.slice(comma + 1);
  try {
    if (/(?:^|;)base64$/i.test(meta.trim())) return Buffer.from(payload, 'base64');
    return Buffer.from(decodeURIComponent(payload), 'utf8');
  } catch {
    return null;
  }
};

const jpegSize = (bytes: Buffer): { width: number; height: number } | null => {
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xFF) break;
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD9)) {
      offset += 2;
      continue;
    }
    const size = bytes.readUInt16BE(offset + 2);
    if (size < 2) break;
    const isSof = (marker >= 0xC0 && marker <= 0xC3)
      || (marker >= 0xC5 && marker <= 0xC7)
      || (marker >= 0xC9 && marker <= 0xCB)
      || (marker >= 0xCD && marker <= 0xCF);
    if (isSof && offset + 8 < bytes.length) {
      const height = bytes.readUInt16BE(offset + 5);
      const width = bytes.readUInt16BE(offset + 7);
      if (width > 0 && height > 0) return { width, height };
      break;
    }
    offset += 2 + size;
  }
  return null;
};

const webpSize = (bytes: Buffer): { width: number; height: number } | null => {
  if (bytes.length < 30) return null;
  const fourcc = bytes.toString('ascii', 12, 16);
  if (fourcc === 'VP8X') {
    const width = 1 + ((bytes[24] ?? 0) | ((bytes[25] ?? 0) << 8) | ((bytes[26] ?? 0) << 16));
    const height = 1 + ((bytes[27] ?? 0) | ((bytes[28] ?? 0) << 8) | ((bytes[29] ?? 0) << 16));
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (fourcc === 'VP8 ' && bytes[23] === 0x9D && bytes[24] === 0x01 && bytes[25] === 0x2A) {
    const width = bytes.readUInt16LE(26) & 0x3FFF;
    const height = bytes.readUInt16LE(28) & 0x3FFF;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (fourcc === 'VP8L' && bytes[20] === 0x2F) {
    const bits = bytes.readUInt32LE(21);
    const width = (bits & 0x3FFF) + 1;
    const height = ((bits >> 14) & 0x3FFF) + 1;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  return null;
};

/** PNG / GIF / JPEG / WebP headers only — never treat unknown bytes as a size. */
const imageSizeFromBytes = (bytes: Buffer): { width: number; height: number } | null => {
  if (!Buffer.isBuffer(bytes) || bytes.length < 10) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47 && bytes.length >= 24) {
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    const width = bytes.readUInt16LE(6);
    const height = bytes.readUInt16LE(8);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (bytes[0] === 0xFF && bytes[1] === 0xD8) return jpegSize(bytes);
  if (
    bytes.length >= 16
    && bytes.toString('ascii', 0, 4) === 'RIFF'
    && bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return webpSize(bytes);
  }
  return null;
};

/**
 * First-packet file projection: identity + mime/filename + stable size metadata.
 * Data-URL bodies are measured then dropped; url/base64 never leave this helper.
 */
const projectFilePart = (part: LoosePart): LoosePart => {
  const bytes = decodeDataUrlBytes(part.url);
  const derivedSize = bytes ? imageSizeFromBytes(bytes) : null;
  const size = metadataNumber(part, 'size', nonNegativeInt);
  const byteSize = bytes ? bytes.length : metadataNumber(part, 'byteSize', nonNegativeInt);
  const width = metadataNumber(part, 'width', positiveDimension) ?? derivedSize?.width;
  const height = metadataNumber(part, 'height', positiveDimension) ?? derivedSize?.height;
  return {
    ...(part.id === undefined ? {} : { id: part.id }),
    ...(part.sessionID === undefined ? {} : { sessionID: part.sessionID }),
    ...(part.messageID === undefined ? {} : { messageID: part.messageID }),
    type: 'file',
    ...(typeof part.mime === 'string' ? { mime: part.mime } : {}),
    ...(typeof part.filename === 'string' ? { filename: part.filename } : {}),
    ...(size === undefined ? {} : { size }),
    ...(byteSize === undefined ? {} : { byteSize }),
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    slim: true,
  };
};

const isUserRecord = (record: LoosePart): boolean => {
  const info = (record.info ?? {}) as LoosePart;
  const role = typeof info.clientRole === 'string' ? info.clientRole : info.role;
  return role === 'user';
};

/**
 * Summarize tool/reasoning parts so a first packet does not have to carry the
 * bodies of a long tool-heavy turn. Parity with the web host `service.js`.
 *
 * Runs after `selectTurnRecords`, so `turnCount`, `complete`, and cursor
 * encoding are all derived from unprojected records and cannot shift.
 */
export const projectSlimParts = <T>(records: T[]): T[] => {
  if (!Array.isArray(records) || records.length === 0) return records;

  let changedAny = false;
  const projected = records.map((record) => {
    if (!record || typeof record !== 'object') return record;
    const loose = record as LoosePart;
    const userRow = isUserRecord(loose);

    const parts = loose.parts;
    if (!Array.isArray(parts) || parts.length === 0) return record;

    let changed = false;
    const nextParts = parts.map((part) => {
      if (!part || typeof part !== 'object') return part;
      const loosePart = part as LoosePart;
      if (loosePart.type === 'file') {
        changed = true;
        return projectFilePart(loosePart);
      }
      if (userRow) return part;
      if (loosePart.type === 'tool') {
        changed = true;
        return projectToolPart(loosePart);
      }
      if (loosePart.type === 'reasoning') {
        changed = true;
        return projectReasoningPart(loosePart);
      }
      return part;
    });

    if (!changed) return record;
    changedAny = true;
    return { ...loose, parts: nextParts } as T;
  });

  return changedAny ? projected : records;
};

export type HostCursorPayload = {
  /** Upstream request `before` of the page that contained the boundary (null = first page). */
  before: string | null;
  /** Authored user message id that is the turn-window start boundary. */
  boundaryID: string;
};

/**
 * Encode host-owned opaque cursor. Payload is only boundary location metadata —
 * never message content.
 */
export const encodeHostCursor = ({ before, boundaryID }: HostCursorPayload): string => {
  const body = {
    v: 1,
    before: before == null ? null : String(before),
    boundaryID: String(boundaryID),
  };
  return HOST_CURSOR_PREFIX + Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
};

/**
 * Decode host-owned cursor. Returns { ok:false } for non-host tokens or bad shape.
 */
export const decodeHostCursor = (
  token: string,
): { ok: true; value: HostCursorPayload } | { ok: false; error: string } => {
  if (typeof token !== 'string' || !token.startsWith(HOST_CURSOR_PREFIX)) {
    return { ok: false, error: 'invalid_cursor' };
  }
  const encoded = token.slice(HOST_CURSOR_PREFIX.length);
  if (encoded.length === 0 || token.length > MAX_BEFORE_LENGTH) {
    return { ok: false, error: 'invalid_cursor' };
  }
  let parsed: unknown;
  try {
    const json = Buffer.from(encoded, 'base64url').toString('utf8');
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: 'invalid_cursor' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'invalid_cursor' };
  }
  const body = parsed as Record<string, unknown>;
  if (body.v !== 1) {
    return { ok: false, error: 'invalid_cursor' };
  }
  const { before, boundaryID } = body;
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
  for (const key of Object.keys(body)) {
    if (key !== 'v' && key !== 'before' && key !== 'boundaryID') {
      return { ok: false, error: 'invalid_cursor' };
    }
  }
  return { ok: true, value: { before: (before as string | null) ?? null, boundaryID } };
};

const isHostCursorToken = (token: unknown): token is string =>
  typeof token === 'string' && token.startsWith(HOST_CURSOR_PREFIX);

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

    if (typeof initialBefore === 'string' && initialBefore.length > MAX_BEFORE_LENGTH) {
      return fail('invalid_cursor');
    }

    /** Host resume: first fetch uses token.raw before; keep only records before boundaryID. */
    let resumeBoundaryID: string | null = null;
    /** upstream request-before for the next fetch */
    let before: string | undefined;
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

    /** chronological oldest → newest */
    const accumulated: unknown[] = [];
    /** Parallel origin: request-before used when each accumulated record was fetched. */
    const accumulatedOrigins: (string | null)[] = [];
    const seen = new Set<string>();
    let pagesFetched = 0;
    let messagesScanned = 0;
    let upstreamComplete = false;
    /** cursors already requested — detect stalls */
    const requestedCursors = new Set<string>();
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
          if (!recordInfoId(entry)) {
            return fail('upstream');
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

        let pageRecords: unknown[] = records;
        if (pendingBoundarySlice) {
          const boundaryIndex = records.findIndex((entry) => recordInfoId(entry) === resumeBoundaryID);
          if (boundaryIndex < 0) {
            return fail('invalid_cursor');
          }
          // Keep only records strictly older than the boundary (old→new: slice(0, index)).
          // Boundary and everything newer are excluded (already returned to the client).
          pageRecords = records.slice(0, boundaryIndex);
          pendingBoundarySlice = false;
        }

        // OpenCode page is already chronological (oldest → newest). Prepend into
        // the global timeline after dedupe by info.id.
        let added = 0;
        const prepend: unknown[] = [];
        const prependOrigins: (string | null)[] = [];
        for (const entry of pageRecords) {
          const id = recordInfoId(entry);
          if (!id) {
            return fail('upstream');
          }
          if (seen.has(id)) continue;
          seen.add(id);
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
        before = nextCursor ?? undefined;
        if (before) requestedCursors.add(before);
      }
    } catch (error) {
      if (error && typeof error === 'object' && (error as { name?: string }).name === 'AbortError') {
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
    // complete when upstream is exhausted and selectTurnRecords kept the full
    // accumulated window (no overscan trim). Overscan trim leaves older history
    // addressable via host cursor even if the last upstream page reported complete.
    const complete = upstreamComplete && selected.length === accumulated.length;

    let cursor: string | null = null;
    if (!complete) {
      const earliest = earliestAuthoredUser(selected);
      if (earliest) {
        const earliestId = recordInfoId(earliest);
        // Find origin of the earliest selected authored user in accumulated.
        const accIndex = accumulated.findIndex((entry) => entry === earliest
          || recordInfoId(entry) === earliestId);
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
