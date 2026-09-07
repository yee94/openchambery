import { parseContactCard, parseContactPart, serializeContactPart } from './cards.js';

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
`;

export const CONTACT_SETTLE_TEXT = Object.freeze({
  complete: 'oc.settle.complete',
  error: 'oc.settle.error',
  question: 'oc.settle.question',
});

const IN_FLIGHT_WATCH = new Set(['busy', 'question']);

export function ensureContactSchema(db) {
  db.exec(CONTACT_SCHEMA_SQL);
  const columns = new Set(db.prepare("SELECT name FROM pragma_table_info('assistant_contact_message')").all().map((column) => column.name));
  if (!columns.has('from_assistant_id')) db.exec('ALTER TABLE assistant_contact_message ADD COLUMN from_assistant_id TEXT');
  if (!columns.has('from_assistant_name')) db.exec('ALTER TABLE assistant_contact_message ADD COLUMN from_assistant_name TEXT');
}

const decodeCursor = (value) => {
  if (value == null || value === '') return null;
  const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
  if (!Number.isSafeInteger(parsed?.ordinal) || typeof parsed?.messageID !== 'string') return null;
  return parsed;
};

const encodeCursor = (row) => Buffer.from(json({ ordinal: row.ordinal, messageID: row.message_id })).toString('base64url');

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

export function listContactMessages(db, assistantID, { before, limit = 50 } = {}) {
  const cursor = before == null || before === '' ? null : decodeCursor(before);
  if (before && !cursor) {
    const error = new Error('validation_error');
    error.code = 'validation_error';
    throw error;
  }
  const rows = cursor
    ? db.prepare(
      'SELECT * FROM assistant_contact_message WHERE assistant_id=? AND (ordinal<? OR (ordinal=? AND message_id<?)) ORDER BY ordinal DESC, message_id DESC LIMIT ?',
    ).all(assistantID, cursor.ordinal, cursor.ordinal, cursor.messageID, limit + 1)
    : db.prepare(
      'SELECT * FROM assistant_contact_message WHERE assistant_id=? ORDER BY ordinal DESC, message_id DESC LIMIT ?',
    ).all(assistantID, limit + 1);
  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit && page[page.length - 1] ? encodeCursor(page[page.length - 1]) : null;
  return {
    messages: [...page].reverse().map((row) => hydrateMessage(db, row)),
    nextCursor,
    complete: nextCursor === null,
  };
}

export function deleteContactMessages(db, assistantID) {
  const ids = db.prepare('SELECT message_id FROM assistant_contact_message WHERE assistant_id=?').all(assistantID).map((row) => row.message_id);
  for (const messageID of ids) {
    db.prepare('DELETE FROM assistant_contact_part WHERE message_id=?').run(messageID);
  }
  db.prepare('DELETE FROM assistant_contact_message WHERE assistant_id=?').run(assistantID);
  db.prepare('DELETE FROM assistant_contact_watch WHERE assistant_id=?').run(assistantID);
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
 * LLM-only contact window. SQLite and the transcript UI may keep older bubbles;
 * this budget is the only model context. There is no summarizer and no
 * user-facing compress / continuous / stateless control on this path.
 *
 * A turn is a user message plus the assistant replies that follow it until the
 * next user. Newest turn is always kept, even when it exceeds the char budget.
 * Char estimate is text length plus CONTACT_LLM_FILE_CHAR_WEIGHT per file part
 * (CJK counts as one char; no tokenizer).
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

export function contactHistoryForLlm(db, assistantID) {
  const page = listContactMessages(db, assistantID, { limit: CONTACT_LLM_FETCH_LIMIT });
  return trimContactHistoryForLlm(page.messages);
}

export { parseContactCard };
