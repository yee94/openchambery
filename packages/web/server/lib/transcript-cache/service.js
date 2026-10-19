import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const TRANSCRIPT_CACHE_SCHEMA_VERSION = 1;
export const TRANSCRIPT_CACHE_INDEX_TABLE = 'transcript_cache_index';
export const TRANSCRIPT_CACHE_CONTENT_TABLE = 'transcript_cache_content';
export const CONTENT_SEARCH_SCHEMA_VERSION = 1;
const CONTENT_SEARCH_TABLE = 'transcript_content_search';
const CONTENT_SEARCH_FTS_TABLE = 'transcript_content_search_fts';
const CONTENT_SEARCH_DEFAULT_LIMIT = 30;
const CONTENT_SEARCH_MAX_LIMIT = 50;
const ASSISTANT_INDEX_TEXT_CAP = 2048;
const ASSISTANT_INDEX_EDGE = 1024;
const SNIPPET_MAX = 160;

/** Client-safe validation failure — routes map this to HTTP 400. */
export class TranscriptCacheValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TranscriptCacheValidationError';
  }
}

const fail = (message) => {
  throw new TranscriptCacheValidationError(message);
};

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const requiredString = (value, label) => {
  if (typeof value !== 'string' || value.length === 0) fail(`Invalid transcript cache ${label}`);
  return value;
};

const requiredInteger = (value, label) => {
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isInteger(parsed)) return parsed;
  }
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  fail(`Invalid transcript cache ${label}`);
};

/**
 * Scope is the full runtime identity. Transport/generation/directory/sessionID
 * are all required — directory+session alone would leak rows across runtimes.
 */
/** Directory-wide content search. Session id is a hit, not a filter. */
export const parseContentSearchScope = (value) => {
  if (!isPlainObject(value)) fail('Invalid transcript cache scope');
  const limit = value.limit === undefined || value.limit === ''
    ? undefined
    : requiredInteger(value.limit, 'limit');
  return {
    scope: {
      transport: requiredString(value.transport, 'scope'),
      generation: requiredInteger(value.generation, 'scope'),
      directory: requiredString(value.directory, 'scope'),
    },
    query: typeof value.q === 'string' ? value.q : '',
    limit,
  };
};

export const parseTranscriptCacheScope = (value) => {
  if (!isPlainObject(value)) fail('Invalid transcript cache scope');
  return {
    transport: requiredString(value.transport, 'scope'),
    generation: requiredInteger(value.generation, 'scope'),
    directory: requiredString(value.directory, 'scope'),
    sessionID: requiredString(value.sessionID, 'scope'),
  };
};

export const parseTranscriptCacheGeneration = (value) => {
  if (!isPlainObject(value)) fail('Invalid transcript cache generation');
  return {
    transport: requiredString(value.transport, 'generation'),
    generation: requiredInteger(value.generation, 'generation'),
  };
};

export const parseTranscriptCacheMessageID = (value) => requiredString(value, 'message ID');

export const parseTranscriptCacheUpsert = (body) => {
  if (!isPlainObject(body)) fail('Invalid transcript cache payload');
  const scope = parseTranscriptCacheScope(body.scope ?? body);
  if (!isPlainObject(body.info)) fail('Invalid transcript cache payload');
  if (!Array.isArray(body.parts)) fail('Invalid transcript cache payload');
  parseTranscriptCacheMessageID(body.info.id);
  return { scope, info: body.info, parts: body.parts };
};

export const parseTranscriptCacheEvict = (body) => {
  if (!isPlainObject(body)) fail('Invalid transcript cache payload');
  if (typeof body.maxBytes !== 'number' || !Number.isFinite(body.maxBytes)) {
    fail('Invalid transcript cache payload');
  }
  const protect = body.protect === undefined
    ? undefined
    : Array.isArray(body.protect)
      ? body.protect.map((scope) => parseTranscriptCacheScope(scope))
      : fail('Invalid transcript cache payload');
  return { maxBytes: body.maxBytes, protect };
};

const cloneValue = (value) => structuredClone(value);

const cloneScope = (scope) => ({
  transport: scope.transport,
  generation: scope.generation,
  directory: scope.directory,
  sessionID: scope.sessionID,
});

const messageRole = (info) => {
  const role = info?.clientRole ?? info?.role;
  return typeof role === 'string' ? role : '';
};

/**
 * Persistable rows are settled assistants (`finish` or `time.completed`) and
 * every non-assistant row. Open assistant turns stay in the live merge path.
 */
export const isTranscriptSettled = (info) => {
  if (!isPlainObject(info)) return false;
  if (messageRole(info) !== 'assistant') return true;
  const completed = info.time?.completed;
  if (typeof completed === 'number') return true;
  return typeof info.finish === 'string' && info.finish.length > 0;
};

export const isSlimPart = (part) => isPlainObject(part) && part.slim === true;

export const transcriptPartCompleteness = (part) => (isSlimPart(part) ? 'slim' : 'full');

export const transcriptRecordCompleteness = (parts) => (
  parts.some((part) => isSlimPart(part)) ? 'slim' : 'full'
);

export const transcriptSortKeyOf = (info) => {
  const created = info?.time?.created;
  return {
    created: typeof created === 'number' && Number.isFinite(created) ? created : 0,
    messageID: info.id,
  };
};

/** Visible conversation text only. Tool output and reasoning never enter the index. */
export const projectContentSearchText = (info, parts) => {
  const role = messageRole(info);
  if (role !== 'user' && role !== 'assistant') return '';
  if (!Array.isArray(parts)) return '';
  const text = parts
    .filter((part) => isPlainObject(part) && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text.trim())
    .filter((part) => part.length > 0)
    .join('\n')
    .trim();
  if (!text) return '';
  if (role !== 'assistant' || text.length <= ASSISTANT_INDEX_TEXT_CAP) return text;
  return `${text.slice(0, ASSISTANT_INDEX_EDGE)}\n${text.slice(-ASSISTANT_INDEX_EDGE)}`;
};

const contentSearchSnippet = (text, terms) => {
  const needle = terms[0] ?? '';
  const at = needle ? text.toLowerCase().indexOf(needle.toLowerCase()) : 0;
  if (text.length <= SNIPPET_MAX) return text;
  const start = Math.max(0, (at < 0 ? 0 : at) - 40);
  const slice = text.slice(start, start + SNIPPET_MAX).trim();
  const prefix = start > 0 ? '\u2026' : '';
  const suffix = start + SNIPPET_MAX < text.length ? '\u2026' : '';
  return `${prefix}${slice}${suffix}`;
};

const canonicalize = (value) => {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const ordered = {};
  for (const key of Object.keys(value).sort()) {
    const entry = value[key];
    if (entry === undefined) continue;
    ordered[key] = canonicalize(entry);
  }
  return ordered;
};

/**
 * Stable content fingerprint. Hash is a change detector only — same identity
 * plus same hash skips the write and refreshes `lastAccessedAt`.
 */
export const fingerprintTranscriptContent = (info, parts) => {
  const payload = JSON.stringify(canonicalize({ info, parts }));
  return {
    hash: crypto.createHash('sha256').update(payload).digest('hex'),
    byteSize: Buffer.byteLength(payload, 'utf8'),
  };
};

const createMonotonicClock = (now) => {
  let last = 0;
  return () => {
    const value = now();
    last = value > last ? value : last + 1;
    return last;
  };
};

const parseStoredRecord = (row) => ({
  scope: {
    transport: row.transport,
    generation: row.generation,
    directory: row.directory,
    sessionID: row.session_id,
  },
  messageID: row.message_id,
  info: JSON.parse(row.info_json),
  parts: JSON.parse(row.parts_json),
  partCompleteness: JSON.parse(row.part_completeness_json),
  completeness: row.completeness,
  contentHash: row.content_hash,
  byteSize: row.byte_size,
  lastAccessedAt: row.last_accessed_at,
  sortKey: {
    created: row.created_at,
    messageID: row.message_id,
  },
});

const openTranscriptCacheService = (dbPath, now) => {
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const existingTables = new Set(db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN (
      'transcript_cache_meta',
      '${TRANSCRIPT_CACHE_INDEX_TABLE}',
      '${TRANSCRIPT_CACHE_CONTENT_TABLE}'
    )
  `).all().map((row) => row.name));
  const hasMetaTable = existingTables.has('transcript_cache_meta');
  const storedSchemaVersion = hasMetaTable
    ? Number(db.prepare("SELECT value FROM transcript_cache_meta WHERE key = 'schema_version'").get()?.value)
    : 0;
  if (existingTables.size > 0 && storedSchemaVersion !== TRANSCRIPT_CACHE_SCHEMA_VERSION) {
    // This database is only an acceleration cache. Schema changes rebuild
    // instead of carrying migration compatibility code.
    db.exec(`
      DROP TABLE IF EXISTS ${TRANSCRIPT_CACHE_CONTENT_TABLE};
      DROP TABLE IF EXISTS ${TRANSCRIPT_CACHE_INDEX_TABLE};
      DROP TABLE IF EXISTS transcript_cache_meta;
    `);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS transcript_cache_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${TRANSCRIPT_CACHE_INDEX_TABLE} (
      transport TEXT NOT NULL,
      generation INTEGER NOT NULL,
      directory TEXT NOT NULL,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      completeness TEXT NOT NULL CHECK(completeness IN ('slim', 'full')),
      byte_size INTEGER NOT NULL,
      last_accessed_at INTEGER NOT NULL,
      PRIMARY KEY (transport, generation, directory, session_id, message_id)
    );
    CREATE TABLE IF NOT EXISTS ${TRANSCRIPT_CACHE_CONTENT_TABLE} (
      transport TEXT NOT NULL,
      generation INTEGER NOT NULL,
      directory TEXT NOT NULL,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      info_json TEXT NOT NULL,
      parts_json TEXT NOT NULL,
      part_completeness_json TEXT NOT NULL,
      PRIMARY KEY (transport, generation, directory, session_id, message_id),
      FOREIGN KEY (transport, generation, directory, session_id, message_id)
        REFERENCES ${TRANSCRIPT_CACHE_INDEX_TABLE}(transport, generation, directory, session_id, message_id)
        ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS transcript_cache_index_session_order
      ON ${TRANSCRIPT_CACHE_INDEX_TABLE}(transport, generation, directory, session_id, created_at, message_id);
    CREATE INDEX IF NOT EXISTS transcript_cache_index_lru
      ON ${TRANSCRIPT_CACHE_INDEX_TABLE}(last_accessed_at, created_at, message_id);
    CREATE INDEX IF NOT EXISTS transcript_cache_index_generation
      ON ${TRANSCRIPT_CACHE_INDEX_TABLE}(transport, generation);
  `);
  db.prepare('INSERT OR REPLACE INTO transcript_cache_meta(key, value) VALUES (?, ?)')
    .run('schema_version', String(TRANSCRIPT_CACHE_SCHEMA_VERSION));

  const storedSearchVersion = Number(
    db.prepare("SELECT value FROM transcript_cache_meta WHERE key = 'content_search_schema_version'").get()?.value,
  );
  if (storedSearchVersion !== CONTENT_SEARCH_SCHEMA_VERSION) {
    db.exec(`
      DROP TABLE IF EXISTS ${CONTENT_SEARCH_FTS_TABLE};
      DROP TABLE IF EXISTS ${CONTENT_SEARCH_TABLE};
    `);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${CONTENT_SEARCH_TABLE} (
      fts_rowid INTEGER PRIMARY KEY,
      transport TEXT NOT NULL,
      generation INTEGER NOT NULL,
      directory TEXT NOT NULL,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      created_at INTEGER NOT NULL,
      body TEXT NOT NULL,
      UNIQUE (transport, generation, directory, session_id, message_id)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS ${CONTENT_SEARCH_FTS_TABLE} USING fts5(
      body,
      content='${CONTENT_SEARCH_TABLE}',
      content_rowid='fts_rowid',
      tokenize='trigram'
    );
  `);
  db.exec(`
    DROP TRIGGER IF EXISTS transcript_content_search_ai;
    DROP TRIGGER IF EXISTS transcript_content_search_ad;
    DROP TRIGGER IF EXISTS transcript_content_search_au;
    CREATE TRIGGER transcript_content_search_ai AFTER INSERT ON ${CONTENT_SEARCH_TABLE} BEGIN
      INSERT INTO ${CONTENT_SEARCH_FTS_TABLE}(rowid, body) VALUES (NEW.fts_rowid, NEW.body);
    END;
    CREATE TRIGGER transcript_content_search_ad AFTER DELETE ON ${CONTENT_SEARCH_TABLE} BEGIN
      INSERT INTO ${CONTENT_SEARCH_FTS_TABLE}(${CONTENT_SEARCH_FTS_TABLE}, rowid, body)
      VALUES ('delete', OLD.fts_rowid, OLD.body);
    END;
    CREATE TRIGGER transcript_content_search_au AFTER UPDATE OF body ON ${CONTENT_SEARCH_TABLE} BEGIN
      INSERT INTO ${CONTENT_SEARCH_FTS_TABLE}(${CONTENT_SEARCH_FTS_TABLE}, rowid, body)
      VALUES ('delete', OLD.fts_rowid, OLD.body);
      INSERT INTO ${CONTENT_SEARCH_FTS_TABLE}(rowid, body) VALUES (NEW.fts_rowid, NEW.body);
    END;
  `);
  db.prepare('INSERT OR REPLACE INTO transcript_cache_meta(key, value) VALUES (?, ?)')
    .run('content_search_schema_version', String(CONTENT_SEARCH_SCHEMA_VERSION));

  const clock = createMonotonicClock(now);
  const identityArgs = (scope, messageID) => [
    scope.transport,
    scope.generation,
    scope.directory,
    scope.sessionID,
    messageID,
  ];

  const readJoined = db.prepare(`
    SELECT
      idx.transport, idx.generation, idx.directory, idx.session_id, idx.message_id,
      idx.created_at, idx.content_hash, idx.completeness, idx.byte_size, idx.last_accessed_at,
      content.info_json, content.parts_json, content.part_completeness_json
    FROM ${TRANSCRIPT_CACHE_INDEX_TABLE} AS idx
    INNER JOIN ${TRANSCRIPT_CACHE_CONTENT_TABLE} AS content
      ON content.transport = idx.transport
      AND content.generation = idx.generation
      AND content.directory = idx.directory
      AND content.session_id = idx.session_id
      AND content.message_id = idx.message_id
    WHERE idx.transport = ? AND idx.generation = ? AND idx.directory = ?
      AND idx.session_id = ? AND idx.message_id = ?
  `);
  const readSessionRows = db.prepare(`
    SELECT
      idx.transport, idx.generation, idx.directory, idx.session_id, idx.message_id,
      idx.created_at, idx.content_hash, idx.completeness, idx.byte_size, idx.last_accessed_at,
      content.info_json, content.parts_json, content.part_completeness_json
    FROM ${TRANSCRIPT_CACHE_INDEX_TABLE} AS idx
    INNER JOIN ${TRANSCRIPT_CACHE_CONTENT_TABLE} AS content
      ON content.transport = idx.transport
      AND content.generation = idx.generation
      AND content.directory = idx.directory
      AND content.session_id = idx.session_id
      AND content.message_id = idx.message_id
    WHERE idx.transport = ? AND idx.generation = ? AND idx.directory = ? AND idx.session_id = ?
    ORDER BY idx.created_at ASC, idx.message_id ASC
  `);
  const touchMessage = db.prepare(`
    UPDATE ${TRANSCRIPT_CACHE_INDEX_TABLE}
    SET last_accessed_at = ?
    WHERE transport = ? AND generation = ? AND directory = ? AND session_id = ? AND message_id = ?
  `);
  const touchSession = db.prepare(`
    UPDATE ${TRANSCRIPT_CACHE_INDEX_TABLE}
    SET last_accessed_at = ?
    WHERE transport = ? AND generation = ? AND directory = ? AND session_id = ?
  `);
  const insertIndex = db.prepare(`
    INSERT OR REPLACE INTO ${TRANSCRIPT_CACHE_INDEX_TABLE}(
      transport, generation, directory, session_id, message_id,
      created_at, content_hash, completeness, byte_size, last_accessed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertContent = db.prepare(`
    INSERT OR REPLACE INTO ${TRANSCRIPT_CACHE_CONTENT_TABLE}(
      transport, generation, directory, session_id, message_id,
      info_json, parts_json, part_completeness_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const deleteMessage = db.prepare(`
    DELETE FROM ${TRANSCRIPT_CACHE_INDEX_TABLE}
    WHERE transport = ? AND generation = ? AND directory = ? AND session_id = ? AND message_id = ?
  `);
  const deleteSession = db.prepare(`
    DELETE FROM ${TRANSCRIPT_CACHE_INDEX_TABLE}
    WHERE transport = ? AND generation = ? AND directory = ? AND session_id = ?
  `);
  const deleteGeneration = db.prepare(`
    DELETE FROM ${TRANSCRIPT_CACHE_INDEX_TABLE}
    WHERE transport = ? AND generation = ?
  `);
  const deleteAllIndex = db.prepare(`DELETE FROM ${TRANSCRIPT_CACHE_INDEX_TABLE}`);
  const sumBytes = db.prepare(`SELECT COALESCE(SUM(byte_size), 0) AS total FROM ${TRANSCRIPT_CACHE_INDEX_TABLE}`);
  const listForEvict = db.prepare(`
    SELECT transport, generation, directory, session_id, message_id, byte_size, last_accessed_at, created_at
    FROM ${TRANSCRIPT_CACHE_INDEX_TABLE}
    ORDER BY last_accessed_at ASC, created_at ASC, message_id ASC
  `);

  const deleteSearchRow = db.prepare(`
    DELETE FROM ${CONTENT_SEARCH_TABLE}
    WHERE transport = ? AND generation = ? AND directory = ? AND session_id = ? AND message_id = ?
  `);
  const deleteSearchSession = db.prepare(`
    DELETE FROM ${CONTENT_SEARCH_TABLE}
    WHERE transport = ? AND generation = ? AND directory = ? AND session_id = ?
  `);
  const deleteSearchGeneration = db.prepare(`
    DELETE FROM ${CONTENT_SEARCH_TABLE}
    WHERE transport = ? AND generation = ?
  `);
  const deleteAllSearch = db.prepare(`DELETE FROM ${CONTENT_SEARCH_TABLE}`);
  const nextSearchRowid = db.prepare(`SELECT COALESCE(MAX(fts_rowid), 0) + 1 AS next FROM ${CONTENT_SEARCH_TABLE}`);
  const insertSearchRow = db.prepare(`
    INSERT INTO ${CONTENT_SEARCH_TABLE}(
      fts_rowid, transport, generation, directory, session_id, message_id, role, created_at, body
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateSearchBody = db.prepare(`
    UPDATE ${CONTENT_SEARCH_TABLE}
    SET role = ?, created_at = ?, body = ?
    WHERE transport = ? AND generation = ? AND directory = ? AND session_id = ? AND message_id = ?
  `);
  const readSearchRow = db.prepare(`
    SELECT role, created_at, body FROM ${CONTENT_SEARCH_TABLE}
    WHERE transport = ? AND generation = ? AND directory = ? AND session_id = ? AND message_id = ?
  `);

  const syncSearchRow = (scope, info, parts) => {
    const body = projectContentSearchText(info, parts);
    const args = identityArgs(scope, info.id);
    if (!body) {
      deleteSearchRow.run(...args);
      return;
    }
    const existing = readSearchRow.get(...args);
    const role = messageRole(info);
    const createdAt = transcriptSortKeyOf(info).created;
    if (!existing) {
      insertSearchRow.run(nextSearchRowid.get().next, ...args, role, createdAt, body);
      return;
    }
    if (existing.body !== body || existing.role !== role || existing.created_at !== createdAt) {
      updateSearchBody.run(role, createdAt, body, ...args);
    }
  };

  const writeRow = db.transaction((scope, info, parts, completeness, partCompleteness, fingerprint, accessedAt) => {
    const sortKey = transcriptSortKeyOf(info);
    const args = identityArgs(scope, info.id);
    insertIndex.run(
      ...args,
      sortKey.created,
      fingerprint.hash,
      completeness,
      fingerprint.byteSize,
      accessedAt,
    );
    insertContent.run(
      ...args,
      JSON.stringify(info),
      JSON.stringify(parts),
      JSON.stringify(partCompleteness),
    );
    syncSearchRow(scope, info, parts);
    return parseStoredRecord(readJoined.get(...args));
  });

  const removeRow = db.transaction((scope, messageID) => {
    deleteSearchRow.run(...identityArgs(scope, messageID));
    deleteMessage.run(...identityArgs(scope, messageID));
  });

  const clearSessionRows = db.transaction((scope) => {
    deleteSearchSession.run(scope.transport, scope.generation, scope.directory, scope.sessionID);
    deleteSession.run(scope.transport, scope.generation, scope.directory, scope.sessionID);
  });

  const clearGenerationRows = db.transaction((generation) => {
    deleteSearchGeneration.run(generation.transport, generation.generation);
    deleteGeneration.run(generation.transport, generation.generation);
  });

  /** Wipe every scope. Content rows follow the index via ON DELETE CASCADE. */
  const clearAllRows = db.transaction(() => {
    deleteAllSearch.run();
    deleteAllIndex.run();
  });

  const evictRows = db.transaction((maxBytes, protect) => {
    const budget = Number.isFinite(maxBytes) ? Math.max(0, maxBytes) : 0;
    const protectedKeys = new Set(
      protect.map((scope) => JSON.stringify([scope.transport, scope.generation, scope.directory, scope.sessionID])),
    );
    let remainingBytes = Number(sumBytes.get()?.total ?? 0);
    if (remainingBytes <= budget) {
      return { evicted: 0, freedBytes: 0, remainingBytes };
    }

    let evicted = 0;
    let freedBytes = 0;
    for (const row of listForEvict.all()) {
      if (remainingBytes <= budget) break;
      const key = JSON.stringify([row.transport, row.generation, row.directory, row.session_id]);
      if (protectedKeys.has(key)) continue;
      deleteSearchRow.run(row.transport, row.generation, row.directory, row.session_id, row.message_id);
      deleteMessage.run(row.transport, row.generation, row.directory, row.session_id, row.message_id);
      remainingBytes -= row.byte_size;
      freedBytes += row.byte_size;
      evicted += 1;
    }
    return { evicted, freedBytes, remainingBytes };
  });

  return {
    readSession(scopeInput) {
      const scope = parseTranscriptCacheScope(scopeInput);
      const accessedAt = clock();
      touchSession.run(accessedAt, scope.transport, scope.generation, scope.directory, scope.sessionID);
      const records = readSessionRows.all(
        scope.transport,
        scope.generation,
        scope.directory,
        scope.sessionID,
      ).map((row) => parseStoredRecord({ ...row, last_accessed_at: accessedAt }));
      return {
        scope: cloneScope(scope),
        records,
        byteSize: records.reduce((sum, record) => sum + record.byteSize, 0),
      };
    },

    readMessage(scopeInput, messageIDInput) {
      const scope = parseTranscriptCacheScope(scopeInput);
      const messageID = parseTranscriptCacheMessageID(messageIDInput);
      const existing = readJoined.get(...identityArgs(scope, messageID));
      if (!existing) return undefined;
      const accessedAt = clock();
      touchMessage.run(accessedAt, ...identityArgs(scope, messageID));
      return parseStoredRecord({ ...existing, last_accessed_at: accessedAt });
    },

    upsertSettled(scopeInput, infoInput, partsInput) {
      const scope = parseTranscriptCacheScope(scopeInput);
      if (!isPlainObject(infoInput)) fail('Invalid transcript cache payload');
      if (!Array.isArray(partsInput)) fail('Invalid transcript cache payload');
      const messageID = parseTranscriptCacheMessageID(infoInput.id);
      if (!isTranscriptSettled(infoInput)) {
        return { status: 'skipped', reason: 'not-settled' };
      }

      const info = cloneValue(infoInput);
      const parts = cloneValue(partsInput);
      const completeness = transcriptRecordCompleteness(parts);
      const existing = readJoined.get(...identityArgs(scope, messageID));
      if (existing && existing.completeness === 'full' && completeness === 'slim') {
        return { status: 'skipped', reason: 'slim-downgrade', record: parseStoredRecord(existing) };
      }

      const fingerprint = fingerprintTranscriptContent(info, parts);
      if (existing && existing.content_hash === fingerprint.hash) {
        const accessedAt = clock();
        touchMessage.run(accessedAt, ...identityArgs(scope, messageID));
        return {
          status: 'skipped',
          reason: 'unchanged',
          record: parseStoredRecord({ ...existing, last_accessed_at: accessedAt }),
        };
      }

      const partCompleteness = parts.map(transcriptPartCompleteness);
      return {
        status: 'written',
        record: writeRow(scope, info, parts, completeness, partCompleteness, fingerprint, clock()),
      };
    },

    removeMessage(scopeInput, messageIDInput) {
      const scope = parseTranscriptCacheScope(scopeInput);
      const messageID = parseTranscriptCacheMessageID(messageIDInput);
      removeRow(scope, messageID);
    },

    clearSession(scopeInput) {
      clearSessionRows(parseTranscriptCacheScope(scopeInput));
    },

    clearGeneration(generationInput) {
      clearGenerationRows(parseTranscriptCacheGeneration(generationInput));
    },

    clearAll() {
      clearAllRows();
    },

    evictToBytes(maxBytes, options = {}) {
      if (typeof maxBytes !== 'number' || !Number.isFinite(maxBytes)) {
        fail('Invalid transcript cache payload');
      }
      const protect = Array.isArray(options?.protect)
        ? options.protect.map((scope) => parseTranscriptCacheScope(scope))
        : options?.protect === undefined
          ? []
          : fail('Invalid transcript cache payload');
      return evictRows(maxBytes, protect);
    },

    searchContent(scopeInput, queryInput, options = {}) {
      const scope = parseContentSearchScope({ ...scopeInput, q: '' }).scope;
      const query = typeof queryInput === 'string' ? queryInput.trim() : '';
      const terms = query.split(/\s+/).filter(Boolean);
      if (terms.length === 0) return { hits: [] };
      const requested = options.limit ?? CONTENT_SEARCH_DEFAULT_LIMIT;
      const limit = Number.isInteger(requested)
        ? Math.min(Math.max(requested, 1), CONTENT_SEARCH_MAX_LIMIT)
        : CONTENT_SEARCH_DEFAULT_LIMIT;
      const like = terms.map(() => `body LIKE ? ESCAPE '\\'`).join(' AND ');
      const patterns = terms.map((term) => `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`);
      const rows = db.prepare(`
        SELECT session_id, message_id, role, created_at, body
        FROM ${CONTENT_SEARCH_TABLE}
        WHERE transport = ? AND generation = ? AND directory = ?
          AND ${like}
        ORDER BY created_at DESC, message_id DESC
        LIMIT ?
      `).all(scope.transport, scope.generation, scope.directory, ...patterns, limit);
      return {
        hits: rows.map((row) => ({
          sessionID: row.session_id,
          messageID: row.message_id,
          role: row.role,
          createdAt: row.created_at,
          snippet: contentSearchSnippet(row.body, terms),
        })),
      };
    },

    /**
     * Project settled cache rows newer than `since` into the content index.
     * Does not read OpenCode. Returns how many excerpts were written or replaced.
     */
    rebuildContentSince(since) {
      const cutoff = typeof since === 'number' && Number.isFinite(since) ? since : 0;
      const rows = db.prepare(`
        SELECT
          idx.transport, idx.generation, idx.directory, idx.session_id, idx.message_id,
          content.info_json, content.parts_json
        FROM ${TRANSCRIPT_CACHE_INDEX_TABLE} AS idx
        INNER JOIN ${TRANSCRIPT_CACHE_CONTENT_TABLE} AS content
          ON content.transport = idx.transport
          AND content.generation = idx.generation
          AND content.directory = idx.directory
          AND content.session_id = idx.session_id
          AND content.message_id = idx.message_id
        WHERE idx.created_at >= ?
      `).all(cutoff);
      let indexed = 0;
      const write = db.transaction(() => {
        for (const row of rows) {
          let info;
          let parts;
          try {
            info = JSON.parse(row.info_json);
            parts = JSON.parse(row.parts_json);
          } catch {
            continue;
          }
          if (!isTranscriptSettled(info)) continue;
          const before = readSearchRow.get(row.transport, row.generation, row.directory, row.session_id, row.message_id);
          syncSearchRow({
            transport: row.transport,
            generation: row.generation,
            directory: row.directory,
            sessionID: row.session_id,
          }, info, parts);
          const after = readSearchRow.get(row.transport, row.generation, row.directory, row.session_id, row.message_id);
          if (after && (!before || before.body !== after.body)) indexed += 1;
        }
      });
      write();
      return { scanned: rows.length, indexed };
    },

    close() {
      db.close();
    },
  };
};

/**
 * Local SQLite acceleration cache for settled transcript messages.
 * `dbPath` empty/null disables the cache so remote Web servers do not persist bodies.
 */
export const createTranscriptCacheService = ({ dbPath, now = Date.now } = {}) => {
  if (typeof dbPath !== 'string' || !dbPath.trim()) return null;
  try {
    return openTranscriptCacheService(dbPath.trim(), now);
  } catch {
    console.warn('[transcript-cache] failed to open sqlite cache');
    return null;
  }
};
