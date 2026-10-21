import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export function projectSearchRecord({ info, parts = [] }) {
  const role = info?.clientRole ?? info?.role;
  if (role !== 'user' && role !== 'assistant') return null;
  if (role === 'assistant' && !info.finish && !info.time?.completed) return null;
  let text = parts.filter((part) => part.type === 'text' && !part.synthetic && !part.ignored && !part.slim)
    .map((part) => typeof part.text === 'string' ? part.text : '').join('\n').trim();
  if (!text) return null;
  if (role === 'assistant' && text.length > 2048) text = text.slice(0, 1024) + '\n' + text.slice(-1023);
  return { info: { id: info.id, role, time: { created: Number(info.time?.created) || 0 }, finish: role === 'assistant' ? info.finish || 'stop' : undefined }, parts: [{ type: 'text', text }] };
}

export function createContentSearchService({ dbPath }) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_session(runtime TEXT, id TEXT, directory TEXT, title TEXT, updated REAL, PRIMARY KEY(runtime,id));
    CREATE TABLE IF NOT EXISTS search_message(id INTEGER PRIMARY KEY, runtime TEXT, session TEXT, message TEXT, role TEXT, created REAL, body TEXT, UNIQUE(runtime,session,message));
    CREATE INDEX IF NOT EXISTS search_message_scope ON search_message(runtime,session);
    CREATE TABLE IF NOT EXISTS search_coverage(runtime TEXT PRIMARY KEY, started_at REAL NOT NULL, completed_at REAL, since REAL, verified_at REAL);
    CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(body, content='search_message', content_rowid='id', tokenize='trigram');
    CREATE TRIGGER IF NOT EXISTS search_insert AFTER INSERT ON search_message BEGIN
      INSERT INTO search_fts(rowid,body) VALUES(new.id,new.body); END;
    CREATE TRIGGER IF NOT EXISTS search_delete AFTER DELETE ON search_message BEGIN
      INSERT INTO search_fts(search_fts,rowid,body) VALUES('delete',old.id,old.body); END;
  `);
  const sessionColumns = db.prepare('PRAGMA table_info(search_session)').all();
  if (!sessionColumns.some((column) => column.name === 'since')) {
    db.exec('ALTER TABLE search_session ADD COLUMN since REAL');
  }
  if (!sessionColumns.some((column) => column.name === 'indexed_at')) {
    db.exec('ALTER TABLE search_session ADD COLUMN indexed_at REAL');
  }
  const remove = db.prepare('DELETE FROM search_message WHERE runtime=? AND session=?');
  const write = db.prepare('INSERT INTO search_message(runtime,session,message,role,created,body) VALUES(?,?,?,?,?,?)');
  const removeSession = db.transaction((runtime, id) => {
    remove.run(runtime, id);
    db.prepare('DELETE FROM search_session WHERE runtime=? AND id=?').run(runtime, id);
  });
  return {
    coverage(runtime) {
      return db.prepare('SELECT started_at AS indexStartedAt, completed_at AS indexCompletedAt, since AS coveredSince, verified_at AS verifiedAt FROM search_coverage WHERE runtime=?').get(runtime)
        ?? { indexStartedAt: null, indexCompletedAt: null, coveredSince: null, verifiedAt: null };
    },
    beginInitialization(runtime, timestamp) {
      db.prepare(`INSERT INTO search_coverage(runtime,started_at) VALUES(?,?)
        ON CONFLICT(runtime) DO UPDATE SET started_at=excluded.started_at, completed_at=NULL
        WHERE search_coverage.completed_at IS NOT NULL`).run(runtime, timestamp);
    },
    completeInitialization(runtime, since, timestamp) {
      db.prepare(`UPDATE search_coverage SET completed_at=COALESCE(completed_at,?), since=?, verified_at=? WHERE runtime=?`)
        .run(timestamp, since, timestamp, runtime);
    },
    replaceSession: db.transaction((runtime, session, records, since = null, indexedAt = Date.now()) => {
      remove.run(runtime, session.id);
      for (const record of records) {
        const projected = projectSearchRecord(record);
        if (projected) write.run(runtime, session.id, projected.info.id, projected.info.role, projected.info.time.created, projected.parts[0].text);
      }
      db.prepare('INSERT OR REPLACE INTO search_session(runtime,id,directory,title,updated,since,indexed_at) VALUES(?,?,?,?,?,?,?)').run(runtime, session.id,
        session.location?.directory ?? session.directory ?? '', session.title ?? '', session.time?.updated ?? 0, since, indexedAt);
    }),
    removeSession,
    updated(runtime, id, since) {
      const row = db.prepare('SELECT updated,since,indexed_at FROM search_session WHERE runtime=? AND id=?').get(runtime, id);
      if (row?.indexed_at == null) return undefined;
      if (since !== undefined && (row?.since == null || row.since > since)) return undefined;
      return row?.updated;
    },
    prune: db.transaction((runtime, since, ids) => {
      db.prepare('DELETE FROM search_message WHERE runtime=? AND created<?').run(runtime, since);
      db.prepare('UPDATE search_session SET since=MAX(since,?) WHERE runtime=? AND since IS NOT NULL').run(since, runtime);
      for (const row of db.prepare('SELECT id FROM search_session WHERE runtime=?').all(runtime)) {
        if (!ids.has(row.id)) removeSession(runtime, row.id);
      }
    }),
    stats(runtime) {
      return db.prepare('SELECT COUNT(*) AS messages, COUNT(DISTINCT session) AS sessions, COALESCE(SUM(length(CAST(body AS BLOB))),0) AS textBytes FROM search_message WHERE runtime=?').get(runtime);
    },
    search(runtime, query, { limit = 30, directory } = {}) {
      const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
      if (!terms.length) return [];
      // MATCH uses trigram postings for terms >= 3 characters; short Chinese terms
      // retain exact substring semantics with a scoped scan.
      const indexed = terms.filter((term) => [...term].length >= 3);
      const match = indexed.map((term) => `"${term.replaceAll('"', '""')}"`).join(' AND ');
      const conditions = ['m.runtime=?', ...terms.map(() => 'instr(lower(m.body),?)>0')];
      const args = [runtime, ...terms];
      if (directory) { conditions.push('s.directory=?'); args.push(directory); }
      if (match) { conditions.push('m.id IN (SELECT rowid FROM search_fts WHERE search_fts MATCH ?)'); args.push(match); }
      args.push(Math.min(50, Math.max(1, limit)));
      return db.prepare(`SELECT m.session AS sessionID,m.message AS messageID,m.role,m.created AS createdAt,m.body,s.title,s.directory
        FROM search_message m JOIN search_session s ON s.runtime=m.runtime AND s.id=m.session
        WHERE ${conditions.join(' AND ')} ORDER BY m.created DESC,m.message DESC LIMIT ?`).all(...args).map(({ body, ...hit }) => {
        const start = Math.max(0, Math.min(...terms.map((term) => body.toLowerCase().indexOf(term))) - 60);
        const end = Math.min(body.length, start + 300);
        return { ...hit, snippet: (start ? '…' : '') + body.slice(start, end) + (end < body.length ? '…' : '') };
      });
    },
    close() { db.close(); },
  };
}
