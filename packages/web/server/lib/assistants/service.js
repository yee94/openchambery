import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { validAssistantDeliveryParts } from '../assistant-delivery-parts.js';
import { reduceBackfillState } from './history-state.js';
import { getWorktrees as defaultListWorktrees } from '../git/service.js';
import { parseContactCard, parseContactPart } from './cards.js';
import {
  CONTACT_SETTLE_TEXT,
  contactHistoryForLlm,
  deleteContactMessages,
  ensureContactSchema,
  insertContactMessage,
  listContactMessages,
  listInFlightWatches,
  listWatchesBySession,
  nextContactOrdinal,
  updateSessionCardStatus,
  upsertContactWatch,
} from './contact-store.js';
import { ASSIGNED_SESSION_FALLBACK_BUBBLE, createContactTools } from './contact-tools.js';
import { assignSession } from './assign.js';
import { runContactTurn as defaultRunContactTurn } from './harness.js';

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
export class AssistantError extends Error {
  constructor(code, message) {
    super(typeof message === 'string' && message.trim() ? message.trim() : code);
    this.code = code;
  }
}
const fail = (code, message) => { throw new AssistantError(code, message); };
const string = (value, max = 10_000, required = false) => { if (value == null && !required) return null; if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail('validation_error'); return value.trim(); };
const nonEmptyString = (value, max = 10_000) => typeof value === 'string' && value.length > 0 && value.length <= max;
const isMissing = (result) => result?.error?.status === 404 || result?.error?.statusCode === 404 || result?.error?.code === 'not_found' || result?.status === 404;
const messagesErrorStatus = (result) => { const status = result?.error?.status ?? result?.error?.statusCode ?? result?.status; return Number.isFinite(status) ? status : null; };
const isTransientMessagesFailure = (result, error) => {
  if (error) {
    if (error instanceof AssistantError) return false;
    if (error?.name === 'TypeError' || error?.name === 'FetchError') return true;
    const code = error?.cause?.code || error?.code;
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EPIPE') return true;
    return false;
  }
  const status = messagesErrorStatus(result);
  if (status == null) return true;
  return status === 408 || status === 429 || status >= 500;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const promptAdmitted = (result) => !result?.error && (result?.response?.status === 204 || result?.status === 204 || result?.data !== undefined || result?.response?.ok === true);

export const createAssistantsService = ({ dbPath, dataDir, buildOpenCodeUrl, getOpenCodeAuthHeaders, getServerId = async () => null, getAllowedRoots = () => [], globalEventHub = null, onRevisionTip = null, clock = () => Date.now(), setIntervalFn = setInterval, clearIntervalFn = clearInterval, reconcileIntervalMs = 60_000, clientFactory, createChatCompletion = null, runContactTurn = defaultRunContactTurn, listWorktrees = defaultListWorktrees } = {}) => {
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
  ensureContactSchema(db);
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
  const output = (row) => {
    const watches = listInFlightWatches(db, row.assistant_id);
    return {
      id: row.assistant_id,
      revision: row.revision,
      enabled: Boolean(row.enabled),
      name: row.name,
      defaultPrompt: row.default_prompt,
      workspacePath: row.workspace_path,
      managedWorkspacePath: workspace(null, row.assistant_id, true),
      effectiveWorkspacePath: effectiveWorkspace(row),
      providerID: row.provider_id,
      modelID: row.model_id,
      agent: row.agent,
      variant: row.variant,
      mode: row.mode === 'stateless' ? 'stateless' : 'continuous',
      sessionID: row.current_session_id,
      sessionGeneration: row.session_generation,
      historySessionIDs: historyIDs(row.assistant_id),
      historySessionCount: historyCount(row.assistant_id),
      assignedSessionIDs: watches.map((watch) => watch.sessionID),
      working: watches.some((watch) => watch.status === 'busy'),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      tombstoneAt: row.tombstone_at,
    };
  };
  const binding = (row) => ({ sessionID: row.current_session_id, directory: effectiveWorkspace(row), sessionGeneration: row.session_generation });
  const client = () => clientFactory ? clientFactory() : createOpencodeClient({ baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''), headers: getOpenCodeAuthHeaders() });
  const metadata = (row) => ({ openchamber: { assistant: { assistantID: row.assistant_id, name: row.name } } });
  const ARCHIVE_RETRY_MS = 25;
  const archiveCreatedSession = async (sessionID, directory) => {
    const archiveAt = now();
    const update = () => client().session.update({ sessionID, directory, time: { archived: archiveAt } });
    let result = await update();
    if (isMissing(result)) {
      await sleep(ARCHIVE_RETRY_MS);
      result = await update();
    }
    if (result?.error || isMissing(result)) fail('upstream_error');
  };
  const createSession = async (row) => {
    const directory = effectiveWorkspace(row);
    const result = await client().session.create({ directory, title: `[Assistant] ${row.name}`, metadata: metadata(row) });
    if (result.error || !result.data?.id) fail('upstream_error');
    const sessionID = result.data.id;
    // Archive before binding so ordinary session lists never flash system sessions.
    // Metadata still isolates the session if archive fails after create.
    await archiveCreatedSession(sessionID, directory);
    return { sessionID, directory };
  };
  const sessionExists = async (row) => { if (!row.current_session_id) return false; const result = await client().session.get({ sessionID: row.current_session_id, directory: effectiveWorkspace(row) }); if (isMissing(result)) return false; if (result.error) fail('upstream_error'); return Boolean(result.data); };
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
  // Reopen demand backfill without clearing covered/provisional mirrors.
  const invalidateBackfill = (assistantID, sessionID) => {
    const current = db.prepare('SELECT cursor,complete FROM assistant_message_backfill WHERE assistant_id=? AND session_id=?').get(assistantID, sessionID);
    const next = reduceBackfillState({ cursor: current?.cursor ?? null, complete: Boolean(current?.complete) }, 'invalidate');
    db.prepare('INSERT INTO assistant_message_backfill(assistant_id,session_id,cursor,complete,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(assistant_id,session_id) DO UPDATE SET cursor=excluded.cursor,complete=excluded.complete,updated_at=excluded.updated_at').run(assistantID, sessionID, next.cursor, next.complete ? 1 : 0, now());
  };
  // Structural part deletes may leave a covered message incomplete; re-demand that session only.
  // Do not blanket-uncover on ordinary message/part upserts — that blanks served history until re-backfill.
  const invalidateMessageCoverage = (assistantID, sessionID, messageID) => {
    db.prepare('UPDATE assistant_message_mirror SET covered=0 WHERE assistant_id=? AND session_id=? AND message_id=?').run(assistantID, sessionID, messageID);
    db.prepare('INSERT INTO assistant_message_backfill(assistant_id,session_id,cursor,complete,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(assistant_id,session_id) DO UPDATE SET cursor=NULL,complete=0,updated_at=excluded.updated_at').run(assistantID, sessionID, null, 0, now());
  };
  const eventSessionID = (properties) => {
    const sessionID = properties?.sessionID || properties?.sessionId || properties?.info?.sessionID || properties?.info?.sessionId;
    return nonEmptyString(sessionID) ? sessionID : '';
  };
  const settleStatusFromEvent = (payload, properties) => {
    if (payload.type === 'session.error') return 'error';
    if (payload.type === 'question.asked' || payload.type === 'permission.asked') return 'question';
    if (payload.type === 'session.idle') return 'complete';
    if (payload.type === 'session.status') {
      const statusType = typeof properties.status?.type === 'string' ? properties.status.type : typeof properties.info?.type === 'string' ? properties.info.type : '';
      if (statusType === 'busy' || statusType === 'retry') return 'busy';
      if (statusType === 'idle') return 'complete';
    }
    return null;
  };
  const reportAssignedSession = (sessionID, status) => {
    const watches = listWatchesBySession(db, sessionID);
    if (watches.length === 0) return false;
    let changed = false;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const watch of watches) {
        if (watch.status === status) continue;
        // session.idle / status idle follow session.error. Do not rewrite 失败 as 完成.
        if (status === 'complete' && watch.status === 'error') continue;
        updateSessionCardStatus(db, { assistantID: watch.assistantID, sessionID, status });
        upsertContactWatch(db, {
          assistantID: watch.assistantID,
          sessionID,
          directory: watch.directory,
          status,
          updatedAt: now(),
        });
        const settleText = CONTACT_SETTLE_TEXT[status];
        const settleID = `settle_${watch.assistantID}_${sessionID}_${status}`;
        if (settleText && !db.prepare('SELECT 1 AS ok FROM assistant_contact_message WHERE message_id=?').get(settleID)) {
          insertContactMessage(db, {
            messageID: settleID,
            assistantID: watch.assistantID,
            role: 'assistant',
            turnID: `settle:${sessionID}`,
            bubbleIndex: 0,
            createdAt: now(),
            ordinal: nextContactOrdinal(db, watch.assistantID),
            status: 'complete',
            parts: [{ type: 'text', text: settleText }],
          });
        }
        changed = true;
      }
      if (changed) bump();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return changed;
  };
  const sessionStatusType = (session) => {
    if (typeof session?.status?.type === 'string') return session.status.type;
    if (typeof session?.status === 'string') return session.status;
    if (typeof session?.type === 'string') return session.type;
    return '';
  };
  const lastAssistantInfo = (messages) => {
    if (!Array.isArray(messages)) return null;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const info = messages[index]?.info ?? messages[index];
      if (info?.role === 'assistant') return info;
    }
    return null;
  };
  const inferAssignedSessionSettleStatus = (getResult, messagesResult) => {
    if (isMissing(getResult)) return 'complete';
    if (getResult?.error) return null;
    const session = getResult?.data;
    if (session?.error) return 'error';
    const statusType = sessionStatusType(session);
    if (statusType === 'busy' || statusType === 'retry') return null;
    if (isMissing(messagesResult)) return 'complete';
    const assistant = messagesResult && !messagesResult.error ? lastAssistantInfo(messagesResult.data) : null;
    if (assistant?.error) return 'error';
    if (statusType === 'idle' || session?.time?.completed) return 'complete';
    if (assistant?.time?.completed) return 'complete';
    return null;
  };
  const resolveWatchDirectory = (watch) => {
    if (nonEmptyString(watch.directory)) {
      try { return workspace(watch.directory, watch.assistantID); } catch { /* Fall through to the assistant workspace. */ }
    }
    const row = assistant(watch.assistantID);
    if (!row || row.tombstone_at) return null;
    try { return effectiveWorkspace(row); } catch { return null; }
  };
  const reconcileInFlightWatches = async () => {
    if (closed) return;
    let watches;
    try {
      watches = listInFlightWatches(db);
    } catch {
      return;
    }
    for (const watch of watches) {
      if (closed) return;
      try {
        const directory = resolveWatchDirectory(watch);
        if (!directory) continue;
        let getResult;
        try {
          getResult = await client().session.get({ sessionID: watch.sessionID, directory });
        } catch {
          continue;
        }
        if (closed) return;
        let messagesResult = null;
        try {
          messagesResult = await client().session.messages({ sessionID: watch.sessionID, directory, limit: 100 });
        } catch {
          messagesResult = null;
        }
        if (closed) return;
        const status = inferAssignedSessionSettleStatus(getResult, messagesResult);
        if (status) reportAssignedSession(watch.sessionID, status);
      } catch {
        // One failed watch must not block unrelated watches.
      }
    }
  };
  const processEvent = (event) => {
    const payload = event?.payload?.payload ?? event?.payload ?? event;
    const properties = payload?.properties;
    if (!plainObject(payload) || !plainObject(properties)) return false;
    if (payload.type === 'message.updated') {
      const info = properties.info; const sessionID = info?.sessionID;
      if (!nonEmptyString(sessionID) || !plainObject(info)) return false;
      const assistants = mappedAssistants(sessionID); for (const assistantID of assistants) { const current = assistant(assistantID)?.current_session_id === sessionID; mirrorMessage(assistantID, sessionID, info, undefined, current); if (!current) invalidateBackfill(assistantID, sessionID); } return assistants.length > 0;
    }
    if (payload.type === 'message.part.updated') {
      const part = properties.part; const sessionID = properties.sessionID ?? part?.sessionID;
      if (!nonEmptyString(sessionID) || !plainObject(part)) return false;
      const assistants = mappedAssistants(sessionID); for (const assistantID of assistants) { db.prepare("DELETE FROM assistant_message_part_mirror WHERE assistant_id=? AND session_id=? AND message_id=? AND part_id GLOB 'oc_asst_admission:*'").run(assistantID, sessionID, part.messageID); mirrorPart(assistantID, sessionID, part); if (assistant(assistantID)?.current_session_id !== sessionID) invalidateBackfill(assistantID, sessionID); } return assistants.length > 0;
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
    if (payload.type === 'session.idle' || payload.type === 'session.error') {
      const sessionID = eventSessionID(properties);
      if (!sessionID) return false;
      const reported = reportAssignedSession(sessionID, settleStatusFromEvent(payload, properties));
      const assistants = mappedAssistants(sessionID); for (const assistantID of assistants) { if (assistant(assistantID)?.current_session_id !== sessionID) invalidateBackfill(assistantID, sessionID); }
      return reported || assistants.some((assistantID) => assistant(assistantID)?.current_session_id !== sessionID);
    }
    if (payload.type === 'session.status') {
      const sessionID = eventSessionID(properties);
      const status = settleStatusFromEvent(payload, properties);
      if (!sessionID || !status) return false;
      const reported = reportAssignedSession(sessionID, status);
      const assistants = mappedAssistants(sessionID); for (const assistantID of assistants) { if (assistant(assistantID)?.current_session_id !== sessionID) invalidateBackfill(assistantID, sessionID); }
      return reported || assistants.some((assistantID) => assistant(assistantID)?.current_session_id !== sessionID);
    }
    if (payload.type === 'question.asked' || payload.type === 'permission.asked') {
      const sessionID = eventSessionID(properties);
      if (!sessionID) return false;
      return reportAssignedSession(sessionID, 'question');
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
  const writeBackfillState = (assistantID, sessionID, next) => {
    db.prepare('INSERT INTO assistant_message_backfill(assistant_id,session_id,cursor,complete,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(assistant_id,session_id) DO UPDATE SET cursor=excluded.cursor,complete=excluded.complete,updated_at=excluded.updated_at').run(assistantID, sessionID, next.cursor, next.complete ? 1 : 0, now());
  };
  // Authoritative 404 means this session ID is gone from OpenCode. Converge its
  // backfill so one deleted archive cannot block demand scans of other sessions.
  // Covered/admitted rows stay; only uncovered event mirrors are dropped. Safe
  // under concurrent ensure: a replaced current binding archives under its old
  // ID, while a still-current missing ID is recreated with a new session ID.
  const completeMissingSessionBackfill = (assistantID, sessionID) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = db.prepare('SELECT cursor,complete FROM assistant_message_backfill WHERE assistant_id=? AND session_id=?').get(assistantID, sessionID);
      const next = reduceBackfillState({ cursor: current?.cursor ?? null, complete: Boolean(current?.complete) }, 'session-missing');
      if (next.disposition === 'discard-provisional') clearUncoveredSessionMirror(assistantID, sessionID);
      writeBackfillState(assistantID, sessionID, next);
      db.exec('COMMIT');
      return true;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const fetchBackfillMessages = async (history, directory, cursor) => {
    for (let attempt = 0; attempt < BACKFILL_MESSAGES_ATTEMPTS; attempt++) {
      try {
        const result = await client().session.messages({ sessionID: history.session_id, ...(directory ? { directory } : {}), limit: BACKFILL_PAGE_SIZE, ...(cursor ? { before: cursor } : {}) });
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
      const session = await client().session.get({ sessionID: history.session_id }).catch(() => null);
      const resolved = resolveArchivedDirectory(history.assistant_id, session?.data?.directory, session?.data?.project?.worktree);
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
      const next = reduceBackfillState({ cursor, complete: false }, { type: 'page', nextCursor });
      // Successful pages only upsert authoritative rows; never delete provisional
      // event mirrors that the snapshot omitted — only 404 / message.removed /
      // assistant deletion may shrink the message set.
      writeBackfillState(history.assistant_id, history.session_id, next);
      db.exec('COMMIT');
      return next.complete;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const decodeCursor = (value) => { if (value == null || value === '') return null; try { const parsed = parse(Buffer.from(String(value), 'base64url').toString('utf8')); return Number.isSafeInteger(parsed?.sessionOrdinal) && Number.isSafeInteger(parsed?.messageOrdinal) && nonEmptyString(parsed?.messageID) && (parsed.scanSessionOrdinal == null || Number.isSafeInteger(parsed.scanSessionOrdinal)) ? parsed : fail('validation_error'); } catch (error) { if (error instanceof AssistantError) throw error; fail('validation_error'); } };
  const encodeCursor = (row, scanSessionOrdinal = row.session_ordinal) => Buffer.from(json({ sessionOrdinal: row.session_ordinal, messageOrdinal: row.message_ordinal, messageID: row.message_id, scanSessionOrdinal })).toString('base64url');
  const historicalMessages = async (assistantID, input = {}) => {
    const row = editable(assistantID); const limit = input.limit == null ? 50 : Number(input.limit); if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('validation_error'); const before = decodeCursor(input.before);
    const currentSessionOrdinal = Number(db.prepare('SELECT COALESCE(MAX(ordinal), 0) + 1 AS next FROM assistant_session_history WHERE assistant_id=?').get(row.assistant_id).next);
    const currentIsArchived = row.current_session_id != null && Boolean(db.prepare('SELECT 1 FROM assistant_session_history WHERE assistant_id=? AND session_id=?').get(row.assistant_id, row.current_session_id));
    const beforeIncludes = (sessionOrdinal, messageOrdinal, messageID) => before == null || sessionOrdinal < before.sessionOrdinal || (sessionOrdinal === before.sessionOrdinal && (messageOrdinal < before.messageOrdinal || (messageOrdinal === before.messageOrdinal && messageID < before.messageID)));
    const pageRows = () => {
      // Archived mirrors include covered=1 authoritative rows and covered=0
      // provisional event mirrors so a partial REST snapshot cannot hide a reply
      // already observed on the live channel.
      const historical = db.prepare(`SELECT h.ordinal AS session_ordinal,h.directory,m.ordinal AS message_ordinal,m.message_id,m.info_json,m.session_id FROM assistant_session_history h JOIN assistant_message_mirror m ON m.assistant_id=h.assistant_id AND m.session_id=h.session_id WHERE h.assistant_id=? AND (? IS NULL OR h.ordinal<? OR (h.ordinal=? AND (m.ordinal<? OR (m.ordinal=? AND m.message_id<?)))) ORDER BY h.ordinal DESC,m.ordinal DESC,m.message_id DESC LIMIT ?`).all(row.assistant_id, before?.sessionOrdinal ?? null, before?.sessionOrdinal ?? 0, before?.sessionOrdinal ?? 0, before?.messageOrdinal ?? 0, before?.messageOrdinal ?? 0, before?.messageID ?? '', limit + 1);
      const current = row.current_session_id && !currentIsArchived
        ? db.prepare('SELECT ? AS session_ordinal,? AS directory,ordinal AS message_ordinal,message_id,info_json,session_id FROM assistant_message_mirror WHERE assistant_id=? AND session_id=? AND covered=1 ORDER BY ordinal DESC,message_id DESC LIMIT ?').all(currentSessionOrdinal, effectiveWorkspace(row), row.assistant_id, row.current_session_id, limit + 1).filter((message) => beforeIncludes(message.session_ordinal, message.message_ordinal, message.message_id))
        : [];
      return [...historical, ...current].sort((left, right) => right.session_ordinal - left.session_ordinal || right.message_ordinal - left.message_ordinal || right.message_id.localeCompare(left.message_id)).slice(0, limit + 1);
    };
    const nextIncomplete = (boundary = before?.scanSessionOrdinal ?? before?.sessionOrdinal ?? null) => db.prepare(`SELECT h.* FROM assistant_session_history h LEFT JOIN assistant_message_backfill b ON b.assistant_id=h.assistant_id AND b.session_id=h.session_id WHERE h.assistant_id=? AND (b.complete IS NULL OR b.complete=0) AND (? IS NULL OR h.ordinal<=?) ORDER BY h.ordinal DESC LIMIT 1`).get(row.assistant_id, boundary, boundary ?? 0);
    let rows = pageRows();
    // Demand-backfill incomplete archived sessions even when provisional
    // mirrors already fill the page, so authoritative upserts can elevate
    // covered=0 fallbacks. Cap remains BACKFILL_MAX_PAGES per request.
    for (let page = 0; page < BACKFILL_MAX_PAGES; page++) {
      const target = nextIncomplete();
      if (!target) break;
      try {
        await backfillSession(target);
      } catch (error) {
        // Partial-result scope is this request's pageRows() only: any already
        // visible covered or provisional row keeps the page usable and the
        // incomplete cursor retryable. An empty current page still throws.
        if (rows.length === 0) throw error;
        break;
      }
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
      const targetConfig = configuration(target);
      result = await sendPrompt(restored.sessionID, restored.directory, targetConfig);
      if (promptAdmitted(result)) mirrorAdmittedUserMessage(target, restored.sessionID, messageID, parts, targetConfig);
      return { result, binding: restored };
    }
    if (promptAdmitted(result)) mirrorAdmittedUserMessage(row, sessionID, messageID, parts, config);
    return { result, binding: binding(row) };
  };
  const extractUserText = (input) => {
    if (typeof input.text === 'string' && input.text.trim()) return input.text.trim();
    if (!Array.isArray(input.parts)) return '';
    const text = input.parts.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n').trim();
    if (text) return text;
    return input.parts.some((part) => part?.type === 'file') ? '[attachment]' : '';
  };
  const persistContactTurn = (assistantID, { userMessageID, userText, bubbles, cards = [], turnID }) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      let ordinal = nextContactOrdinal(db, assistantID);
      insertContactMessage(db, {
        messageID: userMessageID,
        assistantID,
        role: 'user',
        turnID,
        bubbleIndex: 0,
        createdAt: now(),
        ordinal,
        status: 'complete',
        parts: [{ type: 'text', text: userText }],
      });
      bubbles.forEach((text, index) => {
        ordinal += 1;
        const bubbleID = `${userMessageID}:bubble:${index + 1}`;
        insertContactMessage(db, {
          messageID: bubbleID,
          assistantID,
          role: 'assistant',
          turnID,
          bubbleIndex: index,
          createdAt: now(),
          ordinal,
          status: 'complete',
          parts: [{ type: 'text', text }],
        });
      });
      cards.forEach((cardInput, index) => {
        const card = parseContactCard({ type: 'card', cardType: 'session', ...cardInput });
        if (!card) return;
        ordinal += 1;
        insertContactMessage(db, {
          messageID: `${userMessageID}:card:${index + 1}`,
          assistantID,
          role: 'assistant',
          turnID,
          bubbleIndex: 0,
          createdAt: now(),
          ordinal,
          status: 'complete',
          parts: [card],
        });
        upsertContactWatch(db, {
          assistantID,
          sessionID: card.sessionID,
          directory: card.directory,
          status: card.status === 'error' || card.status === 'question' || card.status === 'complete' ? card.status : 'busy',
          updatedAt: now(),
        });
      });
      bump();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const assignWork = (row, params) => assignSession({
    ...params,
    assistant: output(row),
    defaultProjectPath: row.workspace_path,
    allowedRoots: getAllowedRoots(),
    managedWorkspaceRoot: path.resolve(dataDir, 'assistant-workspaces'),
    listWorktrees,
    createSession: (created) => client().session.create(created),
    promptExisting: (prompted) => client().session.promptAsync(prompted),
    messageID: params?.messageID || `msg_assign_${id()}`,
  });
  const send = async (assistantID, input) => {
    if (!plainObject(input)) fail('validation_error');
    if (input.parts !== undefined) validateParts(input.parts);
    const messageID = string(input.messageID, 256, true);
    const userText = extractUserText(input);
    if (!userText) fail('validation_error');
    const row = active(assistantID);
    // Contact turns are OpenChamber-owned. Binding mismatch no longer gates send;
    // OpenCode session history is not the user-visible queue.
    const history = contactHistoryForLlm(db, assistantID);
    if (typeof createChatCompletion !== 'function' && runContactTurn === defaultRunContactTurn) fail('upstream_error');
    const assignedCards = [];
    const tools = createContactTools({
      assignWork: (params) => assignWork(row, params),
      onCard: (card) => assignedCards.push(card),
    });
    let generated;
    try {
      generated = await runContactTurn({
        assistant: output(row),
        history,
        userText,
        createChatCompletion,
        tools,
      });
    } catch (error) {
      if (error instanceof AssistantError) throw error;
      const detail = typeof error?.message === 'string' && error.message.trim() ? error.message : undefined;
      if (error?.code === 'no_provider') fail('no_provider', detail);
      fail('upstream_error', detail);
    }
    const bubbles = Array.isArray(generated?.bubbles) ? generated.bubbles.filter((item) => typeof item === 'string' && item.trim()) : [];
    const cards = [
      ...assignedCards,
      ...(Array.isArray(generated?.cards) ? generated.cards : []),
    ].filter((card, index, list) => list.findIndex((item) => item?.sessionID === card?.sessionID && item?.directory === card?.directory) === index);
    if (bubbles.length === 0 && cards.length === 0) fail('upstream_error');
    persistContactTurn(row.assistant_id, {
      userMessageID: messageID,
      userText,
      bubbles: bubbles.length > 0 ? bubbles : [ASSIGNED_SESSION_FALLBACK_BUBBLE],
      cards,
      turnID: messageID,
    });
    return { binding: binding(row), messageID, admitted: true };
  };
  const contactMessages = (assistantID, query = {}) => {
    editable(assistantID);
    const limit = query.limit == null ? 50 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('validation_error');
    return listContactMessages(db, assistantID, { before: query.before, limit });
  };
  const appendContactCard = (assistantID, input) => {
    const row = active(assistantID);
    const card = parseContactCard({ type: 'card', ...input, cardType: input?.cardType || 'session' });
    if (!card) fail('validation_error');
    const messageID = string(input.messageID, 256) || `card_${id()}`;
    db.exec('BEGIN IMMEDIATE');
    try {
      insertContactMessage(db, {
        messageID,
        assistantID: row.assistant_id,
        role: input.role === 'user' ? 'user' : 'assistant',
        turnID: string(input.turnID, 256) || messageID,
        bubbleIndex: 0,
        createdAt: now(),
        ordinal: nextContactOrdinal(db, row.assistant_id),
        status: 'complete',
        parts: [card],
      });
      upsertContactWatch(db, {
        assistantID: row.assistant_id,
        sessionID: card.sessionID,
        directory: card.directory,
        status: card.status === 'error' || card.status === 'question' || card.status === 'complete' ? card.status : 'busy',
        updatedAt: now(),
      });
      bump();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return { messageID, admitted: true, card };
  };
  /**
   * Read-only inter-assistant DM. Inserts into the recipient's OpenChamber
   * contact transcript only. Must never call OpenCode promptAsync, mutate
   * sessions/files/worktrees, or run tools on the recipient's behalf.
   *
   * Assign opens a worker session on the sender's contact turn — never here.
   * TODO(watch/summon): later inbound coordination may attach cards on this same peer row.
   */
  const deliverPeerMessage = (fromAssistantID, input) => {
    if (!plainObject(input)) fail('validation_error');
    const sender = active(fromAssistantID);
    const toAssistantID = string(input.toAssistantID, 256, true);
    if (toAssistantID === sender.assistant_id) fail('validation_error');
    const recipient = active(toAssistantID);
    const parts = [];
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (text) parts.push({ type: 'text', text });
    if (input.parts !== undefined) {
      if (!Array.isArray(input.parts)) fail('validation_error');
      for (const part of input.parts) {
        const parsed = parseContactPart(part);
        if (!parsed) fail('validation_error');
        parts.push(parsed);
      }
    }
    if (parts.length === 0) fail('validation_error');
    const messageID = string(input.messageID, 256) || `peer_${id()}`;
    db.exec('BEGIN IMMEDIATE');
    try {
      insertContactMessage(db, {
        messageID,
        assistantID: recipient.assistant_id,
        role: 'peer',
        turnID: string(input.turnID, 256) || messageID,
        bubbleIndex: 0,
        createdAt: now(),
        ordinal: nextContactOrdinal(db, recipient.assistant_id),
        status: 'complete',
        parts,
        fromAssistantID: sender.assistant_id,
        fromAssistantName: sender.name,
      });
      bump();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return {
      messageID,
      admitted: true,
      role: 'peer',
      fromAssistantID: sender.assistant_id,
      fromAssistantName: sender.name,
      toAssistantID: recipient.assistant_id,
    };
  };
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
  const abort = async (assistantID, input) => { const row = active(assistantID); if (!plainObject(input) || input.sessionID !== row.current_session_id || input.sessionGeneration !== row.session_generation || !row.current_session_id) fail('revision_conflict'); const result = await client().session.abort({ sessionID: row.current_session_id, directory: effectiveWorkspace(row) }); if (isMissing(result)) fail('not_found'); if (result.error) fail('upstream_error'); return { binding: binding(row), aborted: true }; };
  const createNew = async (assistantID) => { for (let attempt = 0; attempt < 3; attempt++) { const row = active(assistantID); const created = await createSession(row); const won = replaceBinding(row, created); if (won) return binding(won); } return binding(active(assistantID)); };
  const shareOperation = (operationID) => { const row = db.prepare('SELECT * FROM assistant_share_operation WHERE operation_id=?').get(operationID); return row && { operationID: row.operation_id, assistantID: row.assistant_id, sessionID: row.session_id, messageID: row.message_id, state: row.state, phase: row.phase, attempt: row.attempt, leaseExpiresAt: row.lease_expires_at, errorCode: row.error_code }; };
  const claim = (operationID, retry = false) => { db.exec('BEGIN IMMEDIATE'); try { const operation = db.prepare('SELECT * FROM assistant_share_operation WHERE operation_id=?').get(operationID); if (!operation) { db.exec('COMMIT'); return null; } const at = now(); const eligible = operation.state === 'failed' ? retry : operation.state === 'running' && operation.lease_expires_at <= at && operation.phase === 'admitted'; if (!eligible || operation.attempt >= SHARE_MAX_ATTEMPTS) { db.exec('COMMIT'); return null; } const result = db.prepare("UPDATE assistant_share_operation SET state='running',phase='submitting',attempt=attempt+1,lease_expires_at=?,error_code=NULL,updated_at=? WHERE operation_id=? AND state=? AND phase=? AND attempt<? AND (state='failed' OR lease_expires_at<=?)").run(at + SHARE_LEASE_MS, at, operationID, operation.state, operation.phase, SHARE_MAX_ATTEMPTS, at); const claimed = result.changes ? db.prepare('SELECT * FROM assistant_share_operation WHERE operation_id=?').get(operationID) : null; db.exec('COMMIT'); return claimed; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  const completeOrFail = (operation, errorCode = null) => { const at = now(); if (errorCode) db.prepare("UPDATE assistant_share_operation SET state='failed',phase='admitted',error_code=?,lease_expires_at=NULL,updated_at=? WHERE operation_id=? AND state='running' AND phase='submitting'").run(errorCode, at, operation.operation_id); else db.prepare("UPDATE assistant_share_operation SET state='running',phase='submitted',error_code=NULL,lease_expires_at=?,updated_at=? WHERE operation_id=? AND state='running' AND phase='submitting'").run(at + SHARE_LEASE_MS, at, operation.operation_id); };
  const submitClaim = async (operation) => { const payload = parse(operation.response); const row = active(operation.assistant_id); try { const config = configuration(row); const result = await client().session.promptAsync({ sessionID: operation.session_id, directory: effectiveWorkspace(row), ...config, parts: payload.parts, messageID: operation.message_id }); if (!promptAdmitted(result)) fail('upstream_error'); mirrorAdmittedUserMessage(row, operation.session_id, operation.message_id, payload.parts, config); completeOrFail(operation); } catch (error) { completeOrFail(operation, error instanceof AssistantError ? error.code : 'upstream_error'); } };
  const reconcileShareOperations = async () => { const candidates = db.prepare("SELECT * FROM assistant_share_operation WHERE state='running'").all(); for (const operation of candidates) { const row = assistant(operation.assistant_id); if (!row || !operation.session_id || !operation.message_id) continue; try { const result = await client().session.messages({ sessionID: operation.session_id, directory: effectiveWorkspace(row), limit: 100 }); const messages = result.data ?? []; const found = Array.isArray(messages) && messages.some((message) => message?.info?.id === operation.message_id || message?.id === operation.message_id); if (found) db.prepare("UPDATE assistant_share_operation SET state='completed',phase='submitted',lease_expires_at=NULL,updated_at=? WHERE operation_id=? AND state='running'").run(now(), operation.operation_id); else if (operation.phase === 'admitted' && operation.lease_expires_at <= now() && operation.attempt >= SHARE_MAX_ATTEMPTS) db.prepare("UPDATE assistant_share_operation SET state='failed',lease_expires_at=NULL,error_code='attempt_limit',updated_at=? WHERE operation_id=? AND state='running' AND phase='admitted'").run(now(), operation.operation_id); else if (operation.phase === 'admitted' && operation.lease_expires_at <= now()) { const claimed = claim(operation.operation_id); if (claimed) void submitClaim(claimed); } else if (operation.phase === 'submitted' && operation.lease_expires_at <= now()) db.prepare("UPDATE assistant_share_operation SET state='unresolved',lease_expires_at=NULL,error_code='message_unresolved',updated_at=? WHERE operation_id=? AND state='running' AND phase='submitted'").run(now(), operation.operation_id); } catch { /* Reconciliation remains retryable until its lease expires. */ } } };
  const reconcile = async () => {
    if (closed) return;
    try {
      await reconcileShareOperations();
      if (closed) return;
      await reconcileInFlightWatches();
    } catch {
      // Reconcile remains retryable on the next timer.
    }
  };
  const share = async (assistantID, input) => { if (!plainObject(input) || !plainObject(input.payload)) fail('validation_error'); validateParts(input.payload.parts); const operationID = string(input.operationID, 128, true); const messageID = string(input.payload.messageID, 256, true); const payloadHash = hash(input.payload); active(assistantID); const at = now(); let operation; let reservationOwner = false; db.exec('BEGIN IMMEDIATE'); try { const inserted = db.prepare('INSERT OR IGNORE INTO assistant_share_operation(operation_id,assistant_id,payload_hash,phase,session_id,message_id,state,response,error_code,attempt,lease_expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(operationID, assistantID, payloadHash, 'reserving', null, messageID, 'running', json(input.payload), null, 0, null, at, at); operation = db.prepare('SELECT * FROM assistant_share_operation WHERE operation_id=?').get(operationID); if (operation.assistant_id !== assistantID || operation.payload_hash !== payloadHash) fail('idempotency_conflict'); reservationOwner = inserted.changes === 1; db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
    let resolveReservation; if (reservationOwner) shareReservations.set(operationID, new Promise((resolve) => { resolveReservation = resolve; })); else await shareReservations.get(operationID);
    if (reservationOwner) {
      try { const row = active(assistantID); const target = row.mode === 'stateless' ? await createNew(assistantID) : await ensure(assistantID); const attachedAt = now(); const attached = db.prepare("UPDATE assistant_share_operation SET phase='admitted',session_id=?,message_id=?,lease_expires_at=?,updated_at=? WHERE operation_id=? AND state='running' AND phase='reserving'").run(target.sessionID, messageID, attachedAt, attachedAt, operationID); if (!attached.changes) fail('upstream_error'); } catch (error) { db.prepare("DELETE FROM assistant_share_operation WHERE operation_id=? AND state='running' AND phase='reserving'").run(operationID); throw error; } finally { shareReservations.delete(operationID); resolveReservation(); }
    }
    operation = db.prepare('SELECT * FROM assistant_share_operation WHERE operation_id=?').get(operationID); if (operation?.phase !== 'reserving') { const claimed = claim(operationID, operation?.state === 'failed'); if (claimed) await submitClaim(claimed); } return shareOperation(operationID); };
  const timer = setIntervalFn(() => { if (!closed) { db.prepare('DELETE FROM assistant_share_operation WHERE updated_at<?').run(now() - SHARE_RETENTION_MS); return reconcile(); } }, reconcileIntervalMs);
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
      deleteContactMessages(db, assistantID);
      bump();
      db.exec('COMMIT');
      return { assistantID, tombstoneAt: now() };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }, ensure, createNew, compact, send, abort, captureQueueDeliveryTarget, sendWithCapturedConfig, share, shareOperation, historicalMessages, contactMessages, appendContactCard, deliverPeerMessage, processEvent, reportAssignedSessionSettle: reportAssignedSession, reconcile, close: () => { if (!closed) { closed = true; unsubscribeEvents?.(); clearIntervalFn(timer); db.close(); } } };
};
