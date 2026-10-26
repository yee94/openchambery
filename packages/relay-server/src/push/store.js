import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `CREATE TABLE IF NOT EXISTS push_tokens (
  token TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT`;

export const createTokenStore = (databasePath, { busyTimeoutMs = 5_000 } = {}) => {
  if (typeof databasePath !== 'string' || databasePath.length === 0 || databasePath.includes('\0')) {
    throw new RangeError('invalid database path');
  }
  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  }
  const db = new DatabaseSync(databasePath, { timeout: busyTimeoutMs });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  db.exec(SCHEMA);
  if (!db.prepare('PRAGMA table_info(push_tokens)').all().some((column) => column.name === 'bundle_id')) {
    db.exec('ALTER TABLE push_tokens ADD COLUMN bundle_id TEXT');
  }
  const getStmt = db.prepare('SELECT server_id AS serverId, platform, updated_at AS updatedAt, bundle_id AS bundleId FROM push_tokens WHERE token = ?');
  const upsertStmt = db.prepare(`INSERT INTO push_tokens (token, server_id, platform, updated_at, bundle_id) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(token) DO UPDATE SET server_id = excluded.server_id, platform = excluded.platform, updated_at = excluded.updated_at, bundle_id = excluded.bundle_id`);
  const deleteStmt = db.prepare('DELETE FROM push_tokens WHERE token = ?');
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM push_tokens');
  let closed = false;
  const assertOpen = () => { if (closed) throw new Error('token store closed'); };
  return {
    entries(maxTokens) {
      assertOpen();
      const rows = db.prepare('SELECT token, server_id AS serverId, platform, updated_at AS updatedAt, bundle_id AS bundleId FROM push_tokens LIMIT ?').all(maxTokens + 1);
      if (rows.length > maxTokens) throw new Error('token capacity exceeded');
      return rows.map(({ bundleId, ...row }) => ({ ...row, ...(bundleId ? { bundleId } : {}) }));
    },
    get(token) {
      assertOpen();
      const row = getStmt.get(token);
      return row ? { serverId: row.serverId, platform: row.platform, updatedAt: row.updatedAt, ...(row.bundleId ? { bundleId: row.bundleId } : {}) } : null;
    },
    upsert(token, serverId, platform, updatedAt, bundleId = null) {
      assertOpen();
      upsertStmt.run(token, serverId, platform, updatedAt, bundleId);
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
