/**
 * Assistant contact attachment ownership + descriptors.
 * Bytes live in shared content-addressed prompt-attachments store.
 * DB only stores controlled relative paths + opaque attachment IDs.
 */
import crypto from 'node:crypto';
import {
  MAX_PROMPT_ATTACHMENT_BYTES,
  PROMPT_ATTACHMENT_ID,
  PROMPT_ATTACHMENT_MIME,
  PROMPT_ATTACHMENT_SHA256,
  absoluteObjectPath,
  collectRequestBytes,
  decodeDataUrlStrict,
  isSafeInlineImageMime,
  promptAttachmentFileExistsSync,
  readPromptAttachmentBytes,
  relativeObjectPath,
  sha256Hex,
  storePromptAttachmentBytes,
} from '../fs/prompt-attachment-store.js';
import { getContactGeneration } from './contact-store.js';

export const CONTACT_ATTACHMENT_MAX_BYTES = MAX_PROMPT_ATTACHMENT_BYTES;
/** Total inbound file bytes per contact send (sum of attachments). */
export const CONTACT_ATTACHMENT_TURN_BUDGET_BYTES = 50 * 1024 * 1024;
export const CONTACT_ATTACHMENT_MIGRATE_BATCH = 20;
export const CONTACT_ATTACHMENT_MIGRATE_BATCH_BYTES = 50 * 1024 * 1024;
/**
 * Historical legacy data-URL decode ceiling.
 * ~70MiB base64-encoded ≈ 52.5MiB decoded; 56MiB leaves a small safety margin.
 * Over-cap rows keep old part_json and are reported in migration failures.
 */
export const CONTACT_ATTACHMENT_HISTORICAL_MAX_BYTES = 56 * 1024 * 1024;

const ATTACHMENT_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

const fail = (code, message) => {
  const error = new Error(typeof message === 'string' && message.trim() ? message.trim() : code);
  error.code = code;
  throw error;
};

export const CONTACT_ATTACHMENT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS assistant_contact_attachment (
    attachment_id TEXT PRIMARY KEY,
    assistant_id TEXT NOT NULL,
    generation INTEGER NOT NULL DEFAULT 0,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    mime TEXT NOT NULL,
    filename TEXT,
    relative_path TEXT NOT NULL,
    upload_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS assistant_contact_attachment_upload
    ON assistant_contact_attachment(assistant_id, upload_id) WHERE upload_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS assistant_contact_attachment_assistant
    ON assistant_contact_attachment(assistant_id, generation, attachment_id);
`;

export function ensureContactAttachmentSchema(db) {
  // Table first (always).
  db.exec(`
    CREATE TABLE IF NOT EXISTS assistant_contact_attachment (
      attachment_id TEXT PRIMARY KEY,
      assistant_id TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 0,
      sha256 TEXT NOT NULL,
      size INTEGER NOT NULL,
      mime TEXT NOT NULL,
      filename TEXT,
      relative_path TEXT NOT NULL,
      upload_id TEXT,
      created_at INTEGER NOT NULL
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS assistant_contact_attachment_assistant
      ON assistant_contact_attachment(assistant_id, generation, attachment_id);
  `);
  // Partial unique index — if unsupported, fall back to full unique on (assistant_id, upload_id)
  // where upload_id is NOT NULL via application-level checks (putContactAttachment).
  try {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS assistant_contact_attachment_upload
        ON assistant_contact_attachment(assistant_id, upload_id) WHERE upload_id IS NOT NULL;
    `);
  } catch (error) {
    try {
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS assistant_contact_attachment_upload_full
          ON assistant_contact_attachment(assistant_id, upload_id);
      `);
    } catch (fallbackError) {
      // Surface once — do not swallow silently.
      console.warn(
        '[assistants] contact attachment unique index unavailable:',
        fallbackError?.message || error?.message || fallbackError,
      );
    }
  }
}

const headerValue = (value) => {
  if (Array.isArray(value)) return value[0];
  return typeof value === 'string' ? value : undefined;
};

export function parseAttachmentFilenameHeader(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const decoded = decodeURIComponent(raw.trim());
    const cleaned = decoded.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (!cleaned || cleaned.length > 512) return null;
    if (cleaned.includes('/') || cleaned.includes('\\') || cleaned.includes('..')) return null;
    return cleaned;
  } catch {
    return null;
  }
}

/** Public descriptor — never includes filesystem paths. */
export function toContactAttachmentDescriptor(row) {
  if (!row) return null;
  return {
    type: 'file',
    attachmentID: row.attachment_id,
    sha256: row.sha256,
    size: row.size,
    mime: row.mime,
    ...(row.filename ? { filename: row.filename } : {}),
  };
}

export function getContactAttachmentRow(db, attachmentID) {
  if (typeof attachmentID !== 'string' || !ATTACHMENT_ID.test(attachmentID.trim())) return null;
  return db.prepare(
    'SELECT * FROM assistant_contact_attachment WHERE attachment_id=?',
  ).get(attachmentID.trim()) || null;
}

export function getContactAttachmentByUploadID(db, assistantID, uploadID) {
  if (typeof uploadID !== 'string' || !PROMPT_ATTACHMENT_ID.test(uploadID.trim())) return null;
  return db.prepare(
    'SELECT * FROM assistant_contact_attachment WHERE assistant_id=? AND upload_id=?',
  ).get(assistantID, uploadID.trim()) || null;
}

/**
 * External GET / admission: assistant match + generation === current live gen.
 */
export function assertContactAttachmentReadable(db, { attachmentID, assistantID }) {
  const row = getContactAttachmentRow(db, attachmentID);
  if (!row || row.assistant_id !== assistantID) {
    fail('not_found', 'Attachment not found');
  }
  const current = getContactGeneration(db, assistantID);
  if (row.generation !== current) {
    fail('not_found', 'Attachment not found');
  }
  return row;
}

/**
 * Already-admitted execution only: assistant ownership, any generation ≤ current
 * so an in-flight turn can still materialize after a concurrent wipe tagged the
 * attachment under the pre-wipe generation.
 */
export function assertContactAttachmentOwned(db, { attachmentID, assistantID }) {
  const row = getContactAttachmentRow(db, attachmentID);
  if (!row || row.assistant_id !== assistantID) {
    fail('not_found', 'Attachment not found');
  }
  const current = getContactGeneration(db, assistantID);
  if (row.generation > current) {
    fail('not_found', 'Attachment not found');
  }
  return row;
}

/** Rebuild public descriptor solely from storage row (ignore client metadata). */
export function canonicalDescriptorFromRow(row) {
  return toContactAttachmentDescriptor(row);
}

export async function putContactAttachment({
  db,
  dataDir,
  assistantID,
  uploadID,
  stream,
  headers = {},
  clock = () => Date.now(),
  signal,
  storeBytes = storePromptAttachmentBytes,
} = {}) {
  if (typeof assistantID !== 'string' || !assistantID) fail('validation_error', 'assistantID required');
  if (typeof uploadID !== 'string' || !PROMPT_ATTACHMENT_ID.test(uploadID.trim())) {
    fail('validation_error', 'uploadID is invalid');
  }
  const upload = uploadID.trim();

  const existing = getContactAttachmentByUploadID(db, assistantID, upload);
  const expectedSize = Number(
    headerValue(headers['x-content-size'])
    ?? headerValue(headers['x-openchamber-content-length'])
    ?? headerValue(headers['content-length']),
  );
  const expectedSha256 = (
    headerValue(headers['x-content-sha256'])
    || headerValue(headers['x-openchamber-sha256'])
    || ''
  ).toLowerCase();
  const mimeRaw = headerValue(headers['content-type'])
    || headerValue(headers['x-openchamber-mime'])
    || 'application/octet-stream';
  const mime = mimeRaw.split(';', 1)[0].trim();
  const filename = parseAttachmentFilenameHeader(
    headerValue(headers['x-attachment-filename'])
    || headerValue(headers['x-openchamber-filename']),
  );

  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > CONTACT_ATTACHMENT_MAX_BYTES) {
    fail('validation_error', 'Attachment size is required');
  }
  if (!PROMPT_ATTACHMENT_SHA256.test(expectedSha256)) {
    fail('validation_error', 'Attachment digest is required');
  }
  if (!PROMPT_ATTACHMENT_MIME.test(mime)) {
    fail('validation_error', 'Attachment MIME type is invalid');
  }

  if (existing) {
    if (existing.sha256 !== expectedSha256 || existing.size !== expectedSize || existing.mime !== mime) {
      fail('idempotency_conflict', 'Upload ID already used with different content');
    }
    // Re-check generation still current after any concurrent reset.
    const live = getContactGeneration(db, assistantID);
    if (existing.generation !== live) {
      fail('contact_generation_conflict', 'Contact generation changed during upload');
    }
    return canonicalDescriptorFromRow(existing);
  }

  const genBefore = getContactGeneration(db, assistantID);
  const { buffer, size } = await collectRequestBytes(stream, {
    expectedSize,
    maxBytes: CONTACT_ATTACHMENT_MAX_BYTES,
    signal,
  });
  // After await: reset/delete may have raced — re-check before durable write/DB.
  const genAfterRead = getContactGeneration(db, assistantID);
  if (genAfterRead !== genBefore) {
    fail('contact_generation_conflict', 'Contact generation changed during upload');
  }
  if (getContactAttachmentByUploadID(db, assistantID, upload)) {
    const racedEarly = getContactAttachmentByUploadID(db, assistantID, upload);
    if (racedEarly.sha256 === expectedSha256 && racedEarly.size === expectedSize) {
      return canonicalDescriptorFromRow(racedEarly);
    }
    fail('idempotency_conflict', 'Upload ID already used with different content');
  }

  const stored = await storeBytes({
    dataDir,
    buffer,
    expectedSha256,
    mime,
    filename: filename || undefined,
    maxBytes: CONTACT_ATTACHMENT_MAX_BYTES,
    validateImage: true,
  });
  if (Number.isSafeInteger(expectedSize) && stored.size !== expectedSize) {
    fail('attachment_hash_mismatch', 'Stored size does not match declared size');
  }
  if (expectedSha256 && stored.sha256 !== expectedSha256) {
    fail('attachment_hash_mismatch', 'Stored digest does not match declared digest');
  }

  const genAfterStore = getContactGeneration(db, assistantID);
  if (genAfterStore !== genBefore) {
    fail('contact_generation_conflict', 'Contact generation changed during upload');
  }

  const attachmentID = `att_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const at = clock();
  try {
    db.prepare(
      `INSERT INTO assistant_contact_attachment(
        attachment_id, assistant_id, generation, sha256, size, mime, filename, relative_path, upload_id, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      attachmentID,
      assistantID,
      genAfterStore,
      stored.sha256,
      stored.size,
      stored.mime,
      filename || null,
      stored.relativePath,
      upload,
      at,
    );
  } catch (error) {
    const raced = getContactAttachmentByUploadID(db, assistantID, upload);
    if (raced && raced.sha256 === stored.sha256 && raced.size === size) {
      return canonicalDescriptorFromRow(raced);
    }
    if (String(error?.message || '').includes('UNIQUE') || error?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      fail('idempotency_conflict', 'Upload ID already used with different content');
    }
    throw error;
  }

  return canonicalDescriptorFromRow({
    attachment_id: attachmentID,
    sha256: stored.sha256,
    size: stored.size,
    mime: stored.mime,
    filename: filename || null,
  });
}

export async function readContactAttachmentBytes({
  db,
  dataDir,
  assistantID,
  attachmentID,
  external = true,
}) {
  const row = external
    ? assertContactAttachmentReadable(db, { attachmentID, assistantID })
    : assertContactAttachmentOwned(db, { attachmentID, assistantID });
  const { buffer, size } = await readPromptAttachmentBytes(dataDir, row.relative_path, {
    maxBytes: Math.max(CONTACT_ATTACHMENT_HISTORICAL_MAX_BYTES, CONTACT_ATTACHMENT_MAX_BYTES * 4),
    expectedSize: Number.isSafeInteger(row.size) ? row.size : undefined,
    expectedSha256: typeof row.sha256 === 'string' && row.sha256 ? row.sha256 : undefined,
  });
  return {
    buffer,
    size,
    mime: row.mime,
    filename: row.filename,
    sha256: row.sha256,
    etag: `"${row.sha256}"`,
  };
}

/**
 * Resolve canonical size for a file part (prefer descriptor size / row size).
 * Returns null when unknown (must load to measure — counted after read).
 */
function canonicalFileSize(part) {
  if (Number.isSafeInteger(part?.size) && part.size >= 0) return part.size;
  return null;
}

/**
 * Materialize one file part. options.historySoftFail: missing/corrupt history
 * attachments become an explicit unavailable text stub (does not throw).
 * Current-turn materialize must leave historySoftFail false so missing files error.
 */
export async function materializeContactFilePart(db, dataDir, assistantID, part, {
  historySoftFail = false,
} = {}) {
  if (!part || part.type !== 'file') return null;
  if (typeof part.url === 'string' && part.url.startsWith('data:')) {
    return {
      type: 'file',
      mime: part.mime,
      url: part.url,
      size: canonicalFileSize(part) ?? undefined,
      ...(part.filename ? { filename: part.filename } : {}),
    };
  }
  if (typeof part.attachmentID === 'string' && part.attachmentID) {
    try {
      const { buffer, mime, filename, size, sha256 } = await readContactAttachmentBytes({
        db,
        dataDir,
        assistantID,
        attachmentID: part.attachmentID,
        external: false,
      });
      // Integrity: if descriptor carried size/hash, they must match disk.
      if (Number.isSafeInteger(part.size) && part.size !== size) {
        fail('attachment_hash_mismatch', 'Attachment size does not match descriptor');
      }
      if (typeof part.sha256 === 'string' && part.sha256 && part.sha256 !== sha256) {
        fail('attachment_hash_mismatch', 'Attachment digest does not match descriptor');
      }
      return {
        type: 'file',
        mime,
        url: `data:${mime};base64,${buffer.toString('base64')}`,
        size,
        sha256,
        ...(filename ? { filename } : {}),
      };
    } catch (error) {
      if (historySoftFail) {
        const name = typeof part.filename === 'string' && part.filename ? part.filename : part.attachmentID;
        return {
          type: 'text',
          text: `[attachment unavailable: ${name}]`,
          synthetic: true,
          unavailableAttachmentID: part.attachmentID,
        };
      }
      throw error;
    }
  }
  return null;
}

/**
 * Materialize current-turn parts under an exact canonical-size budget.
 * Exceeding budget → explicit error (no silent drop).
 * Text always kept. signal aborts mid-loop.
 */
export async function materializeContactParts(db, dataDir, assistantID, parts = [], {
  budgetBytes = CONTACT_ATTACHMENT_TURN_BUDGET_BYTES,
  signal = null,
  historySoftFail = false,
} = {}) {
  const list = Array.isArray(parts) ? parts : [];
  // Pre-sum known sizes — two 25MiB must fit in 50MiB; over budget fails closed.
  let known = 0;
  for (const part of list) {
    if (part?.type !== 'file') continue;
    const sz = canonicalFileSize(part);
    if (sz != null) known += sz;
  }
  if (budgetBytes >= 0 && known > budgetBytes) {
    fail('attachment_budget_exceeded', `Contact attachment materialize exceeds ${budgetBytes} byte budget`);
  }

  const out = [];
  let used = 0;
  for (const part of list) {
    if (signal?.aborted) fail('PROMPT_ATTACHMENT_ABORTED', 'Materialize aborted');
    if (part?.type !== 'file') {
      out.push(part);
      continue;
    }
    const est = canonicalFileSize(part);
    if (est != null && budgetBytes >= 0 && used + est > budgetBytes) {
      fail('attachment_budget_exceeded', `Contact attachment materialize exceeds ${budgetBytes} byte budget`);
    }
    const materialized = await materializeContactFilePart(db, dataDir, assistantID, part, { historySoftFail });
    if (!materialized) continue;
    if (materialized.type === 'file') {
      const actual = canonicalFileSize(materialized) ?? canonicalFileSize(part) ?? 0;
      if (budgetBytes >= 0 && used + actual > budgetBytes) {
        fail('attachment_budget_exceeded', `Contact attachment materialize exceeds ${budgetBytes} byte budget`);
      }
      used += actual;
    }
    out.push(materialized);
  }
  return out;
}

/**
 * Group history into turns (user starts a turn; following non-user until next user).
 * Select newest complete turns whose total canonical file sizes fit budget.
 * Missing history attachments soft-fail to unavailable text — never block current turn.
 */
export async function materializeContactHistory(db, dataDir, assistantID, history = [], {
  budgetBytes = CONTACT_ATTACHMENT_TURN_BUDGET_BYTES,
  signal = null,
} = {}) {
  const list = Array.isArray(history) ? history : [];
  // Build turns: each turn is [user, ...followers] or orphan assistant/peer blocks.
  const turns = [];
  let current = [];
  for (const message of list) {
    if (message?.role === 'user' && current.length > 0) {
      turns.push(current);
      current = [message];
    } else {
      current.push(message);
    }
  }
  if (current.length) turns.push(current);

  const turnFileBytes = (turn) => turn.reduce((sum, message) => (
    sum + (message?.parts || [])
      .filter((p) => p?.type === 'file')
      .reduce((s, p) => s + (canonicalFileSize(p) ?? 0), 0)
  ), 0);

  // Newest turns first until budget fills (complete turn groups only).
  const selected = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    const bytes = turnFileBytes(turn);
    if (budgetBytes >= 0 && used + bytes > budgetBytes && selected.length > 0) break;
    // Single oversized historical turn: skip entire turn rather than partial expand.
    if (budgetBytes >= 0 && bytes > budgetBytes) continue;
    used += bytes;
    selected.push(turn);
  }
  selected.reverse();

  const out = [];
  for (const turn of selected) {
    for (const message of turn) {
      if (signal?.aborted) fail('PROMPT_ATTACHMENT_ABORTED', 'Materialize aborted');
      if (!message?.parts?.length) {
        out.push(message);
        continue;
      }
      // Selected turns already fit the history budget as complete groups; expand fully
      // with soft-fail so a missing historical file never blocks later turns.
      out.push({
        ...message,
        parts: await materializeContactParts(db, dataDir, assistantID, message.parts, {
          budgetBytes: Number.MAX_SAFE_INTEGER,
          signal,
          historySoftFail: true,
        }),
      });
    }
  }
  return out;
}

/** Estimate decoded payload bytes of a data URL without allocating the buffer. */
export function estimateDataUrlPayloadBytes(url) {
  if (typeof url !== 'string' || !url.startsWith('data:')) return 0;
  const comma = url.indexOf(',');
  if (comma < 0) return 0;
  const meta = url.slice(5, comma);
  const payload = url.slice(comma + 1).replace(/\s+/g, '');
  if (!payload) return 0;
  if (/;base64/i.test(meta)) {
    const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
  }
  try {
    return Buffer.byteLength(decodeURIComponent(payload), 'utf8');
  } catch {
    return Buffer.byteLength(payload, 'utf8');
  }
}

/**
 * Persist a data-URL file part. mode=admission enforces 25MiB + safe mime.
 * mode=migration allows larger historical payloads without bypassing unsafe mime.
 * storeBytes inject allows tests to simulate disk write failure without editing fs store.
 */
export async function ingestDataUrlFilePart({
  db,
  dataDir,
  assistantID,
  part,
  clock = () => Date.now(),
  mode = 'admission',
  storeBytes = storePromptAttachmentBytes,
  signal = null,
} = {}) {
  if (!part || part.type !== 'file') return null;
  if (typeof part.attachmentID === 'string' && part.attachmentID) {
    // Admission: must be current generation; rebuild canonical descriptor from row.
    const row = mode === 'admission'
      ? assertContactAttachmentReadable(db, { attachmentID: part.attachmentID, assistantID })
      : assertContactAttachmentOwned(db, { attachmentID: part.attachmentID, assistantID });
    return canonicalDescriptorFromRow(row);
  }
  const url = typeof part.url === 'string' ? part.url : '';
  if (!url.startsWith('data:')) {
    fail('validation_error', 'File parts require attachmentID or data URL');
  }
  if (signal?.aborted) fail('PROMPT_ATTACHMENT_ABORTED', 'Ingest aborted');
  const decoded = decodeDataUrlStrict(url, {
    mode,
    maxBytes: mode === 'migration' ? CONTACT_ATTACHMENT_HISTORICAL_MAX_BYTES : CONTACT_ATTACHMENT_MAX_BYTES,
  });
  const mime = part.mime || decoded.mime;
  const genBefore = getContactGeneration(db, assistantID);
  const stored = await storeBytes({
    dataDir,
    buffer: decoded.buffer,
    mime,
    filename: part.filename,
    maxBytes: mode === 'migration'
      ? Math.min(CONTACT_ATTACHMENT_HISTORICAL_MAX_BYTES, Math.max(CONTACT_ATTACHMENT_MAX_BYTES, decoded.buffer.length))
      : CONTACT_ATTACHMENT_MAX_BYTES,
    // Admission: validate image magic when size is large enough for a header.
    validateImage: mode === 'admission' && decoded.buffer.length >= 8 && String(mime).startsWith('image/'),
  });
  // After await: abort / generation must still match before any DB write.
  if (signal?.aborted) fail('PROMPT_ATTACHMENT_ABORTED', 'Ingest aborted after store');
  const genAfter = getContactGeneration(db, assistantID);
  if (genAfter !== genBefore) {
    fail('contact_generation_conflict', 'Contact generation changed during ingest');
  }
  // Integrity vs caller-supplied size/hash when present.
  if (Number.isSafeInteger(part.size) && part.size !== stored.size) {
    fail('attachment_hash_mismatch', 'Stored size does not match part descriptor');
  }
  if (typeof part.sha256 === 'string' && part.sha256 && part.sha256.toLowerCase() !== stored.sha256) {
    fail('attachment_hash_mismatch', 'Stored digest does not match part descriptor');
  }
  if (stored.size !== decoded.buffer.length) {
    fail('attachment_hash_mismatch', 'Stored size does not match decoded buffer');
  }
  const attachmentID = `att_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
  db.prepare(
    `INSERT INTO assistant_contact_attachment(
      attachment_id, assistant_id, generation, sha256, size, mime, filename, relative_path, upload_id, created_at
    ) VALUES (?,?,?,?,?,?,?,?,NULL,?)`,
  ).run(
    attachmentID,
    assistantID,
    genAfter,
    stored.sha256,
    stored.size,
    stored.mime,
    part.filename || null,
    stored.relativePath,
    clock(),
  );
  return canonicalDescriptorFromRow({
    attachment_id: attachmentID,
    sha256: stored.sha256,
    size: stored.size,
    mime: stored.mime,
    filename: part.filename || null,
  });
}

/**
 * Keyset migration of legacy data-URL parts. One part at a time; 20/50MiB batches
 * with real yield. CAS fences on part_json + generation. Failures diagnosed, continue.
 * storeBytes inject simulates disk write failure without replacing bad dataURL paths.
 */
export async function migrateContactDataUrlParts({
  db,
  dataDir,
  assistantID = null,
  clock = () => Date.now(),
  yieldFn = () => new Promise((r) => setImmediate(r)),
  batchSize = CONTACT_ATTACHMENT_MIGRATE_BATCH,
  batchBytes = CONTACT_ATTACHMENT_MIGRATE_BATCH_BYTES,
  signal = null,
  storeBytes = storePromptAttachmentBytes,
} = {}) {
  let migrated = 0;
  let failed = 0;
  let scanned = 0;
  const failures = [];
  let batchCount = 0;
  let batchByteAcc = 0;
  let cursorMessageID = '';
  let cursorPartID = '';

  const selectSql = assistantID
    ? `SELECT p.message_id, p.part_id, p.ordinal, p.part_json, m.assistant_id
       FROM assistant_contact_part p
       JOIN assistant_contact_message m ON m.message_id = p.message_id
       WHERE m.assistant_id=?
         AND p.part_json LIKE '%data:%'
         AND (p.message_id > ? OR (p.message_id = ? AND p.part_id > ?))
       ORDER BY p.message_id ASC, p.part_id ASC
       LIMIT 1`
    : `SELECT p.message_id, p.part_id, p.ordinal, p.part_json, m.assistant_id
       FROM assistant_contact_part p
       JOIN assistant_contact_message m ON m.message_id = p.message_id
       WHERE p.part_json LIKE '%data:%'
         AND (p.message_id > ? OR (p.message_id = ? AND p.part_id > ?))
       ORDER BY p.message_id ASC, p.part_id ASC
       LIMIT 1`;

  for (;;) {
    if (signal?.aborted) break;
    const row = assistantID
      ? db.prepare(selectSql).get(assistantID, cursorMessageID, cursorMessageID, cursorPartID)
      : db.prepare(selectSql).get(cursorMessageID, cursorMessageID, cursorPartID);
    if (!row) break;
    cursorMessageID = row.message_id;
    cursorPartID = row.part_id;
    scanned += 1;

    let part;
    try {
      part = JSON.parse(row.part_json);
    } catch {
      failed += 1;
      failures.push({ messageID: row.message_id, partID: row.part_id, error: 'invalid_json' });
      continue;
    }
    if (part?.type !== 'file' || typeof part.url !== 'string' || !part.url.startsWith('data:')) continue;
    if (typeof part.attachmentID === 'string' && part.attachmentID) continue;

    // Pre-estimate before decode/store — yield when adding would blow the batch budget.
    const estBytes = estimateDataUrlPayloadBytes(part.url);
    if (batchByteAcc > 0 && estBytes > 0 && batchByteAcc + estBytes > batchBytes) {
      batchCount = 0;
      batchByteAcc = 0;
      await yieldFn();
      if (signal?.aborted) break;
    }
    // Historical single item larger than batch budget: process alone after a yield boundary.
    if (estBytes > batchBytes && batchByteAcc > 0) {
      batchCount = 0;
      batchByteAcc = 0;
      await yieldFn();
      if (signal?.aborted) break;
    }

    const genAtStart = getContactGeneration(db, row.assistant_id);
    try {
      // Disk first outside TX (injectable storeBytes for real write-failure tests).
      const descriptor = await ingestDataUrlFilePart({
        db,
        dataDir,
        assistantID: row.assistant_id,
        part: {
          type: 'file',
          mime: part.mime,
          url: part.url,
          filename: part.filename,
          ...(Number.isSafeInteger(part.size) ? { size: part.size } : {}),
          ...(typeof part.sha256 === 'string' ? { sha256: part.sha256 } : {}),
        },
        clock,
        mode: 'migration',
        storeBytes,
        signal,
      });
      // Post-await fences before DB commit (close / gen wipe).
      if (signal?.aborted) {
        failed += 1;
        failures.push({ messageID: row.message_id, partID: row.part_id, error: 'aborted' });
        break;
      }
      const genAfterStore = getContactGeneration(db, row.assistant_id);
      if (genAfterStore !== genAtStart) {
        failed += 1;
        failures.push({ messageID: row.message_id, partID: row.part_id, error: 'generation_changed' });
        continue;
      }
      if (Number.isSafeInteger(part.size) && part.size !== descriptor.size) {
        fail('attachment_hash_mismatch', 'Migrated size does not match source part');
      }
      if (typeof part.sha256 === 'string' && part.sha256 && part.sha256.toLowerCase() !== descriptor.sha256) {
        fail('attachment_hash_mismatch', 'Migrated digest does not match source part');
      }

      const nextJson = JSON.stringify({
        id: part.id,
        type: 'file',
        mime: descriptor.mime,
        attachmentID: descriptor.attachmentID,
        sha256: descriptor.sha256,
        size: descriptor.size,
        ...(descriptor.filename ? { filename: descriptor.filename } : {}),
      });
      // Transaction fence: generation unchanged + part_json CAS.
      db.exec('BEGIN IMMEDIATE');
      try {
        const liveGen = getContactGeneration(db, row.assistant_id);
        if (liveGen !== genAtStart) {
          db.exec('ROLLBACK');
          failed += 1;
          failures.push({ messageID: row.message_id, partID: row.part_id, error: 'generation_changed' });
          continue;
        }
        const result = db.prepare(
          'UPDATE assistant_contact_part SET part_json=? WHERE message_id=? AND part_id=? AND part_json=?',
        ).run(nextJson, row.message_id, row.part_id, row.part_json);
        db.exec('COMMIT');
        if (result.changes === 1) {
          migrated += 1;
          batchCount += 1;
          batchByteAcc += descriptor.size || estBytes || 0;
        }
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    } catch (error) {
      failed += 1;
      failures.push({
        messageID: row.message_id,
        partID: row.part_id,
        error: error?.code || error?.message || 'migrate_failed',
      });
    }

    if (batchCount >= batchSize || batchByteAcc >= batchBytes) {
      batchCount = 0;
      batchByteAcc = 0;
      await yieldFn();
    }
  }

  return { migrated, failed, scanned, failures };
}

export {
  absoluteObjectPath,
  relativeObjectPath,
  promptAttachmentFileExistsSync,
  sha256Hex,
  collectRequestBytes,
  headerValue,
  isSafeInlineImageMime,
};
