import { createHash } from 'node:crypto';
import { getContactAssistantContextBoundary, getContactContextBoundary, getContactGeneration } from './contact-store.js';

const SCAN_LIMIT = 200;
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const paramsObject = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) fail('validation_error');
};
const integer = (value, fallback, min, max) => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('validation_error');
  return value;
};
const time = (value) => {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) fail('validation_error');
  const result = Date.parse(value);
  if (!Number.isFinite(result)) fail('validation_error');
  return result;
};

// Project only authored text, ordered exactly as the contact transcript.
// Attachment bodies, URLs, peer DMs, diagnostics and tool payloads never leave this reader.
const textRows = (count) => `
  WITH text_parts AS (
    SELECT message_id, json_extract(part_json, '$.text') AS text
    FROM assistant_contact_part
    WHERE message_id IN (${Array(count).fill('?').join(',')})
      AND json_extract(part_json, '$.type') = 'text'
      AND substr(json_extract(part_json, '$.text'), 1, 10) <> 'oc.settle.'
    ORDER BY message_id, ordinal, part_id
  ), texts AS (
    SELECT message_id, group_concat(text, '') AS text FROM text_parts GROUP BY message_id
  )`;

/** One contact turn's read-only view, fenced again against live memory state on every call. */
export function createContactMemoryReader(db, assistantID, { beforeOrdinal = null, assertAvailable = () => {} } = {}) {
  const boundary = getContactContextBoundary(db, assistantID);
  const assistantBoundary = getContactAssistantContextBoundary(db, assistantID);
  const generation = getContactGeneration(db, assistantID);
  const ceiling = Number(db.prepare('SELECT COALESCE(MAX(ordinal), 0) AS value FROM assistant_contact_message WHERE assistant_id=?').get(assistantID).value);
  const eligible = (row) => row.role !== 'peer' && ['user', 'assistant'].includes(row.role)
    && row.status === 'complete' && !row.from_assistant_id
    && (row.role !== 'assistant' || row.ordinal > assistantBoundary)
    && (row.role !== 'user' || beforeOrdinal === null || row.ordinal < beforeOrdinal);
  const check = () => {
    assertAvailable();
    if (getContactGeneration(db, assistantID) !== generation || getContactContextBoundary(db, assistantID) !== boundary
      || getContactAssistantContextBoundary(db, assistantID) !== assistantBoundary) fail('memory_scope_changed');
  };
  return {
    search(params = {}) {
      check();
      paramsObject(params, ['query', 'from', 'to', 'limit', 'cursor']);
      const query = params.query === undefined ? '' : params.query;
      if (typeof query !== 'string' || query.length > 256) fail('validation_error');
      const from = time(params.from);
      const to = time(params.to);
      if (from !== null && to !== null && from > to) fail('validation_error');
      const limit = integer(params.limit, 10, 1, 20);
      const scope = createHash('sha256').update(JSON.stringify([assistantID, boundary, assistantBoundary, generation, ceiling, beforeOrdinal, query, from, to])).digest('hex');
      let cursor = null;
      if (params.cursor !== undefined) {
        if (typeof params.cursor !== 'string' || params.cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/u.test(params.cursor)) fail('invalid_memory_cursor');
        try { cursor = JSON.parse(Buffer.from(params.cursor, 'base64url').toString('utf8')); } catch { fail('invalid_memory_cursor'); }
        if (cursor?.v !== 1 || cursor.scope !== scope || !Number.isSafeInteger(cursor.ordinal)
          || cursor.ordinal <= boundary || cursor.ordinal > ceiling || typeof cursor.messageID !== 'string'
          || !cursor.messageID || cursor.messageID.length > 512) fail('invalid_memory_cursor');
      }
      const rows = db.prepare(`SELECT message_id, role, created_at, ordinal, status, from_assistant_id
        FROM assistant_contact_message WHERE assistant_id=? AND ordinal>? AND ordinal<=?
        ${cursor ? 'AND (ordinal, message_id) < (?, ?)' : ''}
        ORDER BY ordinal DESC, message_id DESC LIMIT ?`).all(
        assistantID, boundary, ceiling, ...(cursor ? [cursor.ordinal, cursor.messageID] : []), SCAN_LIMIT + 1,
      );
      const candidates = rows.slice(0, SCAN_LIMIT);
      const ids = candidates.filter((row) => eligible(row)
        && (from === null || row.created_at >= from) && (to === null || row.created_at <= to)).map((row) => row.message_id);
      const snippets = ids.length === 0 ? [] : db.prepare(`${textRows(ids.length)}
        SELECT message_id, substr(text, max(instr(lower(text), lower(?)) - 80, 1), 400) AS snippet,
          max(instr(lower(text), lower(?)) - 81, 0) AS snippet_offset, length(text) AS total_chars
        FROM texts WHERE length(trim(text)) > 0 AND (? = '' OR instr(lower(text), lower(?)) > 0)
      `).all(...ids, query, query, query, query);
      const byID = new Map(snippets.map((row) => [row.message_id, row]));
      const matches = [];
      let scanned = 0;
      for (const row of candidates) {
        scanned += 1;
        const snippet = byID.get(row.message_id);
        if (snippet) matches.push({
          messageID: row.message_id, role: row.role, createdAt: row.created_at,
          snippet: snippet.snippet, offset: snippet.snippet_offset, totalChars: snippet.total_chars,
        });
        if (matches.length === limit) break;
      }
      const last = candidates[scanned - 1];
      const hasMore = scanned < rows.length;
      const nextCursor = hasMore && last ? Buffer.from(JSON.stringify({
        v: 1, scope, ordinal: last.ordinal, messageID: last.message_id,
      })).toString('base64url') : null;
      return { matches, nextCursor, complete: nextCursor === null, scanned };
    },
    read(params = {}) {
      check();
      paramsObject(params, ['messageID', 'offset', 'maxChars']);
      if (typeof params.messageID !== 'string' || !params.messageID || params.messageID.length > 512) fail('validation_error');
      const offset = integer(params.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      const maxChars = integer(params.maxChars, 4000, 1, 8000);
      const row = db.prepare(`SELECT message_id, role, created_at, ordinal, status, from_assistant_id
        FROM assistant_contact_message WHERE assistant_id=? AND message_id=? AND ordinal>? AND ordinal<=?`).get(
        assistantID, params.messageID, boundary, ceiling,
      );
      if (!row || !eligible(row)) fail('memory_not_found');
      const content = db.prepare(`${textRows(1)} SELECT substr(text, ?, ?) AS text, length(text) AS total_chars FROM texts`).get(row.message_id, offset + 1, maxChars);
      if (!content || !content.total_chars) fail('memory_not_found');
      if (offset > content.total_chars) fail('validation_error');
      const nextOffset = offset + maxChars < content.total_chars ? offset + maxChars : null;
      return {
        messageID: row.message_id, role: row.role, createdAt: row.created_at,
        text: content.text, offset, totalChars: content.total_chars, nextOffset, complete: nextOffset === null,
      };
    },
  };
}
