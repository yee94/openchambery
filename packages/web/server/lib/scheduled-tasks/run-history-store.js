import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const INTERRUPTED_ERROR = 'Run interrupted by process restart';

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const asFiniteInteger = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.trunc(value);
};

const encodeCursor = ({ startedAt, runID }) => Buffer
  .from(JSON.stringify({ startedAt, runID }), 'utf8')
  .toString('base64url');

const decodeCursor = (before) => {
  if (before == null || before === '') {
    return null;
  }
  if (typeof before !== 'string') {
    throw new Error('Invalid cursor');
  }
  try {
    const raw = Buffer.from(before, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw);
    const startedAt = asFiniteInteger(parsed?.startedAt);
    const runID = asNonEmptyString(parsed?.runID);
    if (startedAt === null || !runID) {
      throw new Error('Invalid cursor');
    }
    return { startedAt, runID };
  } catch (error) {
    if (error instanceof Error && /cursor/i.test(error.message)) {
      throw error;
    }
    throw new Error('Invalid cursor');
  }
};

const rowToDto = (row) => ({
  id: row.run_id,
  projectId: row.project_id,
  taskId: row.task_id,
  taskName: row.task_name,
  trigger: row.trigger,
  status: row.status,
  sessionId: row.session_id ?? null,
  directory: row.directory ?? null,
  error: row.error ?? null,
  startedAt: row.started_at,
  finishedAt: row.finished_at ?? null,
  durationMs: row.duration_ms ?? null,
});

export const createScheduledTaskRunHistoryStore = ({ dbPath, clock = () => Date.now() } = {}) => {
  if (typeof dbPath !== 'string' || !dbPath.trim()) {
    throw new Error('dbPath is required');
  }

  const resolvedPath = path.resolve(dbPath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

  const Database = require('better-sqlite3');
  const db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_task_run (
      run_id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      task_name TEXT NOT NULL,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL,
      session_id TEXT,
      directory TEXT,
      error TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      duration_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS scheduled_task_run_started_desc
      ON scheduled_task_run (started_at DESC, run_id DESC);
    CREATE INDEX IF NOT EXISTS scheduled_task_run_project_started_desc
      ON scheduled_task_run (project_id, started_at DESC, run_id DESC);
    CREATE INDEX IF NOT EXISTS scheduled_task_run_task_started_desc
      ON scheduled_task_run (task_id, started_at DESC, run_id DESC);
    CREATE INDEX IF NOT EXISTS scheduled_task_run_project_task_started_desc
      ON scheduled_task_run (project_id, task_id, started_at DESC, run_id DESC);
  `);

  const now = () => Math.trunc(clock());

  const convergeInterruptedRuns = () => {
    const finishedAt = now();
    db.prepare(`
      UPDATE scheduled_task_run
      SET status = 'error',
          error = ?,
          finished_at = ?,
          duration_ms = MAX(0, ? - started_at)
      WHERE status = 'running'
    `).run(INTERRUPTED_ERROR, finishedAt, finishedAt);
  };

  convergeInterruptedRuns();

  let closed = false;
  const assertOpen = () => {
    if (closed) {
      throw new Error('scheduled task run history store is closed');
    }
  };

  const startRun = (record = {}) => {
    assertOpen();
    const id = asNonEmptyString(record.id) || crypto.randomUUID();
    const projectId = asNonEmptyString(record.projectId ?? record.projectID);
    const taskId = asNonEmptyString(record.taskId ?? record.taskID);
    const taskName = asNonEmptyString(record.taskName) || 'Schedule';
    const trigger = record.trigger === 'manual' ? 'manual' : 'scheduled';
    const directory = asNonEmptyString(record.directory);
    const startedAt = asFiniteInteger(record.startedAt) ?? now();

    if (!projectId || !taskId) {
      throw new Error('projectId and taskId are required');
    }

    db.prepare(`
      INSERT INTO scheduled_task_run (
        run_id, project_id, task_id, task_name, trigger, status,
        session_id, directory, error, started_at, finished_at, duration_ms
      ) VALUES (?, ?, ?, ?, ?, 'running', NULL, ?, NULL, ?, NULL, NULL)
    `).run(id, projectId, taskId, taskName, trigger, directory, startedAt);

    return rowToDto(db.prepare('SELECT * FROM scheduled_task_run WHERE run_id = ?').get(id));
  };

  const attachSession = (runID, sessionID) => {
    assertOpen();
    const id = asNonEmptyString(runID);
    const sessionId = asNonEmptyString(sessionID);
    if (!id || !sessionId) {
      throw new Error('runID and sessionID are required');
    }
    const result = db.prepare(`
      UPDATE scheduled_task_run
      SET session_id = ?
      WHERE run_id = ?
    `).run(sessionId, id);
    if (result.changes === 0) {
      throw new Error('run not found');
    }
    return rowToDto(db.prepare('SELECT * FROM scheduled_task_run WHERE run_id = ?').get(id));
  };

  const finishRun = (runID, result = {}) => {
    assertOpen();
    const id = asNonEmptyString(runID);
    if (!id) {
      throw new Error('runID is required');
    }
    const row = db.prepare('SELECT * FROM scheduled_task_run WHERE run_id = ?').get(id);
    if (!row) {
      throw new Error('run not found');
    }

    const status = result.status === 'success' ? 'success' : 'error';
    const finishedAt = asFiniteInteger(result.finishedAt) ?? now();
    const durationMs = asFiniteInteger(result.durationMs)
      ?? Math.max(0, finishedAt - row.started_at);
    const error = status === 'error'
      ? (asNonEmptyString(result.error) || 'Unknown error')
      : null;
    const sessionId = asNonEmptyString(result.sessionId ?? result.sessionID) ?? row.session_id;

    db.prepare(`
      UPDATE scheduled_task_run
      SET status = ?,
          session_id = ?,
          error = ?,
          finished_at = ?,
          duration_ms = ?
      WHERE run_id = ?
    `).run(status, sessionId, error, finishedAt, durationMs, id);

    return rowToDto(db.prepare('SELECT * FROM scheduled_task_run WHERE run_id = ?').get(id));
  };

  const listRuns = ({ before, limit, projectID, taskID, projectId, taskId } = {}) => {
    assertOpen();
    const cursor = decodeCursor(before);
    const resolvedLimit = (() => {
      if (limit == null || limit === '') {
        return DEFAULT_LIMIT;
      }
      const parsed = typeof limit === 'number' ? limit : Number(limit);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error('Invalid limit');
      }
      return Math.min(MAX_LIMIT, parsed);
    })();

    const filters = [];
    const params = [];
    const resolvedProjectID = asNonEmptyString(projectID ?? projectId);
    const resolvedTaskID = asNonEmptyString(taskID ?? taskId);
    if (resolvedProjectID) {
      filters.push('project_id = ?');
      params.push(resolvedProjectID);
    }
    if (resolvedTaskID) {
      filters.push('task_id = ?');
      params.push(resolvedTaskID);
    }
    if (cursor) {
      filters.push('(started_at < ? OR (started_at = ? AND run_id < ?))');
      params.push(cursor.startedAt, cursor.startedAt, cursor.runID);
    }

    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    const rows = db.prepare(`
      SELECT *
      FROM scheduled_task_run
      ${where}
      ORDER BY started_at DESC, run_id DESC
      LIMIT ?
    `).all(...params, resolvedLimit + 1);

    const pageRows = rows.slice(0, resolvedLimit);
    const hasMore = rows.length > resolvedLimit;
    const last = pageRows[pageRows.length - 1];
    return {
      runs: pageRows.map(rowToDto),
      nextCursor: hasMore && last
        ? encodeCursor({ startedAt: last.started_at, runID: last.run_id })
        : null,
      complete: !hasMore,
    };
  };

  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    db.close();
  };

  return {
    startRun,
    attachSession,
    finishRun,
    listRuns,
    close,
  };
};
