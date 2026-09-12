import crypto from 'node:crypto';
import { decodeDataUrlStrict } from '../fs/prompt-attachment-store.js';
import { parseContactCard, parseContactPart, serializeContactPart } from './cards.js';

/** Keep in sync with CONTACT_ATTACHMENT_HISTORICAL_MAX_BYTES in contact-attachments.js */
const FINGERPRINT_DATA_URL_MAX_BYTES = 56 * 1024 * 1024;

const json = (value) => JSON.stringify(value);
const parse = (value) => JSON.parse(value);

export const CONTACT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS assistant_contact_message (
    message_id TEXT PRIMARY KEY,
    assistant_id TEXT NOT NULL,
    role TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    bubble_index INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    ordinal INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'complete',
    from_assistant_id TEXT,
    from_assistant_name TEXT
  );
  CREATE INDEX IF NOT EXISTS assistant_contact_message_page
    ON assistant_contact_message(assistant_id, ordinal, message_id);
  CREATE TABLE IF NOT EXISTS assistant_contact_part (
    message_id TEXT NOT NULL,
    part_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    part_json TEXT NOT NULL,
    PRIMARY KEY (message_id, part_id)
  );
  CREATE INDEX IF NOT EXISTS assistant_contact_part_message
    ON assistant_contact_part(message_id, ordinal, part_id);
  CREATE TABLE IF NOT EXISTS assistant_contact_watch (
    assistant_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    directory TEXT,
    status TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (assistant_id, session_id)
  );
  CREATE INDEX IF NOT EXISTS assistant_contact_watch_session
    ON assistant_contact_watch(session_id, status);
  -- Per-assistant LLM context watermark. Messages with ordinal <= after_ordinal
  -- stay in the transcript UI but are excluded from contactHistoryForLlm.
  -- Survives restart. Cleared only when the transcript is fully deleted.
  CREATE TABLE IF NOT EXISTS assistant_contact_context_boundary (
    assistant_id TEXT PRIMARY KEY,
    after_ordinal INTEGER NOT NULL,
    assistant_after_ordinal INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
  -- Contact transcript generation: bumps only on clear_chat_history / resetContact.
  -- clear memory (context boundary) must not change this. Cursor keyset embeds it.
  CREATE TABLE IF NOT EXISTS assistant_contact_generation (
    assistant_id TEXT PRIMARY KEY,
    generation INTEGER NOT NULL DEFAULT 0
  );
  -- Shared per-assistant contact read watermark (multi-client). Keyset order is
  -- (ordinal ASC, message_id ASC). generation must match transcript generation.
  -- Missing row ≡ nothing read (ordinal 0, empty message_id). Schema migrate
  -- seeds existing assistants to the current tip so legacy history is read.
  CREATE TABLE IF NOT EXISTS assistant_contact_read_state (
    assistant_id TEXT PRIMARY KEY,
    last_read_ordinal INTEGER NOT NULL DEFAULT 0,
    last_read_message_id TEXT NOT NULL DEFAULT '',
    generation INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
`;

export const CONTACT_SETTLE_TEXT = Object.freeze({
  complete: 'oc.settle.complete',
  error: 'oc.settle.error',
  question: 'oc.settle.question',
});

/** List-card preview body bound (plain text only; no base64 / tool traces). */
export const CONTACT_PREVIEW_MAX_CHARS = 500;
/** How many newest contact rows to scan per assistant for a visible preview. */
export const CONTACT_PREVIEW_CANDIDATE_LIMIT = 24;

/** Frozen UI page contract defaults. */
export const CONTACT_PAGE_DEFAULT_LIMIT = 20;
export const CONTACT_PAGE_MAX_LIMIT = 100;
export const CONTACT_CURSOR_VERSION = 1;

const IN_FLIGHT_WATCH = new Set(['busy', 'question']);

const contactStoreError = (code, message) => {
  const error = new Error(typeof message === 'string' && message.trim() ? message.trim() : code);
  error.code = code;
  return error;
};

export function ensureContactSchema(db) {
  db.exec(CONTACT_SCHEMA_SQL);
  const columns = new Set(db.prepare("SELECT name FROM pragma_table_info('assistant_contact_message')").all().map((column) => column.name));
  if (!columns.has('from_assistant_id')) db.exec('ALTER TABLE assistant_contact_message ADD COLUMN from_assistant_id TEXT');
  if (!columns.has('from_assistant_name')) db.exec('ALTER TABLE assistant_contact_message ADD COLUMN from_assistant_name TEXT');
  const boundaryColumns = new Set(db.prepare("SELECT name FROM pragma_table_info('assistant_contact_context_boundary')").all().map((column) => column.name));
  if (!boundaryColumns.has('assistant_after_ordinal')) db.exec('ALTER TABLE assistant_contact_context_boundary ADD COLUMN assistant_after_ordinal INTEGER NOT NULL DEFAULT 0');
  const watchColumns = new Set(db.prepare("SELECT name FROM pragma_table_info('assistant_contact_watch')").all().map((column) => column.name));
  if (!watchColumns.has('resume_allowed')) db.exec('ALTER TABLE assistant_contact_watch ADD COLUMN resume_allowed INTEGER NOT NULL DEFAULT 1');
  // Attachment table ownership lives in contact-attachments.ensureContactAttachmentSchema.
}

/** Current contact transcript generation for one assistant (default 0). */
export function getContactGeneration(db, assistantID) {
  if (typeof assistantID !== 'string' || !assistantID) return 0;
  const row = db.prepare(
    'SELECT generation FROM assistant_contact_generation WHERE assistant_id=?',
  ).get(assistantID);
  if (!row || !Number.isSafeInteger(Number(row.generation)) || Number(row.generation) < 0) return 0;
  return Number(row.generation);
}

/**
 * Atomically bump contact generation (clear chat history / reset only).
 * Returns the new generation. clearContactMemory must never call this.
 */
export function bumpContactGeneration(db, assistantID) {
  if (typeof assistantID !== 'string' || !assistantID) {
    throw contactStoreError('validation_error', 'assistantID required');
  }
  db.prepare(
    'INSERT INTO assistant_contact_generation(assistant_id, generation) VALUES (?, 1) ON CONFLICT(assistant_id) DO UPDATE SET generation=generation+1',
  ).run(assistantID);
  return getContactGeneration(db, assistantID);
}

/** Empty / start-of-transcript read cursor (nothing read). */
export const EMPTY_CONTACT_READ_CURSOR = Object.freeze({
  ordinal: 0,
  messageID: '',
});

/**
 * Compare contact keyset cursors (ordinal ASC, message_id ASC).
 * Returns negative when left < right, 0 when equal, positive when left > right.
 */
export function compareContactReadCursor(left, right) {
  const leftOrdinal = Number(left?.ordinal);
  const rightOrdinal = Number(right?.ordinal);
  const a = Number.isFinite(leftOrdinal) ? leftOrdinal : 0;
  const b = Number.isFinite(rightOrdinal) ? rightOrdinal : 0;
  if (a !== b) return a - b;
  const leftID = typeof left?.messageID === 'string' ? left.messageID : '';
  const rightID = typeof right?.messageID === 'string' ? right.messageID : '';
  if (leftID < rightID) return -1;
  if (leftID > rightID) return 1;
  return 0;
}

const normalizeReadCursor = (value) => {
  const ordinalRaw = Number(value?.ordinal);
  const ordinal = Number.isSafeInteger(ordinalRaw) && ordinalRaw >= 0 ? ordinalRaw : 0;
  const messageID = typeof value?.messageID === 'string' ? value.messageID : '';
  return { ordinal, messageID };
};

/**
 * Persisted shared read watermark for one assistant.
 * Missing row → generation from transcript gen table, cursor at empty (nothing read).
 */
export function getContactReadWatermark(db, assistantID) {
  if (typeof assistantID !== 'string' || !assistantID) {
    return {
      generation: 0,
      ordinal: EMPTY_CONTACT_READ_CURSOR.ordinal,
      messageID: EMPTY_CONTACT_READ_CURSOR.messageID,
    };
  }
  const generation = getContactGeneration(db, assistantID);
  const row = db.prepare(
    'SELECT last_read_ordinal, last_read_message_id, generation FROM assistant_contact_read_state WHERE assistant_id=?',
  ).get(assistantID);
  if (!row) {
    return {
      generation,
      ordinal: EMPTY_CONTACT_READ_CURSOR.ordinal,
      messageID: EMPTY_CONTACT_READ_CURSOR.messageID,
    };
  }
  const cursor = normalizeReadCursor({
    ordinal: row.last_read_ordinal,
    messageID: row.last_read_message_id,
  });
  // Stale generation on the row (e.g. wipe without reset helper) → treat as unread baseline.
  const rowGeneration = Number(row.generation);
  if (!Number.isSafeInteger(rowGeneration) || rowGeneration !== generation) {
    return {
      generation,
      ordinal: EMPTY_CONTACT_READ_CURSOR.ordinal,
      messageID: EMPTY_CONTACT_READ_CURSOR.messageID,
    };
  }
  return {
    generation,
    ordinal: cursor.ordinal,
    messageID: cursor.messageID,
  };
}

/**
 * Highest transcript keyset tip for one assistant (any role).
 * Empty transcript → empty cursor. Clients report up to this tip after viewing.
 */
export function getContactReadTip(db, assistantID) {
  if (typeof assistantID !== 'string' || !assistantID) {
    return {
      generation: 0,
      ordinal: EMPTY_CONTACT_READ_CURSOR.ordinal,
      messageID: EMPTY_CONTACT_READ_CURSOR.messageID,
    };
  }
  const generation = getContactGeneration(db, assistantID);
  const row = db.prepare(
    `SELECT ordinal, message_id AS messageID
     FROM assistant_contact_message
     WHERE assistant_id=?
     ORDER BY ordinal DESC, message_id DESC
     LIMIT 1`,
  ).get(assistantID);
  if (!row) {
    return {
      generation,
      ordinal: EMPTY_CONTACT_READ_CURSOR.ordinal,
      messageID: EMPTY_CONTACT_READ_CURSOR.messageID,
    };
  }
  return {
    generation,
    ordinal: Number(row.ordinal) || 0,
    messageID: typeof row.messageID === 'string' ? row.messageID : '',
  };
}

/**
 * True when one part is user-visible — matches UI settle-per-part filter
 * (AssistantConversationSurface / getLoadedAssistantReadPosition):
 * file/card, or non-empty text that is not an internal `oc.settle.*` marker.
 * Empty/whitespace text and settle markers alone are not visible.
 */
export function isContactVisiblePart(part) {
  if (!part || typeof part !== 'object') return false;
  if (part.type === 'file' || part.type === 'card') return true;
  if (part.type !== 'text') return false;
  const trimmed = typeof part.text === 'string' ? part.text.trim() : '';
  return Boolean(trimmed) && !trimmed.startsWith('oc.settle.');
}

/**
 * True when a contact row should contribute to unreadCount.
 * Counts complete/error assistant replies and user-facing peer DMs that have
 * ≥1 visible part (per-part settle filter). User messages, blank rows,
 * settle-only markers, and non-visible roles are excluded.
   * Token-level SSE deltas never create rows. Each published spoken bubble
   * or card is one count unit, including rows persisted before turn end.
 */
export function isContactUnreadCountableMessage(message) {
  if (!message || typeof message !== 'object') return false;
  const role = message.role;
  if (role !== 'assistant' && role !== 'peer') return false;
  const status = typeof message.status === 'string' ? message.status : 'complete';
  if (status !== 'complete' && status !== 'error') return false;
  const parts = Array.isArray(message.parts) ? message.parts : [];
  if (parts.length > 0) return parts.some(isContactVisiblePart);
  // Parts-less fixtures: treat top-level text like a single text part.
  const trimmed = typeof message.text === 'string' ? message.text.trim() : '';
  return Boolean(trimmed) && !trimmed.startsWith('oc.settle.');
}

/** SQL predicate: message is after the read watermark keyset (exclusive). */
const contactUnreadAfterWatermarkSql = (ordinalAlias, messageIdAlias) => (
  `(${ordinalAlias} > ?
    OR (${ordinalAlias} = ? AND ${messageIdAlias} > ?))`
);

/**
 * SQL: message has ≥1 user-visible part (file/card/non-empty non-settle text).
 * Per-part — settle prefix on one part does not hide sibling body/file/card.
 * Uses json_extract + GLOB (case-sensitive) to match JS startsWith('oc.settle.').
 */
const contactUnreadHasVisiblePartSql = (messageIdExpr) => (
  `EXISTS (
     SELECT 1 FROM assistant_contact_part p
     WHERE p.message_id = ${messageIdExpr}
       AND (
         json_extract(p.part_json, '$.type') IN ('file', 'card')
         OR (
           json_extract(p.part_json, '$.type') = 'text'
           AND length(trim(coalesce(json_extract(p.part_json, '$.text'), ''))) > 0
           AND trim(coalesce(json_extract(p.part_json, '$.text'), '')) NOT GLOB 'oc.settle.*'
         )
       )
   )`
);

/**
 * Count unread user-facing assistant/peer replies after the watermark.
 * Watermark keyset is applied in SQL; only post-watermark candidates hit the
 * visible-part EXISTS. Fully-read history (no candidates) does not scan parts.
 */
export function countContactUnread(db, assistantID, watermark = null) {
  if (typeof assistantID !== 'string' || !assistantID) return 0;
  const mark = watermark && typeof watermark === 'object'
    ? normalizeReadCursor(watermark)
    : normalizeReadCursor(getContactReadWatermark(db, assistantID));
  const afterSql = contactUnreadAfterWatermarkSql('m.ordinal', 'm.message_id');
  const row = db.prepare(
    `SELECT COUNT(*) AS count
     FROM assistant_contact_message m
     WHERE m.assistant_id = ?
       AND m.role IN ('assistant', 'peer')
       AND m.status IN ('complete', 'error')
       AND ${afterSql}
       AND ${contactUnreadHasVisiblePartSql('m.message_id')}`,
  ).get(assistantID, mark.ordinal, mark.ordinal, mark.messageID);
  return Number(row?.count) || 0;
}

/**
 * Batch unread counts + watermarks + tips for snapshot (catalog ≤100).
 * Returns Map(assistantID → { unreadCount, readWatermark, readTip }).
 * Per-assistant watermark keyset is pushed into SQL via a VALUES marks CTE;
 * COUNT aggregates only post-watermark visible candidates (no full-history
 * message/.parts scan when the catalog is fully read).
 */
export function getContactUnreadSnapshots(db, assistantIDs) {
  const result = new Map();
  const ids = [...new Set(
    (Array.isArray(assistantIDs) ? assistantIDs : [])
      .filter((id) => typeof id === 'string' && id),
  )];
  for (const id of ids) {
    result.set(id, {
      unreadCount: 0,
      readWatermark: {
        generation: 0,
        ordinal: EMPTY_CONTACT_READ_CURSOR.ordinal,
        messageID: EMPTY_CONTACT_READ_CURSOR.messageID,
      },
      readTip: {
        generation: 0,
        ordinal: EMPTY_CONTACT_READ_CURSOR.ordinal,
        messageID: EMPTY_CONTACT_READ_CURSOR.messageID,
      },
    });
  }
  if (ids.length === 0) return result;

  const placeholders = ids.map(() => '?').join(',');
  const generationRows = db.prepare(
    `SELECT assistant_id, generation FROM assistant_contact_generation
     WHERE assistant_id IN (${placeholders})`,
  ).all(...ids);
  const generationByID = new Map(ids.map((id) => [id, 0]));
  for (const row of generationRows) {
    const generation = Number(row.generation);
    generationByID.set(
      row.assistant_id,
      Number.isSafeInteger(generation) && generation >= 0 ? generation : 0,
    );
  }

  const stateRows = db.prepare(
    `SELECT assistant_id, last_read_ordinal, last_read_message_id, generation
     FROM assistant_contact_read_state
     WHERE assistant_id IN (${placeholders})`,
  ).all(...ids);
  const watermarkByID = new Map();
  for (const id of ids) {
    watermarkByID.set(id, {
      generation: generationByID.get(id) ?? 0,
      ordinal: EMPTY_CONTACT_READ_CURSOR.ordinal,
      messageID: EMPTY_CONTACT_READ_CURSOR.messageID,
    });
  }
  for (const row of stateRows) {
    const liveGeneration = generationByID.get(row.assistant_id) ?? 0;
    const rowGeneration = Number(row.generation);
    if (!Number.isSafeInteger(rowGeneration) || rowGeneration !== liveGeneration) {
      continue;
    }
    const cursor = normalizeReadCursor({
      ordinal: row.last_read_ordinal,
      messageID: row.last_read_message_id,
    });
    watermarkByID.set(row.assistant_id, {
      generation: liveGeneration,
      ordinal: cursor.ordinal,
      messageID: cursor.messageID,
    });
  }

  // Tip: newest (ordinal, message_id) per assistant — one indexed probe each (≤100).
  const tipProbe = db.prepare(
    `SELECT ordinal, message_id AS messageID
     FROM assistant_contact_message
     WHERE assistant_id=?
     ORDER BY ordinal DESC, message_id DESC
     LIMIT 1`,
  );
  const tipByID = new Map();
  for (const id of ids) {
    const tipRow = tipProbe.get(id);
    tipByID.set(id, {
      generation: generationByID.get(id) ?? 0,
      ordinal: tipRow ? (Number(tipRow.ordinal) || 0) : EMPTY_CONTACT_READ_CURSOR.ordinal,
      messageID: tipRow && typeof tipRow.messageID === 'string' ? tipRow.messageID : EMPTY_CONTACT_READ_CURSOR.messageID,
    });
  }

  // Unread: one aggregated COUNT with per-id watermark keyset in SQL.
  // Fully-read assistants contribute zero candidate rows → no parts EXISTS work.
  const markValuesSql = ids.map(() => '(?,?,?)').join(',');
  const markParams = [];
  for (const id of ids) {
    const mark = watermarkByID.get(id) || EMPTY_CONTACT_READ_CURSOR;
    markParams.push(id, mark.ordinal, mark.messageID);
  }
  const unreadByID = new Map(ids.map((id) => [id, 0]));
  const countRows = db.prepare(
    `WITH marks(assistant_id, mark_ordinal, mark_message_id) AS (
       VALUES ${markValuesSql}
     )
     SELECT m.assistant_id AS assistant_id, COUNT(*) AS count
     FROM assistant_contact_message m
     INNER JOIN marks ON marks.assistant_id = m.assistant_id
     WHERE m.role IN ('assistant', 'peer')
       AND m.status IN ('complete', 'error')
       AND (
         m.ordinal > marks.mark_ordinal
         OR (m.ordinal = marks.mark_ordinal AND m.message_id > marks.mark_message_id)
       )
       AND ${contactUnreadHasVisiblePartSql('m.message_id')}
     GROUP BY m.assistant_id`,
  ).all(...markParams);
  for (const row of countRows) {
    unreadByID.set(row.assistant_id, Number(row.count) || 0);
  }

  for (const id of ids) {
    result.set(id, {
      unreadCount: unreadByID.get(id) || 0,
      readWatermark: watermarkByID.get(id),
      readTip: tipByID.get(id),
    });
  }
  return result;
}

/**
 * Monotonic advance of the shared read watermark.
 * - generation must match live transcript generation (else contact_generation_conflict).
 * - Only moves forward in (ordinal, messageID) keyset order; late/stale lower
 *   cursors are no-ops (changed:false) so concurrent clients cannot erase newer unread.
 * - Incoming cursor is clamped to the current transcript tip (cannot invent future ids).
 * - Idempotent when equal: changed false, no write.
 */
export function advanceContactReadWatermark(db, assistantID, input = {}, { updatedAt = Date.now() } = {}) {
  if (typeof assistantID !== 'string' || !assistantID) {
    throw contactStoreError('validation_error', 'assistantID required');
  }
  const liveGeneration = getContactGeneration(db, assistantID);
  const requestedGeneration = Number(input.generation);
  if (!Number.isSafeInteger(requestedGeneration) || requestedGeneration < 0) {
    throw contactStoreError('validation_error', 'generation must be a non-negative integer');
  }
  if (requestedGeneration !== liveGeneration) {
    throw contactStoreError(
      'contact_generation_conflict',
      'Contact transcript generation changed; refetch snapshot before marking read.',
    );
  }
  const requested = normalizeReadCursor({
    ordinal: input.ordinal,
    messageID: input.messageID,
  });
  if (requested.ordinal < 0 || (requested.ordinal > 0 && !requested.messageID)) {
    // ordinal 0 + empty messageID is the valid "nothing" cursor; otherwise require messageID.
    if (requested.ordinal !== 0 || requested.messageID !== '') {
      throw contactStoreError('validation_error', 'ordinal/messageID cursor invalid');
    }
  }
  if (requested.ordinal > 0 && typeof input.messageID !== 'string') {
    throw contactStoreError('validation_error', 'messageID must be a string');
  }

  const tip = getContactReadTip(db, assistantID);
  const current = getContactReadWatermark(db, assistantID);

  // Clamp to tip so deleted/future ids cannot jump past the authoritative head.
  let next = requested;
  if (compareContactReadCursor(next, tip) > 0) {
    next = { ordinal: tip.ordinal, messageID: tip.messageID };
  }

  // Monotonic: never move backward.
  if (compareContactReadCursor(next, current) <= 0) {
    return {
      changed: false,
      readWatermark: current,
      readTip: tip,
      unreadCount: countContactUnread(db, assistantID, current),
    };
  }

  db.prepare(
    `INSERT INTO assistant_contact_read_state(
       assistant_id, last_read_ordinal, last_read_message_id, generation, updated_at
     ) VALUES (?,?,?,?,?)
     ON CONFLICT(assistant_id) DO UPDATE SET
       last_read_ordinal=excluded.last_read_ordinal,
       last_read_message_id=excluded.last_read_message_id,
       generation=excluded.generation,
       updated_at=excluded.updated_at`,
  ).run(assistantID, next.ordinal, next.messageID, liveGeneration, updatedAt);

  const readWatermark = {
    generation: liveGeneration,
    ordinal: next.ordinal,
    messageID: next.messageID,
  };
  return {
    changed: true,
    readWatermark,
    readTip: tip,
    unreadCount: countContactUnread(db, assistantID, readWatermark),
  };
}

/**
 * After a generation bump (wipe/reset): bind read state to the new generation
 * with an empty watermark so remaining/new rows can become unread. Does not
 * seed to tip — post-wipe confirm bubbles should surface as unread until viewed.
 */
export function resetContactReadWatermarkForGeneration(db, assistantID, generation, { updatedAt = Date.now() } = {}) {
  if (typeof assistantID !== 'string' || !assistantID) {
    throw contactStoreError('validation_error', 'assistantID required');
  }
  const nextGeneration = Number(generation);
  if (!Number.isSafeInteger(nextGeneration) || nextGeneration < 0) {
    throw contactStoreError('validation_error', 'generation must be a non-negative integer');
  }
  db.prepare(
    `INSERT INTO assistant_contact_read_state(
       assistant_id, last_read_ordinal, last_read_message_id, generation, updated_at
     ) VALUES (?,?,?,?,?)
     ON CONFLICT(assistant_id) DO UPDATE SET
       last_read_ordinal=excluded.last_read_ordinal,
       last_read_message_id=excluded.last_read_message_id,
       generation=excluded.generation,
       updated_at=excluded.updated_at`,
  ).run(
    assistantID,
    EMPTY_CONTACT_READ_CURSOR.ordinal,
    EMPTY_CONTACT_READ_CURSOR.messageID,
    nextGeneration,
    updatedAt,
  );
  return getContactReadWatermark(db, assistantID);
}

/**
 * Schema migrate helper: seed every assistant that has transcript rows so
 * legacy history is treated as already read (unreadCount 0). Assistants with
 * no messages keep the implicit empty watermark.
 */
export function migrateContactReadStateDefaultRead(db, { updatedAt = Date.now() } = {}) {
  const assistants = db.prepare(
    `SELECT DISTINCT assistant_id AS assistantID FROM assistant_contact_message`,
  ).all();
  let seeded = 0;
  for (const row of assistants) {
    const assistantID = row.assistantID;
    if (typeof assistantID !== 'string' || !assistantID) continue;
    const existing = db.prepare(
      'SELECT assistant_id FROM assistant_contact_read_state WHERE assistant_id=?',
    ).get(assistantID);
    if (existing) continue;
    const tip = getContactReadTip(db, assistantID);
    db.prepare(
      `INSERT INTO assistant_contact_read_state(
         assistant_id, last_read_ordinal, last_read_message_id, generation, updated_at
       ) VALUES (?,?,?,?,?)`,
    ).run(assistantID, tip.ordinal, tip.messageID, tip.generation, updatedAt);
    seeded += 1;
  }
  return { seeded };
}

/** Drop read-state row (assistant delete / full cleanup). */
export function deleteContactReadState(db, assistantID) {
  if (typeof assistantID !== 'string' || !assistantID) return;
  db.prepare('DELETE FROM assistant_contact_read_state WHERE assistant_id=?').run(assistantID);
}

/**
 * Decode an opaque contact page cursor.
 * v1: { v:1, assistantID, generation, ordinal, messageID }
 * Legacy (pre-pagination clients): { ordinal, messageID } — treated as generation 0.
 */
export function decodeContactCursor(value) {
  if (value == null || value === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (!Number.isSafeInteger(parsed.ordinal) || typeof parsed.messageID !== 'string' || !parsed.messageID) {
    return null;
  }
  const hasVersion = parsed.v != null;
  if (hasVersion) {
    if (parsed.v !== CONTACT_CURSOR_VERSION) return null;
    if (typeof parsed.assistantID !== 'string' || !parsed.assistantID.trim()) return null;
    if (!Number.isSafeInteger(parsed.generation) || parsed.generation < 0) return null;
    return {
      v: CONTACT_CURSOR_VERSION,
      assistantID: parsed.assistantID.trim(),
      generation: parsed.generation,
      ordinal: parsed.ordinal,
      messageID: parsed.messageID,
      legacy: false,
    };
  }
  // Legacy keyset without generation/assistant — only valid while generation is still 0.
  return {
    v: CONTACT_CURSOR_VERSION,
    assistantID: null,
    generation: 0,
    ordinal: parsed.ordinal,
    messageID: parsed.messageID,
    legacy: true,
  };
}

export function encodeContactCursor({ assistantID, generation, ordinal, messageID }) {
  return Buffer.from(json({
    v: CONTACT_CURSOR_VERSION,
    assistantID,
    generation,
    ordinal,
    messageID,
  })).toString('base64url');
}

const hydrateMessage = (db, row) => {
  const parts = db.prepare(
    'SELECT part_json FROM assistant_contact_part WHERE message_id=? ORDER BY ordinal ASC, part_id ASC',
  ).all(row.message_id).map((part) => parse(part.part_json)).map(parseContactPart).filter(Boolean);
  const fromAssistantID = typeof row.from_assistant_id === 'string' && row.from_assistant_id.trim() ? row.from_assistant_id : null;
  const storedName = typeof row.from_assistant_name === 'string' && row.from_assistant_name.trim() ? row.from_assistant_name : null;
  let liveName = null;
  if (fromAssistantID) {
    try {
      liveName = db.prepare('SELECT name FROM assistant_v2 WHERE assistant_id=?').get(fromAssistantID)?.name;
    } catch {
      liveName = null;
    }
  }
  return {
    messageID: row.message_id,
    assistantID: row.assistant_id,
    role: row.role,
    turnID: row.turn_id,
    bubbleIndex: row.bubble_index,
    createdAt: row.created_at,
    ordinal: row.ordinal,
    status: row.status,
    fromAssistantID,
    fromAssistantName: storedName || (typeof liveName === 'string' && liveName.trim() ? liveName : null),
    parts,
    text: parts.filter((part) => part.type === 'text').map((part) => part.text).join(''),
    cards: parts.filter((part) => part.type === 'card'),
  };
};

export function nextContactOrdinal(db, assistantID) {
  return Number(db.prepare(
    'SELECT COALESCE(MAX(ordinal), 0) + 1 AS next FROM assistant_contact_message WHERE assistant_id=?',
  ).get(assistantID).next);
}

/** Load one contact row by message id (null when missing). */
export function getContactMessage(db, messageID) {
  if (typeof messageID !== 'string' || !messageID) return null;
  const row = db.prepare('SELECT * FROM assistant_contact_message WHERE message_id=?').get(messageID);
  if (!row) return null;
  return hydrateMessage(db, row);
}

const isSettleOnlyText = (text) => {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  return trimmed.startsWith('oc.settle.');
};

/** Strip data-URLs / dense base64 so list previews never carry attachment bodies. */
export function sanitizeContactPreviewText(text, maxChars = CONTACT_PREVIEW_MAX_CHARS) {
  const raw = typeof text === 'string' ? text : '';
  const cleaned = raw
    .replace(/data:[^\s]+/giu, ' ')
    .replace(/(?:[A-Za-z0-9+/]{48,}={0,2})/g, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : CONTACT_PREVIEW_MAX_CHARS;
  return cleaned.length > limit ? cleaned.slice(0, limit) : cleaned;
}

/**
 * Build AssistantDTO.latestMessagePreview from one hydrated contact message.
 * Returns null when the row is not list-visible (internal settle-only, empty,
 * unsupported role). Peer inbox rows map to role `user` (user-visible DM).
 * Visible error bubbles keep real body text. Cards/files set fallbackKind.
 */
export function buildContactMessagePreview(message) {
  if (!message || typeof message !== 'object') return null;
  const sourceRole = message.role;
  if (sourceRole !== 'user' && sourceRole !== 'assistant' && sourceRole !== 'peer') return null;
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const textFromParts = parts
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
  const rawText = (typeof message.text === 'string' && message.text) || textFromParts || '';
  const trimmed = rawText.trim();
  const files = parts.filter((part) => part?.type === 'file');
  const cards = parts.filter((part) => part?.type === 'card');
  // Assigned-session settle notices are internal transcript markers, not list copy.
  if (isSettleOnlyText(trimmed) && files.length === 0 && cards.length === 0) return null;

  let text = '';
  let fallbackKind = null;
  if (trimmed && !isSettleOnlyText(trimmed)) {
    text = sanitizeContactPreviewText(trimmed);
  }
  if (!text && files.length > 0) {
    const file = files[0];
    const mime = typeof file.mime === 'string' ? file.mime : '';
    fallbackKind = mime.startsWith('image/') ? 'image' : 'file';
    const filename = typeof file.filename === 'string' ? file.filename.trim() : '';
    text = sanitizeContactPreviewText(filename);
  }
  if (!text && !fallbackKind && cards.length > 0) {
    const card = cards[0];
    const cardType = card.cardType;
    if (cardType === 'session' || cardType === 'assistant' || cardType === 'schedule') {
      fallbackKind = cardType;
    }
    const label = typeof card.title === 'string' && card.title.trim()
      ? card.title
      : (typeof card.name === 'string' ? card.name : '');
    text = sanitizeContactPreviewText(label);
  }
  // Empty pure-card without title still surfaces the card kind for the list icon.
  if (!text && !fallbackKind) return null;
  if (!text && fallbackKind && cards.length > 0 && files.length === 0 && !trimmed) {
    // keep empty text + fallbackKind
  } else if (!text && !fallbackKind) {
    return null;
  }

  const messageID = typeof message.messageID === 'string' ? message.messageID : '';
  const ordinal = Number(message.ordinal);
  if (!messageID || !Number.isFinite(ordinal)) return null;

  return {
    messageID,
    ordinal,
    createdAt: message.createdAt,
    // Peer DMs are user-visible inbox rows; list language is user|assistant only.
    role: sourceRole === 'assistant' ? 'assistant' : 'user',
    text: text || '',
    fallbackKind,
  };
}

const loadContactPartsByMessageIDs = (db, messageIDs) => {
  const map = new Map();
  const ids = (Array.isArray(messageIDs) ? messageIDs : [])
    .filter((id) => typeof id === 'string' && id);
  if (ids.length === 0) return map;
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT message_id, part_json FROM assistant_contact_part
     WHERE message_id IN (${placeholders})
     ORDER BY message_id ASC, ordinal ASC, part_id ASC`,
  ).all(...ids);
  for (const row of rows) {
    const part = parseContactPart(parse(row.part_json));
    if (!part) continue;
    const list = map.get(row.message_id);
    if (list) list.push(part);
    else map.set(row.message_id, [part]);
  }
  return map;
};

const messageFromPreviewRow = (row, parts) => {
  const list = Array.isArray(parts) ? parts : [];
  return {
    messageID: row.message_id,
    assistantID: row.assistant_id,
    role: row.role,
    ordinal: row.ordinal,
    status: row.status,
    parts: list,
    text: list.filter((part) => part.type === 'text').map((part) => part.text).join(''),
  };
};

const pickPreviewFromCandidateRows = (rows, partsByMessage) => {
  for (const row of rows) {
    const preview = buildContactMessagePreview(
      messageFromPreviewRow(row, partsByMessage.get(row.message_id) || []),
    );
    if (preview) return preview;
  }
  return null;
};

/**
 * Indexed newest-first probe for list-visible contact rows.
 *
 * - Uses `assistant_contact_message_page` (assistant_id, ordinal, message_id).
 * - Limits to `candidateLimit` rows per assistant (no full-history sort).
 * - Restricts to user/assistant/peer (preview-visible roles).
 * - Drops pure internal settle markers (`oc.settle.*` text-only parts) in SQL
 *   so a long tail of settle rows cannot exhaust the LIMIT and hide the real
 *   latest user/assistant bubble. File/card settle hybrids still pass through
 *   for buildContactMessagePreview. Other empty/non-preview rows may still
 *   occupy a slot and force a deeper probe only within the same LIMIT.
 */
const CONTACT_PREVIEW_CANDIDATE_SQL = `
  SELECT message_id, assistant_id, role, ordinal, status
  FROM assistant_contact_message m
  WHERE m.assistant_id = ?
    AND m.role IN ('user', 'assistant', 'peer')
    AND NOT (
      EXISTS (
        SELECT 1 FROM assistant_contact_part p
        WHERE p.message_id = m.message_id
          AND (
            p.part_json LIKE '%"text":"oc.settle.complete"%'
            OR p.part_json LIKE '%"text":"oc.settle.error"%'
            OR p.part_json LIKE '%"text":"oc.settle.question"%'
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM assistant_contact_part p2
        WHERE p2.message_id = m.message_id
          AND (
            p2.part_json LIKE '%"type":"file"%'
            OR p2.part_json LIKE '%"type":"card"%'
          )
      )
    )
  ORDER BY m.ordinal DESC, m.message_id DESC
  LIMIT ?
`;

const boundPreviewCandidateLimit = (candidateLimit) => {
  if (Number.isFinite(candidateLimit) && candidateLimit > 0) {
    return Math.min(Math.floor(candidateLimit), 100);
  }
  return CONTACT_PREVIEW_CANDIDATE_LIMIT;
};

/**
 * Authoritative list preview for one assistant: newest visible contact row by
 * (ordinal DESC, message_id DESC). One indexed probe + parts for those IDs only.
 */
export function getLatestContactMessagePreview(db, assistantID, {
  candidateLimit = CONTACT_PREVIEW_CANDIDATE_LIMIT,
} = {}) {
  if (typeof assistantID !== 'string' || !assistantID) return null;
  const limit = boundPreviewCandidateLimit(candidateLimit);
  const rows = db.prepare(CONTACT_PREVIEW_CANDIDATE_SQL).all(assistantID, limit);
  if (rows.length === 0) return null;
  const partsByMessage = loadContactPartsByMessageIDs(db, rows.map((row) => row.message_id));
  return pickPreviewFromCandidateRows(rows, partsByMessage);
}

/**
 * Batch previews for snapshot (catalog size ≤100).
 *
 * Reuses **one** prepared statement: per assistant_id, indexed
 * `ORDER BY ordinal DESC, message_id DESC LIMIT candidateLimit` (not a window
 * over the full multi-assistant history). Collects bounded candidate IDs, then
 * **one** parts IN-query for all of them. No HTTP N+1; no full-table rank sort.
 *
 * Returns Map(assistantID → preview | null). Missing / empty assistants → null.
 */
export function getLatestContactMessagePreviews(db, assistantIDs, {
  candidateLimit = CONTACT_PREVIEW_CANDIDATE_LIMIT,
} = {}) {
  const result = new Map();
  const ids = [...new Set(
    (Array.isArray(assistantIDs) ? assistantIDs : [])
      .filter((id) => typeof id === 'string' && id),
  )];
  for (const id of ids) result.set(id, null);
  if (ids.length === 0) return result;

  const limit = boundPreviewCandidateLimit(candidateLimit);
  const probe = db.prepare(CONTACT_PREVIEW_CANDIDATE_SQL);
  const candidates = [];
  for (const assistantID of ids) {
    const rows = probe.all(assistantID, limit);
    for (const row of rows) candidates.push(row);
  }
  if (candidates.length === 0) return result;

  const partsByMessage = loadContactPartsByMessageIDs(
    db,
    candidates.map((row) => row.message_id),
  );
  const byAssistant = new Map();
  for (const row of candidates) {
    const list = byAssistant.get(row.assistant_id);
    if (list) list.push(row);
    else byAssistant.set(row.assistant_id, [row]);
  }
  for (const [assistantID, rows] of byAssistant) {
    result.set(assistantID, pickPreviewFromCandidateRows(rows, partsByMessage));
  }
  return result;
}

/** Stable fingerprint for idempotent contact admission replay. */
/**
 * Canonical fingerprint for idempotent admission.
 * File parts prefer sha256+size+mime+filename (stable across attachmentID/url forms).
 * Legacy data URLs are normalized by decoded content hash when possible.
 */
export function contactPartsFingerprint(parts) {
  const list = Array.isArray(parts) ? parts : [];
  return json(list.map((part) => {
    if (!part || typeof part !== 'object') return null;
    if (part.type === 'text') return { type: 'text', text: typeof part.text === 'string' ? part.text : '' };
    if (part.type === 'file') {
      const mime = typeof part.mime === 'string' ? part.mime : '';
      const filename = typeof part.filename === 'string' ? part.filename : '';
      const sha256 = typeof part.sha256 === 'string' ? part.sha256.toLowerCase() : '';
      const size = Number.isSafeInteger(part.size) ? part.size : null;
      // Content identity only when hash/size known — attachmentID is ownership, not replay key.
      if (sha256 || size != null) {
        return {
          type: 'file',
          mime,
          filename,
          sha256,
          size,
        };
      }
      const url = typeof part.url === 'string' ? part.url : '';
      if (url.startsWith('data:')) {
        try {
          // Reuse fs-store strict decoder (same alphabet / padding / charset rules).
          const decoded = decodeDataUrlStrict(url, {
            mode: 'migration',
            maxBytes: FINGERPRINT_DATA_URL_MAX_BYTES,
          });
          return {
            type: 'file',
            mime: mime || decoded.mime,
            filename,
            sha256: crypto.createHash('sha256').update(decoded.buffer).digest('hex'),
            size: decoded.buffer.length,
          };
        } catch {
          return { type: 'file', mime, filename, sha256: '', size: null, urlLen: url.length };
        }
      }
      // Ref without hash/size: ownership id is not content identity (cannot key replay alone).
      if (typeof part.attachmentID === 'string' && part.attachmentID) {
        return { type: 'file', mime, filename, sha256: '', size: null, refOnly: true };
      }
      return { type: 'file', mime, filename, sha256: '', size: null };
    }
    return part;
  }));
}

export function insertContactMessage(db, {
  messageID,
  assistantID,
  role,
  turnID,
  bubbleIndex = 0,
  createdAt,
  ordinal,
  status = 'complete',
  parts,
  fromAssistantID = null,
  fromAssistantName = null,
}) {
  db.prepare(
    'INSERT INTO assistant_contact_message(message_id,assistant_id,role,turn_id,bubble_index,created_at,ordinal,status,from_assistant_id,from_assistant_name) VALUES (?,?,?,?,?,?,?,?,?,?)',
  ).run(messageID, assistantID, role, turnID, bubbleIndex, createdAt, ordinal, status, fromAssistantID, fromAssistantName);
  parts.forEach((part, index) => {
    const serialized = serializeContactPart(part, index);
    db.prepare(
      'INSERT INTO assistant_contact_part(message_id,part_id,ordinal,part_json) VALUES (?,?,?,?)',
    ).run(messageID, serialized.id, index + 1, json(serialized));
  });
}

/**
 * Page the contact transcript (UI contract).
 * - Ascending messages on the page; keyset is (ordinal DESC, messageID DESC) for older pages.
 * - Default limit 20, max 100.
 * - `before` and `messageID` are mutually exclusive.
 * - Exact `messageID` returns at most one row for this assistant, nextCursor null, complete true.
 * - Stale generation in cursor → contact_generation_conflict.
 */
export function listContactMessages(db, assistantID, {
  before,
  limit = CONTACT_PAGE_DEFAULT_LIMIT,
  messageID = null,
} = {}) {
  if (typeof assistantID !== 'string' || !assistantID) {
    throw contactStoreError('validation_error', 'assistantID required');
  }
  const hasBefore = !(before == null || before === '');
  const hasExact = !(messageID == null || messageID === '');
  if (hasBefore && hasExact) {
    throw contactStoreError('validation_error', 'before and messageID are mutually exclusive');
  }

  let parsedLimit = limit;
  if (parsedLimit == null || parsedLimit === '') parsedLimit = CONTACT_PAGE_DEFAULT_LIMIT;
  parsedLimit = typeof parsedLimit === 'number' ? parsedLimit : Number(String(parsedLimit).trim());
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > CONTACT_PAGE_MAX_LIMIT) {
    throw contactStoreError('validation_error', `limit must be an integer from 1 to ${CONTACT_PAGE_MAX_LIMIT}`);
  }

  const generation = getContactGeneration(db, assistantID);

  if (hasExact) {
    if (typeof messageID !== 'string' || !messageID.trim()) {
      throw contactStoreError('validation_error', 'messageID must be a non-empty string');
    }
    const row = db.prepare(
      'SELECT * FROM assistant_contact_message WHERE assistant_id=? AND message_id=?',
    ).get(assistantID, messageID.trim());
    return {
      messages: row ? [hydrateMessage(db, row)] : [],
      nextCursor: null,
      complete: true,
      generation,
    };
  }

  let cursor = null;
  if (hasBefore) {
    cursor = decodeContactCursor(before);
    if (!cursor) {
      throw contactStoreError('validation_error', 'invalid contact messages cursor');
    }
    if (cursor.assistantID && cursor.assistantID !== assistantID) {
      throw contactStoreError('validation_error', 'cursor assistantID does not match path');
    }
    if (cursor.generation !== generation) {
      throw contactStoreError(
        'contact_generation_conflict',
        'Contact transcript generation changed; refetch from the start.',
      );
    }
  }

  const rows = cursor
    ? db.prepare(
      'SELECT * FROM assistant_contact_message WHERE assistant_id=? AND (ordinal<? OR (ordinal=? AND message_id<?)) ORDER BY ordinal DESC, message_id DESC LIMIT ?',
    ).all(assistantID, cursor.ordinal, cursor.ordinal, cursor.messageID, parsedLimit + 1)
    : db.prepare(
      'SELECT * FROM assistant_contact_message WHERE assistant_id=? ORDER BY ordinal DESC, message_id DESC LIMIT ?',
    ).all(assistantID, parsedLimit + 1);
  const page = rows.slice(0, parsedLimit);
  const oldest = page[page.length - 1];
  const nextCursor = rows.length > parsedLimit && oldest
    ? encodeContactCursor({
      assistantID,
      generation,
      ordinal: oldest.ordinal,
      messageID: oldest.message_id,
    })
    : null;
  return {
    messages: [...page].reverse().map((row) => hydrateMessage(db, row)),
    nextCursor,
    complete: nextCursor === null,
    generation,
  };
}

/**
 * Wipe contact transcript rows for one assistant.
 *
 * Bounded tool wipe (`upToOrdinal` = wiping turn's user ordinal):
 * - **Keep** only `role='user'` rows with `ordinal >= ceiling` (the wipe request
 *   itself plus later-admitted queued users) and their parts / message IDs.
 * - **Delete** every other row at any ordinal: prior users, and all
 *   assistant / peer / error / card rows — including late writes from an
 *   earlier still-running lane whose ordinal landed after the wipe user.
 * Keeping the wipe user avoids delete+re-admit reordering queued users before it.
 *
 * Direct API callers without a turn ceiling omit `upToOrdinal` and delete every
 * row (existing contract; concurrent in-flight admissions are not preserved).
 * Watches and the LLM context boundary always clear on wipe.
 */
export function deleteContactMessages(db, assistantID, { upToOrdinal = null } = {}) {
  const parsedCeiling = upToOrdinal == null || upToOrdinal === ''
    ? NaN
    : Number(upToOrdinal);
  const bounded = Number.isFinite(parsedCeiling);
  // Single delete set drives both parts and message rows.
  const ids = bounded
    ? db.prepare(
      `SELECT message_id FROM assistant_contact_message
       WHERE assistant_id=?
         AND NOT (role = 'user' AND ordinal >= ?)`,
    ).all(assistantID, parsedCeiling).map((row) => row.message_id)
    : db.prepare(
      'SELECT message_id FROM assistant_contact_message WHERE assistant_id=?',
    ).all(assistantID).map((row) => row.message_id);
  for (const messageID of ids) {
    db.prepare('DELETE FROM assistant_contact_part WHERE message_id=?').run(messageID);
  }
  if (bounded) {
    db.prepare(
      `DELETE FROM assistant_contact_message
       WHERE assistant_id=?
         AND NOT (role = 'user' AND ordinal >= ?)`,
    ).run(assistantID, parsedCeiling);
  } else {
    db.prepare('DELETE FROM assistant_contact_message WHERE assistant_id=?').run(assistantID);
  }
  db.prepare('DELETE FROM assistant_contact_watch WHERE assistant_id=?').run(assistantID);
  db.prepare('DELETE FROM assistant_contact_context_boundary WHERE assistant_id=?').run(assistantID);
  // Unbounded wipe leaves generation/read_state for the service layer to rebind
  // (resetContact bumps generation + resetContactReadWatermarkForGeneration).
  // Assistant delete clears read_state via deleteContactReadState.
}

/**
 * Delete only this turn's assistant-role output rows (spoken bubbles / cards / errors).
 * Keeps the clearing user, queued users, peers, older turns, watches, generation,
 * context boundary, and read watermark. Does not call deleteContactMessages.
 */
export function deleteContactTurnAssistantOutputs(db, assistantID, turnID) {
  if (typeof assistantID !== 'string' || !assistantID.trim()) return 0;
  if (typeof turnID !== 'string' || !turnID.trim()) return 0;
  const ids = db.prepare(
    `SELECT message_id FROM assistant_contact_message
     WHERE assistant_id=? AND turn_id=? AND role='assistant'`,
  ).all(assistantID, turnID).map((row) => row.message_id);
  for (const messageID of ids) {
    db.prepare('DELETE FROM assistant_contact_part WHERE message_id=?').run(messageID);
  }
  if (ids.length === 0) return 0;
  const result = db.prepare(
    `DELETE FROM assistant_contact_message
     WHERE assistant_id=? AND turn_id=? AND role='assistant'`,
  ).run(assistantID, turnID);
  return Number(result?.changes) || ids.length;
}

/** Durable LLM context watermark for one assistant (0 = no boundary). */
export function getContactContextBoundary(db, assistantID) {
  const row = db.prepare(
    'SELECT after_ordinal FROM assistant_contact_context_boundary WHERE assistant_id=?',
  ).get(assistantID);
  if (!row || !Number.isFinite(Number(row.after_ordinal))) return 0;
  return Number(row.after_ordinal);
}

/** Includes replies committed by an earlier lane after the clearing user was queued. */
export function getContactAssistantContextBoundary(db, assistantID) {
  const row = db.prepare('SELECT after_ordinal, assistant_after_ordinal FROM assistant_contact_context_boundary WHERE assistant_id=?').get(assistantID);
  return row ? Math.max(Number(row.after_ordinal) || 0, Number(row.assistant_after_ordinal) || 0) : 0;
}

/**
 * Clear LLM memory only: keep every transcript row, advance the watermark so
 * later contactHistoryForLlm drops prior turns.
 *
 * Prefer `upToOrdinal` (the clearing turn's user ordinal). Using global MAX
 * would swallow later-admitted queued user rows and permanently exclude them
 * from subsequent LLM windows. API/direct callers without a turn ceiling may
 * omit `upToOrdinal` and clear through the current max.
 * Never lowers an existing boundary. Failed callers must roll back the
 * surrounding transaction to keep the old boundary.
 */
export function clearContactMemory(db, assistantID, { updatedAt = Date.now(), upToOrdinal = null } = {}) {
  const current = getContactContextBoundary(db, assistantID);
  const currentTip = Number(db.prepare('SELECT COALESCE(MAX(ordinal), 0) AS value FROM assistant_contact_message WHERE assistant_id=?').get(assistantID).value);
  const assistantAfterOrdinal = Math.max(currentTip, getContactAssistantContextBoundary(db, assistantID));
  const parsedCeiling = upToOrdinal == null || upToOrdinal === ''
    ? NaN
    : Number(upToOrdinal);
  let afterOrdinal;
  if (Number.isFinite(parsedCeiling)) {
    afterOrdinal = parsedCeiling;
  } else {
    afterOrdinal = Number(db.prepare(
      'SELECT COALESCE(MAX(ordinal), 0) AS max FROM assistant_contact_message WHERE assistant_id=?',
    ).get(assistantID).max);
  }
  if (!Number.isFinite(afterOrdinal)) afterOrdinal = 0;
  afterOrdinal = Math.max(afterOrdinal, current);
  db.prepare(
    'INSERT INTO assistant_contact_context_boundary(assistant_id, after_ordinal, assistant_after_ordinal, updated_at) VALUES (?,?,?,?) ON CONFLICT(assistant_id) DO UPDATE SET after_ordinal=excluded.after_ordinal, assistant_after_ordinal=excluded.assistant_after_ordinal, updated_at=excluded.updated_at',
  ).run(assistantID, afterOrdinal, assistantAfterOrdinal, updatedAt);
  return { assistantID, afterOrdinal, memoryCleared: true };
}

export function upsertContactWatch(db, { assistantID, sessionID, directory, status, updatedAt, resumeAllowed = true }) {
  db.prepare(
    'INSERT INTO assistant_contact_watch(assistant_id,session_id,directory,status,updated_at,resume_allowed) VALUES (?,?,?,?,?,?) ON CONFLICT(assistant_id,session_id) DO UPDATE SET directory=excluded.directory,status=excluded.status,updated_at=excluded.updated_at,resume_allowed=excluded.resume_allowed',
  ).run(assistantID, sessionID, directory || null, status, updatedAt, resumeAllowed ? 1 : 0);
}

export function listWatchesBySession(db, sessionID) {
  return db.prepare('SELECT assistant_id, session_id, directory, status, resume_allowed FROM assistant_contact_watch WHERE session_id=?').all(sessionID)
    .map((row) => ({
      assistantID: row.assistant_id,
      sessionID: row.session_id,
      directory: row.directory,
      status: row.status,
      resumeAllowed: row.resume_allowed !== 0,
    }));
}

export function listInFlightWatches(db, assistantID) {
  const rows = typeof assistantID === 'string' && assistantID
    ? db.prepare('SELECT assistant_id, session_id, directory, status FROM assistant_contact_watch WHERE assistant_id=?').all(assistantID)
    : db.prepare('SELECT assistant_id, session_id, directory, status FROM assistant_contact_watch').all();
  return rows
    .filter((row) => IN_FLIGHT_WATCH.has(row.status))
    .map((row) => ({
      assistantID: row.assistant_id,
      sessionID: row.session_id,
      directory: row.directory,
      status: row.status,
    }));
}

export function updateSessionCardStatus(db, { assistantID, sessionID, status }) {
  const rows = db.prepare(
    'SELECT p.message_id, p.part_id, p.ordinal, p.part_json FROM assistant_contact_part p JOIN assistant_contact_message m ON m.message_id=p.message_id WHERE m.assistant_id=?',
  ).all(assistantID);
  let updated = 0;
  for (const row of rows) {
    const part = parseContactPart(parse(row.part_json));
    if (!part || part.type !== 'card' || part.cardType !== 'session' || part.sessionID !== sessionID) continue;
    const next = { ...part, status };
    db.prepare('UPDATE assistant_contact_part SET part_json=? WHERE message_id=? AND part_id=?').run(json(serializeContactPart(next, row.ordinal - 1)), row.message_id, row.part_id);
    updated += 1;
  }
  return updated;
}

/**
 * LLM-only contact window. SQLite and the transcript UI may keep older bubbles
 * (including rows before the durable context boundary). This budget owns the
 * automatic model context; explicit recall uses the same boundaries in memory.js.
 * There is no summarizer and no user-facing compress /
 * continuous / stateless control on this path.
 *
 * A turn is a user message plus the assistant replies that follow it until the
 * next user. Newest turn is always kept, even when it exceeds the char budget.
 * Char estimate is text length plus CONTACT_LLM_FILE_CHAR_WEIGHT per file part
 * (CJK counts as one char; no tokenizer).
 *
 * clearContactMemory advances assistant_contact_context_boundary.after_ordinal;
 * only messages with ordinal > that watermark enter this window.
 */
export const CONTACT_LLM_MAX_TURNS = 32;
export const CONTACT_LLM_MAX_CHARS = 48_000;
export const CONTACT_LLM_FETCH_LIMIT = 100;
export const CONTACT_LLM_FILE_CHAR_WEIGHT = 80;

const estimateLlmChars = (item) => {
  const text = typeof item.content === 'string' ? item.content.length : 0;
  const files = Array.isArray(item.parts) ? item.parts.length * CONTACT_LLM_FILE_CHAR_WEIGHT : 0;
  return text + files;
};

const toLlmHistoryItem = (message) => {
  const files = message.parts.filter((part) => part.type === 'file');
  const cards = message.parts.filter((part) => part.type === 'card').map((part) => `[OpenChamber card context: ${JSON.stringify(part)}]`);
  const content = [message.text.trim() || (files.length > 0 ? '[attachment]' : ''), ...cards].filter(Boolean).join('\n');
  return files.length > 0 ? { role: message.role, content, parts: files } : { role: message.role, content };
};

const isLlmEligibleContactMessage = (message) => {
  if (message.role !== 'user' && message.role !== 'assistant') return false;
  if (message.status === 'error') return false;
  // Peer DMs are read-only inbox rows. They must not become harness turns.
  if (message.role === 'peer' || message.fromAssistantID) return false;
  const hasText = Boolean(message.text?.trim());
  const hasFiles = Array.isArray(message.parts) && message.parts.some((part) => part.type === 'file');
  const hasCards = Array.isArray(message.parts) && message.parts.some((part) => part.type === 'card');
  return hasText || hasFiles || hasCards;
};

/** Turn-aware keep of recent user+assistant text pairs for the model only. */
export function trimContactHistoryForLlm(messages, {
  maxTurns = CONTACT_LLM_MAX_TURNS,
  maxChars = CONTACT_LLM_MAX_CHARS,
} = {}) {
  const eligible = (Array.isArray(messages) ? messages : [])
    .filter(isLlmEligibleContactMessage)
    .map(toLlmHistoryItem)
    .filter((item) => item.content.trim().length > 0);

  const turns = [];
  let current = [];
  for (let index = eligible.length - 1; index >= 0; index -= 1) {
    const item = eligible[index];
    if (item.role === 'user') {
      current.unshift(item);
      turns.push(current);
      current = [];
    } else {
      current.unshift(item);
    }
  }
  if (current.length > 0) turns.push(current);

  const kept = [];
  let chars = 0;
  for (const turn of turns) {
    const turnChars = turn.reduce((sum, item) => sum + estimateLlmChars(item), 0);
    if (kept.length >= maxTurns) break;
    if (kept.length > 0 && chars + turnChars > maxChars) break;
    kept.push(turn);
    chars += turnChars;
  }
  return kept.reverse().flat();
}

/**
 * LLM window for one contact turn.
 * - after_ordinal watermark drops cleared memory.
 * - excludeMessageIDs drops the current admitted user row (prompt still gets userText).
 * - beforeOrdinal is the current turn's user message ordinal. Later-admitted user
 *   rows (queued turns) must not be injected into this turn; assistant rows written
 *   after that ordinal by a prior completed lane turn still enter the window.
 */
/**
 * In-process contact-turn activity (not SQLite). Process memory only: APP
 * restart while the server keeps running can rehydrate from snapshot; a server
 * process restart clears every active turn so the green dot cannot stick forever.
 * Status ladder: admission → queued → running → settled (removed).
 */
export const CONTACT_ACTIVE_TURN_STATUSES = Object.freeze(['queued', 'running']);

export function createActiveContactTurn({ turnID, messageID, status = 'queued', admittedAt }) {
  if (typeof turnID !== 'string' || !turnID.trim()) return null;
  if (typeof messageID !== 'string' || !messageID.trim()) return null;
  if (!CONTACT_ACTIVE_TURN_STATUSES.includes(status)) return null;
  const at = Number(admittedAt);
  if (!Number.isFinite(at)) return null;
  return {
    turnID: turnID.trim(),
    messageID: messageID.trim(),
    status,
    admittedAt: Math.trunc(at),
  };
}

/** Earliest admitted active turn; running preferred when admittedAt ties. */
export function projectActiveContactTurn(activeTurns) {
  const list = Array.isArray(activeTurns)
    ? activeTurns
    : (activeTurns instanceof Map ? [...activeTurns.values()] : []);
  const valid = list
    .map((item) => createActiveContactTurn(item))
    .filter(Boolean)
    .sort((left, right) => {
      if (left.admittedAt !== right.admittedAt) return left.admittedAt - right.admittedAt;
      if (left.status === right.status) return left.turnID.localeCompare(right.turnID);
      return left.status === 'running' ? -1 : 1;
    });
  return valid[0] ?? null;
}

export function contactHistoryForLlm(db, assistantID, { excludeMessageIDs = [], beforeOrdinal = null } = {}) {
  const afterOrdinal = getContactContextBoundary(db, assistantID);
  const assistantAfterOrdinal = getContactAssistantContextBoundary(db, assistantID);
  const exclude = new Set(
    (Array.isArray(excludeMessageIDs) ? excludeMessageIDs : [])
      .filter((id) => typeof id === 'string' && id),
  );
  // null/undefined must not become 0 via Number(null) — that would drop every user row.
  const parsedCeiling = beforeOrdinal == null || beforeOrdinal === ''
    ? NaN
    : Number(beforeOrdinal);
  const userOrdinalCeiling = Number.isFinite(parsedCeiling) ? parsedCeiling : null;
  const page = listContactMessages(db, assistantID, { limit: CONTACT_LLM_FETCH_LIMIT });
  const messages = page.messages.filter((message) => {
    if (exclude.has(message.messageID)) return false;
    if (!(message.ordinal > afterOrdinal)) return false;
    if (message.role === 'assistant' && message.ordinal <= assistantAfterOrdinal) return false;
    // Queued user admits after this turn's ordinal belong to later lane work.
    if (
      userOrdinalCeiling != null
      && message.role === 'user'
      && message.ordinal > userOrdinalCeiling
    ) {
      return false;
    }
    return true;
  });
  return trimContactHistoryForLlm(messages);
}

export { parseContactCard };
