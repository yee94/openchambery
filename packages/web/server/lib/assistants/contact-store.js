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
    updated_at INTEGER NOT NULL
  );
  -- Contact transcript generation: bumps only on clear_chat_history / resetContact.
  -- clear memory (context boundary) must not change this. Cursor keyset embeds it.
  CREATE TABLE IF NOT EXISTS assistant_contact_generation (
    assistant_id TEXT PRIMARY KEY,
    generation INTEGER NOT NULL DEFAULT 0
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
}

/** Durable LLM context watermark for one assistant (0 = no boundary). */
export function getContactContextBoundary(db, assistantID) {
  const row = db.prepare(
    'SELECT after_ordinal FROM assistant_contact_context_boundary WHERE assistant_id=?',
  ).get(assistantID);
  if (!row || !Number.isFinite(Number(row.after_ordinal))) return 0;
  return Number(row.after_ordinal);
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
    'INSERT INTO assistant_contact_context_boundary(assistant_id, after_ordinal, updated_at) VALUES (?,?,?) ON CONFLICT(assistant_id) DO UPDATE SET after_ordinal=excluded.after_ordinal, updated_at=excluded.updated_at',
  ).run(assistantID, afterOrdinal, updatedAt);
  return { assistantID, afterOrdinal, memoryCleared: true };
}

export function upsertContactWatch(db, { assistantID, sessionID, directory, status, updatedAt }) {
  db.prepare(
    'INSERT INTO assistant_contact_watch(assistant_id,session_id,directory,status,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(assistant_id,session_id) DO UPDATE SET directory=excluded.directory,status=excluded.status,updated_at=excluded.updated_at',
  ).run(assistantID, sessionID, directory || null, status, updatedAt);
}

export function listWatchesBySession(db, sessionID) {
  return db.prepare('SELECT assistant_id, session_id, directory, status FROM assistant_contact_watch WHERE session_id=?').all(sessionID)
    .map((row) => ({
      assistantID: row.assistant_id,
      sessionID: row.session_id,
      directory: row.directory,
      status: row.status,
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
 * (including rows before the durable context boundary). This budget is the only
 * model context. There is no summarizer and no user-facing compress /
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
export const CONTACT_LLM_MAX_TURNS = 8;
export const CONTACT_LLM_MAX_CHARS = 6_000;
export const CONTACT_LLM_FETCH_LIMIT = 40;
export const CONTACT_LLM_FILE_CHAR_WEIGHT = 80;

const estimateLlmChars = (item) => {
  const text = typeof item.content === 'string' ? item.content.length : 0;
  const files = Array.isArray(item.parts) ? item.parts.length * CONTACT_LLM_FILE_CHAR_WEIGHT : 0;
  return text + files;
};

const toLlmHistoryItem = (message) => {
  const files = message.parts.filter((part) => part.type === 'file');
  const content = message.text.trim() || (files.length > 0 ? '[attachment]' : '');
  return files.length > 0 ? { role: message.role, content, parts: files } : { role: message.role, content };
};

const isLlmEligibleContactMessage = (message) => {
  if (message.role !== 'user' && message.role !== 'assistant') return false;
  if (message.status === 'error') return false;
  // Peer DMs are read-only inbox rows. They must not become harness turns.
  if (message.role === 'peer' || message.fromAssistantID) return false;
  const hasText = Boolean(message.text?.trim());
  const hasFiles = Array.isArray(message.parts) && message.parts.some((part) => part.type === 'file');
  // Drop pure-card, tool-trace, and thinking-only rows. Process text is not
  // persisted as contact bubbles; card-only rows have neither text nor files.
  return hasText || hasFiles;
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
