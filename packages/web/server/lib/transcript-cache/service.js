import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const TRANSCRIPT_CACHE_SCHEMA_VERSION = 1;
export const TRANSCRIPT_CACHE_INDEX_TABLE = 'transcript_cache_index';
export const TRANSCRIPT_CACHE_CONTENT_TABLE = 'transcript_cache_content';

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
    return parseStoredRecord(readJoined.get(...args));
  });

  const removeRow = db.transaction((scope, messageID) => {
    deleteMessage.run(...identityArgs(scope, messageID));
  });

  const clearSessionRows = db.transaction((scope) => {
    deleteSession.run(scope.transport, scope.generation, scope.directory, scope.sessionID);
  });

  const clearGenerationRows = db.transaction((generation) => {
    deleteGeneration.run(generation.transport, generation.generation);
  });

  /** Wipe every scope. Content rows follow the index via ON DELETE CASCADE. */
  const clearAllRows = db.transaction(() => {
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
