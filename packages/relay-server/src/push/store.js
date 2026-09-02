import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `CREATE TABLE IF NOT EXISTS push_tokens (
  token TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT`;

export const createTokenStore = (databasePath) => {
  if (typeof databasePath !== 'string' || databasePath.length === 0 || databasePath.includes('\0')) {
    throw new RangeError('invalid database path');
  }
  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  }
  const db = new DatabaseSync(databasePath, { timeout: 5_000 });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  const getStmt = db.prepare('SELECT server_id AS serverId, platform, updated_at AS updatedAt FROM push_tokens WHERE token = ?');
  const upsertStmt = db.prepare(`INSERT INTO push_tokens (token, server_id, platform, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(token) DO UPDATE SET server_id = excluded.server_id, platform = excluded.platform, updated_at = excluded.updated_at`);
  const deleteStmt = db.prepare('DELETE FROM push_tokens WHERE token = ?');
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM push_tokens');
  let closed = false;
  const assertOpen = () => { if (closed) throw new Error('token store closed'); };
  return {
    get(token) {
      assertOpen();
      const row = getStmt.get(token);
      return row ? { serverId: row.serverId, platform: row.platform, updatedAt: row.updatedAt } : null;
    },
    upsert(token, serverId, platform, updatedAt) {
      assertOpen();
      upsertStmt.run(token, serverId, platform, updatedAt);
    },
    delete(token) {
      assertOpen();
      deleteStmt.run(token);
    },
    count() {
      assertOpen();
      return Number(countStmt.get().n);
    },
    close() {
      if (closed) return;
      closed = true;
      try { db.close(); } catch { /* already closed */ }
    },
  };
};
