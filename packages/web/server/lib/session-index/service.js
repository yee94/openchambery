import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const SCHEMA_VERSION = 5;
const MAX_ROOT_SESSIONS = 20;
const HIDDEN_SESSION_TITLES = new Set(['smartfetch-secondary']);

const isVisibleSession = (session) => !HIDDEN_SESSION_TITLES.has(session?.title) && session?.metadata?.openchamber?.assistant?.kind !== 'assistant';

const normalizeDirectory = (value) => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized || null;
};

const toTimestamp = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0);

const toBooleanInt = (value) => (value ? 1 : 0);

const getActivityUpdatedAt = (session) => {
  const activityUpdatedAt = session?.metadata?.openchamber?.titleRefresh?.activityUpdatedAt;
  return Math.max(toTimestamp(activityUpdatedAt), toTimestamp(session?.time?.updated), toTimestamp(session?.time?.created));
};

const runtimeKeyFor = (runtimeConfig) => {
  const source = typeof runtimeConfig?.apiBaseUrl === 'string' && runtimeConfig.apiBaseUrl.trim()
    ? runtimeConfig.apiBaseUrl.trim()
    : 'local-managed-opencode';
  return crypto.createHash('sha256').update(source).digest('hex');
};

const toSummary = (session, fallbackDirectory) => {
  if (!session || !isVisibleSession(session) || typeof session.id !== 'string' || !session.id) return null;
  const directory = normalizeDirectory(session.directory ?? session.project?.worktree ?? fallbackDirectory);
  if (!directory) return null;
  return {
    id: session.id,
    directory,
    title: typeof session.title === 'string' ? session.title : '',
    createdAt: toTimestamp(session.time?.created),
    updatedAt: toTimestamp(session.time?.updated),
    activityUpdatedAt: getActivityUpdatedAt(session),
    archivedAt: toTimestamp(session.time?.archived),
    parentID: typeof session.parentID === 'string' ? session.parentID : null,
    hasChildren: typeof session.hasChildren === 'boolean' ? session.hasChildren : null,
  };
};

export const createSessionIndexService = ({ dbPath, getRuntimeConfig = () => null } = {}) => {
  if (typeof dbPath !== 'string' || !dbPath.trim()) return null;

  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const existingTables = new Set(db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN ('session_index_meta', 'runtime_directory', 'session_summary', 'session_child')
  `).all().map((row) => row.name));
  const hasMetaTable = existingTables.has('session_index_meta');
  const storedSchemaVersion = hasMetaTable
    ? Number(db.prepare("SELECT value FROM session_index_meta WHERE key = 'schema_version'").get()?.value)
    : 0;
  if (existingTables.size > 0 && storedSchemaVersion !== SCHEMA_VERSION) {
    // This database is only an acceleration index. Schema changes deliberately
    // rebuild from OpenCode instead of carrying migration compatibility code.
    db.exec(`
      DROP TABLE IF EXISTS session_summary;
      DROP TABLE IF EXISTS session_child;
      DROP TABLE IF EXISTS runtime_directory;
      DROP TABLE IF EXISTS session_index_meta;
    `);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_index_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runtime_directory (
      runtime_key TEXT NOT NULL,
      directory TEXT NOT NULL,
      cursor INTEGER,
      has_more INTEGER NOT NULL DEFAULT 0,
      last_synced_at INTEGER NOT NULL DEFAULT 0,
      last_full_synced_at INTEGER NOT NULL DEFAULT 0,
      last_accessed_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (runtime_key, directory)
    );
    CREATE TABLE IF NOT EXISTS session_summary (
      runtime_key TEXT NOT NULL,
      directory TEXT NOT NULL,
      session_id TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      activity_updated_at INTEGER NOT NULL,
      archived_at INTEGER NOT NULL DEFAULT 0,
      status TEXT,
      status_changed_at INTEGER NOT NULL DEFAULT 0,
      parent_id TEXT,
      has_children INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (runtime_key, directory, session_id),
      FOREIGN KEY (runtime_key, directory)
        REFERENCES runtime_directory(runtime_key, directory)
        ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS session_child (
      runtime_key TEXT NOT NULL,
      directory TEXT NOT NULL,
      session_id TEXT NOT NULL,
      parent_id TEXT NOT NULL,
      PRIMARY KEY (runtime_key, directory, session_id)
    );
    CREATE INDEX IF NOT EXISTS session_summary_runtime_activity
      ON session_summary(runtime_key, directory, activity_updated_at DESC, session_id DESC);
    CREATE INDEX IF NOT EXISTS session_child_parent
      ON session_child(runtime_key, directory, parent_id);
  `);
  db.prepare('INSERT OR REPLACE INTO session_index_meta(key, value) VALUES (?, ?)')
    .run('schema_version', String(SCHEMA_VERSION));

  const runtimeKey = () => runtimeKeyFor(getRuntimeConfig());
  const touchDirectory = db.prepare(`
    INSERT INTO runtime_directory(runtime_key, directory, cursor, has_more, last_synced_at, last_full_synced_at, last_accessed_at)
    VALUES (@runtimeKey, @directory, @cursor, @hasMore, @lastSyncedAt, @lastFullSyncedAt, @lastAccessedAt)
    ON CONFLICT(runtime_key, directory) DO UPDATE SET
      cursor = excluded.cursor,
      has_more = excluded.has_more,
      last_synced_at = excluded.last_synced_at,
      last_full_synced_at = CASE
        WHEN @fullSync = 1 THEN excluded.last_synced_at
        ELSE runtime_directory.last_full_synced_at
      END,
      last_accessed_at = excluded.last_accessed_at
  `);
  const touchExistingDirectory = db.prepare(`
    INSERT INTO runtime_directory(runtime_key, directory, cursor, has_more, last_synced_at, last_full_synced_at, last_accessed_at)
    VALUES (@runtimeKey, @directory, NULL, 0, 0, 0, @lastAccessedAt)
    ON CONFLICT(runtime_key, directory) DO UPDATE SET
      last_accessed_at = excluded.last_accessed_at
  `);
  const deleteDirectoryRows = db.prepare('DELETE FROM session_summary WHERE runtime_key = ? AND directory = ?');
  const existingSummaryState = db.prepare(`
    SELECT session_id, has_children AS hasChildren, activity_updated_at AS activityUpdatedAt,
      status, status_changed_at AS statusChangedAt
    FROM session_summary WHERE runtime_key = ? AND directory = ?
  `);
  const readSummary = db.prepare(`
    SELECT title, created_at AS createdAt, updated_at AS updatedAt,
      activity_updated_at AS activityUpdatedAt, archived_at AS archivedAt,
      parent_id AS parentID, has_children AS hasChildren
    FROM session_summary
    WHERE runtime_key = ? AND directory = ? AND session_id = ?
  `);
  const readRootRetentionCutoff = db.prepare(`
    SELECT session_id AS id, activity_updated_at AS activityUpdatedAt
    FROM session_summary
    WHERE runtime_key = ? AND directory = ?
    ORDER BY activity_updated_at DESC, session_id DESC
    LIMIT 1 OFFSET ?
  `);
  const insertSummary = db.prepare(`
    INSERT INTO session_summary(runtime_key, directory, session_id, title, created_at, updated_at, activity_updated_at, archived_at, status, status_changed_at, parent_id, has_children)
    VALUES (@runtimeKey, @directory, @id, @title, @createdAt, @updatedAt, @activityUpdatedAt, @archivedAt, @status, @statusChangedAt, @parentID, @hasChildren)
  `);
  const upsertSummary = db.prepare(`
    INSERT INTO session_summary(runtime_key, directory, session_id, title, created_at, updated_at, activity_updated_at, archived_at, status, status_changed_at, parent_id, has_children)
    VALUES (@runtimeKey, @directory, @id, @title, @createdAt, @updatedAt, @activityUpdatedAt, @archivedAt, NULL, 0, @parentID, @hasChildren)
    ON CONFLICT(runtime_key, directory, session_id) DO UPDATE SET
      title = excluded.title,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      activity_updated_at = MAX(session_summary.activity_updated_at, excluded.activity_updated_at),
      archived_at = excluded.archived_at,
      parent_id = excluded.parent_id,
      has_children = excluded.has_children
  `);
  const setHasChildren = db.prepare(`
    UPDATE session_summary SET has_children = ?
    WHERE runtime_key = ? AND directory = ? AND session_id = ?
  `);
  const upsertChild = db.prepare(`
    INSERT INTO session_child(runtime_key, directory, session_id, parent_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(runtime_key, directory, session_id) DO UPDATE SET parent_id = excluded.parent_id
  `);
  const deleteChildrenForParent = db.prepare(`
    DELETE FROM session_child WHERE runtime_key = ? AND directory = ? AND parent_id = ?
  `);
  const insertChild = db.prepare(`
    INSERT INTO session_child(runtime_key, directory, session_id, parent_id) VALUES (?, ?, ?, ?)
  `);
  const parentForChild = db.prepare(`
    SELECT directory, parent_id AS parentID FROM session_child
    WHERE runtime_key = ? AND session_id = ?
  `);
  const deleteChild = db.prepare('DELETE FROM session_child WHERE runtime_key = ? AND session_id = ?');
  const deleteChildrenWithParent = db.prepare('DELETE FROM session_child WHERE runtime_key = ? AND parent_id = ?');
  const deleteOrphanChildRows = db.prepare(`
    DELETE FROM session_child
    WHERE runtime_key = ? AND directory = ?
      AND parent_id NOT IN (
        SELECT session_id FROM session_summary WHERE runtime_key = ? AND directory = ?
      )
  `);
  const countChildrenForParent = db.prepare(`
    SELECT COUNT(*) AS count FROM session_child
    WHERE runtime_key = ? AND directory = ? AND parent_id = ?
  `);

  const replaceDirectoryRows = ({ directory, sessions, cursor, hasMore, fullSync = true, now = Date.now() }) => {
    const normalizedDirectory = normalizeDirectory(directory);
    if (!normalizedDirectory) throw new Error('directory is required');
    const key = runtimeKey();
    const previousStateByID = new Map(
      existingSummaryState.all(key, normalizedDirectory).map((row) => [row.session_id, row]),
    );
    const summaries = Array.isArray(sessions)
      ? sessions.map((session) => toSummary(session, normalizedDirectory)).filter(Boolean).slice(0, MAX_ROOT_SESSIONS)
      : [];
    touchDirectory.run({
      runtimeKey: key,
      directory: normalizedDirectory,
      cursor: typeof cursor === 'number' && Number.isFinite(cursor) ? Math.trunc(cursor) : null,
      hasMore: toBooleanInt(hasMore),
      lastSyncedAt: toTimestamp(now),
      lastFullSyncedAt: fullSync ? toTimestamp(now) : 0,
      lastAccessedAt: toTimestamp(now),
      fullSync: toBooleanInt(fullSync),
    });
    deleteDirectoryRows.run(key, normalizedDirectory);
    for (const summary of summaries) {
      const previous = previousStateByID.get(summary.id);
      insertSummary.run({
        ...summary,
        activityUpdatedAt: Math.max(summary.activityUpdatedAt, toTimestamp(previous?.activityUpdatedAt)),
        status: typeof previous?.status === 'string' ? previous.status : null,
        statusChangedAt: toTimestamp(previous?.statusChangedAt),
        hasChildren: toBooleanInt(summary.hasChildren ?? Boolean(previous?.hasChildren)),
        runtimeKey: key,
        directory: normalizedDirectory,
      });
    }
    deleteOrphanChildRows.run(key, normalizedDirectory, key, normalizedDirectory);
  };
  const replaceDirectory = db.transaction(replaceDirectoryRows);
  const replaceDirectories = db.transaction((directories, now = Date.now()) => {
    if (!Array.isArray(directories)) throw new Error('directories must be an array');
    for (const directory of directories) {
      replaceDirectoryRows({ ...directory, now });
    }
  });

  const upsertMutation = db.transaction((session, now = Date.now(), options = {}) => {
    if (!isVisibleSession(session)) {
      const changed = remove(session?.id);
      return { accepted: changed, changed };
    }
    const summary = toSummary(session);
    if (!summary) return { accepted: false, changed: false };
    const key = runtimeKey();
    if (summary.archivedAt) {
      return { accepted: true, changed: remove(summary.id) };
    }
    if (summary.parentID) {
      const existingChild = parentForChild.get(key, summary.id);
      const parent = readSummary.get(key, summary.directory, summary.parentID);
      const membershipChanged = existingChild?.directory !== summary.directory
        || existingChild?.parentID !== summary.parentID;
      const parentFlagChanged = Boolean(parent) && !Boolean(parent.hasChildren);
      if (!membershipChanged && !parentFlagChanged) {
        return { accepted: true, changed: false };
      }
      touchExistingDirectory.run({
        runtimeKey: key,
        directory: summary.directory,
        lastAccessedAt: toTimestamp(now),
      });
      upsertChild.run(key, summary.directory, summary.id, summary.parentID);
      setHasChildren.run(1, key, summary.directory, summary.parentID);
      return { accepted: true, changed: true };
    }
    const existing = readSummary.get(key, summary.directory, summary.id);
    const activityUpdatedAt = options.preserveActivity === true && existing
      ? toTimestamp(existing.activityUpdatedAt)
      : Math.max(toTimestamp(existing?.activityUpdatedAt), summary.activityUpdatedAt);
    const hasChildren = toBooleanInt(summary.hasChildren ?? Boolean(existing?.hasChildren));
    if (existing) {
      const unchanged = existing.title === summary.title
        && toTimestamp(existing.createdAt) === summary.createdAt
        && toTimestamp(existing.updatedAt) === summary.updatedAt
        && toTimestamp(existing.activityUpdatedAt) === activityUpdatedAt
        && toTimestamp(existing.archivedAt) === summary.archivedAt
        && (existing.parentID ?? null) === summary.parentID
        && toBooleanInt(existing.hasChildren) === hasChildren;
      if (unchanged) return { accepted: true, changed: false };
    } else {
      const cutoff = readRootRetentionCutoff.get(key, summary.directory, MAX_ROOT_SESSIONS - 1);
      const fallsOutsideBound = cutoff
        && (activityUpdatedAt < toTimestamp(cutoff.activityUpdatedAt)
          || (activityUpdatedAt === toTimestamp(cutoff.activityUpdatedAt) && summary.id < cutoff.id));
      if (fallsOutsideBound) return { accepted: true, changed: false };
    }
    touchExistingDirectory.run({
      runtimeKey: key,
      directory: summary.directory,
      lastAccessedAt: toTimestamp(now),
    });
    upsertSummary.run({
      ...summary,
      activityUpdatedAt,
      hasChildren,
      runtimeKey: key,
    });
    const extra = db.prepare(`
      SELECT session_id FROM session_summary
      WHERE runtime_key = ? AND directory = ?
      ORDER BY activity_updated_at DESC, session_id DESC
      LIMIT -1 OFFSET ?
    `).all(key, summary.directory, MAX_ROOT_SESSIONS);
    if (extra.length > 0) {
      const remove = db.prepare('DELETE FROM session_summary WHERE runtime_key = ? AND directory = ? AND session_id = ?');
      for (const row of extra) remove.run(key, summary.directory, row.session_id);
    }
    return { accepted: true, changed: true };
  });
  const upsert = (...args) => upsertMutation(...args).accepted;
  const upsertAndReportChange = (...args) => upsertMutation(...args).changed;

  const snapshot = () => {
    const key = runtimeKey();
    const directories = db.prepare(`
      SELECT directory, cursor, has_more AS hasMore, last_synced_at AS lastSyncedAt,
        last_full_synced_at AS lastFullSyncedAt, last_accessed_at AS lastAccessedAt
      FROM runtime_directory WHERE runtime_key = ? ORDER BY last_accessed_at DESC, directory ASC
    `).all(key).map((directory) => ({
      ...directory,
      hasMore: Boolean(directory.hasMore),
      sessions: db.prepare(`
        SELECT session_id AS id, title, created_at AS createdAt, updated_at AS updatedAt,
          activity_updated_at AS activityUpdatedAt, archived_at AS archivedAt,
          status, status_changed_at AS statusChangedAt, parent_id AS parentID,
          has_children AS hasChildren
        FROM session_summary WHERE runtime_key = ? AND directory = ?
        ORDER BY activity_updated_at DESC, id DESC
      `).all(key, directory.directory)
        .map((session) => ({
          id: session.id,
          title: session.title,
          directory: directory.directory,
          time: { created: session.createdAt, updated: session.updatedAt, ...(session.archivedAt ? { archived: session.archivedAt } : {}) },
          metadata: {
            openchamber: {
              titleRefresh: { activityUpdatedAt: session.activityUpdatedAt },
              sessionStatus: { type: session.status ?? 'idle', changedAt: session.statusChangedAt },
            },
          },
          ...(session.parentID ? { parentID: session.parentID } : {}),
          ...(session.hasChildren ? { hasChildren: true } : {}),
        }))
        .filter(isVisibleSession),
    }));
    return { directories };
  };

  function remove(sessionID) {
    if (typeof sessionID !== 'string' || !sessionID) return false;
    const key = runtimeKey();
    const parent = parentForChild.get(key, sessionID);
    const result = db.prepare('DELETE FROM session_summary WHERE runtime_key = ? AND session_id = ?').run(key, sessionID);
    deleteChildrenWithParent.run(key, sessionID);
    deleteChild.run(key, sessionID);
    if (parent) {
      setHasChildren.run(
        toBooleanInt(Number(countChildrenForParent.get(key, parent.directory, parent.parentID)?.count ?? 0) > 0),
        key,
        parent.directory,
        parent.parentID,
      );
    }
    return result.changes > 0;
  }

  const touchActivity = (sessionID, observedAt) => {
    if (typeof sessionID !== 'string' || !sessionID) return false;
    const timestamp = toTimestamp(observedAt);
    if (!timestamp) return false;
    const result = db.prepare(`
      UPDATE session_summary
      SET activity_updated_at = ?
      WHERE runtime_key = ? AND session_id = ? AND activity_updated_at < ?
    `).run(timestamp, runtimeKey(), sessionID, timestamp);
    return result.changes > 0;
  };

  const updateStatus = (sessionID, status, observedAt) => {
    if (typeof sessionID !== 'string' || !sessionID) return false;
    if (status !== 'busy' && status !== 'retry' && status !== 'idle') return false;
    const timestamp = toTimestamp(observedAt);
    if (!timestamp) return false;
    const result = db.prepare(`
      UPDATE session_summary
      SET status = ?, status_changed_at = ?
      WHERE runtime_key = ? AND session_id = ? AND status_changed_at <= ?
    `).run(status, timestamp, runtimeKey(), sessionID, timestamp);
    return result.changes > 0;
  };

  const replaceChildSessions = db.transaction((directory, parentSessionID, children) => {
    const normalizedDirectory = normalizeDirectory(directory);
    if (!normalizedDirectory || typeof parentSessionID !== 'string' || !parentSessionID) return false;
    const key = runtimeKey();
    const childIDs = Array.isArray(children)
      ? children
        .filter((child) => child && typeof child.id === 'string' && child.id)
        .map((child) => child.id)
      : [];
    deleteChildrenForParent.run(key, normalizedDirectory, parentSessionID);
    for (const childID of childIDs) insertChild.run(key, normalizedDirectory, childID, parentSessionID);
    const result = setHasChildren.run(toBooleanInt(childIDs.length > 0), key, normalizedDirectory, parentSessionID);
    return result.changes > 0;
  });

  return {
    replaceDirectory,
    replaceDirectories,
    upsert,
    upsertAndReportChange,
    touchActivity,
    updateStatus,
    remove,
    replaceChildSessions,
    snapshot,
    getRuntimeKey: runtimeKey,
    close: () => db.close(),
  };
};
