import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { validAssistantDeliveryParts } from '../assistant-delivery-parts.js';

const require = createRequire(import.meta.url);
const SCHEMA_VERSION = 11;
const BACKFILL_PAGE_SIZE = 100;
const BACKFILL_MAX_PAGES = 3;
const SHARE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const SHARE_LEASE_MS = 30_000;
const SHARE_MAX_ATTEMPTS = 3;
const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const json = (value) => JSON.stringify(value);
const parse = (value) => JSON.parse(value);
const hash = (value) => crypto.createHash('sha256').update(json(value)).digest('hex');
const id = () => crypto.randomUUID();
export class AssistantError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = (code) => { throw new AssistantError(code); };
const string = (value, max = 10_000, required = false) => { if (value == null && !required) return null; if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail('validation_error'); return value.trim(); };
const nonEmptyString = (value, max = 10_000) => typeof value === 'string' && value.length > 0 && value.length <= max;
const isMissing = (result) => result?.error?.status === 404 || result?.error?.statusCode === 404 || result?.error?.code === 'not_found' || result?.status === 404;
const promptAdmitted = (result) => !result?.error && (result?.response?.status === 204 || result?.status === 204 || result?.data !== undefined || result?.response?.ok === true);

export const createAssistantsService = ({ dbPath, dataDir, buildOpenCodeUrl, getOpenCodeAuthHeaders, getServerId = async () => null, getAllowedRoots = () => [], globalEventHub = null, clock = () => Date.now(), setIntervalFn = setInterval, clearIntervalFn = clearInterval, reconcileIntervalMs = 60_000, clientFactory } = {}) => {
  if (!dbPath || !dataDir) return null;
  const Database = require('better-sqlite3');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath); db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = ON');
  let closed = false;
  const shareReservations = new Map();
  db.exec(`CREATE TABLE IF NOT EXISTS assistant_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS assistant_v2 (assistant_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, enabled INTEGER NOT NULL, name TEXT NOT NULL, default_prompt TEXT NOT NULL, workspace_path TEXT, provider_id TEXT NOT NULL, model_id TEXT NOT NULL, agent TEXT, variant TEXT, mode TEXT NOT NULL DEFAULT 'continuous', current_session_id TEXT, session_generation INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, tombstone_at INTEGER);
    CREATE TABLE IF NOT EXISTS assistant_share_operation (operation_id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL, payload_hash TEXT NOT NULL, phase TEXT NOT NULL, session_id TEXT, message_id TEXT, state TEXT NOT NULL, response TEXT, error_code TEXT, attempt INTEGER NOT NULL DEFAULT 0, lease_expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS assistant_share_operation_expiry ON assistant_share_operation(updated_at);
    CREATE TABLE IF NOT EXISTS assistant_topic (topic_id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL, title TEXT NOT NULL, session_id TEXT, session_workspace_path TEXT, revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, tombstone_at INTEGER);
    CREATE TABLE IF NOT EXISTS assistant_turn (turn_id TEXT PRIMARY KEY, topic_id TEXT NOT NULL, ordinal INTEGER NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'composer', parts TEXT NOT NULL, assistant_revision INTEGER NOT NULL, session_id TEXT, message_id TEXT, operation_id TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS assistant_operation (operation_id TEXT PRIMARY KEY, topic_id TEXT, type TEXT, payload_hash TEXT NOT NULL, state TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'admitted', response TEXT, error_code TEXT, attempt INTEGER NOT NULL DEFAULT 0, lease_expires_at INTEGER, session_id TEXT, message_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS assistant_session_history (assistant_id TEXT NOT NULL, session_id TEXT NOT NULL, ordinal INTEGER NOT NULL, directory TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (assistant_id, session_id));
    CREATE INDEX IF NOT EXISTS assistant_session_history_ordinal ON assistant_session_history(assistant_id, ordinal);
    CREATE TABLE IF NOT EXISTS assistant_message_mirror (assistant_id TEXT NOT NULL, session_id TEXT NOT NULL, message_id TEXT NOT NULL, info_json TEXT NOT NULL, ordinal INTEGER NOT NULL, covered INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY (assistant_id, session_id, message_id));
    CREATE INDEX IF NOT EXISTS assistant_message_mirror_page ON assistant_message_mirror(assistant_id, session_id, ordinal, message_id);
    CREATE TABLE IF NOT EXISTS assistant_message_part_mirror (assistant_id TEXT NOT NULL, session_id TEXT NOT NULL, message_id TEXT NOT NULL, part_id TEXT NOT NULL, part_json TEXT NOT NULL, ordinal INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (assistant_id, session_id, message_id, part_id));
    CREATE INDEX IF NOT EXISTS assistant_message_part_mirror_message ON assistant_message_part_mirror(assistant_id, session_id, message_id, ordinal, part_id);
    CREATE TABLE IF NOT EXISTS assistant_message_backfill (assistant_id TEXT NOT NULL, session_id TEXT NOT NULL, cursor TEXT, complete INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY (assistant_id, session_id));`);
  const historyColumns = new Set(db.prepare("SELECT name FROM pragma_table_info('assistant_session_history')").all().map((column) => column.name));
  if (!historyColumns.has('directory')) db.exec('ALTER TABLE assistant_session_history ADD COLUMN directory TEXT');
  const mirrorColumns = new Set(db.prepare("SELECT name FROM pragma_table_info('assistant_message_mirror')").all().map((column) => column.name));
  if (!mirrorColumns.has('covered')) db.exec('ALTER TABLE assistant_message_mirror ADD COLUMN covered INTEGER NOT NULL DEFAULT 0');
  const shareColumns = new Set(db.prepare("SELECT name FROM pragma_table_info('assistant_share_operation')").all().map((column) => column.name));
  if (!shareColumns.has('attempt')) db.exec('ALTER TABLE assistant_share_operation ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0');
  if (!shareColumns.has('lease_expires_at')) db.exec('ALTER TABLE assistant_share_operation ADD COLUMN lease_expires_at INTEGER');
  // Fresh installs keep Assistants off until Settings flips the global switch.
  // INSERT OR IGNORE preserves any already-persisted enabled value.
  db.prepare("INSERT OR IGNORE INTO assistant_meta(key,value) VALUES ('enabled','0')").run(); db.prepare("INSERT OR IGNORE INTO assistant_meta(key,value) VALUES ('revision','0')").run();
  const now = () => Math.trunc(clock());
  const revision = () => Number(db.prepare("SELECT value FROM assistant_meta WHERE key='revision'").get().value);
  const bump = () => { const value = revision() + 1; db.prepare("UPDATE assistant_meta SET value=? WHERE key='revision'").run(String(value)); return value; };
  const enabled = () => db.prepare("SELECT value FROM assistant_meta WHERE key='enabled'").get().value === '1';
  const assistant = (assistantID) => db.prepare('SELECT * FROM assistant_v2 WHERE assistant_id=?').get(assistantID);
  const editable = (assistantID) => { const row = assistant(assistantID); if (!row || row.tombstone_at) fail('not_found'); return row; };
  const active = (assistantID) => { const row = editable(assistantID); if (!enabled() || !row.enabled) fail('assistant_disabled'); return row; };
  const workspaceFor = (assistantID) => path.join(dataDir, 'assistant-workspaces', assistantID);
  const contained = (candidate, root) => candidate === root || candidate.startsWith(`${root}${path.sep}`);
  const roots = () => [path.resolve(dataDir, 'assistant-workspaces'), ...getAllowedRoots().filter((root) => typeof root === 'string').map((root) => path.resolve(root))];
  const workspace = (candidate, assistantID, createDefault = false) => { const requested = candidate == null ? workspaceFor(assistantID) : path.resolve(string(candidate, 4096, true)); const allowed = roots(); const permitted = (value) => allowed.some((root) => contained(value, root) || (fs.existsSync(root) && contained(value, fs.realpathSync(root)))); if (!permitted(requested)) fail('workspace_forbidden'); if (createDefault && requested === workspaceFor(assistantID)) fs.mkdirSync(requested, { recursive: true }); try { const resolved = fs.realpathSync(requested); if (!fs.statSync(resolved).isDirectory() || !permitted(resolved)) fail('workspace_forbidden'); return resolved; } catch (error) { if (error instanceof AssistantError) throw error; fail('workspace_forbidden'); } };
  const effectiveWorkspace = (row) => workspace(row.workspace_path, row.assistant_id, row.workspace_path == null);
  const historyIDs = (assistantID) => db.prepare('SELECT session_id FROM assistant_session_history WHERE assistant_id=? ORDER BY ordinal DESC LIMIT 50').all(assistantID).reverse().map((row) => row.session_id);
  const historyCount = (assistantID) => Number(db.prepare('SELECT COUNT(*) AS count FROM assistant_session_history WHERE assistant_id=?').get(assistantID).count);
  const archiveSession = (assistantID, sessionID, directory = null) => {
    if (!sessionID) return;
    const existing = db.prepare('SELECT directory FROM assistant_session_history WHERE assistant_id=? AND session_id=?').get(assistantID, sessionID);
    if (existing) {
      if (existing.directory == null && directory != null) db.prepare('UPDATE assistant_session_history SET directory=? WHERE assistant_id=? AND session_id=?').run(directory, assistantID, sessionID);
      db.prepare('DELETE FROM assistant_message_backfill WHERE assistant_id=? AND session_id=?').run(assistantID, sessionID);
      db.prepare('UPDATE assistant_message_mirror SET covered=0 WHERE assistant_id=? AND session_id=?').run(assistantID, sessionID);
      return;
    }
    const effectiveDirectory = directory ?? effectiveWorkspace(editable(assistantID));
    const ordinal = Number(db.prepare('SELECT COALESCE(MAX(ordinal), 0) + 1 AS next FROM assistant_session_history WHERE assistant_id=?').get(assistantID).next);
    db.prepare('INSERT INTO assistant_session_history(assistant_id, session_id, ordinal, directory, created_at) VALUES (?,?,?,?,?)').run(assistantID, sessionID, ordinal, effectiveDirectory, now());
    db.prepare('DELETE FROM assistant_message_backfill WHERE assistant_id=? AND session_id=?').run(assistantID, sessionID);
    db.prepare('UPDATE assistant_message_mirror SET covered=0 WHERE assistant_id=? AND session_id=?').run(assistantID, sessionID);
  };
  const output = (row) => ({ id: row.assistant_id, revision: row.revision, enabled: Boolean(row.enabled), name: row.name, defaultPrompt: row.default_prompt, workspacePath: row.workspace_path, managedWorkspacePath: workspace(null, row.assistant_id, true), effectiveWorkspacePath: effectiveWorkspace(row), providerID: row.provider_id, modelID: row.model_id, agent: row.agent, variant: row.variant, mode: row.mode === 'stateless' ? 'stateless' : 'continuous', sessionID: row.current_session_id, sessionGeneration: row.session_generation, historySessionIDs: historyIDs(row.assistant_id), historySessionCount: historyCount(row.assistant_id), createdAt: row.created_at, updatedAt: row.updated_at, tombstoneAt: row.tombstone_at });
  const binding = (row) => ({ sessionID: row.current_session_id, directory: effectiveWorkspace(row), sessionGeneration: row.session_generation });
  const client = () => clientFactory ? clientFactory() : createOpencodeClient({ baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''), headers: getOpenCodeAuthHeaders() });
  const metadata = (row) => ({ openchamber: { assistant: { assistantID: row.assistant_id, name: row.name } } });
  const createSession = async (row) => { const directory = effectiveWorkspace(row); const result = await client().session.create({ directory, title: row.name, metadata: metadata(row) }); if (result.error || !result.data?.id) fail('upstream_error'); return { sessionID: result.data.id, directory }; };
  const sessionExists = async (row) => { if (!row.current_session_id) return false; const result = await client().session.get({ sessionID: row.current_session_id, directory: effectiveWorkspace(row) }); if (isMissing(result)) return false; if (result.error) fail('upstream_error'); return Boolean(result.data); };
  const replaceBinding = (row, created) => { if (row.current_session_id && row.current_session_id !== created.sessionID) archiveSession(row.assistant_id, row.current_session_id, effectiveWorkspace(row)); const result = db.prepare('UPDATE assistant_v2 SET current_session_id=?,session_generation=session_generation+1,updated_at=? WHERE assistant_id=? AND session_generation=? AND tombstone_at IS NULL').run(created.sessionID, now(), row.assistant_id, row.session_generation); if (result.changes) bump(); return result.changes ? assistant(row.assistant_id) : null; };
  const prepareExecutionBinding = async (row) => { if (row.mode !== 'stateless') return row; const created = await createSession(row); const won = replaceBinding(row, created); if (!won) fail('revision_conflict'); return won; };
  const ensure = async (assistantID) => { for (let attempt = 0; attempt < 4; attempt++) { const row = active(assistantID); if (await sessionExists(row)) return binding(row); const created = await createSession(row); const won = replaceBinding(row, created); if (won) return binding(won); const authoritative = active(assistantID); if (authoritative.current_session_id) return binding(authoritative); } fail('revision_conflict'); };
  const restoreOnce = async (row, expectedSessionID, expectedGeneration) => { for (let attempt = 0; attempt < 3; attempt++) { const current = active(row.assistant_id); if (current.current_session_id !== expectedSessionID || current.session_generation !== expectedGeneration) return binding(current); const created = await createSession(current); const won = replaceBinding(current, created); if (won) return binding(won); } return binding(active(row.assistant_id)); };
  const configuration = (row) => ({ model: { providerID: row.provider_id, modelID: row.model_id }, ...(row.agent ? { agent: row.agent } : {}), ...(row.variant ? { variant: row.variant } : {}), ...(row.default_prompt ? { system: row.default_prompt } : {}) });
  const capturedConfiguration = (target) => ({ model: { providerID: target.providerID, modelID: target.modelID }, ...(target.agent ? { agent: target.agent } : {}), ...(target.variant ? { variant: target.variant } : {}), ...(target.system ? { system: target.system } : target.defaultPrompt ? { system: target.defaultPrompt } : {}) });
  const validateParts = (parts) => { if (!validAssistantDeliveryParts(parts)) fail('validation_error'); };
  const migrate = () => {
    if (db.prepare("SELECT value FROM assistant_meta WHERE key='schema_version'").get()?.value === String(SCHEMA_VERSION)) return;
    const v2Info = db.prepare("SELECT name,\"notnull\" AS required FROM pragma_table_info('assistant_v2')").all(); const v2Columns = new Set(v2Info.map((column) => column.name));
    if (v2Columns.has('skill_roots') || v2Info.some((column) => column.name === 'workspace_path' && column.required)) db.exec(`CREATE TABLE assistant_v2_next (assistant_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, enabled INTEGER NOT NULL, name TEXT NOT NULL, default_prompt TEXT NOT NULL, workspace_path TEXT, provider_id TEXT NOT NULL, model_id TEXT NOT NULL, agent TEXT, variant TEXT, current_session_id TEXT, session_generation INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, tombstone_at INTEGER); INSERT INTO assistant_v2_next (assistant_id,revision,enabled,name,default_prompt,workspace_path,provider_id,model_id,agent,variant,current_session_id,session_generation,created_at,updated_at,tombstone_at) SELECT assistant_id,revision,enabled,name,default_prompt,workspace_path,provider_id,model_id,agent,NULL,current_session_id,session_generation,created_at,updated_at,tombstone_at FROM assistant_v2; DROP TABLE assistant_v2; ALTER TABLE assistant_v2_next RENAME TO assistant_v2;`);
    if (!new Set(db.prepare("SELECT name FROM pragma_table_info('assistant_v2')").all().map((column) => column.name)).has('variant')) db.exec('ALTER TABLE assistant_v2 ADD COLUMN variant TEXT');
    if (!new Set(db.prepare("SELECT name FROM pragma_table_info('assistant_v2')").all().map((column) => column.name)).has('mode')) db.exec("ALTER TABLE assistant_v2 ADD COLUMN mode TEXT NOT NULL DEFAULT 'continuous'");
    const managedConfig = (workspacePath, assistantID) => workspacePath != null && path.resolve(workspacePath) === workspaceFor(assistantID) ? null : workspacePath;
    const legacy = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='assistant'").get();
    if (legacy) { const columns = new Set(db.prepare("SELECT name FROM pragma_table_info('assistant')").all().map((column) => column.name)); for (const row of db.prepare('SELECT * FROM assistant').all()) { let sessionID = row.current_session_id ?? null; if (!sessionID && columns.has('inbox_topic_id') && row.inbox_topic_id) sessionID = db.prepare('SELECT session_id FROM assistant_topic WHERE topic_id=?').get(row.inbox_topic_id)?.session_id ?? null; if (!sessionID) sessionID = db.prepare("SELECT session_id FROM assistant_operation WHERE topic_id IN (SELECT topic_id FROM assistant_topic WHERE assistant_id=?) AND state='completed' AND session_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1").get(row.assistant_id)?.session_id ?? db.prepare('SELECT session_id FROM assistant_turn WHERE topic_id IN (SELECT topic_id FROM assistant_topic WHERE assistant_id=?) AND session_id IS NOT NULL ORDER BY created_at DESC LIMIT 1').get(row.assistant_id)?.session_id ?? null; const mode = columns.has('mode') && row.mode === 'stateless' ? 'stateless' : 'continuous'; db.prepare('INSERT OR IGNORE INTO assistant_v2 (assistant_id,revision,enabled,name,default_prompt,workspace_path,provider_id,model_id,agent,variant,mode,current_session_id,session_generation,created_at,updated_at,tombstone_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(row.assistant_id, row.revision, row.enabled, row.name, row.default_prompt, managedConfig(row.workspace_path, row.assistant_id), row.provider_id, row.model_id, row.agent, null, mode, sessionID, Math.max(0, row.session_generation ?? 0), row.created_at, row.updated_at, row.tombstone_at); } }
    for (const row of db.prepare('SELECT assistant_id,workspace_path FROM assistant_v2 WHERE workspace_path IS NOT NULL').all()) { const workspacePath = managedConfig(row.workspace_path, row.assistant_id); if (workspacePath === null) db.prepare('UPDATE assistant_v2 SET workspace_path=NULL WHERE assistant_id=?').run(row.assistant_id); }
    db.prepare("INSERT OR REPLACE INTO assistant_meta(key,value) VALUES ('schema_version',?)").run(String(SCHEMA_VERSION));
  };
  migrate();
  const mirrorMessage = (assistantID, sessionID, info, ordinal, covered = false) => {
    const messageID = info?.id;
    if (!nonEmptyString(assistantID) || !nonEmptyString(sessionID) || !nonEmptyString(messageID) || !plainObject(info)) return;
    const existing = db.prepare('SELECT ordinal FROM assistant_message_mirror WHERE assistant_id=? AND session_id=? AND message_id=?').get(assistantID, sessionID, messageID);
    const nextOrdinal = Number.isSafeInteger(ordinal) ? ordinal : existing?.ordinal ?? Number(db.prepare('SELECT COALESCE(MAX(ordinal), 0) + 1 AS next FROM assistant_message_mirror WHERE assistant_id=? AND session_id=?').get(assistantID, sessionID).next);
    db.prepare('INSERT INTO assistant_message_mirror(assistant_id,session_id,message_id,info_json,ordinal,covered,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(assistant_id,session_id,message_id) DO UPDATE SET info_json=excluded.info_json,ordinal=excluded.ordinal,covered=CASE WHEN assistant_message_mirror.covered=1 OR excluded.covered=1 THEN 1 ELSE 0 END,updated_at=excluded.updated_at').run(assistantID, sessionID, messageID, json(info), nextOrdinal, covered ? 1 : 0, now());
  };
  const mirrorPart = (assistantID, sessionID, part, ordinal) => {
    const messageID = part?.messageID; const partID = part?.id;
    if (!nonEmptyString(assistantID) || !nonEmptyString(sessionID) || !nonEmptyString(messageID) || !nonEmptyString(partID) || !plainObject(part)) return;
    const existing = db.prepare('SELECT ordinal FROM assistant_message_part_mirror WHERE assistant_id=? AND session_id=? AND message_id=? AND part_id=?').get(assistantID, sessionID, messageID, partID);
    const nextOrdinal = Number.isSafeInteger(ordinal) ? ordinal : existing?.ordinal ?? Number(db.prepare('SELECT COALESCE(MAX(ordinal), 0) + 1 AS next FROM assistant_message_part_mirror WHERE assistant_id=? AND session_id=? AND message_id=?').get(assistantID, sessionID, messageID).next);
    db.prepare('INSERT INTO assistant_message_part_mirror(assistant_id,session_id,message_id,part_id,part_json,ordinal,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(assistant_id,session_id,message_id,part_id) DO UPDATE SET part_json=excluded.part_json,ordinal=excluded.ordinal,updated_at=excluded.updated_at').run(assistantID, sessionID, messageID, partID, json(part), nextOrdinal, now());
  };
  const mappedAssistants = (sessionID) => db.prepare("SELECT assistant_id FROM assistant_v2 WHERE current_session_id=? AND tombstone_at IS NULL UNION SELECT h.assistant_id FROM assistant_session_history h JOIN assistant_v2 a ON a.assistant_id=h.assistant_id WHERE h.session_id=? AND a.tombstone_at IS NULL").all(sessionID, sessionID).map((row) => row.assistant_id);
  const invalidateCoverage = (assistantID, sessionID) => {
    db.prepare('UPDATE assistant_message_mirror SET covered=0 WHERE assistant_id=? AND session_id=?').run(assistantID, sessionID);
    db.prepare('INSERT INTO assistant_message_backfill(assistant_id,session_id,cursor,complete,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(assistant_id,session_id) DO UPDATE SET cursor=NULL,complete=0,updated_at=excluded.updated_at').run(assistantID, sessionID, null, 0, now());
  };
  // Structural part deletes may leave a covered message incomplete; re-demand that session only.
  // Do not blanket-uncover on ordinary message/part upserts — that blanks served history until re-backfill.
  const invalidateMessageCoverage = (assistantID, sessionID, messageID) => {
    db.prepare('UPDATE assistant_message_mirror SET covered=0 WHERE assistant_id=? AND session_id=? AND message_id=?').run(assistantID, sessionID, messageID);
    db.prepare('INSERT INTO assistant_message_backfill(assistant_id,session_id,cursor,complete,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(assistant_id,session_id) DO UPDATE SET cursor=NULL,complete=0,updated_at=excluded.updated_at').run(assistantID, sessionID, null, 0, now());
  };
  const processEvent = (event) => {
    const payload = event?.payload?.payload ?? event?.payload ?? event;
    const properties = payload?.properties;
    if (!plainObject(payload) || !plainObject(properties)) return false;
    if (payload.type === 'message.updated') {
      const info = properties.info; const sessionID = info?.sessionID;
      if (!nonEmptyString(sessionID) || !plainObject(info)) return false;
      const assistants = mappedAssistants(sessionID); for (const assistantID of assistants) mirrorMessage(assistantID, sessionID, info); return assistants.length > 0;
    }
    if (payload.type === 'message.part.updated') {
      const part = properties.part; const sessionID = properties.sessionID ?? part?.sessionID;
      if (!nonEmptyString(sessionID) || !plainObject(part)) return false;
      const assistants = mappedAssistants(sessionID); for (const assistantID of assistants) mirrorPart(assistantID, sessionID, part); return assistants.length > 0;
    }
    if (payload.type === 'message.removed') {
      const sessionID = properties.sessionID; const messageID = properties.messageID;
      if (!nonEmptyString(sessionID) || !nonEmptyString(messageID)) return false;
      const assistants = mappedAssistants(sessionID); for (const assistantID of assistants) { db.prepare('DELETE FROM assistant_message_part_mirror WHERE assistant_id=? AND session_id=? AND message_id=?').run(assistantID, sessionID, messageID); db.prepare('DELETE FROM assistant_message_mirror WHERE assistant_id=? AND session_id=? AND message_id=?').run(assistantID, sessionID, messageID); } return assistants.length > 0;
    }
    if (payload.type === 'message.part.removed') {
      const sessionID = properties.sessionID; const messageID = properties.messageID ?? properties.part?.messageID; const partID = properties.partID ?? properties.part?.id;
      if (!nonEmptyString(sessionID) || !nonEmptyString(messageID) || !nonEmptyString(partID)) return false;
      const assistants = mappedAssistants(sessionID); for (const assistantID of assistants) { db.prepare('DELETE FROM assistant_message_part_mirror WHERE assistant_id=? AND session_id=? AND message_id=? AND part_id=?').run(assistantID, sessionID, messageID, partID); invalidateMessageCoverage(assistantID, sessionID, messageID); } return assistants.length > 0;
    }
    return false;
  };
  const resolveArchivedDirectory = (assistantID, ...candidates) => {
    for (const candidate of candidates) {
      if (!nonEmptyString(candidate)) continue;
      try { return workspace(candidate, assistantID); } catch { /* An unavailable or disallowed historical directory remains unknown. */ }
    }
    return null;
  };
  const backfillSession = async (history) => {
    const state = db.prepare('SELECT cursor,complete FROM assistant_message_backfill WHERE assistant_id=? AND session_id=?').get(history.assistant_id, history.session_id);
    if (state?.complete) return true;
    const cursor = state?.cursor ?? null;
    let directory = history.directory ?? null;
    if (directory == null) {
      const session = await client().session.get({ sessionID: history.session_id }).catch(() => null);
      const resolved = resolveArchivedDirectory(history.assistant_id, session?.data?.directory, session?.data?.project?.worktree);
      if (resolved) {
        db.prepare('UPDATE assistant_session_history SET directory=? WHERE assistant_id=? AND session_id=? AND directory IS NULL').run(resolved, history.assistant_id, history.session_id);
        directory = resolved;
      }
    }
    const result = await client().session.messages({ sessionID: history.session_id, ...(directory ? { directory } : {}), limit: BACKFILL_PAGE_SIZE, ...(cursor ? { before: cursor } : {}) });
    if (result?.error) fail('upstream_error');
    const entries = Array.isArray(result?.data) ? result.data : Array.isArray(result?.data?.items) ? result.data.items : null;
    if (!entries) fail('upstream_error');
    db.exec('BEGIN IMMEDIATE');
    try {
      entries.forEach((entry) => { const info = entry?.info ?? entry; const parts = Array.isArray(entry?.parts) ? entry.parts : []; const messageOrdinal = Number.isSafeInteger(info?.time?.created) ? info.time.created : undefined; mirrorMessage(history.assistant_id, history.session_id, info, messageOrdinal, true); const partIDs = parts.filter((part) => nonEmptyString(part?.id)).map((part) => part.id); if (partIDs.length) db.prepare(`DELETE FROM assistant_message_part_mirror WHERE assistant_id=? AND session_id=? AND message_id=? AND part_id NOT IN (${partIDs.map(() => '?').join(',')})`).run(history.assistant_id, history.session_id, info?.id, ...partIDs); else db.prepare('DELETE FROM assistant_message_part_mirror WHERE assistant_id=? AND session_id=? AND message_id=?').run(history.assistant_id, history.session_id, info?.id); parts.forEach((part, partIndex) => mirrorPart(history.assistant_id, history.session_id, part, partIndex + 1)); });
      const nextCursor = result?.response?.headers?.get('x-next-cursor') ?? null;
      const complete = !nextCursor;
      if (complete) { db.prepare('DELETE FROM assistant_message_part_mirror WHERE assistant_id=? AND session_id=? AND message_id IN (SELECT message_id FROM assistant_message_mirror WHERE assistant_id=? AND session_id=? AND covered=0)').run(history.assistant_id, history.session_id, history.assistant_id, history.session_id); db.prepare('DELETE FROM assistant_message_mirror WHERE assistant_id=? AND session_id=? AND covered=0').run(history.assistant_id, history.session_id); }
      db.prepare('INSERT INTO assistant_message_backfill(assistant_id,session_id,cursor,complete,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(assistant_id,session_id) DO UPDATE SET cursor=excluded.cursor,complete=excluded.complete,updated_at=excluded.updated_at').run(history.assistant_id, history.session_id, nextCursor, complete ? 1 : 0, now());
      db.exec('COMMIT');
      return complete;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const decodeCursor = (value) => { if (value == null || value === '') return null; try { const parsed = parse(Buffer.from(String(value), 'base64url').toString('utf8')); return Number.isSafeInteger(parsed?.sessionOrdinal) && Number.isSafeInteger(parsed?.messageOrdinal) && nonEmptyString(parsed?.messageID) && (parsed.scanSessionOrdinal == null || Number.isSafeInteger(parsed.scanSessionOrdinal)) ? parsed : fail('validation_error'); } catch (error) { if (error instanceof AssistantError) throw error; fail('validation_error'); } };
  const encodeCursor = (row, scanSessionOrdinal = row.session_ordinal) => Buffer.from(json({ sessionOrdinal: row.session_ordinal, messageOrdinal: row.message_ordinal, messageID: row.message_id, scanSessionOrdinal })).toString('base64url');
  const historicalMessages = async (assistantID, input = {}) => {
    const row = editable(assistantID); const limit = input.limit == null ? 50 : Number(input.limit); if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('validation_error'); const before = decodeCursor(input.before);
    const pageRows = () => db.prepare(`SELECT h.ordinal AS session_ordinal,h.directory,m.ordinal AS message_ordinal,m.message_id,m.info_json,m.session_id FROM assistant_session_history h JOIN assistant_message_mirror m ON m.assistant_id=h.assistant_id AND m.session_id=h.session_id WHERE h.assistant_id=? AND m.covered=1 AND (? IS NULL OR h.ordinal<? OR (h.ordinal=? AND (m.ordinal<? OR (m.ordinal=? AND m.message_id<?)))) ORDER BY h.ordinal DESC,m.ordinal DESC,m.message_id DESC LIMIT ?`).all(row.assistant_id, before?.sessionOrdinal ?? null, before?.sessionOrdinal ?? 0, before?.sessionOrdinal ?? 0, before?.messageOrdinal ?? 0, before?.messageOrdinal ?? 0, before?.messageID ?? '', limit + 1);
    const nextIncomplete = (boundary = before?.scanSessionOrdinal ?? before?.sessionOrdinal ?? null) => db.prepare(`SELECT h.* FROM assistant_session_history h LEFT JOIN assistant_message_backfill b ON b.assistant_id=h.assistant_id AND b.session_id=h.session_id WHERE h.assistant_id=? AND (b.complete IS NULL OR b.complete=0) AND (? IS NULL OR h.ordinal<=?) ORDER BY h.ordinal DESC LIMIT 1`).get(row.assistant_id, boundary, boundary ?? 0);
    let rows = pageRows();
    for (let page = 0; rows.length < limit + 1 && page < BACKFILL_MAX_PAGES; page++) {
      const target = nextIncomplete();
      if (!target) break;
      await backfillSession(target);
      rows = pageRows();
    }
    const page = rows.slice(0, limit); const oldest = page[page.length - 1]; const remaining = nextIncomplete(oldest?.session_ordinal ?? before?.scanSessionOrdinal ?? before?.sessionOrdinal ?? null); const nextCursor = oldest ? (rows.length > limit || remaining ? encodeCursor(oldest, oldest.session_ordinal) : null) : remaining ? encodeCursor({ session_ordinal: remaining.ordinal, message_ordinal: Number.MAX_SAFE_INTEGER, message_id: '\uffff' }, remaining.ordinal) : null;
    const ordered = [...page].reverse().map((message) => ({ sessionID: message.session_id, directory: message.directory, info: parse(message.info_json), parts: db.prepare('SELECT part_json FROM assistant_message_part_mirror WHERE assistant_id=? AND session_id=? AND message_id=? ORDER BY ordinal ASC,part_id ASC').all(row.assistant_id, message.session_id, message.message_id).map((part) => parse(part.part_json)) }));
    return { entries: ordered, nextCursor, complete: nextCursor === null };
  };
  for (const current of db.prepare('SELECT * FROM assistant_v2 WHERE current_session_id IS NOT NULL AND tombstone_at IS NULL').all()) void backfillSession({ assistant_id: current.assistant_id, session_id: current.current_session_id, directory: effectiveWorkspace(current) }).catch(() => {});
  const unsubscribeEvents = typeof globalEventHub?.subscribeEvent === 'function' ? globalEventHub.subscribeEvent(processEvent) : null;
  const createAssistant = (input) => { const allowed = new Set(['enabled', 'name', 'defaultPrompt', 'providerID', 'modelID', 'agent', 'variant', 'mode', 'workspacePath']); if (!plainObject(input) || Object.keys(input).some((key) => !allowed.has(key))) fail('validation_error'); const mode = input.mode == null ? 'continuous' : input.mode === 'stateless' || input.mode === 'continuous' ? input.mode : fail('validation_error'); const assistantID = id(); const workspacePath = input.workspacePath == null ? null : workspace(input.workspacePath, assistantID); effectiveWorkspace({ assistant_id: assistantID, workspace_path: workspacePath }); const at = now(); db.exec('BEGIN IMMEDIATE'); try { if (Number(db.prepare('SELECT COUNT(*) AS count FROM assistant_v2 WHERE tombstone_at IS NULL').get().count) >= 100) fail('assistant_limit'); db.prepare('INSERT INTO assistant_v2 (assistant_id,revision,enabled,name,default_prompt,workspace_path,provider_id,model_id,agent,variant,mode,current_session_id,session_generation,created_at,updated_at,tombstone_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(assistantID, 1, input.enabled === false ? 0 : 1, string(input.name, 256, true), input.defaultPrompt ? string(input.defaultPrompt, 200_000) : '', workspacePath, string(input.providerID, 256, true), string(input.modelID, 256, true), input.agent == null ? null : string(input.agent, 256), input.variant == null ? null : string(input.variant, 256), mode, null, 0, at, at, null); bump(); db.exec('COMMIT'); return output(assistant(assistantID)); } catch (error) { db.exec('ROLLBACK'); throw error; } };
  const updateAssistant = async (assistantID, input) => { const row = editable(assistantID); const allowed = new Set(['expectedRevision', 'enabled', 'name', 'defaultPrompt', 'providerID', 'modelID', 'agent', 'variant', 'mode', 'workspacePath']); if (!plainObject(input) || !Number.isInteger(input.expectedRevision) || Object.keys(input).some((key) => !allowed.has(key))) fail('validation_error'); const next = { enabled: input.enabled === undefined ? row.enabled : input.enabled ? 1 : 0, name: input.name === undefined ? row.name : string(input.name, 256, true), prompt: input.defaultPrompt === undefined ? row.default_prompt : string(input.defaultPrompt, 200_000), provider: input.providerID === undefined ? row.provider_id : string(input.providerID, 256, true), model: input.modelID === undefined ? row.model_id : string(input.modelID, 256, true), agent: input.agent === undefined ? row.agent : input.agent === null ? null : string(input.agent, 256), variant: input.variant === undefined ? row.variant : input.variant === null ? null : string(input.variant, 256), mode: input.mode === undefined ? (row.mode === 'stateless' ? 'stateless' : 'continuous') : input.mode === 'continuous' || input.mode === 'stateless' ? input.mode : fail('validation_error'), workspacePath: input.workspacePath === undefined ? row.workspace_path : input.workspacePath == null ? null : workspace(input.workspacePath, assistantID) }; const nextRow = { ...row, workspace_path: next.workspacePath, name: next.name }; effectiveWorkspace(nextRow); const workspaceChanged = next.workspacePath !== row.workspace_path; if (workspaceChanged && row.current_session_id) archiveSession(assistantID, row.current_session_id); const created = workspaceChanged ? await createSession(nextRow) : null; const result = db.prepare('UPDATE assistant_v2 SET enabled=?,name=?,default_prompt=?,provider_id=?,model_id=?,agent=?,variant=?,mode=?,workspace_path=?,current_session_id=?,session_generation=session_generation+?,revision=revision+1,updated_at=? WHERE assistant_id=? AND revision=? AND session_generation=? AND tombstone_at IS NULL').run(next.enabled, next.name, next.prompt, next.provider, next.model, next.agent, next.variant, next.mode, next.workspacePath, created?.sessionID ?? row.current_session_id, workspaceChanged ? 1 : 0, now(), assistantID, input.expectedRevision, row.session_generation); if (!result.changes) fail('revision_conflict'); bump(); return output(assistant(assistantID)); };
  const compact = async (assistantID, input) => { const row = active(assistantID); if (!plainObject(input) || input.sessionID !== row.current_session_id || input.sessionGeneration !== row.session_generation || !row.current_session_id) fail('revision_conflict'); let target = row; let result = await client().session.summarize({ sessionID: target.current_session_id, directory: effectiveWorkspace(target), providerID: target.provider_id, modelID: target.model_id }); if (isMissing(result)) { await restoreOnce(row, row.current_session_id, row.session_generation); target = active(assistantID); result = await client().session.summarize({ sessionID: target.current_session_id, directory: effectiveWorkspace(target), providerID: target.provider_id, modelID: target.model_id }); } if (result.error || result.data !== true) fail('upstream_error'); return { binding: binding(active(assistantID)), summarized: true }; };
  const sendWithConfig = async ({ row, sessionID, directory, config, parts, messageID, restore }) => {
    const sendPrompt = (targetSessionID, targetDirectory, targetConfig) => client().session.promptAsync({ sessionID: targetSessionID, directory: targetDirectory, ...targetConfig, parts, messageID });
    let result = await sendPrompt(sessionID, directory, config);
    if (isMissing(result) && restore) {
      const restored = await restoreOnce(row, sessionID, row.session_generation);
      const target = active(row.assistant_id);
      result = await sendPrompt(restored.sessionID, restored.directory, configuration(target));
      return { result, binding: restored };
    }
    return { result, binding: binding(row) };
  };
  const send = async (assistantID, input) => { if (!plainObject(input)) fail('validation_error'); validateParts(input.parts); const messageID = string(input.messageID, 256, true); const row = active(assistantID); if (input.sessionID !== row.current_session_id || input.sessionGeneration !== row.session_generation) fail('revision_conflict'); const target = await prepareExecutionBinding(row); const sent = await sendWithConfig({ row: target, sessionID: target.current_session_id, directory: effectiveWorkspace(target), config: configuration(target), parts: input.parts, messageID, restore: target.mode !== 'stateless' }); if (!promptAdmitted(sent.result)) fail('upstream_error'); return { binding: sent.binding, messageID, admitted: true }; };
  const captureQueueDeliveryTarget = ({ assistantID, scope }) => {
    const row = active(assistantID); const current = binding(row);
    if (scope.sessionID !== current.sessionID || scope.directory !== current.directory) fail('revision_conflict');
    return { kind: 'assistant', assistantID, binding: current, sessionID: current.sessionID, sessionGeneration: current.sessionGeneration, directory: current.directory, providerID: row.provider_id, modelID: row.model_id, agent: row.agent, variant: row.variant, mode: row.mode === 'stateless' ? 'stateless' : 'continuous', defaultPrompt: row.default_prompt, system: row.default_prompt };
  };
  const sendWithCapturedConfig = async ({ deliveryTarget, messageID, parts }) => {
    const capturedBinding = deliveryTarget?.binding ?? { sessionID: deliveryTarget?.sessionID, sessionGeneration: deliveryTarget?.sessionGeneration, directory: deliveryTarget?.directory };
    const mode = deliveryTarget?.mode === 'stateless' ? 'stateless' : deliveryTarget?.mode === 'continuous' || deliveryTarget?.mode == null ? 'continuous' : fail('validation_error');
    if (!plainObject(deliveryTarget) || deliveryTarget.kind !== 'assistant' || !nonEmptyString(deliveryTarget.assistantID) || !nonEmptyString(capturedBinding.sessionID) || !Number.isSafeInteger(capturedBinding.sessionGeneration) || !nonEmptyString(capturedBinding.directory) || !nonEmptyString(deliveryTarget.providerID) || !nonEmptyString(deliveryTarget.modelID) || (deliveryTarget.agent != null && !nonEmptyString(deliveryTarget.agent)) || (deliveryTarget.variant != null && !nonEmptyString(deliveryTarget.variant)) || (deliveryTarget.defaultPrompt != null && typeof deliveryTarget.defaultPrompt !== 'string') || (deliveryTarget.system != null && typeof deliveryTarget.system !== 'string')) fail('validation_error');
    validateParts(parts); const row = active(deliveryTarget.assistantID); const current = binding(row);
    if (current.sessionID !== capturedBinding.sessionID || current.sessionGeneration !== capturedBinding.sessionGeneration || current.directory !== capturedBinding.directory) fail('stale_target');
    const target = mode === 'stateless' ? await prepareExecutionBinding(row) : row;
    const sent = await sendWithConfig({ row: target, sessionID: target.current_session_id, directory: effectiveWorkspace(target), config: capturedConfiguration(deliveryTarget), parts, messageID, restore: false });
    if (!promptAdmitted(sent.result)) return { ok: false, status: sent.result?.status ?? sent.result?.response?.status, code: 'upstream_error' };
    return { ok: true, accepted: true, binding: binding(target), messageID };
  };
  const abort = async (assistantID, input) => { const row = active(assistantID); if (!plainObject(input) || input.sessionID !== row.current_session_id || input.sessionGeneration !== row.session_generation || !row.current_session_id) fail('revision_conflict'); const result = await client().session.abort({ sessionID: row.current_session_id, directory: effectiveWorkspace(row) }); if (isMissing(result)) fail('not_found'); if (result.error) fail('upstream_error'); return { binding: binding(row), aborted: true }; };
  const createNew = async (assistantID) => { for (let attempt = 0; attempt < 3; attempt++) { const row = active(assistantID); const created = await createSession(row); const won = replaceBinding(row, created); if (won) return binding(won); } return binding(active(assistantID)); };
  const shareOperation = (operationID) => { const row = db.prepare('SELECT * FROM assistant_share_operation WHERE operation_id=?').get(operationID); return row && { operationID: row.operation_id, assistantID: row.assistant_id, sessionID: row.session_id, messageID: row.message_id, state: row.state, phase: row.phase, attempt: row.attempt, leaseExpiresAt: row.lease_expires_at, errorCode: row.error_code }; };
  const claim = (operationID, retry = false) => { db.exec('BEGIN IMMEDIATE'); try { const operation = db.prepare('SELECT * FROM assistant_share_operation WHERE operation_id=?').get(operationID); if (!operation) { db.exec('COMMIT'); return null; } const at = now(); const eligible = operation.state === 'failed' ? retry : operation.state === 'running' && operation.lease_expires_at <= at && operation.phase === 'admitted'; if (!eligible || operation.attempt >= SHARE_MAX_ATTEMPTS) { db.exec('COMMIT'); return null; } const result = db.prepare("UPDATE assistant_share_operation SET state='running',phase='submitting',attempt=attempt+1,lease_expires_at=?,error_code=NULL,updated_at=? WHERE operation_id=? AND state=? AND phase=? AND attempt<? AND (state='failed' OR lease_expires_at<=?)").run(at + SHARE_LEASE_MS, at, operationID, operation.state, operation.phase, SHARE_MAX_ATTEMPTS, at); const claimed = result.changes ? db.prepare('SELECT * FROM assistant_share_operation WHERE operation_id=?').get(operationID) : null; db.exec('COMMIT'); return claimed; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  const completeOrFail = (operation, errorCode = null) => { const at = now(); if (errorCode) db.prepare("UPDATE assistant_share_operation SET state='failed',phase='admitted',error_code=?,lease_expires_at=NULL,updated_at=? WHERE operation_id=? AND state='running' AND phase='submitting'").run(errorCode, at, operation.operation_id); else db.prepare("UPDATE assistant_share_operation SET state='running',phase='submitted',error_code=NULL,lease_expires_at=?,updated_at=? WHERE operation_id=? AND state='running' AND phase='submitting'").run(at + SHARE_LEASE_MS, at, operation.operation_id); };
  const submitClaim = async (operation) => { const payload = parse(operation.response); const row = active(operation.assistant_id); try { const result = await client().session.promptAsync({ sessionID: operation.session_id, directory: effectiveWorkspace(row), ...configuration(row), parts: payload.parts, messageID: operation.message_id }); if (!promptAdmitted(result)) fail('upstream_error'); completeOrFail(operation); } catch (error) { completeOrFail(operation, error instanceof AssistantError ? error.code : 'upstream_error'); } };
  const reconcile = async () => { const candidates = db.prepare("SELECT * FROM assistant_share_operation WHERE state='running'").all(); for (const operation of candidates) { const row = assistant(operation.assistant_id); if (!row || !operation.session_id || !operation.message_id) continue; try { const result = await client().session.messages({ sessionID: operation.session_id, directory: effectiveWorkspace(row), limit: 100 }); const messages = result.data ?? []; const found = Array.isArray(messages) && messages.some((message) => message?.info?.id === operation.message_id || message?.id === operation.message_id); if (found) db.prepare("UPDATE assistant_share_operation SET state='completed',phase='submitted',lease_expires_at=NULL,updated_at=? WHERE operation_id=? AND state='running'").run(now(), operation.operation_id); else if (operation.phase === 'admitted' && operation.lease_expires_at <= now() && operation.attempt >= SHARE_MAX_ATTEMPTS) db.prepare("UPDATE assistant_share_operation SET state='failed',lease_expires_at=NULL,error_code='attempt_limit',updated_at=? WHERE operation_id=? AND state='running' AND phase='admitted'").run(now(), operation.operation_id); else if (operation.phase === 'admitted' && operation.lease_expires_at <= now()) { const claimed = claim(operation.operation_id); if (claimed) void submitClaim(claimed); } else if (operation.phase === 'submitted' && operation.lease_expires_at <= now()) db.prepare("UPDATE assistant_share_operation SET state='unresolved',lease_expires_at=NULL,error_code='message_unresolved',updated_at=? WHERE operation_id=? AND state='running' AND phase='submitted'").run(now(), operation.operation_id); } catch { /* Reconciliation remains retryable until its lease expires. */ } } };
  const share = async (assistantID, input) => { if (!plainObject(input) || !plainObject(input.payload)) fail('validation_error'); validateParts(input.payload.parts); const operationID = string(input.operationID, 128, true); const messageID = string(input.payload.messageID, 256, true); const payloadHash = hash(input.payload); active(assistantID); const at = now(); let operation; let reservationOwner = false; db.exec('BEGIN IMMEDIATE'); try { const inserted = db.prepare('INSERT OR IGNORE INTO assistant_share_operation(operation_id,assistant_id,payload_hash,phase,session_id,message_id,state,response,error_code,attempt,lease_expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(operationID, assistantID, payloadHash, 'reserving', null, messageID, 'running', json(input.payload), null, 0, null, at, at); operation = db.prepare('SELECT * FROM assistant_share_operation WHERE operation_id=?').get(operationID); if (operation.assistant_id !== assistantID || operation.payload_hash !== payloadHash) fail('idempotency_conflict'); reservationOwner = inserted.changes === 1; db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
    let resolveReservation; if (reservationOwner) shareReservations.set(operationID, new Promise((resolve) => { resolveReservation = resolve; })); else await shareReservations.get(operationID);
    if (reservationOwner) {
      try { const row = active(assistantID); const target = row.mode === 'stateless' ? await createNew(assistantID) : await ensure(assistantID); const attachedAt = now(); const attached = db.prepare("UPDATE assistant_share_operation SET phase='admitted',session_id=?,message_id=?,lease_expires_at=?,updated_at=? WHERE operation_id=? AND state='running' AND phase='reserving'").run(target.sessionID, messageID, attachedAt, attachedAt, operationID); if (!attached.changes) fail('upstream_error'); } catch (error) { db.prepare("DELETE FROM assistant_share_operation WHERE operation_id=? AND state='running' AND phase='reserving'").run(operationID); throw error; } finally { shareReservations.delete(operationID); resolveReservation(); }
    }
    operation = db.prepare('SELECT * FROM assistant_share_operation WHERE operation_id=?').get(operationID); if (operation?.phase !== 'reserving') { const claimed = claim(operationID, operation?.state === 'failed'); if (claimed) await submitClaim(claimed); } return shareOperation(operationID); };
  const timer = setIntervalFn(() => { if (!closed) { db.prepare('DELETE FROM assistant_share_operation WHERE updated_at<?').run(now() - SHARE_RETENTION_MS); void reconcile(); } }, reconcileIntervalMs);
  void reconcile();
  return { capability: async () => ({ supported: true, enabled: enabled(), revision: revision(), serverInstanceID: await getServerId() }), snapshot: () => ({ revision: revision(), enabled: enabled(), assistants: db.prepare('SELECT * FROM assistant_v2 WHERE tombstone_at IS NULL ORDER BY created_at').all().map(output) }), createAssistant, updateAssistant, setEnabled: (input) => { if (!plainObject(input) || typeof input.enabled !== 'boolean' || input.expectedRevision !== revision()) fail('revision_conflict'); db.prepare("UPDATE assistant_meta SET value=? WHERE key='enabled'").run(input.enabled ? '1' : '0'); return { enabled: input.enabled, revision: bump() }; }, removeAssistant: (assistantID, expectedRevision) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = db.prepare('UPDATE assistant_v2 SET tombstone_at=?,revision=revision+1,updated_at=? WHERE assistant_id=? AND revision=? AND tombstone_at IS NULL').run(now(), now(), assistantID, expectedRevision);
      if (!result.changes) fail('revision_conflict');
      db.prepare('DELETE FROM assistant_session_history WHERE assistant_id=?').run(assistantID);
      db.prepare('DELETE FROM assistant_message_part_mirror WHERE assistant_id=?').run(assistantID);
      db.prepare('DELETE FROM assistant_message_mirror WHERE assistant_id=?').run(assistantID);
      db.prepare('DELETE FROM assistant_message_backfill WHERE assistant_id=?').run(assistantID);
      bump();
      db.exec('COMMIT');
      return { assistantID, tombstoneAt: now() };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }, ensure, createNew, compact, send, abort, captureQueueDeliveryTarget, sendWithCapturedConfig, share, shareOperation, historicalMessages, processEvent, close: () => { if (!closed) { closed = true; unsubscribeEvents?.(); clearIntervalFn(timer); db.close(); } } };
};
