import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { OpenCode } from '@opencode-ai/client';
import { validAssistantDeliveryParts } from '../assistant-delivery-parts.js';

const require = createRequire(import.meta.url);
const SCHEMA_VERSION = 11;
const BACKFILL_PAGE_SIZE = 100;
const BACKFILL_MAX_PAGES = 3;
const BACKFILL_MESSAGES_ATTEMPTS = 3;
const BACKFILL_RETRY_MS = Object.freeze([25, 75]);
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
const messagesErrorStatus = (result) => { const status = result?.error?.status ?? result?.error?.statusCode ?? result?.status; return Number.isFinite(status) ? status : null; };
const getHttpStatus = (error) => {
  const candidates = [error?.cause?.status, error?.status, error?.response?.status];
  for (const value of candidates) { if (Number.isFinite(value)) return value; }
  return undefined;
};
const isMissingError = (error) => getHttpStatus(error) === 404 || isMissing(error);
const isTransientMessagesFailure = (result, error) => {
  if (error) {
    if (error instanceof AssistantError) return false;
    if (error?.reason === 'Transport' || error?.name === 'TypeError' || error?.name === 'FetchError' || error?.name === 'AbortError') return true;
    const code = error?.cause?.code || error?.code;
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EPIPE') return true;
    const status = getHttpStatus(error);
    if (status == null) return false;
    return status === 408 || status === 429 || status >= 500;
  }
  const status = messagesErrorStatus(result);
  if (status == null) return true;
  return status === 408 || status === 429 || status >= 500;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sessionRecord = (value) => (value && typeof value === 'object' && value.data && value.id == null ? value.data : value);
const sessionIDOf = (value) => sessionRecord(value)?.id ?? null;
const sessionDirectoryOf = (value) => {
  const session = sessionRecord(value);
  return session?.location?.directory ?? session?.directory ?? session?.project?.worktree ?? null;
};
const toV2PromptInput = (sessionID, parts, messageID) => {
  const text = (parts || []).filter((part) => part?.type === 'text').map((part) => part.text).join('\n');
  const files = (parts || []).filter((part) => part?.type === 'file').map((part) => ({ uri: part.url, ...(part.filename ? { name: part.filename } : {}) }));
  const agents = (parts || []).filter((part) => part?.type === 'agent').map((part) => ({ name: part.name }));
  return { sessionID, id: messageID, text, ...(files.length ? { files } : {}), ...(agents.length ? { agents } : {}), delivery: 'steer' };
};
const projectV2Parts = (entry, sessionID) => {
  if (Array.isArray(entry?.parts)) return entry.parts;
  const messageID = entry?.id;
  const parts = [];
  if (typeof entry?.text === 'string' && entry.text) parts.push({ id: `${messageID}:text`, sessionID, messageID, type: 'text', text: entry.text });
  if (Array.isArray(entry?.files)) entry.files.forEach((file, index) => parts.push({ id: `${messageID}:file:${index}`, sessionID, messageID, type: 'file', mime: file?.mime || 'application/octet-stream', url: file?.uri ?? file?.url, ...(file?.name ? { filename: file.name } : {}) }));
  if (Array.isArray(entry?.content)) entry.content.forEach((item, index) => {
    const partID = item?.id || `${messageID}:content:${index}`;
    if (item?.type === 'text') parts.push({ id: partID, sessionID, messageID, type: 'text', text: item.text ?? '' });
    else if (item?.type === 'reasoning') parts.push({ id: partID, sessionID, messageID, type: 'reasoning', text: item.text ?? '' });
    else if (item?.type === 'tool') parts.push({ id: partID, sessionID, messageID, type: 'tool', tool: item.name, callID: item.id, state: item.state ?? {} });
  });
  return parts;
};
const projectProjectionEntry = (entry, sessionID) => {
  if (plainObject(entry?.info)) return { info: entry.info, parts: Array.isArray(entry.parts) ? entry.parts : [] };
  if (!plainObject(entry) || !nonEmptyString(entry.id)) return { info: entry, parts: [] };
  const role = entry.type === 'user' || entry.type === 'assistant' ? entry.type : (entry.role ?? entry.type);
  return { info: { id: entry.id, sessionID: nonEmptyString(entry.sessionID) ? entry.sessionID : sessionID, role, time: entry.time ?? { created: 0 }, ...entry }, parts: projectV2Parts(entry, nonEmptyString(entry.sessionID) ? entry.sessionID : sessionID) };
};
const projectionEntries = (payload, sessionID) => {
  const items = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : Array.isArray(payload?.data?.items) ? payload.data.items : null;
  if (!items) return null;
  return items.map((entry) => projectProjectionEntry(entry, sessionID));
};
const projectionCursor = (result) => { const next = typeof result?.cursor === 'string' ? result.cursor : result?.cursor?.next; return (typeof next === 'string' && next) ? next : (result?.response?.headers?.get?.('x-next-cursor') ?? null); };
const promptAdmitted = (result) => !result?.error && (result?.response?.status === 204 || result?.status === 204 || result?.id != null || result?.type != null || result?.data !== undefined || result?.response?.ok === true);
const invokeSession = async (work) => {
  try {
    const value = await work();
    if (isMissing(value)) return { error: { status: 404 }, status: 404 };
    if (value?.error) return value;
    return value;
  } catch (error) {
    if (error instanceof AssistantError) throw error;
    if (isMissingError(error)) return { error: { status: 404 }, status: 404 };
    const status = getHttpStatus(error);
    if (status != null) return { error: { status }, status };
    return { error: { status: 500 }, status: 500 };
  }
};

export const createAssistantsService = ({ dbPath, dataDir, buildOpenCodeUrl, getOpenCodeAuthHeaders, getServerId = async () => null, getAllowedRoots = () => [], globalEventHub = null, onRevisionTip = null, clock = () => Date.now(), setIntervalFn = setInterval, clearIntervalFn = clearInterval, reconcileIntervalMs = 60_000, clientFactory, fetchImpl } = {}) => {
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
  const bump = () => {
    const value = revision() + 1;
    db.prepare("UPDATE assistant_meta SET value=? WHERE key='revision'").run(String(value));
    if (typeof onRevisionTip === 'function') queueMicrotask(() => { if (!closed) onRevisionTip({ revision: value, occurredAt: now() }); });
    return value;
  };
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
      db.prepare("UPDATE assistant_message_mirror SET covered=0 WHERE assistant_id=? AND session_id=? AND COALESCE(json_extract(info_json,'$.role'),'')<>'user' AND COALESCE(json_extract(info_json,'$.openchamberAssistantAdmission'),0)<>1").run(assistantID, sessionID);
      return;
    }
    const effectiveDirectory = directory ?? effectiveWorkspace(editable(assistantID));
    const ordinal = Number(db.prepare('SELECT COALESCE(MAX(ordinal), 0) + 1 AS next FROM assistant_session_history WHERE assistant_id=?').get(assistantID).next);
    db.prepare('INSERT INTO assistant_session_history(assistant_id, session_id, ordinal, directory, created_at) VALUES (?,?,?,?,?)').run(assistantID, sessionID, ordinal, effectiveDirectory, now());
    db.prepare('DELETE FROM assistant_message_backfill WHERE assistant_id=? AND session_id=?').run(assistantID, sessionID);
    db.prepare("UPDATE assistant_message_mirror SET covered=0 WHERE assistant_id=? AND session_id=? AND COALESCE(json_extract(info_json,'$.role'),'')<>'user' AND COALESCE(json_extract(info_json,'$.openchamberAssistantAdmission'),0)<>1").run(assistantID, sessionID);
  };
  const output = (row) => ({ id: row.assistant_id, revision: row.revision, enabled: Boolean(row.enabled), name: row.name, defaultPrompt: row.default_prompt, workspacePath: row.workspace_path, managedWorkspacePath: workspace(null, row.assistant_id, true), effectiveWorkspacePath: effectiveWorkspace(row), providerID: row.provider_id, modelID: row.model_id, agent: row.agent, variant: row.variant, mode: row.mode === 'stateless' ? 'stateless' : 'continuous', sessionID: row.current_session_id, sessionGeneration: row.session_generation, historySessionIDs: historyIDs(row.assistant_id), historySessionCount: historyCount(row.assistant_id), createdAt: row.created_at, updatedAt: row.updated_at, tombstoneAt: row.tombstone_at });
  const binding = (row) => ({ sessionID: row.current_session_id, directory: effectiveWorkspace(row), sessionGeneration: row.session_generation });
  const client = () => clientFactory ? clientFactory() : OpenCode.make({ baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''), headers: getOpenCodeAuthHeaders() });
  const metadata = (row) => ({ openchamber: { assistant: { assistantID: row.assistant_id, name: row.name } } });
  const ARCHIVE_RETRY_MS = 25;
  const createSession = async (row) => {
    const directory = effectiveWorkspace(row);
    const result = await invokeSession(() => client().session.create({
      title: `[Assistant] ${row.name}`,
      location: { directory },
      ...(row.agent ? { agent: row.agent } : {}),
      ...(row.provider_id && row.model_id ? { model: { id: row.model_id, providerID: row.provider_id, ...(row.variant ? { variant: row.variant } : {}) } } : {}),
    }));
    const sessionID = sessionIDOf(result);
    if (result?.error || !sessionID) fail('upstream_error');
    // Archive before binding so ordinary session lists never flash system sessions.
    // Metadata still isolates the session if archive fails after create.
    // v2 has no session.update archive-metadata write; local history + title prefix are the equivalent isolation.
    return { sessionID, directory };
  };
  const sessionExists = async (row) => { if (!row.current_session_id) return false; const result = await invokeSession(() => client().session.get({ sessionID: row.current_session_id })); if (isMissing(result)) return false; if (result.error) fail('upstream_error'); return Boolean(sessionIDOf(result) || result); };
  const replaceBinding = (row, created) => { if (row.current_session_id && row.current_session_id !== created.sessionID) archiveSession(row.assistant_id, row.current_session_id, effectiveWorkspace(row)); const result = db.prepare('UPDATE assistant_v2 SET current_session_id=?,session_generation=session_generation+1,updated_at=? WHERE assistant_id=? AND session_generation=? AND tombstone_at IS NULL').run(created.sessionID, now(), row.assistant_id, row.session_generation); if (result.changes) bump(); return result.changes ? assistant(row.assistant_id) : null; };
  const statelessLanes = new Map();
  const inStatelessLane = (assistantID, task) => {
    const previous = statelessLanes.get(assistantID) ?? Promise.resolve();
    let tail;
    const run = previous.catch(() => {}).then(task);
    tail = run.catch(() => {}).finally(() => { if (statelessLanes.get(assistantID) === tail) statelessLanes.delete(assistantID); });
    statelessLanes.set(assistantID, tail);
    return run;
  };
  const createStatelessExecutionBinding = async (assistantID) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = active(assistantID); const created = await createSession(current); const won = replaceBinding(current, created);
      if (won) return won;
    }
    fail('revision_conflict');
  };
  const prepareExecutionBinding = async (row) => row.mode === 'stateless' ? createStatelessExecutionBinding(row.assistant_id) : row;
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
  const mirrorAdmittedUserMessage = (row, sessionID, messageID, parts, config) => {
    const existingMessage = db.prepare('SELECT info_json FROM assistant_message_mirror WHERE assistant_id=? AND session_id=? AND message_id=?').get(row.assistant_id, sessionID, messageID);
    const existingInfo = existingMessage ? parse(existingMessage.info_json) : null;
    const info = plainObject(existingInfo) && existingInfo.role === 'user'
      ? existingInfo
      : {
          id: messageID,
          sessionID,
          role: 'user',
          time: { created: now() },
          ...(config?.agent ? { agent: config.agent } : {}),
          ...(plainObject(config?.model) ? { model: config.model } : {}),
          ...(typeof config?.system === 'string' && config.system ? { system: config.system } : {}),
          summary: { diffs: [] },
          openchamberAssistantAdmission: true,
        };
    db.exec('BEGIN IMMEDIATE');
    try {
      mirrorMessage(row.assistant_id, sessionID, info, undefined, true);
      const hasAuthoritativeParts = Number(db.prepare("SELECT COUNT(*) AS count FROM assistant_message_part_mirror WHERE assistant_id=? AND session_id=? AND message_id=? AND part_id NOT GLOB 'oc_asst_admission:*'").get(row.assistant_id, sessionID, messageID).count) > 0;
      if (!hasAuthoritativeParts) {
        db.prepare("DELETE FROM assistant_message_part_mirror WHERE assistant_id=? AND session_id=? AND message_id=? AND part_id GLOB 'oc_asst_admission:*'").run(row.assistant_id, sessionID, messageID);
        parts.forEach((part, index) => mirrorPart(row.assistant_id, sessionID, {
          ...part,
          id: `oc_asst_admission:${index + 1}`,
          sessionID,
          messageID,
        }, index + 1));
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    bump();
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
      // Ticket 11: live display reads OpenCode projections; do not write assistant body mirrors.
      return mappedAssistants(sessionID).length > 0;
    }
    if (payload.type === 'message.part.updated') {
      const part = properties.part; const sessionID = properties.sessionID ?? part?.sessionID;
      if (!nonEmptyString(sessionID) || !plainObject(part)) return false;
      // Ticket 11: live parts stay on the OpenCode session; old mirrors do not participate.
      return mappedAssistants(sessionID).length > 0;
    }
    if (payload.type === 'message.removed') {
      const sessionID = properties.sessionID; const messageID = properties.messageID;
      if (!nonEmptyString(sessionID) || !nonEmptyString(messageID)) return false;
      const assistants = mappedAssistants(sessionID); for (const assistantID of assistants) { db.prepare('DELETE FROM assistant_message_part_mirror WHERE assistant_id=? AND session_id=? AND message_id=?').run(assistantID, sessionID, messageID); db.prepare('DELETE FROM assistant_message_mirror WHERE assistant_id=? AND session_id=? AND message_id=?').run(assistantID, sessionID, messageID); } return assistants.length > 0;
    }
    if (payload.type === 'message.part.removed') {
      const sessionID = properties.sessionID; const messageID = properties.messageID ?? properties.part?.messageID; const partID = properties.partID ?? properties.part?.id;
      if (!nonEmptyString(sessionID) || !nonEmptyString(messageID) || !nonEmptyString(partID)) return false;
      const assistants = mappedAssistants(sessionID); for (const assistantID of assistants) { db.prepare('DELETE FROM assistant_message_part_mirror WHERE assistant_id=? AND session_id=? AND message_id=? AND part_id=?').run(assistantID, sessionID, messageID, partID); if (assistant(assistantID)?.current_session_id !== sessionID) invalidateMessageCoverage(assistantID, sessionID, messageID); } return assistants.length > 0;
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
  const clearUncoveredSessionMirror = (assistantID, sessionID) => {
    db.prepare('DELETE FROM assistant_message_part_mirror WHERE assistant_id=? AND session_id=? AND message_id IN (SELECT message_id FROM assistant_message_mirror WHERE assistant_id=? AND session_id=? AND covered=0)').run(assistantID, sessionID, assistantID, sessionID);
    db.prepare('DELETE FROM assistant_message_mirror WHERE assistant_id=? AND session_id=? AND covered=0').run(assistantID, sessionID);
  };
  const markSessionBackfillComplete = (assistantID, sessionID) => {
    db.prepare('INSERT INTO assistant_message_backfill(assistant_id,session_id,cursor,complete,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(assistant_id,session_id) DO UPDATE SET cursor=excluded.cursor,complete=excluded.complete,updated_at=excluded.updated_at').run(assistantID, sessionID, null, 1, now());
  };
  // Authoritative 404 means this session ID is gone from OpenCode. Converge its
  // backfill so one deleted archive cannot block demand scans of other sessions.
  // Covered/admitted rows stay; only uncovered event mirrors are dropped. Safe
  // under concurrent ensure: a replaced current binding archives under its old
  // ID, while a still-current missing ID is recreated with a new session ID.
  const completeMissingSessionBackfill = (assistantID, sessionID) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      clearUncoveredSessionMirror(assistantID, sessionID);
      markSessionBackfillComplete(assistantID, sessionID);
      db.exec('COMMIT');
      return true;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const fetchProjectionViaHttp = async (history, directory, cursor, limit) => {
    if (typeof fetchImpl !== 'function') return null;
    const base = String(buildOpenCodeUrl('/', '') || '').replace(/\/$/, '');
    if (!base) return null;
    const url = new URL(`${base}/session/${encodeURIComponent(history.session_id)}/message`);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('order', 'desc');
    if (directory) url.searchParams.set('directory', directory);
    if (cursor) url.searchParams.set('cursor', cursor);
    const response = await fetchImpl(url, { headers: getOpenCodeAuthHeaders() || {} });
    const status = response?.status;
    if (status === 404) return { error: { status: 404 }, status: 404 };
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    if (!response.ok) return { error: { status }, status, data: payload };
    const data = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : payload?.data?.items;
    return { data, response, status };
  };
  const fetchBackfillMessages = async (history, directory, cursor, limit = BACKFILL_PAGE_SIZE) => {
    for (let attempt = 0; attempt < BACKFILL_MESSAGES_ATTEMPTS; attempt++) {
      try {
        const http = await fetchProjectionViaHttp(history, directory, cursor, limit);
        const result = http ?? await invokeSession(() => client().message.list({ sessionID: history.session_id, limit, order: 'desc', ...(cursor ? { cursor } : {}) }));
        if (!result?.error || isMissing(result)) return result;
        if (!isTransientMessagesFailure(result, null) || attempt === BACKFILL_MESSAGES_ATTEMPTS - 1) fail('upstream_error');
      } catch (error) {
        if (error instanceof AssistantError) throw error;
        if (!isTransientMessagesFailure(null, error) || attempt === BACKFILL_MESSAGES_ATTEMPTS - 1) fail('upstream_error');
      }
      await sleep(BACKFILL_RETRY_MS[Math.min(attempt, BACKFILL_RETRY_MS.length - 1)]);
    }
    fail('upstream_error');
  };
  const backfillSession = async (history) => {
    const state = db.prepare('SELECT cursor,complete FROM assistant_message_backfill WHERE assistant_id=? AND session_id=?').get(history.assistant_id, history.session_id);
    if (state?.complete) return true;
    const cursor = state?.cursor ?? null;
    let directory = history.directory ?? null;
    if (directory == null) {
      const session = await invokeSession(() => client().session.get({ sessionID: history.session_id })).catch(() => null);
      const resolved = resolveArchivedDirectory(history.assistant_id, sessionDirectoryOf(session), session?.data?.directory, session?.data?.project?.worktree);
      if (resolved) {
        db.prepare('UPDATE assistant_session_history SET directory=? WHERE assistant_id=? AND session_id=? AND directory IS NULL').run(resolved, history.assistant_id, history.session_id);
        directory = resolved;
      }
    }
    const result = await fetchBackfillMessages(history, directory, cursor);
    if (isMissing(result)) return completeMissingSessionBackfill(history.assistant_id, history.session_id);
    if (result?.error) fail('upstream_error');
    const entries = Array.isArray(result?.data) ? result.data : Array.isArray(result?.data?.items) ? result.data.items : null;
    if (!entries) fail('upstream_error');
    db.exec('BEGIN IMMEDIATE');
    try {
      entries.forEach((entry) => { const info = entry?.info ?? entry; if (nonEmptyString(info?.sessionID) && info.sessionID !== history.session_id) return; const parts = Array.isArray(entry?.parts) ? entry.parts : []; const messageOrdinal = Number.isSafeInteger(info?.time?.created) ? info.time.created : undefined; mirrorMessage(history.assistant_id, history.session_id, info, messageOrdinal, true); const partIDs = parts.filter((part) => nonEmptyString(part?.id)).map((part) => part.id); if (partIDs.length) db.prepare(`DELETE FROM assistant_message_part_mirror WHERE assistant_id=? AND session_id=? AND message_id=? AND part_id NOT IN (${partIDs.map(() => '?').join(',')})`).run(history.assistant_id, history.session_id, info?.id, ...partIDs); else db.prepare('DELETE FROM assistant_message_part_mirror WHERE assistant_id=? AND session_id=? AND message_id=?').run(history.assistant_id, history.session_id, info?.id); parts.forEach((part, partIndex) => mirrorPart(history.assistant_id, history.session_id, part, partIndex + 1)); });
      const nextCursor = result?.response?.headers?.get('x-next-cursor') ?? null;
      const complete = !nextCursor;
      if (complete) clearUncoveredSessionMirror(history.assistant_id, history.session_id);
      db.prepare('INSERT INTO assistant_message_backfill(assistant_id,session_id,cursor,complete,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(assistant_id,session_id) DO UPDATE SET cursor=excluded.cursor,complete=excluded.complete,updated_at=excluded.updated_at').run(history.assistant_id, history.session_id, nextCursor, complete ? 1 : 0, now());
      db.exec('COMMIT');
      return complete;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const decodeCursor = (value) => { if (value == null || value === '') return null; try { const parsed = parse(Buffer.from(String(value), 'base64url').toString('utf8')); return Number.isSafeInteger(parsed?.sessionOrdinal) && Number.isSafeInteger(parsed?.messageOrdinal) && nonEmptyString(parsed?.messageID) && (parsed.scanSessionOrdinal == null || Number.isSafeInteger(parsed.scanSessionOrdinal)) ? parsed : fail('validation_error'); } catch (error) { if (error instanceof AssistantError) throw error; fail('validation_error'); } };
  const encodeCursor = (row, scanSessionOrdinal = row.session_ordinal) => Buffer.from(json({ sessionOrdinal: row.session_ordinal, messageOrdinal: row.message_ordinal, messageID: row.message_id, scanSessionOrdinal })).toString('base64url');
  const loadProjectionSession = async (history, pageLimit = BACKFILL_PAGE_SIZE) => {
    let directory = history.directory ?? null;
    if (directory == null) {
      const session = await invokeSession(() => client().session.get({ sessionID: history.session_id })).catch(() => null);
      const resolved = resolveArchivedDirectory(history.assistant_id, sessionDirectoryOf(session), session?.data?.directory, session?.data?.project?.worktree);
      if (resolved) {
        db.prepare('UPDATE assistant_session_history SET directory=? WHERE assistant_id=? AND session_id=? AND directory IS NULL').run(resolved, history.assistant_id, history.session_id);
        directory = resolved;
      }
    }
    const collected = [];
    let cursor = null;
    for (let page = 0; page < BACKFILL_MAX_PAGES; page++) {
      const result = await fetchBackfillMessages(history, directory, cursor, pageLimit);
      if (isMissing(result)) return { entries: collected, directory, missing: true };
      if (result?.error) fail('upstream_error');
      const entries = projectionEntries(result, history.session_id);
      if (!entries) fail('upstream_error');
      collected.push(...entries);
      cursor = projectionCursor(result);
      if (!cursor) break;
    }
    return { entries: collected, directory, missing: false };
  };
  const historicalMessages = async (assistantID, input = {}) => {
    const row = editable(assistantID); const limit = input.limit == null ? 50 : Number(input.limit); if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('validation_error'); const before = decodeCursor(input.before);
    const currentSessionOrdinal = Number(db.prepare('SELECT COALESCE(MAX(ordinal), 0) + 1 AS next FROM assistant_session_history WHERE assistant_id=?').get(row.assistant_id).next);
    const archived = db.prepare('SELECT session_id,directory,ordinal FROM assistant_session_history WHERE assistant_id=? ORDER BY ordinal ASC').all(row.assistant_id);
    const currentIsArchived = row.current_session_id != null && archived.some((item) => item.session_id === row.current_session_id);
    const sessions = archived.map((item) => ({ assistant_id: row.assistant_id, session_id: item.session_id, directory: item.directory, ordinal: item.ordinal }));
    if (row.current_session_id && !currentIsArchived) sessions.push({ assistant_id: row.assistant_id, session_id: row.current_session_id, directory: effectiveWorkspace(row), ordinal: currentSessionOrdinal });
    const collected = [];
    let requiredFailure = null;
    for (const session of sessions) {
      try {
        const loaded = await loadProjectionSession(session, limit);
        for (const entry of loaded.entries) {
          const info = entry?.info ?? entry;
          if (!plainObject(info) || !nonEmptyString(info.id)) continue;
          if (nonEmptyString(info.sessionID) && info.sessionID !== session.session_id) continue;
          collected.push({
            session_ordinal: session.ordinal,
            message_ordinal: Number.isSafeInteger(info?.time?.created) ? info.time.created : 0,
            message_id: info.id,
            session_id: session.session_id,
            directory: loaded.directory,
            info,
            parts: Array.isArray(entry?.parts) ? entry.parts : [],
          });
        }
      } catch (error) {
        requiredFailure = error;
      }
    }
    collected.sort((left, right) => right.session_ordinal - left.session_ordinal || right.message_ordinal - left.message_ordinal || right.message_id.localeCompare(left.message_id));
    const filtered = collected.filter((message) => before == null || message.session_ordinal < before.sessionOrdinal || (message.session_ordinal === before.sessionOrdinal && (message.message_ordinal < before.messageOrdinal || (message.message_ordinal === before.messageOrdinal && message.message_id < before.messageID))));
    if (filtered.length === 0 && requiredFailure && collected.length === 0) throw requiredFailure;
    const page = filtered.slice(0, limit);
    const oldest = page[page.length - 1];
    const nextCursor = filtered.length > limit && oldest ? encodeCursor(oldest, oldest.session_ordinal) : null;
    const ordered = [...page].reverse().map((message) => ({ sessionID: message.session_id, directory: message.directory, info: message.info, parts: message.parts }));
    return { entries: ordered, nextCursor, complete: nextCursor === null };
  };
  // Ticket 11: history is read live from OpenCode projections; do not start a mirror backfill.
  const unsubscribeEvents = typeof globalEventHub?.subscribeEvent === 'function' ? globalEventHub.subscribeEvent(processEvent) : null;
  const createAssistant = (input) => { const allowed = new Set(['enabled', 'name', 'defaultPrompt', 'providerID', 'modelID', 'agent', 'variant', 'mode', 'workspacePath']); if (!plainObject(input) || Object.keys(input).some((key) => !allowed.has(key))) fail('validation_error'); const mode = input.mode == null ? 'continuous' : input.mode === 'stateless' || input.mode === 'continuous' ? input.mode : fail('validation_error'); const assistantID = id(); const workspacePath = input.workspacePath == null ? null : workspace(input.workspacePath, assistantID); effectiveWorkspace({ assistant_id: assistantID, workspace_path: workspacePath }); const at = now(); db.exec('BEGIN IMMEDIATE'); try { if (Number(db.prepare('SELECT COUNT(*) AS count FROM assistant_v2 WHERE tombstone_at IS NULL').get().count) >= 100) fail('assistant_limit'); db.prepare('INSERT INTO assistant_v2 (assistant_id,revision,enabled,name,default_prompt,workspace_path,provider_id,model_id,agent,variant,mode,current_session_id,session_generation,created_at,updated_at,tombstone_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(assistantID, 1, input.enabled === false ? 0 : 1, string(input.name, 256, true), input.defaultPrompt ? string(input.defaultPrompt, 200_000) : '', workspacePath, string(input.providerID, 256, true), string(input.modelID, 256, true), input.agent == null ? null : string(input.agent, 256), input.variant == null ? null : string(input.variant, 256), mode, null, 0, at, at, null); bump(); db.exec('COMMIT'); return output(assistant(assistantID)); } catch (error) { db.exec('ROLLBACK'); throw error; } };
  const updateAssistant = async (assistantID, input) => { const row = editable(assistantID); const allowed = new Set(['expectedRevision', 'enabled', 'name', 'defaultPrompt', 'providerID', 'modelID', 'agent', 'variant', 'mode', 'workspacePath']); if (!plainObject(input) || !Number.isInteger(input.expectedRevision) || Object.keys(input).some((key) => !allowed.has(key))) fail('validation_error'); const next = { enabled: input.enabled === undefined ? row.enabled : input.enabled ? 1 : 0, name: input.name === undefined ? row.name : string(input.name, 256, true), prompt: input.defaultPrompt === undefined ? row.default_prompt : string(input.defaultPrompt, 200_000), provider: input.providerID === undefined ? row.provider_id : string(input.providerID, 256, true), model: input.modelID === undefined ? row.model_id : string(input.modelID, 256, true), agent: input.agent === undefined ? row.agent : input.agent === null ? null : string(input.agent, 256), variant: input.variant === undefined ? row.variant : input.variant === null ? null : string(input.variant, 256), mode: input.mode === undefined ? (row.mode === 'stateless' ? 'stateless' : 'continuous') : input.mode === 'continuous' || input.mode === 'stateless' ? input.mode : fail('validation_error'), workspacePath: input.workspacePath === undefined ? row.workspace_path : input.workspacePath == null ? null : workspace(input.workspacePath, assistantID) }; const nextRow = { ...row, workspace_path: next.workspacePath, name: next.name }; effectiveWorkspace(nextRow); const workspaceChanged = next.workspacePath !== row.workspace_path; if (workspaceChanged && row.current_session_id) archiveSession(assistantID, row.current_session_id); if (!workspaceChanged && next.name !== row.name && row.current_session_id) { const renamed = await invokeSession(() => client().session.rename({ sessionID: row.current_session_id, title: `[Assistant] ${next.name}` })); if (renamed?.error && !isMissing(renamed)) fail('upstream_error'); } const created = workspaceChanged ? await createSession(nextRow) : null; const result = db.prepare('UPDATE assistant_v2 SET enabled=?,name=?,default_prompt=?,provider_id=?,model_id=?,agent=?,variant=?,mode=?,workspace_path=?,current_session_id=?,session_generation=session_generation+?,revision=revision+1,updated_at=? WHERE assistant_id=? AND revision=? AND session_generation=? AND tombstone_at IS NULL').run(next.enabled, next.name, next.prompt, next.provider, next.model, next.agent, next.variant, next.mode, next.workspacePath, created?.sessionID ?? row.current_session_id, workspaceChanged ? 1 : 0, now(), assistantID, input.expectedRevision, row.session_generation); if (!result.changes) fail('revision_conflict'); bump(); return output(assistant(assistantID)); };
  const compact = async (assistantID, input) => { const row = active(assistantID); if (!plainObject(input) || input.sessionID !== row.current_session_id || input.sessionGeneration !== row.session_generation || !row.current_session_id) fail('revision_conflict'); let target = row; let result = await invokeSession(() => client().session.compact({ sessionID: target.current_session_id })); if (isMissing(result)) { await restoreOnce(row, row.current_session_id, row.session_generation); target = active(assistantID); result = await invokeSession(() => client().session.compact({ sessionID: target.current_session_id })); } if (result?.error || (result?.data !== true && result?.id == null && result?.type !== 'compaction')) fail('upstream_error'); return { binding: binding(active(assistantID)), summarized: true }; };
  const sendWithConfig = async ({ row, sessionID, directory, config, parts, messageID, restore }) => {
    const sendPrompt = async (targetSessionID, targetConfig) => invokeSession(async () => {
      const api = client();
      if (typeof api.session.switchAgent === 'function' && targetConfig?.agent) await api.session.switchAgent({ sessionID: targetSessionID, agent: targetConfig.agent });
      if (typeof api.session.switchModel === 'function' && targetConfig?.model) await api.session.switchModel({ sessionID: targetSessionID, model: { id: targetConfig.model.modelID, providerID: targetConfig.model.providerID, ...(targetConfig.variant ? { variant: targetConfig.variant } : {}) } });
      if (typeof api.session.instructions?.entry?.put === 'function' && typeof targetConfig?.system === 'string' && targetConfig.system) await api.session.instructions.entry.put({ sessionID: targetSessionID, key: 'system', value: targetConfig.system });
      return api.session.prompt(toV2PromptInput(targetSessionID, parts, messageID));
    });
    let result = await sendPrompt(sessionID, config);
    if (isMissing(result) && restore) {
      const restored = await restoreOnce(row, sessionID, row.session_generation);
      const target = active(row.assistant_id);
      const targetConfig = configuration(target);
      result = await sendPrompt(restored.sessionID, targetConfig);
      return { result, binding: restored };
    }
    return { result, binding: binding(row) };
  };
  const send = async (assistantID, input) => { if (!plainObject(input)) fail('validation_error'); validateParts(input.parts); const messageID = string(input.messageID, 256, true); const row = active(assistantID); if (row.mode !== 'stateless' && (input.sessionID !== row.current_session_id || input.sessionGeneration !== row.session_generation)) fail('revision_conflict'); const submit = async () => { const latest = active(assistantID); const target = await prepareExecutionBinding(latest); const sent = await sendWithConfig({ row: target, sessionID: target.current_session_id, directory: effectiveWorkspace(target), config: configuration(target), parts: input.parts, messageID, restore: target.mode !== 'stateless' }); if (!promptAdmitted(sent.result)) fail('upstream_error'); return { binding: sent.binding, messageID, admitted: true }; }; return row.mode === 'stateless' ? inStatelessLane(assistantID, submit) : submit(); };
  const captureQueueDeliveryTarget = ({ assistantID, scope }) => {
    const row = active(assistantID); const current = binding(row);
    const expectedSessionID = row.mode === 'stateless' ? `assistant:${assistantID}` : current.sessionID;
    if (scope.sessionID !== expectedSessionID || scope.directory !== current.directory) fail('revision_conflict');
    return { kind: 'assistant', assistantID, binding: current, sessionID: current.sessionID, sessionGeneration: current.sessionGeneration, directory: current.directory, providerID: row.provider_id, modelID: row.model_id, agent: row.agent, variant: row.variant, mode: row.mode === 'stateless' ? 'stateless' : 'continuous', defaultPrompt: row.default_prompt, system: row.default_prompt };
  };
  const sendWithCapturedConfig = async ({ deliveryTarget, messageID, parts }) => {
    const capturedBinding = deliveryTarget?.binding ?? { sessionID: deliveryTarget?.sessionID, sessionGeneration: deliveryTarget?.sessionGeneration, directory: deliveryTarget?.directory };
    const mode = deliveryTarget?.mode === 'stateless' ? 'stateless' : deliveryTarget?.mode === 'continuous' || deliveryTarget?.mode == null ? 'continuous' : fail('validation_error');
    if (!plainObject(deliveryTarget) || deliveryTarget.kind !== 'assistant' || !nonEmptyString(deliveryTarget.assistantID) || !nonEmptyString(capturedBinding.sessionID) || !Number.isSafeInteger(capturedBinding.sessionGeneration) || !nonEmptyString(capturedBinding.directory) || !nonEmptyString(deliveryTarget.providerID) || !nonEmptyString(deliveryTarget.modelID) || (deliveryTarget.agent != null && !nonEmptyString(deliveryTarget.agent)) || (deliveryTarget.variant != null && !nonEmptyString(deliveryTarget.variant)) || (deliveryTarget.defaultPrompt != null && typeof deliveryTarget.defaultPrompt !== 'string') || (deliveryTarget.system != null && typeof deliveryTarget.system !== 'string')) fail('validation_error');
    validateParts(parts); const submit = async () => { const row = active(deliveryTarget.assistantID); const current = binding(row);
      if (mode !== 'stateless' && (current.sessionID !== capturedBinding.sessionID || current.sessionGeneration !== capturedBinding.sessionGeneration || current.directory !== capturedBinding.directory)) fail('stale_target');
      const target = mode === 'stateless' ? await createStatelessExecutionBinding(deliveryTarget.assistantID) : row;
      const sent = await sendWithConfig({ row: target, sessionID: target.current_session_id, directory: effectiveWorkspace(target), config: capturedConfiguration(deliveryTarget), parts, messageID, restore: false });
      if (!promptAdmitted(sent.result)) return { ok: false, status: sent.result?.status ?? sent.result?.response?.status, code: 'upstream_error' };
      return { ok: true, accepted: true, binding: binding(target), messageID };
    };
    return mode === 'stateless' ? inStatelessLane(deliveryTarget.assistantID, submit) : submit();
  };
  const abort = async (assistantID, input) => { const row = active(assistantID); if (!plainObject(input) || input.sessionID !== row.current_session_id || input.sessionGeneration !== row.session_generation || !row.current_session_id) fail('revision_conflict'); const result = await invokeSession(() => client().session.interrupt({ sessionID: row.current_session_id })); if (isMissing(result)) fail('not_found'); if (result?.error) fail('upstream_error'); return { binding: binding(row), aborted: true }; };
  const createNew = async (assistantID) => { for (let attempt = 0; attempt < 3; attempt++) { const row = active(assistantID); const created = await createSession(row); const won = replaceBinding(row, created); if (won) return binding(won); } return binding(active(assistantID)); };
  const shareOperation = (operationID) => { const row = db.prepare('SELECT * FROM assistant_share_operation WHERE operation_id=?').get(operationID); return row && { operationID: row.operation_id, assistantID: row.assistant_id, sessionID: row.session_id, messageID: row.message_id, state: row.state, phase: row.phase, attempt: row.attempt, leaseExpiresAt: row.lease_expires_at, errorCode: row.error_code }; };
  const claim = (operationID, retry = false) => { db.exec('BEGIN IMMEDIATE'); try { const operation = db.prepare('SELECT * FROM assistant_share_operation WHERE operation_id=?').get(operationID); if (!operation) { db.exec('COMMIT'); return null; } const at = now(); const eligible = operation.state === 'failed' ? retry : operation.state === 'running' && operation.lease_expires_at <= at && operation.phase === 'admitted'; if (!eligible || operation.attempt >= SHARE_MAX_ATTEMPTS) { db.exec('COMMIT'); return null; } const result = db.prepare("UPDATE assistant_share_operation SET state='running',phase='submitting',attempt=attempt+1,lease_expires_at=?,error_code=NULL,updated_at=? WHERE operation_id=? AND state=? AND phase=? AND attempt<? AND (state='failed' OR lease_expires_at<=?)").run(at + SHARE_LEASE_MS, at, operationID, operation.state, operation.phase, SHARE_MAX_ATTEMPTS, at); const claimed = result.changes ? db.prepare('SELECT * FROM assistant_share_operation WHERE operation_id=?').get(operationID) : null; db.exec('COMMIT'); return claimed; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  const completeOrFail = (operation, errorCode = null) => { const at = now(); if (errorCode) db.prepare("UPDATE assistant_share_operation SET state='failed',phase='admitted',error_code=?,lease_expires_at=NULL,updated_at=? WHERE operation_id=? AND state='running' AND phase='submitting'").run(errorCode, at, operation.operation_id); else db.prepare("UPDATE assistant_share_operation SET state='running',phase='submitted',error_code=NULL,lease_expires_at=?,updated_at=? WHERE operation_id=? AND state='running' AND phase='submitting'").run(at + SHARE_LEASE_MS, at, operation.operation_id); };
  const submitClaim = async (operation) => { const payload = parse(operation.response); const row = active(operation.assistant_id); try { const sent = await sendWithConfig({ row, sessionID: operation.session_id, directory: effectiveWorkspace(row), config: configuration(row), parts: payload.parts, messageID: operation.message_id, restore: false }); if (!promptAdmitted(sent.result)) fail('upstream_error'); completeOrFail(operation); } catch (error) { completeOrFail(operation, error instanceof AssistantError ? error.code : 'upstream_error'); } };
  const reconcile = async () => { const candidates = db.prepare("SELECT * FROM assistant_share_operation WHERE state='running'").all(); for (const operation of candidates) { const row = assistant(operation.assistant_id); if (!row || !operation.session_id || !operation.message_id) continue; try { const result = await invokeSession(() => client().message.list({ sessionID: operation.session_id, limit: 100, order: 'desc' })); if (result?.error) continue; const messages = projectionEntries(result, operation.session_id) ?? result.data ?? []; const found = Array.isArray(messages) && messages.some((message) => message?.info?.id === operation.message_id || message?.id === operation.message_id); if (found) db.prepare("UPDATE assistant_share_operation SET state='completed',phase='submitted',lease_expires_at=NULL,updated_at=? WHERE operation_id=? AND state='running'").run(now(), operation.operation_id); else if (operation.phase === 'admitted' && operation.lease_expires_at <= now() && operation.attempt >= SHARE_MAX_ATTEMPTS) db.prepare("UPDATE assistant_share_operation SET state='failed',lease_expires_at=NULL,error_code='attempt_limit',updated_at=? WHERE operation_id=? AND state='running' AND phase='admitted'").run(now(), operation.operation_id); else if (operation.phase === 'admitted' && operation.lease_expires_at <= now()) { const claimed = claim(operation.operation_id); if (claimed) void submitClaim(claimed); } else if (operation.phase === 'submitted' && operation.lease_expires_at <= now()) db.prepare("UPDATE assistant_share_operation SET state='unresolved',lease_expires_at=NULL,error_code='message_unresolved',updated_at=? WHERE operation_id=? AND state='running' AND phase='submitted'").run(now(), operation.operation_id); } catch { /* Reconciliation remains retryable until its lease expires. */ } } };
  const share = async (assistantID, input) => { if (!plainObject(input) || !plainObject(input.payload)) fail('validation_error'); validateParts(input.payload.parts); const operationID = string(input.operationID, 128, true); const messageID = string(input.payload.messageID, 256, true); const payloadHash = hash(input.payload); active(assistantID); const at = now(); let operation; let reservationOwner = false; db.exec('BEGIN IMMEDIATE'); try { const inserted = db.prepare('INSERT OR IGNORE INTO assistant_share_operation(operation_id,assistant_id,payload_hash,phase,session_id,message_id,state,response,error_code,attempt,lease_expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(operationID, assistantID, payloadHash, 'reserving', null, messageID, 'running', json(input.payload), null, 0, null, at, at); operation = db.prepare('SELECT * FROM assistant_share_operation WHERE operation_id=?').get(operationID); if (operation.assistant_id !== assistantID || operation.payload_hash !== payloadHash) fail('idempotency_conflict'); reservationOwner = inserted.changes === 1; db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
    let resolveReservation; if (reservationOwner) shareReservations.set(operationID, new Promise((resolve) => { resolveReservation = resolve; })); else await shareReservations.get(operationID);
    if (reservationOwner) {
      try { const row = active(assistantID); const target = row.mode === 'stateless' ? await createNew(assistantID) : await ensure(assistantID); const attachedAt = now(); const attached = db.prepare("UPDATE assistant_share_operation SET phase='admitted',session_id=?,message_id=?,lease_expires_at=?,updated_at=? WHERE operation_id=? AND state='running' AND phase='reserving'").run(target.sessionID, messageID, attachedAt, attachedAt, operationID); if (!attached.changes) fail('upstream_error'); } catch (error) { db.prepare("DELETE FROM assistant_share_operation WHERE operation_id=? AND state='running' AND phase='reserving'").run(operationID); throw error; } finally { shareReservations.delete(operationID); resolveReservation(); }
    }
    operation = db.prepare('SELECT * FROM assistant_share_operation WHERE operation_id=?').get(operationID); if (operation?.phase !== 'reserving') { const claimed = claim(operationID, operation?.state === 'failed'); if (claimed) await submitClaim(claimed); } return shareOperation(operationID); };
  const timer = setIntervalFn(() => { if (!closed) { db.prepare('DELETE FROM assistant_share_operation WHERE updated_at<?').run(now() - SHARE_RETENTION_MS); void reconcile(); } }, reconcileIntervalMs);
  void reconcile();
  return { capability: async () => ({ supported: true, enabled: enabled(), revision: revision(), serverInstanceID: await getServerId(), sharingAvailable: false, archiveMetadataAvailable: false, sessionMetadataAvailable: false }), snapshot: () => ({ revision: revision(), enabled: enabled(), assistants: db.prepare('SELECT * FROM assistant_v2 WHERE tombstone_at IS NULL ORDER BY created_at').all().map(output) }), createAssistant, updateAssistant, setEnabled: (input) => { if (!plainObject(input) || typeof input.enabled !== 'boolean' || input.expectedRevision !== revision()) fail('revision_conflict'); db.prepare("UPDATE assistant_meta SET value=? WHERE key='enabled'").run(input.enabled ? '1' : '0'); return { enabled: input.enabled, revision: bump() }; }, removeAssistant: (assistantID, expectedRevision) => {
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
