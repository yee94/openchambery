import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { validAssistantDeliveryParts } from '../assistant-delivery-parts.js';
import { reduceBackfillState } from './history-state.js';
import { createContactMemoryReader } from './memory.js';
import { getWorktrees as defaultListWorktrees } from '../git/service.js';
import { contactCardIdentity, parseContactCard, parseContactPart } from './cards.js';
import {
  CONTACT_PAGE_DEFAULT_LIMIT,
  CONTACT_PAGE_MAX_LIMIT,
  advanceContactReadWatermark,
  bumpContactGeneration,
  clearContactMemory as clearContactMemoryStore,
  contactHistoryForLlm,
  createActiveContactTurn,
  deleteContactMessages,
  deleteContactReadState,
  deleteContactTurnAssistantOutputs,
  ensureContactSchema,
  contactPartsFingerprint,
  getContactMessage,
  getContactReadTip,
  getContactReadWatermark,
  getContactUnreadSnapshots,
  getLatestContactMessagePreview,
  getLatestContactMessagePreviews,
  insertContactMessage,
  listContactMessages,
  listInFlightWatches,
  listWatchesBySession,
  migrateContactReadStateDefaultRead,
  nextContactOrdinal,
  projectActiveContactTurn,
  resetContactReadWatermarkForGeneration,
  updateSessionCardStatus,
  upsertContactWatch,
} from './contact-store.js';
import {
  CONTACT_ATTACHMENT_TURN_BUDGET_BYTES,
  assertContactAttachmentOwned,
  assertContactAttachmentReadable,
  canonicalDescriptorFromRow,
  ensureContactAttachmentSchema,
  getContactAttachmentRow,
  ingestDataUrlFilePart,
  isSafeInlineImageMime,
  materializeContactHistory,
  materializeContactParts,
  migrateContactDataUrlParts,
  putContactAttachment,
  readContactAttachmentBytes,
} from './contact-attachments.js';
import {
  boundSessionListLimit,
  createContactTools,
  filterRegisteredProjects,
  matchesProjectQuery,
  normalizeConnectedModels,
  normalizeRegisteredProjects,
  sanitizeRegisteredProject,
} from './contact-tools.js';
import {
  AssignError,
  ASSIGN_CODES,
  assignSession,
  attachmentScopeKey,
  extractSessionDirectory,
  extractSessionTitle,
  hasAssignImageParts,
  mapSessionToWatchStatus,
  resolveAssignDirectory,
  extractAssignSessionModel,
  resolveAssignWorkerModel,
  sanitizeAssignFileParts,
} from './assign.js';
import { runContactTurn as defaultRunContactTurn } from './harness.js';
import { loadConnectedCatalog } from '../llm/catalog.js';

const require = createRequire(import.meta.url);
const SCHEMA_VERSION = 13;
const normalizeSessionDirectory = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  let resolved = trimmed;
  try { resolved = fs.realpathSync(trimmed); } catch { /* Keep the original path when realpath is unavailable. */ }
  const normalized = resolved.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized || null;
};
const directoryContained = (candidate, root) => {
  const left = normalizeSessionDirectory(candidate);
  const right = normalizeSessionDirectory(root);
  if (!left || !right) return false;
  return left === right || left.startsWith(`${right}/`);
};
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
/** Bound catalog / project list waits so a contact lane cannot hang forever. */
export const CONTACT_CATALOG_DEADLINE_MS = 8_000;
/** Bound last worker assistant text injected into assigned-session resume prompts. */
export const ASSIGNED_SESSION_RESUME_WORKER_TEXT_MAX = 2_000;
/** Stable resume turn/message id for assigned-session complete/error/cancelled continuation. */
export const assignedSessionResumeMessageID = (assistantID, sessionID, status, updatedAt) => (
  `resume_${assistantID}_${sessionID}_${status}_${updatedAt}`
);
const assignedSessionResumeStatus = (status) => status === 'complete' || status === 'error' || status === 'cancelled';
const awaitWithDeadline = async (work, ms = CONTACT_CATALOG_DEADLINE_MS, code = 'upstream_error') => {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(() => work),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(code);
          error.code = code;
          reject(error);
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export const createAssistantsService = ({ dbPath, dataDir, buildOpenCodeUrl, getOpenCodeAuthHeaders, getServerId = async () => null, getAllowedRoots = () => [], listProjects = async () => [], readModelPreferences = async () => null, listScheduledTasks = null, sessionIndexService = null, upsertScheduledTask = null, syncScheduledTaskProject = null, globalEventHub = null, onRevisionTip = null, onContactTurnEvent = null, onContactTurnComplete = null, clock = () => Date.now(), setIntervalFn = setInterval, clearIntervalFn = clearInterval, setImmediateFn = setImmediate, reconcileIntervalMs = 60_000, clientFactory, createChatCompletion = null, runContactTurn = defaultRunContactTurn, listWorktrees = defaultListWorktrees } = {}) => {
  if (!dbPath || !dataDir) return null;
  const Database = require('better-sqlite3');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath); db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = ON');
  let closed = false;
  const shareReservations = new Map();
  // Process-local contact-turn activity. Not durable across server restart —
  // a new process starts empty so working cannot stick green forever. APP
  // restart rehydrates from snapshot while this process still holds the turn.
  const activeContactTurnsByAssistant = new Map();
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
    CREATE TABLE IF NOT EXISTS assistant_message_backfill (assistant_id TEXT NOT NULL, session_id TEXT NOT NULL, cursor TEXT, complete INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY (assistant_id, session_id));
    CREATE TABLE IF NOT EXISTS assistant_scheduled_task (
      assistant_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (assistant_id, project_id, task_id)
    );
    CREATE INDEX IF NOT EXISTS assistant_scheduled_task_assistant
      ON assistant_scheduled_task(assistant_id, created_at DESC);`);
  ensureContactSchema(db);
  ensureContactAttachmentSchema(db);
  // Background legacy data-URL → descriptor migration (cancelable; never touches foreign DBs).
  const contactAttachmentMigration = { controller: new AbortController(), promise: null };
  contactAttachmentMigration.promise = Promise.resolve().then(() => migrateContactDataUrlParts({
    db,
    dataDir,
    signal: contactAttachmentMigration.controller.signal,
    yieldFn: () => new Promise((resolve) => setImmediateFn(resolve)),
  })).catch((error) => {
    if (error?.name !== 'AbortError' && !closed) {
      // Diagnostics only — never throw into boot.
      console.warn('[assistants] contact attachment migration:', error?.code || error?.message || error);
    }
    return { migrated: 0, failed: 0, scanned: 0, failures: [], error: error?.code || error?.message };
  });
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
  const activeContactTurnsFor = (assistantID) => activeContactTurnsByAssistant.get(assistantID) ?? new Map();
  const rememberActiveContactTurn = (assistantID, input) => {
    const next = createActiveContactTurn(input);
    if (!next) return null;
    const turns = activeContactTurnsFor(assistantID);
    turns.set(next.turnID, next);
    activeContactTurnsByAssistant.set(assistantID, turns);
    return next;
  };
  const markActiveContactTurnRunning = (assistantID, turnID) => {
    const turns = activeContactTurnsFor(assistantID);
    const current = turns.get(turnID);
    if (!current) return null;
    if (current.status === 'running') return current;
    const next = createActiveContactTurn({ ...current, status: 'running' });
    if (!next) return null;
    turns.set(turnID, next);
    activeContactTurnsByAssistant.set(assistantID, turns);
    // queued → running must tip snapshot so clients poll authoritative status.
    bump();
    return next;
  };
  const settleActiveContactTurn = (assistantID, turnID, { bumpRevision = false } = {}) => {
    const turns = activeContactTurnsFor(assistantID);
    if (!turns.has(turnID)) {
      if (bumpRevision) bump();
      return false;
    }
    turns.delete(turnID);
    if (turns.size === 0) activeContactTurnsByAssistant.delete(assistantID);
    else activeContactTurnsByAssistant.set(assistantID, turns);
    // Error paths may not persist assistant rows; still tip the snapshot so
    // list green dots clear without waiting for a later SQLite write.
    if (bumpRevision) bump();
    return true;
  };
  const clearActiveContactTurns = (assistantID) => {
    if (assistantID == null) {
      activeContactTurnsByAssistant.clear();
      return;
    }
    activeContactTurnsByAssistant.delete(assistantID);
  };
  const output = (row, latestMessagePreview, unreadSnapshot) => {
    const watches = listInFlightWatches(db, row.assistant_id);
    const activeContactTurn = projectActiveContactTurn(activeContactTurnsFor(row.assistant_id));
    const preview = latestMessagePreview !== undefined
      ? latestMessagePreview
      : getLatestContactMessagePreview(db, row.assistant_id);
    const unread = unreadSnapshot !== undefined && unreadSnapshot !== null
      ? unreadSnapshot
      : (getContactUnreadSnapshots(db, [row.assistant_id]).get(row.assistant_id) ?? {
        unreadCount: 0,
        readWatermark: getContactReadWatermark(db, row.assistant_id),
        readTip: getContactReadTip(db, row.assistant_id),
      });
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
      // Grok-Bot list green dot: contact turn only. Assigned-session busy stays
      // on the session card / assignedSessionIDs and must not keep the avatar lit.
      working: activeContactTurn != null,
      activeContactTurn,
      // Contact-transcript list desc: authoritative last visible bubble (not
      // defaultPrompt / updatedAt). null when the contact has no list-visible rows.
      latestMessagePreview: preview ?? null,
      // Shared multi-client unread: countable assistant/peer replies after watermark.
      unreadCount: Number(unread.unreadCount) || 0,
      // Persisted shared watermark (generation + keyset). Clients POST this tip safely.
      readWatermark: unread.readWatermark,
      // Highest readable tip for safe mark-read report (transcript head + generation).
      readTip: unread.readTip,
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
  const validateParts = (parts) => {
    if (!validAssistantDeliveryParts(parts, { allowAttachmentRefs: true })) fail('validation_error');
  };
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
    // v13: shared contact read watermark. Legacy transcripts default to fully read
    // so existing installs do not flash unread on upgrade; later messages count.
    migrateContactReadStateDefaultRead(db, { updatedAt: now() });
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
  const isUserAbort = (error) => error?.name === 'MessageAbortedError';
  const assignedResumes = new Map();
  const contactControllers = new Map();
  // Last UI locale seen from a client per assistant. Background notifications
  // (assigned-session settle) have no request locale, so they recall this value.
  const contactTurnLanguages = new Map();
  const cancelAssignedResumes = ({ sessionID, assistantID, statuses } = {}) => {
    for (const resume of assignedResumes.values()) {
      if (sessionID && resume.sessionID !== sessionID) continue;
      if (assistantID && resume.assistantID !== assistantID) continue;
      if (statuses && !statuses.includes(resume.status)) continue;
      resume.controller.abort();
    }
  };
  // Abort-request lifecycle only (stop_session). Concurrent same-session aborts share one promise.
  // Observed SSE terminals are stashed until abort settles so resume=true cannot beat resume=false.
  const sessionAbortInflight = new Map();
  const abortTerminalRank = (status) => {
    if (status === 'cancelled') return 3;
    if (status === 'error') return 2;
    if (status === 'complete') return 1;
    return 0;
  };
  const stashSessionAbortTerminal = (entry, status, resume) => {
    if (!entry || typeof status !== 'string' || !status) return;
    const nextRank = abortTerminalRank(status);
    if (nextRank <= 0) return;
    const prev = entry.observed;
    const prevRank = prev ? abortTerminalRank(prev.status) : -1;
    // cancelled wins over complete/error; error wins over complete; equal rank keeps latest.
    if (nextRank > prevRank || (nextRank === prevRank && (status === 'cancelled' || nextRank > 0))) {
      entry.observed = { status, resume: resume !== false };
      if (status === 'cancelled') entry.observed.resume = resume !== false;
    }
  };
  const settleStatusFromEvent = (payload, properties) => {
    if (payload.type === 'session.error') return isUserAbort(properties.error) ? 'cancelled' : 'error';
    if (payload.type === 'question.asked' || payload.type === 'permission.asked') return 'question';
    if (payload.type === 'session.idle') return 'complete';
    if (payload.type === 'session.status') {
      const statusType = typeof properties.status?.type === 'string' ? properties.status.type : typeof properties.info?.type === 'string' ? properties.info.type : '';
      if (statusType === 'busy' || statusType === 'retry') return 'busy';
      if (statusType === 'idle') return 'complete';
    }
    return null;
  };
  // Assigned-session complete/error/cancelled resumes the contact LLM (no canned settle bubble).
  // Assigned after inContactTurnLane exists; reportAssignedSession only schedules via this ref.
  const assignedSessionResumeRef = { schedule: null };
  const reportAssignedSession = (sessionID, status, resume = true) => {
    const inflight = sessionAbortInflight.get(sessionID);
    if (inflight) {
      // Defer watch terminal + continuation until stop_session abort settles.
      stashSessionAbortTerminal(inflight, status, resume);
      return false;
    }
    // Drop complete/error notifies for this worker. Do not abort a cancelled
    // interrupt notify — duplicate cancelled reports (boot+timer, error+message.updated)
    // must still reach the contact LLM.
    if (status === 'cancelled') cancelAssignedResumes({ sessionID, statuses: ['complete', 'error'] });
    const watches = listWatchesBySession(db, sessionID);
    if (watches.length === 0) return false;
    let changed = false;
    const resumes = [];
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const watch of watches) {
        if (watch.status === status || watch.status === 'cancelled') continue;
        // session.idle / status idle follow session.error. Do not rewrite 失败 as 完成.
        if (status === 'complete' && watch.status === 'error') continue;
        const updatedAt = now();
        updateSessionCardStatus(db, { assistantID: watch.assistantID, sessionID, status });
        upsertContactWatch(db, {
          assistantID: watch.assistantID,
          sessionID,
          directory: watch.directory,
          status,
          updatedAt,
          resumeAllowed: watch.resumeAllowed,
        });
        // complete/error/user-interrupt cancelled: hand result back to contact LLM.
        // question: card only (worker waiting). stop_session passes resume=false.
        // Never insert oc.settle.* canned transcript bubbles.
        if (resume && watch.resumeAllowed && assignedSessionResumeStatus(status)) {
          resumes.push({
            assistantID: watch.assistantID,
            sessionID,
            status,
            directory: watch.directory,
            updatedAt,
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
    // processEvent stays sync; resume runs on the contact turn lane asynchronously.
    if (typeof assignedSessionResumeRef.schedule === 'function') {
      for (const resume of resumes) assignedSessionResumeRef.schedule(resume);
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
    if (session?.error) return isUserAbort(session.error) ? 'cancelled' : 'error';
    const statusType = sessionStatusType(session);
    if (statusType === 'busy' || statusType === 'retry') return null;
    if (isMissing(messagesResult)) return 'complete';
    const assistant = messagesResult && !messagesResult.error ? lastAssistantInfo(messagesResult.data) : null;
    if (assistant?.error) return isUserAbort(assistant.error) ? 'cancelled' : 'error';
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
      const cancelled = info.role === 'assistant' && isUserAbort(info.error)
        ? reportAssignedSession(sessionID, 'cancelled') : false;
      const assistants = mappedAssistants(sessionID); for (const assistantID of assistants) { const current = assistant(assistantID)?.current_session_id === sessionID; mirrorMessage(assistantID, sessionID, info, undefined, current); if (!current) invalidateBackfill(assistantID, sessionID); } return cancelled || assistants.length > 0;
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
  const userContactParts = async (assistantID, input, userText) => {
    const parts = [];
    let turnBytes = 0;
    if (Array.isArray(input.parts)) {
      for (const part of input.parts) {
        const parsed = parseContactPart(part);
        if (parsed?.type === 'text' && parsed.text.trim()) {
          parts.push({ type: 'text', text: parsed.text });
          continue;
        }
        if (parsed?.type !== 'file') continue;
        if (parsed.attachmentID) {
          let row;
          try {
            // Admission: current-generation ownership + canonical row rebuild (ignore client meta).
            row = assertContactAttachmentReadable(db, { attachmentID: parsed.attachmentID, assistantID });
          } catch (error) {
            fail(error?.code === 'not_found' ? 'not_found' : 'validation_error', error?.message);
          }
          const descriptor = canonicalDescriptorFromRow(row);
          turnBytes += descriptor.size || 0;
          if (turnBytes > CONTACT_ATTACHMENT_TURN_BUDGET_BYTES) {
            fail('validation_error', 'Contact attachment total exceeds 50MiB budget');
          }
          parts.push(descriptor);
          continue;
        }
        if (typeof parsed.url === 'string' && parsed.url.startsWith('data:')) {
          try {
            const descriptor = await ingestDataUrlFilePart({
              db,
              dataDir,
              assistantID,
              part: parsed,
              clock: now,
              mode: 'admission',
            });
            // Re-check generation after await.
            const row = assertContactAttachmentReadable(db, {
              attachmentID: descriptor.attachmentID,
              assistantID,
            });
            const canonical = canonicalDescriptorFromRow(row);
            turnBytes += canonical.size || 0;
            if (turnBytes > CONTACT_ATTACHMENT_TURN_BUDGET_BYTES) {
              fail('validation_error', 'Contact attachment total exceeds 50MiB budget');
            }
            parts.push(canonical);
          } catch (error) {
            fail(error?.code || 'validation_error', error?.message);
          }
          continue;
        }
        fail('validation_error', 'File parts require attachmentID or data URL');
      }
    }
    if (parts.length === 0 && userText) parts.push({ type: 'text', text: userText });
    return parts;
  };
  /** Admit the user row only — HTTP 202 returns here; assistant bubbles persist as they publish. */
  const admitContactUser = (assistantID, { userMessageID, userText, userParts, turnID }) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      insertContactMessage(db, {
        messageID: userMessageID,
        assistantID,
        role: 'user',
        turnID,
        bubbleIndex: 0,
        createdAt: now(),
        ordinal: nextContactOrdinal(db, assistantID),
        status: 'complete',
        parts: Array.isArray(userParts) && userParts.length > 0 ? userParts : [{ type: 'text', text: userText }],
      });
      bump();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  /** Durable failure bubble so APP restart can recover error without SSE. */
  const persistContactTurnFailure = (assistantID, { userMessageID, turnID, error }) => {
    const detail = typeof error === 'string' && error.trim() ? error.trim() : 'upstream_error';
    const failureID = `${userMessageID}:error`;
    if (getContactMessage(db, failureID)) return;
    db.exec('BEGIN IMMEDIATE');
    try {
      insertContactMessage(db, {
        messageID: failureID,
        assistantID,
        role: 'assistant',
        turnID,
        bubbleIndex: 0,
        createdAt: now(),
        ordinal: nextContactOrdinal(db, assistantID),
        status: 'error',
        parts: [{ type: 'text', text: detail }],
      });
      bump();
      db.exec('COMMIT');
    } catch (writeError) {
      db.exec('ROLLBACK');
      throw writeError;
    }
  };
  const contactBubbleMessageID = (userMessageID, bubbleIndex) => `${userMessageID}:bubble:${bubbleIndex + 1}`;
  const contactCardMessageID = (userMessageID, index) => `${userMessageID}:card:${index + 1}`;

  const persistPublishedContactBubble = (assistantID, { userMessageID, turnID, bubbleIndex, text }) => {
    const trimmed = typeof text === 'string' ? text.trim() : '';
    if (!trimmed || trimmed.startsWith('oc.settle.')) return false;
    const bubbleID = contactBubbleMessageID(userMessageID, bubbleIndex);
    if (getContactMessage(db, bubbleID)) return false;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (getContactMessage(db, bubbleID)) {
        db.exec('COMMIT');
        return false;
      }
      insertContactMessage(db, {
        messageID: bubbleID,
        assistantID,
        role: 'assistant',
        turnID,
        bubbleIndex,
        createdAt: now(),
        ordinal: nextContactOrdinal(db, assistantID),
        status: 'complete',
        parts: [{ type: 'text', text: trimmed }],
      });
      bump();
      db.exec('COMMIT');
      return true;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };

  const persistPublishedContactCard = (assistantID, { userMessageID, turnID, index, card: cardInput }) => {
    const card = parseContactCard({ type: 'card', cardType: cardInput?.cardType || 'session', ...cardInput });
    if (!card) return false;
    const cardID = contactCardMessageID(userMessageID, index);
    if (getContactMessage(db, cardID)) return false;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (getContactMessage(db, cardID)) {
        db.exec('COMMIT');
        return false;
      }
      insertContactMessage(db, {
        messageID: cardID,
        assistantID,
        role: 'assistant',
        turnID,
        bubbleIndex: 0,
        createdAt: now(),
        ordinal: nextContactOrdinal(db, assistantID),
        status: 'complete',
        parts: [card],
      });
      if (card.cardType === 'session' && card.sessionID) {
        upsertContactWatch(db, {
          assistantID,
          sessionID: card.sessionID,
          directory: card.directory,
          status: card.status === 'error' || card.status === 'question' || card.status === 'complete' ? card.status : 'busy',
          updatedAt: now(),
        });
      }
      bump();
      db.exec('COMMIT');
      return true;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };

  const publishContactBubbleDelta = ({
    assistantID, turnID, userMessageID, spokenByIndex, bubbleIndex, delta, done, signal,
  }) => {
    if (signal?.aborted) return;
    const chunk = typeof delta === 'string' ? delta : '';
    if (chunk) spokenByIndex.set(bubbleIndex, `${spokenByIndex.get(bubbleIndex) || ''}${chunk}`);
    emitContactTurnEvent('openchamber:contact-bubble-delta', {
      assistantID,
      turnID,
      bubbleIndex,
      delta: chunk,
      done: Boolean(done),
    });
    if (!done) return;
    try {
      persistPublishedContactBubble(assistantID, {
        userMessageID,
        turnID,
        bubbleIndex,
        text: spokenByIndex.get(bubbleIndex) || '',
      });
    } catch {
      // Publishing a spoken bubble must not abort the live turn.
    }
  };

  const rememberPublishedContactCard = (assistantID, { userMessageID, turnID, assignedCards, card }) => {
    assignedCards.push(card);
    try {
      persistPublishedContactCard(assistantID, {
        userMessageID,
        turnID,
        index: assignedCards.length - 1,
        card,
      });
    } catch {
      // Publishing a card must not abort the live turn.
    }
  };

  /** Persist remaining assistant bubbles/cards for an already-admitted user turn (no user row). */
  const persistContactAssistantReply = (assistantID, {
    userMessageID, bubbles, cards = [], turnID, reset = false,
  }) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      // Successful new_conversation / clear_chat_history: drop this turn's pre-reset
      // spoken/card rows so the unique confirm can own bubble:1 (same id is not skipped).
      if (reset) {
        deleteContactTurnAssistantOutputs(db, assistantID, turnID);
      }
      let ordinal = nextContactOrdinal(db, assistantID);
      bubbles.forEach((text, index) => {
        const bubbleID = contactBubbleMessageID(userMessageID, index);
        if (getContactMessage(db, bubbleID)) return;
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
        ordinal += 1;
      });
      cards.forEach((cardInput, index) => {
        const card = parseContactCard({ type: 'card', cardType: cardInput?.cardType || 'session', ...cardInput });
        if (!card) return;
        const cardID = contactCardMessageID(userMessageID, index);
        if (getContactMessage(db, cardID)) return;
        insertContactMessage(db, {
          messageID: cardID,
          assistantID,
          role: 'assistant',
          turnID,
          bubbleIndex: 0,
          createdAt: now(),
          ordinal,
          status: 'complete',
          parts: [card],
        });
        ordinal += 1;
        if (card.cardType === 'session' && card.sessionID) {
          upsertContactWatch(db, {
            assistantID,
            sessionID: card.sessionID,
            directory: card.directory,
            status: card.status === 'error' || card.status === 'question' || card.status === 'complete' ? card.status : 'busy',
            updatedAt: now(),
          });
        }
      });
      bump();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const notifyContactTurn = ({ assistantID, name, turnID, status, body }) => {
    if (typeof onContactTurnComplete !== 'function' || closed) return;
    try {
      const result = onContactTurnComplete({
        assistantID,
        name,
        turnID,
        status,
        body: typeof body === 'string' ? body : '',
      });
      if (result && typeof result.then === 'function') {
        result.catch(() => { /* Notification fanout must not fail the turn. */ });
      }
    } catch {
      // Notification fanout must not fail the turn.
    }
  };
  const emitContactTurnEvent = (type, properties) => {
    if (typeof onContactTurnEvent !== 'function' || closed) return;
    const payload = { type, properties: { ...properties, occurredAt: properties?.occurredAt ?? now() } };
    queueMicrotask(() => {
      if (!closed) {
        try { onContactTurnEvent(payload); } catch { /* SSE fan-out must not break the turn. */ }
      }
    });
  };
  // Serialize contact turns per assistant so rapid sends do not interleave persist.
  const contactTurnLanes = new Map();
  const inContactTurnLane = (assistantID, task) => {
    const previous = contactTurnLanes.get(assistantID) ?? Promise.resolve();
    let tail;
    const run = previous.catch(() => {}).then(task);
    tail = run.catch(() => {}).finally(() => {
      if (contactTurnLanes.get(assistantID) === tail) contactTurnLanes.delete(assistantID);
    });
    contactTurnLanes.set(assistantID, tail);
    return run;
  };
  // In-process test hook — never included in the HTTP JSON body.
  const contactTurnSettlements = new Map();
  const contactTurnSettlement = (messageID) => {
    let entry = contactTurnSettlements.get(messageID);
    if (!entry) {
      let resolve;
      const promise = new Promise((settled) => { resolve = settled; });
      entry = { promise, resolve };
      contactTurnSettlements.set(messageID, entry);
    }
    return entry;
  };
  const whenContactTurnSettled = (messageID) => contactTurnSettlement(messageID).promise;
  const resolveContactTurnSettlement = (messageID, result) => {
    contactTurnSettlement(messageID).resolve(result);
  };
  const loadAssignCatalog = async (signal) => {
    try {
      // Catalog owns its 8s AbortSignal deadline; optional parent signal is forwarded.
      return await loadConnectedCatalog(client(), {
        timeoutMs: CONTACT_CATALOG_DEADLINE_MS,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      const wrapped = new AssignError(
        ASSIGN_CODES.UPSTREAM,
        typeof error?.message === 'string' && error.message.trim()
          ? error.message.trim()
          : 'Connected model catalog is unavailable.',
      );
      throw wrapped;
    }
  };
  const loadContactModelContext = async (signal) => {
    const [catalogResult, preferencesResult] = await Promise.allSettled([
      loadAssignCatalog(signal),
      awaitWithDeadline(Promise.resolve().then(() => readModelPreferences()), CONTACT_CATALOG_DEADLINE_MS, 'upstream_error'),
    ]);
    const catalog = catalogResult.status === 'fulfilled' ? catalogResult.value : null;
    const providerNames = new Map((catalog?.providers || []).map((provider) => [provider.id, provider.name]));
    const preferences = preferencesResult.status === 'fulfilled' ? preferencesResult.value : null;
    return {
      connectedModels: normalizeConnectedModels((catalog?.models || []).map((model) => ({ ...model, providerName: providerNames.get(model.providerID) }))),
      modelCatalogAvailable: catalog !== null,
      modelPreferences: preferences && typeof preferences === 'object' ? {
        favoriteModels: Array.isArray(preferences.favoriteModels) ? preferences.favoriteModels.slice(0, 64) : [],
        recentModels: Array.isArray(preferences.recentModels) ? preferences.recentModels.slice(0, 16) : [],
      } : null,
    };
  };
  const loadRegisteredProjects = async () => {
    const listed = await awaitWithDeadline(listProjects(), CONTACT_CATALOG_DEADLINE_MS, 'upstream_error');
    if (!Array.isArray(listed)) {
      throw new AssignError(ASSIGN_CODES.UPSTREAM, 'Registered project catalog failed to load.');
    }
    return listed;
  };
  /**
   * Confirm whether an assign prompt message was admitted on the worker session.
   * Prefer SDK exact lookup (v2.session.message → session.message), then bounded messages list.
   * Returns { found: true|false } for assignSession; throws/unavailable become null via assign.
   */
  const lookupAssignMessage = async ({ sessionID, messageID, directory, signal } = {}) => {
    if (typeof sessionID !== 'string' || !sessionID || typeof messageID !== 'string' || !messageID) {
      return { found: false };
    }
    const api = client();
    const options = signal ? { signal } : undefined;
    const identity = (record) => (
      record?.info?.id || record?.id || record?.messageID || record?.message?.id || null
    );
    const viaExact = async (fn, target) => {
      if (typeof fn !== 'function') return null;
      try {
        const result = await fn.call(target, { sessionID, messageID, ...(directory ? { directory } : {}) }, options);
        const status = result?.error?.status ?? result?.error?.statusCode ?? result?.status ?? result?.response?.status;
        if (result?.error) {
          if (status === 404) return { found: false };
          if (status === 405 || status === 501) return null;
          return null;
        }
        const record = result?.data ?? result;
        const id = identity(record);
        return { found: id === messageID };
      } catch {
        return null;
      }
    };
    const v2 = await viaExact(api?.v2?.session?.message, api?.v2?.session);
    if (v2) return v2;
    const legacy = await viaExact(api?.session?.message, api?.session);
    if (legacy) return legacy;
    try {
      const listed = await api.session.messages({
        sessionID,
        ...(directory ? { directory } : {}),
        limit: 100,
      }, options);
      if (listed?.error) return { found: false };
      const rows = Array.isArray(listed?.data) ? listed.data : (Array.isArray(listed) ? listed : []);
      const hit = rows.some((row) => identity(row) === messageID);
      return { found: hit };
    } catch {
      return null;
    }
  };
  /**
   * Best-effort previous worker model for a reused sessionID.
   * session.get → session.model, else newest message info.model. Never throws / never fails assign.
   */
  const lookupReusedSessionModel = async ({ sessionID, directory, signal } = {}) => {
    if (typeof sessionID !== 'string' || !sessionID.trim()) return null;
    const api = client();
    const options = signal ? { signal } : undefined;
    const dir = typeof directory === 'string' && directory.trim() ? directory.trim() : null;
    try {
      const got = await api.session.get({
        sessionID,
        ...(dir ? { directory: dir } : {}),
      }, options);
      if (got?.error) return null;
      const sessionPayload = got?.data ?? got;
      let messages = null;
      const fromSession = extractAssignSessionModel({ session: sessionPayload });
      if (fromSession) return fromSession;
      try {
        if (typeof api.session.messages !== 'function') return null;
        const listed = await api.session.messages({
          sessionID,
          ...(dir ? { directory: dir } : {}),
          limit: 40,
        }, options);
        if (listed?.error) return null;
        messages = listed?.data ?? listed;
      } catch {
        return null;
      }
      return extractAssignSessionModel({ session: sessionPayload, messages });
    } catch {
      return null;
    }
  };
  /**
   * Find a session row in the OpenChamber session index (directory is index-authoritative).
   * Index failure throws — never silent empty.
   */
  const findSessionInIndex = (sessionID) => {
    if (!sessionIndexService || typeof sessionIndexService.snapshot !== 'function') {
      return null;
    }
    let snapshot;
    try {
      snapshot = sessionIndexService.snapshot();
    } catch (error) {
      throw new AssignError(
        ASSIGN_CODES.UPSTREAM,
        typeof error?.message === 'string' && error.message.trim()
          ? error.message.trim()
          : 'Session index snapshot failed.',
      );
    }
    if (!snapshot || !Array.isArray(snapshot.directories)) {
      throw new AssignError(ASSIGN_CODES.UPSTREAM, 'Session index snapshot failed.');
    }
    for (const directory of snapshot.directories) {
      const dir = typeof directory?.directory === 'string' ? directory.directory : '';
      if (!dir) continue;
      for (const session of Array.isArray(directory.sessions) ? directory.sessions : []) {
        if (!session || typeof session.id !== 'string' || session.id !== sessionID) continue;
        return {
          sessionID,
          directory: dir,
          title: typeof session.title === 'string' ? session.title : null,
          updatedAt: typeof session.time?.updated === 'number'
            ? session.time.updated
            : (typeof session.updatedAt === 'number' ? session.updatedAt : 0),
        };
      }
    }
    return null;
  };
  /**
   * Resolve an existing OpenCode session for watch / stop / assign-reuse.
   * Authority order: session index directory → session.get metadata → registered project.
   * User-supplied directory/projectPath is a lookup hint only — never trusted as scope.
   * Failures stay failures (not empty success).
   */
  const resolveReferencedSession = async ({
    sessionID: rawSessionID,
    directoryHint = null,
    titleHint = null,
    signal,
    includeMessages = true,
  } = {}) => {
    const sessionID = typeof rawSessionID === 'string' ? rawSessionID.trim() : '';
    if (!sessionID) {
      throw new AssignError(ASSIGN_CODES.VALIDATION, 'sessionID is required.');
    }
    const options = signal ? { signal } : undefined;
    const indexRow = findSessionInIndex(sessionID);
    const hint = typeof directoryHint === 'string' && directoryHint.trim()
      ? directoryHint.trim()
      : null;
    // Prefer index directory; user path is last-resort get hint only.
    const getHints = [];
    if (indexRow?.directory) getHints.push(indexRow.directory);
    if (hint && !getHints.some((item) => directoryContained(item, hint) || directoryContained(hint, item))) {
      getHints.push(hint);
    }
    if (getHints.length === 0) getHints.push(null);

    let getResult = null;
    let usedDirectoryHint = null;
    let lastError = null;
    for (const dir of getHints) {
      try {
        getResult = await client().session.get({
          sessionID,
          ...(dir ? { directory: dir } : {}),
        }, options);
        usedDirectoryHint = dir;
        if (getResult && !getResult.error) break;
        if (isMissing(getResult)) {
          getResult = { missing: true, error: getResult?.error };
          break;
        }
        // Non-404 error with a directory may be wrong scope — try next hint.
        if (getResult?.error && dir) {
          lastError = getResult.error;
          getResult = null;
          continue;
        }
        break;
      } catch (error) {
        lastError = error;
        getResult = null;
      }
    }
    if (!getResult) {
      throw new AssignError(
        ASSIGN_CODES.UPSTREAM,
        typeof lastError?.message === 'string' && lastError.message.trim()
          ? lastError.message.trim()
          : 'Failed to load that coding session.',
      );
    }
    if (getResult.missing || isMissing(getResult)) {
      throw new AssignError(ASSIGN_CODES.NOT_FOUND, `No coding session ${sessionID} was found.`);
    }
    if (getResult.error) {
      throw new AssignError(
        ASSIGN_CODES.UPSTREAM,
        typeof getResult.error?.message === 'string' && getResult.error.message.trim()
          ? getResult.error.message.trim()
          : 'Failed to load that coding session.',
      );
    }
    const sessionPayload = getResult.data ?? getResult;
    const metaDirectory = extractSessionDirectory(sessionPayload);
    const directoryRaw = metaDirectory || indexRow?.directory || usedDirectoryHint;
    if (!directoryRaw) {
      throw new AssignError(
        ASSIGN_CODES.VALIDATION,
        'That session has no resolvable project directory.',
      );
    }
    // Registered project scope = allowed roots (same gate as assign create).
    // Reject managed assistant-workspaces and paths outside Settings projects.
    let directory;
    try {
      directory = resolveAssignDirectory({
        projectPath: directoryRaw,
        directory: directoryRaw,
        branch: null,
        allowedRoots: getAllowedRoots(),
        managedWorkspaceRoot: path.resolve(dataDir, 'assistant-workspaces'),
        worktrees: [],
      });
    } catch (error) {
      if (error instanceof AssignError) throw error;
      throw new AssignError(
        ASSIGN_CODES.WORKSPACE_FORBIDDEN,
        'That session is not under a registered project. Add the project in Settings first.',
      );
    }

    let messagesResult = null;
    if (includeMessages && typeof client().session.messages === 'function') {
      try {
        messagesResult = await client().session.messages({
          sessionID,
          directory,
          limit: 100,
        }, options);
        if (messagesResult?.error && !isMissing(messagesResult)) {
          // Message fetch failure must not invent status; keep messages null.
          messagesResult = null;
        }
      } catch {
        messagesResult = null;
      }
    }
    const messageRows = Array.isArray(messagesResult?.data)
      ? messagesResult.data
      : (Array.isArray(messagesResult) ? messagesResult : null);
    const status = mapSessionToWatchStatus({
      session: sessionPayload,
      messages: messageRows,
      missing: false,
    });
    const title = (typeof titleHint === 'string' && titleHint.trim() ? titleHint.trim() : null)
      || extractSessionTitle(sessionPayload)
      || indexRow?.title
      || sessionID;
    return {
      sessionID,
      directory,
      title,
      status,
      session: sessionPayload,
      messages: messageRows,
    };
  };
  const readSessionWork = async (params = {}) => {
    const limit = params.limit === undefined ? 20 : params.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new AssignError(ASSIGN_CODES.VALIDATION, 'limit must be an integer from 1 to 50.');
    if (params.before !== undefined && (typeof params.before !== 'string' || !params.before || params.before.length > 2048)) throw new AssignError(ASSIGN_CODES.VALIDATION, 'before must be an opaque cursor.');
    const { signal } = params;
    signal?.throwIfAborted();
    const resolved = await resolveReferencedSession({ sessionID: params.sessionID, signal, includeMessages: false });
    const result = await client().session.messages({
      sessionID: resolved.sessionID, directory: resolved.directory, limit,
      ...(params.before ? { before: params.before } : {}),
    }, signal ? { signal } : undefined);
    signal?.throwIfAborted();
    if (isMissing(result)) throw new AssignError(ASSIGN_CODES.NOT_FOUND, 'That session no longer exists.');
    if (result?.error || !Array.isArray(result?.data)) throw new AssignError(ASSIGN_CODES.UPSTREAM, 'Could not read session messages.');
    const rows = result.data;
    if (rows.some((entry) => (entry?.info?.sessionID && entry.info.sessionID !== resolved.sessionID))) throw new AssignError(ASSIGN_CODES.UPSTREAM, 'Session message identity mismatch.');
    let remaining = 24000;
    let partial = rows.length > limit;
    const text = (value) => {
      if (typeof value !== 'string') return '';
      const kept = value.slice(0, Math.min(4000, remaining));
      remaining -= kept.length;
      if (kept.length < value.length) partial = true;
      return kept;
    };
    const messages = rows.slice(-limit).map((entry) => {
      const info = entry.info ?? entry;
      const parts = [];
      const sourceParts = Array.isArray(entry.parts) ? entry.parts : [];
      if (sourceParts.length > 20) partial = true;
      for (const part of sourceParts.slice(0, 20)) {
        if (part.type === 'text') parts.push({ type: 'text', text: text(part.text) });
        else if (part.type === 'file') { parts.push({ type: 'file', mime: part.mime, filename: text(part.filename) }); partial = true; }
        else if (part.type === 'tool') {
          parts.push({ type: 'tool', tool: text(part.tool), status: part.state?.status, output: text(part.state?.output), error: text(part.state?.error) });
          partial = true; // Inputs and binary details are intentionally omitted.
        } else if (part.type !== 'step-start' && part.type !== 'step-finish') partial = true;
      }
      return { messageID: info.id, role: info.role, parts };
    });
    const cursor = result.response?.headers?.get('x-next-cursor');
    const nextCursor = typeof cursor === 'string' && cursor ? cursor : null;
    return { sessionID: resolved.sessionID, directory: resolved.directory, title: resolved.title.slice(0, 500), messages, nextCursor, partial: partial || nextCursor !== null };
  };
  const assignWork = async (row, params = {}) => {
    const fileParts = sanitizeAssignFileParts(params.fileParts || params.parts || []);
    const signal = params.signal;
    const sdkOptions = signal ? { signal } : undefined;
    const explicitModel = Boolean(
      (typeof params.providerID === 'string' && params.providerID.trim())
      || (typeof params.modelID === 'string' && params.modelID.trim())
      || (typeof params.model === 'string' && params.model.trim())
      || (params.model && typeof params.model === 'object'),
    );
    const reuseSessionID = typeof params.sessionID === 'string' && params.sessionID.trim()
      ? params.sessionID.trim()
      : '';
    // Reuse: resolve directory/project from authoritative session metadata first.
    // User projectPath/directory are hints only and never override scope.
    let reuseScope = null;
    if (reuseSessionID) {
      const directoryHint = typeof params.directory === 'string' && params.directory.trim()
        ? params.directory.trim()
        : (typeof params.projectPath === 'string' && params.projectPath.trim()
          ? params.projectPath.trim()
          : null);
      reuseScope = await resolveReferencedSession({
        sessionID: reuseSessionID,
        directoryHint,
        titleHint: typeof params.title === 'string' ? params.title : null,
        signal,
        // Messages only needed when following session model without explicit selection.
        includeMessages: !explicitModel,
      });
    }
    // Reused session without explicit model may follow the session's last model (catalog-gated).
    const followSessionModel = Boolean(reuseSessionID && !explicitModel);
    const needsCatalog = explicitModel || hasAssignImageParts(fileParts) || followSessionModel;
    let catalog = null;
    let sessionModel = null;
    if (needsCatalog) {
      if (followSessionModel && !explicitModel && !hasAssignImageParts(fileParts)) {
        // Session-follow degrades on catalog failure; explicit/image stay fail-closed.
        try {
          catalog = await loadAssignCatalog(signal);
        } catch {
          catalog = null;
        }
      } else {
        catalog = await loadAssignCatalog(signal);
      }
    }
    if (followSessionModel && catalog && reuseScope) {
      sessionModel = extractAssignSessionModel({
        session: reuseScope.session,
        messages: reuseScope.messages,
      });
      if (!sessionModel) {
        sessionModel = await lookupReusedSessionModel({
          sessionID: reuseSessionID,
          directory: reuseScope.directory,
          signal,
        });
      }
    }
    const workerModel = resolveAssignWorkerModel({
      providerID: params.providerID,
      modelID: params.modelID,
      model: params.model,
      fallback: { providerID: row.provider_id, modelID: row.model_id },
      sessionModel,
      catalog,
    });
    let acceptsImages = workerModel.acceptsImages;
    if (hasAssignImageParts(fileParts) && acceptsImages == null && catalog) {
      const entry = catalog.models.find((item) => (
        item?.providerID === workerModel.providerID && item?.modelID === workerModel.modelID
      ));
      acceptsImages = entry?.acceptsImages === true;
    }
    // Worker model is prompt-only. Never mutate the contact assistant row.
    // Forward tool variant + AbortSignal; lookupMessage uses real SDK exact/list paths.
    return assignSession({
      ...params,
      ...(reuseScope ? {
        sessionID: reuseScope.sessionID,
        directory: reuseScope.directory,
        projectPath: reuseScope.directory,
        // Drop untrusted branch when reusing — directory is already authoritative.
        branch: undefined,
        title: typeof params.title === 'string' && params.title.trim()
          ? params.title.trim()
          : reuseScope.title,
      } : {}),
      fileParts,
      ...(params.variant !== undefined ? { variant: params.variant } : {}),
      ...(signal ? { signal } : {}),
      model: {
        providerID: workerModel.providerID,
        modelID: workerModel.modelID,
        source: workerModel.source,
        acceptsImages,
      },
      acceptsImages,
      assistant: output(row),
      defaultProjectPath: row.workspace_path,
      allowedRoots: getAllowedRoots(),
      managedWorkspaceRoot: path.resolve(dataDir, 'assistant-workspaces'),
      listWorktrees,
      createSession: (created) => client().session.create(created, sdkOptions),
      promptExisting: (prompted) => client().session.promptAsync(prompted, sdkOptions),
      deleteSession: (deleted) => (
        typeof client().session.delete === 'function'
          ? client().session.delete(deleted, sdkOptions)
          : undefined
      ),
      lookupMessage: (lookup) => lookupAssignMessage({ ...lookup, signal }),
      messageID: params?.messageID || `msg_assign_${id()}`,
    });
  };
  /** Watch an existing session only — no prompt. Baseline status avoids false settle resume. */
  const watchSessionWork = async (_row, params = {}) => {
    const sessionID = typeof params.sessionID === 'string' ? params.sessionID.trim() : '';
    if (!sessionID) {
      throw new AssignError(ASSIGN_CODES.VALIDATION, 'watch_session requires sessionID.');
    }
    const resolved = await resolveReferencedSession({
      sessionID,
      // directory/projectPath from the model are never trusted as scope authority.
      directoryHint: null,
      titleHint: typeof params.title === 'string' ? params.title : null,
      signal: params.signal,
      includeMessages: true,
    });
    return {
      sessionID: resolved.sessionID,
      directory: resolved.directory,
      title: resolved.title,
      status: resolved.status,
      watched: true,
      reused: true,
    };
  };
  /** Abort an existing coding session via real OpenCode session.abort. */
  const stopSessionWork = async (_row, params = {}) => {
    const sessionID = typeof params.sessionID === 'string' ? params.sessionID.trim() : '';
    if (!sessionID) {
      throw new AssignError(ASSIGN_CODES.VALIDATION, 'stop_session requires sessionID.');
    }
    const resolved = await resolveReferencedSession({
      sessionID,
      directoryHint: null,
      signal: params.signal,
      // Abort does not need messages for baseline.
      includeMessages: false,
    });
    const signal = params.signal;
    signal?.throwIfAborted();
    if (typeof client().session.abort !== 'function') {
      throw new AssignError(ASSIGN_CODES.UPSTREAM, 'Session abort is unavailable.');
    }
    const targetID = resolved.sessionID;
    // Share one abort lifecycle per worker session (register before await abort).
    const existing = sessionAbortInflight.get(targetID);
    if (existing?.promise) {
      const shared = await existing.promise;
      if (shared?.ok) {
        return {
          sessionID: targetID,
          directory: resolved.directory,
          title: resolved.title,
          aborted: true,
        };
      }
      throw shared?.error || new AssignError(ASSIGN_CODES.UPSTREAM, 'Failed to abort that coding session.');
    }
    const entry = { sessionID: targetID, observed: null, promise: null };
    sessionAbortInflight.set(targetID, entry);
    const failAbort = (code, message) => new AssignError(
      code,
      typeof message === 'string' && message.trim() ? message.trim() : 'Failed to abort that coding session.',
    );
    entry.promise = (async () => {
      const sdkOptions = signal ? { signal } : undefined;
      let result;
      try {
        signal?.throwIfAborted();
        result = await client().session.abort({
          sessionID: targetID,
          directory: resolved.directory,
        }, sdkOptions);
      } catch (error) {
        const observed = entry.observed;
        if (sessionAbortInflight.get(targetID) === entry) sessionAbortInflight.delete(targetID);
        if (observed) reportAssignedSession(targetID, observed.status, observed.resume !== false);
        const wrapped = error?.name === 'AbortError' || signal?.aborted
          ? error
          : failAbort(
            ASSIGN_CODES.UPSTREAM,
            typeof error?.message === 'string' ? error.message : '',
          );
        return { ok: false, error: wrapped };
      }
      if (isMissing(result)) {
        const observed = entry.observed;
        if (sessionAbortInflight.get(targetID) === entry) sessionAbortInflight.delete(targetID);
        if (observed) reportAssignedSession(targetID, observed.status, observed.resume !== false);
        return { ok: false, error: failAbort(ASSIGN_CODES.NOT_FOUND, `No coding session ${targetID} was found.`) };
      }
      if (result?.error || result?.data === false) {
        const observed = entry.observed;
        if (sessionAbortInflight.get(targetID) === entry) sessionAbortInflight.delete(targetID);
        if (observed) reportAssignedSession(targetID, observed.status, observed.resume !== false);
        return {
          ok: false,
          error: failAbort(
            ASSIGN_CODES.UPSTREAM,
            typeof result.error?.message === 'string' ? result.error.message : '',
          ),
        };
      }
      // Success (including silent abort with no SSE): release map first so reporter applies.
      if (sessionAbortInflight.get(targetID) === entry) sessionAbortInflight.delete(targetID);
      cancelAssignedResumes({ sessionID: targetID });
      // Assistant already owns this user turn; do not schedule a second cancelled notify.
      reportAssignedSession(targetID, 'cancelled', false);
      return { ok: true };
    })();
    try {
      const outcome = await entry.promise;
      if (outcome?.ok) {
        return {
          sessionID: targetID,
          directory: resolved.directory,
          title: resolved.title,
          aborted: true,
        };
      }
      throw outcome?.error || failAbort(ASSIGN_CODES.UPSTREAM, '');
    } finally {
      if (sessionAbortInflight.get(targetID) === entry) sessionAbortInflight.delete(targetID);
    }
  };
  // Resolve scope from the authoritative session, never model-supplied directories.
  const mutateSessionWork = async (operation, params = {}) => {
    const sessionID = typeof params.sessionID === 'string' ? params.sessionID.trim() : '';
    if (!sessionID) throw new AssignError(ASSIGN_CODES.VALIDATION, `${operation} requires sessionID.`);
    if (operation === 'steer' && (typeof params.text !== 'string' || !params.text.trim())) {
      throw new AssignError(ASSIGN_CODES.VALIDATION, 'steer requires text.');
    }
    const resolved = await resolveReferencedSession({ sessionID, signal: params.signal, includeMessages: false });
    params.signal?.throwIfAborted();
    const session = client().session;
    const method = operation === 'steer' ? 'promptAsync' : operation === 'archive' ? 'update' : 'delete';
    if (typeof session[method] !== 'function') throw new AssignError(ASSIGN_CODES.UPSTREAM, `Session ${operation} is unavailable.`);
    const request = { sessionID, directory: resolved.directory };
    if (operation === 'steer') Object.assign(request, {
      messageID: `msg_steer_${id()}`, delivery: 'steer', parts: [{ type: 'text', text: params.text.trim() }],
    });
    if (operation === 'archive') request.time = { archived: now() };
    let result;
    try {
      result = await session[method](request, params.signal ? { signal: params.signal } : undefined);
    } catch (error) {
      throw new AssignError(ASSIGN_CODES.UPSTREAM, error?.message || `Session ${operation} failed.`);
    }
    if (isMissing(result)) throw new AssignError(ASSIGN_CODES.NOT_FOUND, `No coding session ${sessionID} was found.`);
    if (result?.error || result?.data === false || (operation === 'steer' && !promptAdmitted(result))) {
      // Do not retry an ambiguous prompt submission: it may already be admitted upstream.
      throw new AssignError(ASSIGN_CODES.UPSTREAM, `Session ${operation} was not confirmed. Do not resend automatically.`);
    }
    if (operation !== 'steer') reportAssignedSession(sessionID, 'cancelled');
    return { sessionID, directory: resolved.directory, operation, ...(operation === 'steer' ? { messageID: request.messageID, admitted: true } : { [operation === 'archive' ? 'archived' : 'deleted']: true }) };
  };
  const matchRegisteredProject = async (directory) => {
    const projects = await listProjects();
    const resolved = path.resolve(directory);
    let real = resolved;
    try { real = fs.realpathSync(resolved); } catch { /* Compare the resolved path when realpath is unavailable. */ }
    const contained = (candidate, root) => candidate === root || candidate.startsWith(`${root}${path.sep}`);
    for (const project of Array.isArray(projects) ? projects : []) {
      const sanitized = sanitizeRegisteredProject(project);
      if (!sanitized) continue;
      let projectPath = path.resolve(sanitized.path);
      try { projectPath = fs.realpathSync(projectPath); } catch { /* Keep the resolved project path. */ }
      if (projectPath === real || contained(real, projectPath)) {
        return { id: sanitized.id, path: projectPath, ...(sanitized.label ? { label: sanitized.label } : {}) };
      }
    }
    return null;
  };
  const recordAssistantScheduledTask = (assistantID, projectID, taskID) => {
    if (typeof assistantID !== 'string' || !assistantID.trim()) return;
    if (typeof projectID !== 'string' || !projectID.trim()) return;
    if (typeof taskID !== 'string' || !taskID.trim()) return;
    db.prepare(
      'INSERT OR IGNORE INTO assistant_scheduled_task(assistant_id, project_id, task_id, created_at) VALUES (?,?,?,?)',
    ).run(assistantID, projectID, taskID, now());
  };
  const scheduleWork = async (row, params) => {
    if (typeof upsertScheduledTask !== 'function') {
      throw new AssignError(ASSIGN_CODES.UPSTREAM, 'Scheduling a task is unavailable.');
    }
    const projectDirectory = resolveAssignDirectory({
      projectPath: params?.projectPath,
      directory: params?.directory,
      branch: null,
      allowedRoots: getAllowedRoots(),
      managedWorkspaceRoot: path.resolve(dataDir, 'assistant-workspaces'),
      defaultProjectPath: row.workspace_path,
    });
    const project = await matchRegisteredProject(projectDirectory);
    if (!project) {
      throw new AssignError(
        ASSIGN_CODES.PROJECT_REQUIRED,
        'Choose a registered project path. Several projects are configured; schedule_task cannot guess.',
      );
    }
    const kind = typeof params?.kind === 'string' && params.kind.trim() ? params.kind.trim() : 'daily';
    const weekdays = Array.isArray(params?.weekdays)
      ? params.weekdays
      : typeof params?.weekdays === 'string'
        ? params.weekdays.split(',').map((item) => Number(item.trim())).filter((item) => Number.isInteger(item))
        : undefined;
    const upserted = await upsertScheduledTask(project.id, {
      name: params.name,
      enabled: true,
      schedule: {
        kind,
        ...(params.time ? { time: params.time } : {}),
        ...(params.timezone ? { timezone: params.timezone } : {}),
        ...(params.date ? { date: params.date } : {}),
        ...(weekdays && weekdays.length > 0 ? { weekdays } : {}),
        ...(params.cron ? { cron: params.cron } : {}),
      },
      execution: {
        prompt: params.prompt,
        providerID: params.providerID,
        modelID: params.modelID,
      },
    });
    const taskID = upserted?.task?.id;
    if (typeof taskID === 'string' && taskID.trim()) {
      recordAssistantScheduledTask(row.assistant_id, project.id, taskID);
    }
    if (typeof syncScheduledTaskProject === 'function') {
      try { await syncScheduledTaskProject(project.id); } catch { /* Card persistence does not depend on scheduler sync. */ }
    }
    return {
      task: upserted?.task,
      taskID,
      projectID: project.id,
      name: upserted?.task?.name || params.name,
      kind: upserted?.task?.schedule?.kind || kind,
      time: upserted?.task?.schedule?.time || upserted?.task?.schedule?.times?.[0] || params.time || null,
      timezone: upserted?.task?.schedule?.timezone || params.timezone || null,
      prompt: upserted?.task?.execution?.prompt || params.prompt,
    };
  };
  const listSessionsFromIndex = (params = {}) => {
    if (!sessionIndexService || typeof sessionIndexService.snapshot !== 'function') {
      throw new AssignError(ASSIGN_CODES.UPSTREAM, 'Session index is unavailable.');
    }
    let snapshot;
    try {
      snapshot = sessionIndexService.snapshot();
    } catch (error) {
      throw new AssignError(
        ASSIGN_CODES.UPSTREAM,
        typeof error?.message === 'string' && error.message.trim()
          ? error.message.trim()
          : 'Session index snapshot failed.',
      );
    }
    if (!snapshot || !Array.isArray(snapshot.directories)) {
      throw new AssignError(ASSIGN_CODES.UPSTREAM, 'Session index snapshot failed.');
    }
    const limit = boundSessionListLimit(params.limit);
    const query = typeof params.query === 'string' ? params.query.trim() : '';
    const projectPath = typeof params.projectPath === 'string' ? params.projectPath.trim() : '';
    const projectID = typeof params.projectID === 'string' ? params.projectID.trim() : '';
    const scopeRoots = [];
    if (projectPath) scopeRoots.push(projectPath);
    if (Array.isArray(params.projectRoots)) {
      for (const root of params.projectRoots) {
        if (typeof root === 'string' && root.trim()) scopeRoots.push(root.trim());
      }
    }
    const sessions = [];
    for (const directory of snapshot.directories) {
      const dir = typeof directory?.directory === 'string' ? directory.directory : '';
      if (!dir) continue;
      if (scopeRoots.length > 0 && !scopeRoots.some((root) => directoryContained(dir, root))) continue;
      for (const session of Array.isArray(directory.sessions) ? directory.sessions : []) {
        if (!session || typeof session.id !== 'string' || !session.id) continue;
        const title = typeof session.title === 'string' ? session.title : '';
        const updatedAt = typeof session.time?.updated === 'number'
          ? session.time.updated
          : (typeof session.updatedAt === 'number' ? session.updatedAt : 0);
        const row = {
          sessionID: session.id,
          title,
          directory: dir,
          updatedAt,
        };
        if (query && !matchesProjectQuery({ ...row, id: session.id }, query)) continue;
        sessions.push(row);
      }
    }
    sessions.sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
    const truncated = sessions.length > limit;
    return {
      sessions: sessions.slice(0, limit),
      truncated,
      source: 'session-index',
      ...(projectID ? { projectID } : {}),
    };
  };
  const listSessionsWork = async (params = {}) => {
    const projectPath = typeof params.projectPath === 'string' ? params.projectPath.trim() : '';
    const projectID = typeof params.projectID === 'string' ? params.projectID.trim() : '';
    let projectRoots = [];
    if (projectID || projectPath) {
      let projects;
      try {
        projects = await listProjects();
      } catch (error) {
        throw new AssignError(
          ASSIGN_CODES.UPSTREAM,
          typeof error?.message === 'string' && error.message.trim()
            ? error.message.trim()
            : 'Registered project catalog failed to load.',
        );
      }
      if (!Array.isArray(projects)) {
        throw new AssignError(ASSIGN_CODES.UPSTREAM, 'Registered project catalog failed to load.');
      }
      const normalized = normalizeRegisteredProjects(projects);
      if (projectID) {
        const match = normalized.find((project) => project.id === projectID);
        if (!match) {
          throw new AssignError(ASSIGN_CODES.PROJECT_REQUIRED, `No registered project with id ${projectID}.`);
        }
        projectRoots = [match.path];
      } else if (projectPath) {
        const match = await matchRegisteredProject(projectPath);
        if (match) projectRoots = [match.path];
        else projectRoots = [projectPath];
      }
    }
    return listSessionsFromIndex({
      ...params,
      projectPath: projectRoots[0] || projectPath || undefined,
      projectRoots,
      projectID: projectID || undefined,
    });
  };
  const listAssistantScheduledTasks = async (assistantID) => {
    editable(assistantID);
    const mappings = db.prepare(
      'SELECT assistant_id AS assistantID, project_id AS projectID, task_id AS taskID, created_at AS createdAt FROM assistant_scheduled_task WHERE assistant_id=? ORDER BY created_at DESC, task_id ASC',
    ).all(assistantID);
    if (mappings.length === 0) return { tasks: [] };
    let projects = [];
    try {
      const listed = await listProjects();
      projects = normalizeRegisteredProjects(Array.isArray(listed) ? listed : []);
    } catch {
      // Failed project lookups must not wipe the mapping.
      projects = [];
    }
    const projectByID = new Map(projects.map((project) => [project.id, project]));
    const liveByKey = new Map();
    if (typeof listScheduledTasks === 'function') {
      const projectIDs = [...new Set(mappings.map((row) => row.projectID))];
      await Promise.all(projectIDs.map(async (projectID) => {
        try {
          const tasks = await listScheduledTasks(projectID);
          if (!Array.isArray(tasks)) return;
          for (const task of tasks) {
            if (task && typeof task.id === 'string') liveByKey.set(`${projectID}:${task.id}`, task);
          }
        } catch {
          // Keep the mapping row with task:null when live lookup fails.
        }
      }));
    }
    return {
      tasks: mappings.map((row) => {
        const project = projectByID.get(row.projectID) || null;
        const live = liveByKey.get(`${row.projectID}:${row.taskID}`) || null;
        return {
          assistantID: row.assistantID,
          projectID: row.projectID,
          taskID: row.taskID,
          createdAt: row.createdAt,
          projectPath: project?.path ?? null,
          projectLabel: project?.label ?? null,
          task: live,
        };
      }),
    };
  };
  const findAssignedSessionCardTitle = (assistantID, sessionID) => {
    const rows = db.prepare(
      'SELECT p.part_json FROM assistant_contact_part p JOIN assistant_contact_message m ON m.message_id=p.message_id WHERE m.assistant_id=?',
    ).all(assistantID);
    for (const row of rows) {
      let part;
      try { part = parseContactPart(parse(row.part_json)); } catch { continue; }
      if (part?.type === 'card' && part.cardType === 'session' && part.sessionID === sessionID) {
        return typeof part.title === 'string' && part.title.trim() ? part.title.trim() : null;
      }
    }
    return null;
  };
  const extractLastWorkerAssistantText = (messages, maxChars = ASSIGNED_SESSION_RESUME_WORKER_TEXT_MAX) => {
    if (!Array.isArray(messages)) return '';
    const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : ASSIGNED_SESSION_RESUME_WORKER_TEXT_MAX;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const entry = messages[index];
      const info = entry?.info ?? entry;
      if (info?.role !== 'assistant') continue;
      const parts = Array.isArray(entry?.parts)
        ? entry.parts
        : (Array.isArray(info?.parts) ? info.parts : []);
      const chunks = [];
      for (const part of parts) {
        if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
          chunks.push(part.text.trim());
        }
      }
      if (chunks.length === 0 && typeof info?.content === 'string' && info.content.trim()) {
        chunks.push(info.content.trim());
      }
      if (chunks.length === 0) continue;
      const joined = chunks.join('\n');
      return joined.length > limit ? joined.slice(0, limit) : joined;
    }
    return '';
  };
  const buildAssignedSessionResumeUserText = ({ sessionID, status, title, workerText }) => {
    const lines = [
      '[Internal assigned-session resume — not a user message. Do not quote this block.]',
      `sessionID: ${sessionID}`,
      `status: ${status}`,
    ];
    if (status === 'cancelled') {
      lines.push(
        'reason: user_interrupted',
        'The user manually interrupted this assigned worker session (OpenCode session.abort / MessageAbortedError). This is not a model failure and not an assistant-initiated stop_session.',
      );
    }
    if (title) lines.push(`cardTitle: ${title}`);
    if (workerText) {
      lines.push('lastWorkerAssistantText (bounded):');
      lines.push(workerText);
    } else {
      lines.push('lastWorkerAssistantText: (unavailable)');
    }
    lines.push(
      'Instructions:',
      '- Never tell the user canned phrases like "会话已完成" / "Session finished" / "会话失败" / "Session failed" / "会话已取消" / "Session cancelled".',
      '- This is a read-only result notification, never authorization to create, restart, continue, steer, or otherwise mutate any session or file.',
      '- Respect the latest user instructions in history, including stop/cancel. If work remains, report it and wait for an explicit user request.',
    );
    if (status === 'cancelled') {
      lines.push(
        '- The user interrupted this worker themselves. In the user\'s language, acknowledge that interruption and decide the next spoken step (usually stop here and wait). Do not restart the worker unless history already asked you to.',
      );
    } else {
      lines.push(
        '- If no further work is needed, reply in one or two short sentences in the user\'s language summarizing the result or failure reason.',
      );
    }
    return lines.join('\n');
  };
  /**
   * After assigned worker complete/error/cancelled: async contact-lane continuation.
   * No user transcript row — only internal runContactTurn userText + assistant bubbles/cards.
   */
  const scheduleAssignedSessionResume = ({ assistantID, sessionID, status, directory, updatedAt }) => {
    if (closed) return;
    if (!assignedSessionResumeStatus(status)) return;
    const row = assistant(assistantID);
    if (!row || row.tombstone_at) return;
    const messageID = assignedSessionResumeMessageID(assistantID, sessionID, status, updatedAt);
    const turnID = messageID;
    // Idempotent: same watch status already resumed (bubbles or durable error).
    if (
      getContactMessage(db, `${messageID}:bubble:1`)
      || getContactMessage(db, `${messageID}:error`)
    ) return;

    if (assignedResumes.has(messageID)) return;
    const controller = new AbortController();
    assignedResumes.set(messageID, { assistantID, sessionID, status, controller });
    const finishCancelled = () => {
      settleActiveContactTurn(assistantID, turnID, { bumpRevision: true });
      emitContactTurnEvent('openchamber:contact-turn-end', { assistantID, turnID, status: 'cancelled' });
      resolveContactTurnSettlement(messageID, { status: 'cancelled' });
    };

    rememberActiveContactTurn(assistantID, {
      turnID,
      messageID,
      status: 'queued',
      admittedAt: now(),
    });
    // Tip snapshot so list green dots / 3-dot row rehydrate without waiting for lane start.
    bump();
    emitContactTurnEvent('openchamber:contact-turn-start', {
      assistantID,
      turnID,
      messageID,
    });
    contactTurnSettlement(messageID);

    void inContactTurnLane(assistantID, async () => {
      if (controller.signal.aborted) { finishCancelled(); return; }
      if (closed) {
        settleActiveContactTurn(assistantID, turnID, { bumpRevision: true });
        resolveContactTurnSettlement(messageID, { status: 'error', error: 'closed' });
        return;
      }
      const live = assistant(assistantID);
      if (!live || live.tombstone_at) {
        settleActiveContactTurn(assistantID, turnID, { bumpRevision: true });
        resolveContactTurnSettlement(messageID, { status: 'error', error: 'not_found' });
        return;
      }
      if (
        getContactMessage(db, `${messageID}:bubble:1`)
        || getContactMessage(db, `${messageID}:error`)
      ) {
        settleActiveContactTurn(assistantID, turnID, { bumpRevision: true });
        resolveContactTurnSettlement(messageID, { status: 'complete', replayed: true });
        return;
      }
      markActiveContactTurnRunning(assistantID, turnID);
      const assistantSnapshot = output(live);
      let registeredProjects = [];
      try {
        registeredProjects = filterRegisteredProjects(await loadRegisteredProjects());
      } catch {
        registeredProjects = [];
      }
      const modelContext = await loadContactModelContext(controller.signal);

      let workerText = '';
      try {
        const watchDirectory = nonEmptyString(directory)
          ? (() => {
            try { return workspace(directory, assistantID); } catch { return null; }
          })()
          : null;
        const resolvedDirectory = watchDirectory || (() => {
          try { return effectiveWorkspace(live); } catch { return null; }
        })();
        if (resolvedDirectory) {
          const messagesResult = await client().session.messages({
            sessionID,
            directory: resolvedDirectory,
            limit: 100,
          });
          if (!messagesResult?.error) {
            const rows = Array.isArray(messagesResult?.data)
              ? messagesResult.data
              : (Array.isArray(messagesResult) ? messagesResult : []);
            // complete/error that discovers a user abort becomes cancelled + notify.
            // A cancelled resume must still run with reason: user_interrupted.
            if (status !== 'cancelled' && isUserAbort(lastAssistantInfo(rows)?.error)) {
              reportAssignedSession(sessionID, 'cancelled');
              finishCancelled();
              return;
            }
            workerText = extractLastWorkerAssistantText(rows);
          }
        }
      } catch {
        workerText = '';
      }

      if (controller.signal.aborted) { finishCancelled(); return; }
      const title = findAssignedSessionCardTitle(assistantID, sessionID);
      const userText = buildAssignedSessionResumeUserText({
        sessionID,
        status,
        title,
        workerText,
      });
      const history = contactHistoryForLlm(db, assistantID, {});
        const assignedCards = [];
        const spokenByIndex = new Map();
        let contactResetThisTurn = false;
        const markContactReset = () => {
          contactResetThisTurn = true;
          spokenByIndex.clear();
          assignedCards.length = 0;
        };

      try {
        const executionHistory = await materializeContactHistory(
          db,
          dataDir,
          assistantID,
          history,
          { budgetBytes: CONTACT_ATTACHMENT_TURN_BUDGET_BYTES },
        );
        const memory = createContactMemoryReader(db, assistantID, { assertAvailable: () => editable(assistantID) });
        const tools = createContactTools({
          searchMemory: memory.search,
          readMemory: memory.read,
          assignWork: (params) => assignWork(live, params),
          watchSession: (params) => watchSessionWork(live, params),
          stopSession: (params) => stopSessionWork(live, params),
          steerSession: (params) => mutateSessionWork('steer', params),
          archiveSession: (params) => mutateSessionWork('archive', params),
          deleteSession: (params) => mutateSessionWork('delete', params),
          createAssistant: (toolInput) => createAssistant(toolInput),
          scheduleTask: (params) => scheduleWork(live, params),
          deliverPeerMessage: (toolInput) => deliverPeerMessage(assistantID, toolInput),
          clearContactMemory: () => {
            const result = clearContactMemory(assistantID, {});
            markContactReset(false);
            return result;
          },
          resetContact: () => {
            const result = resetContact(assistantID, {});
            markContactReset(true);
            return result;
          },
          listAssistants: () => db.prepare('SELECT * FROM assistant_v2 WHERE tombstone_at IS NULL ORDER BY created_at').all().map(output),
          listProjects: async () => loadRegisteredProjects(),
          listSessions: (params) => listSessionsWork(params),
          readSession: (params) => readSessionWork(params),
          readAssistantSettings: (input = {}) => {
            const targetID = typeof input?.assistantID === 'string' && input.assistantID.trim()
              ? input.assistantID.trim()
              : assistantID;
            return output(editable(targetID));
          },
          updateAssistantSettings: async (patch = {}) => {
            const normalizePrompt = (value) => {
              if (typeof value !== 'string') fail('validation_error');
              if (value.length > 200_000) fail('validation_error');
              return value.trim();
            };
            const targetID = typeof patch?.assistantID === 'string' && patch.assistantID.trim()
              ? patch.assistantID.trim()
              : assistantID;
            let lastError = null;
            for (let attempt = 0; attempt < 2; attempt++) {
              const current = output(editable(targetID));
              if (!Object.prototype.hasOwnProperty.call(patch, 'defaultPrompt')) {
                fail('validation_error');
              }
              const nextPrompt = normalizePrompt(patch.defaultPrompt);
              if (current.defaultPrompt === nextPrompt) {
                return {
                  updated: false,
                  unchanged: true,
                  defaultPrompt: current.defaultPrompt,
                  assistant: current,
                };
              }
              await Promise.resolve();
              try {
                const updated = await updateAssistant(targetID, {
                  expectedRevision: current.revision,
                  defaultPrompt: nextPrompt,
                });
                return {
                  updated: true,
                  defaultPrompt: updated.defaultPrompt,
                  assistant: updated,
                };
              } catch (error) {
                lastError = error;
                if (error?.code !== 'revision_conflict') throw error;
              }
            }
            throw lastError;
          },
          currentAssistant: assistantSnapshot,
          onCard: (card) => {
            if (contactResetThisTurn) return;
            rememberPublishedContactCard(assistantID, {
              userMessageID: messageID, turnID, assignedCards, card,
            });
          },
          turnFileParts: [],
          turnAttachmentScope: attachmentScopeKey([]),
        });
        controller.signal.throwIfAborted();
        const generated = await runContactTurn({
          signal: controller.signal,
          readOnly: true,
          assistant: assistantSnapshot,
          history: executionHistory,
          userText,
          userParts: [{ type: 'text', text: userText }],
          language: contactTurnLanguages.get(assistantID) ?? '',
          createChatCompletion,
          tools,
          projects: registeredProjects,
          ...modelContext,
          globalEventHub,
          onBubbleDelta: (bubbleIndex, delta, done) => {
            if (contactResetThisTurn) return;
            publishContactBubbleDelta({
              assistantID, turnID, userMessageID: messageID, spokenByIndex, bubbleIndex, delta, done, signal: controller.signal,
            });
          },
        });
        if (controller.signal.aborted) { finishCancelled(); return; }
        if (closed) {
          settleActiveContactTurn(assistantID, turnID, { bumpRevision: true });
          resolveContactTurnSettlement(messageID, { status: 'error', error: 'closed' });
          return;
        }
        const resetThisTurn = contactResetThisTurn || generated?.reset === true;
        const bubbles = resetThisTurn && generated?.reset !== true ? []
          : (Array.isArray(generated?.bubbles) ? generated.bubbles.filter((item) => typeof item === 'string' && item.trim()).slice(0, resetThisTurn ? 1 : undefined) : []);
        const cards = resetThisTurn
          ? []
          : [
            ...assignedCards,
            ...(Array.isArray(generated?.cards) ? generated.cards : []),
          ].filter((card, index, list) => list.findIndex((item) => contactCardIdentity(item) === contactCardIdentity(card)) === index);
        if (bubbles.length === 0 && cards.length === 0) {
          const detail = 'Assistant returned no text';
          try {
            persistContactTurnFailure(assistantID, {
              userMessageID: messageID,
              turnID,
              error: detail,
            });
            settleActiveContactTurn(assistantID, turnID);
          } catch {
            settleActiveContactTurn(assistantID, turnID, { bumpRevision: true });
          }
          emitContactTurnEvent('openchamber:contact-turn-end', {
            assistantID,
            turnID,
            status: 'error',
            error: detail,
          });
          notifyContactTurn({
            assistantID,
            name: assistantSnapshot.name,
            turnID,
            status: 'error',
            body: detail,
          });
          resolveContactTurnSettlement(messageID, { status: 'error', error: detail });
          return;
        }
        // No user row for resume — only assistant bubbles/cards (userMessageID is id prefix).
        persistContactAssistantReply(assistantID, {
          userMessageID: messageID,
          bubbles,
          cards,
          turnID,
          reset: resetThisTurn,
        });
        settleActiveContactTurn(assistantID, turnID);
        emitContactTurnEvent('openchamber:contact-turn-end', {
          assistantID,
          turnID,
          status: 'complete',
        });
        const spoken = bubbles.filter((text) => typeof text === 'string' && text.trim() && !text.startsWith('oc.settle.'));
        notifyContactTurn({
          assistantID,
          name: assistantSnapshot.name,
          turnID,
          status: 'complete',
          body: spoken.at(-1) || cards[0]?.title || '',
        });
        resolveContactTurnSettlement(messageID, { status: 'complete' });
      } catch (error) {
        if (controller.signal.aborted) { finishCancelled(); return; }
        const detail = typeof error?.message === 'string' && error.message.trim()
          ? error.message.trim()
          : (error?.code || 'upstream_error');
        const statusCode = error?.code === 'no_provider' ? 'no_provider' : (error?.code || 'upstream_error');
        try {
          persistContactTurnFailure(assistantID, {
            userMessageID: messageID,
            turnID,
            error: detail,
          });
          settleActiveContactTurn(assistantID, turnID);
        } catch {
          settleActiveContactTurn(assistantID, turnID, { bumpRevision: true });
        }
        emitContactTurnEvent('openchamber:contact-turn-end', {
          assistantID,
          turnID,
          status: 'error',
          error: detail,
          ...(statusCode !== detail ? { code: statusCode } : {}),
        });
        notifyContactTurn({
          assistantID,
          name: assistantSnapshot.name,
          turnID,
          status: 'error',
          body: detail,
        });
        resolveContactTurnSettlement(messageID, { status: 'error', error: detail, code: statusCode });
      }
    }).finally(() => { assignedResumes.delete(messageID); });
  };
  assignedSessionResumeRef.schedule = scheduleAssignedSessionResume;
  /**
   * Contact composer send: validate → admit user (202) → async turn.
   * Does not await the LLM. Live bubble tokens use openchamber:contact-bubble-delta
   * on /api/openchamber/events; turn lifecycle uses contact-turn-start/end.
   */
  const send = async (assistantID, input) => {
    if (!plainObject(input)) fail('validation_error');
    if (input.parts !== undefined) validateParts(input.parts);
    const messageID = string(input.messageID, 256, true);
    const userText = extractUserText(input);
    if (!userText) fail('validation_error');
    const language = typeof input.language === 'string' ? input.language.trim().slice(0, 64) : '';
    const row = active(assistantID);
    if (language) contactTurnLanguages.set(row.assistant_id, language);
    const userParts = await userContactParts(row.assistant_id, input, userText);
    if (typeof createChatCompletion !== 'function' && runContactTurn === defaultRunContactTurn) fail('upstream_error');
    let registeredProjects = [];
    try {
      registeredProjects = filterRegisteredProjects(await loadRegisteredProjects());
    } catch (error) {
      if (error instanceof AssignError || error instanceof AssistantError) throw error;
      // Still allow the turn — tools can surface a later catalog failure.
      registeredProjects = [];
    }
    const turnID = messageID;
    const assistantSnapshot = output(row);
    const existingUser = getContactMessage(db, messageID);
    if (existingUser) {
      if (existingUser.assistantID !== row.assistant_id || existingUser.role !== 'user') fail('validation_error');
      const existingFingerprint = contactPartsFingerprint(existingUser.parts);
      const nextFingerprint = contactPartsFingerprint(
        Array.isArray(userParts) && userParts.length > 0 ? userParts : [{ type: 'text', text: userText }],
      );
      if (existingFingerprint !== nextFingerprint) fail('idempotency_conflict');
      // Same messageID + payload: replay admission only — never start a second lane turn.
      return {
        binding: binding(row),
        messageID,
        admitted: true,
        revision: revision(),
        replayed: true,
      };
    }
    cancelAssignedResumes({ assistantID: row.assistant_id });
    // A new user turn supersedes pending background notifications as well as running ones.
    // Explicit assign/watch admission rearms only its own watch. Keep live card status intact.
    db.prepare('UPDATE assistant_contact_watch SET resume_allowed=0 WHERE assistant_id=?').run(row.assistant_id);
    admitContactUser(row.assistant_id, {
      userMessageID: messageID,
      userText,
      userParts,
      turnID,
    });
    const controller = new AbortController();
    contactControllers.set(messageID, { assistantID: row.assistant_id, controller });
    const finishCancelled = () => {
      settleActiveContactTurn(row.assistant_id, turnID, { bumpRevision: true });
      emitContactTurnEvent('openchamber:contact-turn-end', { assistantID: row.assistant_id, turnID, status: 'cancelled' });
      resolveContactTurnSettlement(messageID, { status: 'cancelled' });
      contactControllers.delete(messageID);
    };
    rememberActiveContactTurn(row.assistant_id, {
      turnID,
      messageID,
      status: 'queued',
      admittedAt: now(),
    });
    emitContactTurnEvent('openchamber:contact-turn-start', {
      assistantID: row.assistant_id,
      turnID,
      messageID,
    });
    contactTurnSettlement(messageID);
    const kickTurn = () => {
      void inContactTurnLane(row.assistant_id, async () => {
        if (controller.signal.aborted) { finishCancelled(); return; }
        if (closed) {
          settleActiveContactTurn(row.assistant_id, turnID, { bumpRevision: true });
          resolveContactTurnSettlement(messageID, { status: 'error', error: 'closed' });
          return;
        }
        markActiveContactTurnRunning(row.assistant_id, turnID);
        // Load the LLM window when the lane runs — not at admit time — so a
        // prior turn's clear-memory cannot leave queued work with stale history.
        // Exclude the admitted user row; prompt still receives userText/parts.
        // beforeOrdinal caps later-admitted queued user rows out of this turn.
        const admitted = db.prepare(
          'SELECT ordinal FROM assistant_contact_message WHERE message_id=?',
        ).get(messageID);
        const parsedOrdinal = admitted?.ordinal == null ? NaN : Number(admitted.ordinal);
        const beforeOrdinal = Number.isFinite(parsedOrdinal) ? parsedOrdinal : null;
        const history = contactHistoryForLlm(db, row.assistant_id, {
          excludeMessageIDs: [messageID],
          beforeOrdinal,
        });
        const assignedCards = [];
        const spokenByIndex = new Map();
        let contactResetThisTurn = false;
        const markContactReset = () => {
          contactResetThisTurn = true;
          spokenByIndex.clear();
          assignedCards.length = 0;
        };
        const modelContext = await loadContactModelContext(controller.signal);
        try {
          // Materialize inside turn try so failures durable-error + settle working.
          // DB/UI keep descriptors; harness + assign get execution-time data URLs under budget.
          const executionHistory = await materializeContactHistory(
            db,
            dataDir,
            row.assistant_id,
            history,
            { budgetBytes: CONTACT_ATTACHMENT_TURN_BUDGET_BYTES },
          );
          const executionParts = await materializeContactParts(
            db,
            dataDir,
            row.assistant_id,
            userParts,
            { budgetBytes: CONTACT_ATTACHMENT_TURN_BUDGET_BYTES },
          );
          // Current-turn attachments only — never unbounded history image forwarding.
          const turnFileParts = sanitizeAssignFileParts(
            (Array.isArray(executionParts) ? executionParts : []).filter((part) => part?.type === 'file'),
          );
          const turnAttachmentScope = attachmentScopeKey(turnFileParts);
          const memory = createContactMemoryReader(db, row.assistant_id, {
            beforeOrdinal, assertAvailable: () => editable(row.assistant_id),
          });
          const tools = createContactTools({
            searchMemory: memory.search,
            readMemory: memory.read,
            assignWork: (params) => assignWork(row, params),
            watchSession: (params) => watchSessionWork(row, params),
            stopSession: (params) => stopSessionWork(row, params),
            steerSession: (params) => mutateSessionWork('steer', params),
            archiveSession: (params) => mutateSessionWork('archive', params),
            deleteSession: (params) => mutateSessionWork('delete', params),
            createAssistant: (toolInput) => createAssistant(toolInput),
            scheduleTask: (params) => scheduleWork(row, params),
            deliverPeerMessage: (toolInput) => deliverPeerMessage(row.assistant_id, toolInput),
            clearContactMemory: () => {
              // Cap the watermark at this turn's user ordinal — never global MAX,
              // or later-admitted queued users are permanently excluded from LLM history.
              const result = clearContactMemory(row.assistant_id, {
                upToOrdinal: beforeOrdinal,
              });
              markContactReset(false);
              return result;
            },
            resetContact: () => {
              // Tool wipe: keep wipe user + later-admitted users only; delete all
              // other roles at any ordinal (incl. late prior-lane assistant/cards).
              const result = resetContact(row.assistant_id, {
                upToOrdinal: beforeOrdinal,
              });
              markContactReset(true);
              return result;
            },
            listAssistants: () => db.prepare('SELECT * FROM assistant_v2 WHERE tombstone_at IS NULL ORDER BY created_at').all().map(output),
            listProjects: async () => loadRegisteredProjects(),
            listSessions: (params) => listSessionsWork(params),
            readSession: (params) => readSessionWork(params),
            // Live DB read — not the turn-start assistantSnapshot.
            // Optional assistantID targets another live row; omitted → this contact.
            readAssistantSettings: (input = {}) => {
              const assistantID = typeof input?.assistantID === 'string' && input.assistantID.trim()
                ? input.assistantID.trim()
                : row.assistant_id;
              return output(editable(assistantID));
            },
            // Persist defaultPrompt via updateAssistant CAS; one revision_conflict retry.
            updateAssistantSettings: async (patch = {}) => {
              const normalizePrompt = (value) => {
                if (typeof value !== 'string') fail('validation_error');
                if (value.length > 200_000) fail('validation_error');
                return value.trim();
              };
              const assistantID = typeof patch?.assistantID === 'string' && patch.assistantID.trim()
                ? patch.assistantID.trim()
                : row.assistant_id;
              let lastError = null;
              for (let attempt = 0; attempt < 2; attempt++) {
                const current = output(editable(assistantID));
                if (!Object.prototype.hasOwnProperty.call(patch, 'defaultPrompt')) {
                  fail('validation_error');
                }
                const nextPrompt = normalizePrompt(patch.defaultPrompt);
                if (current.defaultPrompt === nextPrompt) {
                  return {
                    updated: false,
                    unchanged: true,
                    defaultPrompt: current.defaultPrompt,
                    assistant: current,
                  };
                }
                // Yield so a concurrent UI PATCH can land before CAS (and tests can inject).
                await Promise.resolve();
                try {
                  const updated = await updateAssistant(assistantID, {
                    expectedRevision: current.revision,
                    defaultPrompt: nextPrompt,
                  });
                  return {
                    updated: true,
                    defaultPrompt: updated.defaultPrompt,
                    assistant: updated,
                  };
                } catch (error) {
                  lastError = error;
                  if (error?.code !== 'revision_conflict') throw error;
                }
              }
              throw lastError;
            },
            currentAssistant: assistantSnapshot,
            onCard: (card) => {
              if (contactResetThisTurn) return;
              rememberPublishedContactCard(row.assistant_id, {
                userMessageID: messageID, turnID, assignedCards, card,
              });
            },
            turnFileParts,
            turnAttachmentScope,
          });
          controller.signal.throwIfAborted();
          const generated = await runContactTurn({
            signal: controller.signal,
            assistant: assistantSnapshot,
            history: executionHistory,
            userText,
            userParts: executionParts,
            language,
            createChatCompletion,
            tools,
            projects: registeredProjects,
            ...modelContext,
            globalEventHub,
            onBubbleDelta: (bubbleIndex, delta, done) => {
              if (contactResetThisTurn) return;
              publishContactBubbleDelta({
                assistantID: row.assistant_id, turnID, userMessageID: messageID, spokenByIndex, bubbleIndex, delta, done, signal: controller.signal,
              });
            },
          });
          if (controller.signal.aborted) { finishCancelled(); return; }
          if (closed) {
            settleActiveContactTurn(row.assistant_id, turnID, { bumpRevision: true });
            resolveContactTurnSettlement(messageID, { status: 'error', error: 'closed' });
            return;
          }
          const resetThisTurn = contactResetThisTurn || generated?.reset === true;
          const bubbles = resetThisTurn && generated?.reset !== true ? []
            : (Array.isArray(generated?.bubbles) ? generated.bubbles.filter((item) => typeof item === 'string' && item.trim()).slice(0, resetThisTurn ? 1 : undefined) : []);
          const cards = resetThisTurn
            ? []
            : [
              ...assignedCards,
              ...(Array.isArray(generated?.cards) ? generated.cards : []),
            ].filter((card, index, list) => list.findIndex((item) => contactCardIdentity(item) === contactCardIdentity(card)) === index);
          if (bubbles.length === 0 && cards.length === 0) {
            const detail = 'Assistant returned no text';
            try {
              persistContactTurnFailure(row.assistant_id, {
                userMessageID: messageID,
                turnID,
                error: detail,
              });
              settleActiveContactTurn(row.assistant_id, turnID);
            } catch {
              settleActiveContactTurn(row.assistant_id, turnID, { bumpRevision: true });
            }
            emitContactTurnEvent('openchamber:contact-turn-end', {
              assistantID: row.assistant_id,
              turnID,
              status: 'error',
              error: detail,
            });
            notifyContactTurn({
              assistantID: row.assistant_id,
              name: assistantSnapshot.name,
              turnID,
              status: 'error',
              body: detail,
            });
            resolveContactTurnSettlement(messageID, { status: 'error', error: detail });
            return;
          }
          // clear_chat_history keeps the wipe user row (bounded delete). Re-admit
          // only if the row is missing (unbounded API wipe / edge). Then persist
          // only the confirm bubble. new_conversation keeps all rows + watermark.
          if (resetThisTurn) {
            const existingUser = db.prepare('SELECT 1 AS ok FROM assistant_contact_message WHERE message_id=?').get(messageID);
            if (!existingUser) {
              admitContactUser(row.assistant_id, {
                userMessageID: messageID,
                userText,
                userParts,
                turnID,
              });
            }
          }
          persistContactAssistantReply(row.assistant_id, {
            userMessageID: messageID,
            bubbles,
            cards,
            turnID,
            reset: resetThisTurn,
          });
          // persistContactAssistantReply already bumps; clear activity without a second tip.
          settleActiveContactTurn(row.assistant_id, turnID);
          emitContactTurnEvent('openchamber:contact-turn-end', {
            assistantID: row.assistant_id,
            turnID,
            status: 'complete',
          });
          const spoken = bubbles.filter((text) => typeof text === 'string' && text.trim() && !text.startsWith('oc.settle.'));
          notifyContactTurn({
            assistantID: row.assistant_id,
            name: assistantSnapshot.name,
            turnID,
            status: 'complete',
            body: spoken.at(-1) || cards[0]?.title || '',
          });
          resolveContactTurnSettlement(messageID, { status: 'complete' });
        } catch (error) {
          if (controller.signal.aborted) { finishCancelled(); return; }
          const detail = typeof error?.message === 'string' && error.message.trim()
            ? error.message.trim()
            : (error?.code || 'upstream_error');
          const statusCode = error?.code === 'no_provider' ? 'no_provider' : (error?.code || 'upstream_error');
          try {
            persistContactTurnFailure(row.assistant_id, {
              userMessageID: messageID,
              turnID,
              error: detail,
            });
            settleActiveContactTurn(row.assistant_id, turnID);
          } catch {
            settleActiveContactTurn(row.assistant_id, turnID, { bumpRevision: true });
          }
          emitContactTurnEvent('openchamber:contact-turn-end', {
            assistantID: row.assistant_id,
            turnID,
            status: 'error',
            error: detail,
            ...(statusCode !== detail ? { code: statusCode } : {}),
          });
          notifyContactTurn({
            assistantID: row.assistant_id,
            name: assistantSnapshot.name,
            turnID,
            status: 'error',
            body: detail,
          });
          resolveContactTurnSettlement(messageID, { status: 'error', error: detail, code: statusCode });
        } finally {
          contactControllers.delete(messageID);
        }
      });
    };
    // Defer past send() resolution so callers observe admission before assistant rows.
    setImmediateFn(kickTurn);
    return { binding: binding(row), messageID, admitted: true, revision: revision() };
  };
  const contactMessages = (assistantID, query = {}) => {
    const row = editable(assistantID);
    const hasBefore = !(query.before == null || query.before === '');
    const hasExact = !(query.messageID == null || query.messageID === '');
    if (hasBefore && hasExact) fail('validation_error', 'before and messageID are mutually exclusive');
    let limit = query.limit == null || query.limit === '' ? CONTACT_PAGE_DEFAULT_LIMIT : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > CONTACT_PAGE_MAX_LIMIT) fail('validation_error');
    let page;
    try {
      page = listContactMessages(db, row.assistant_id, {
        before: hasBefore ? query.before : undefined,
        limit,
        messageID: hasExact ? query.messageID : undefined,
      });
    } catch (error) {
      if (error?.code === 'contact_generation_conflict' || error?.code === 'validation_error') {
        fail(error.code, error.message);
      }
      throw error;
    }
    return {
      messages: page.messages,
      nextCursor: page.nextCursor,
      complete: page.complete,
      generation: page.generation,
      revision: revision(),
    };
  };
  /**
   * Clear LLM memory only: advance the durable context boundary so later
   * contactHistoryForLlm drops prior turns. Transcript GET keeps every row.
   * Failed writes roll back and keep the previous boundary. Does not call
   * OpenCode session/new.
   */
  const clearContactMemory = (assistantID, options = {}) => {
    const row = editable(assistantID);
    const upToOrdinal = options && typeof options === 'object' ? options.upToOrdinal : undefined;
    db.exec('BEGIN IMMEDIATE');
    try {
      const cleared = clearContactMemoryStore(db, row.assistant_id, {
        updatedAt: now(),
        ...(upToOrdinal !== undefined ? { upToOrdinal } : {}),
      });
      bump();
      db.exec('COMMIT');
      return { assistantID: row.assistant_id, reset: true, memoryCleared: true, afterOrdinal: cleared.afterOrdinal };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  /**
   * Delete this assistant's OpenChamber contact transcript (messages, parts,
   * watches) and clear the context boundary. Also the POST /contact/reset
   * contract. Does not call OpenCode session/new.
   *
   * Tool path may pass `upToOrdinal` (wiping turn's user ordinal) so later-
   * admitted queued rows survive. Direct API without a ceiling deletes every
   * row (existing contract). Concurrent in-flight admissions already past 202
   * keep their message IDs only when bounded; unbounded API wipe drops them
   * and a later same-ID send replays as a fresh admission only if the row is gone.
   */
  const resetContact = (assistantID, options = {}) => {
    const row = editable(assistantID);
    const upToOrdinal = options && typeof options === 'object' ? options.upToOrdinal : undefined;
    db.exec('BEGIN IMMEDIATE');
    try {
      // Generation bumps only on transcript wipe — not on clear-memory.
      const generation = bumpContactGeneration(db, row.assistant_id);
      deleteContactMessages(db, row.assistant_id, {
        ...(upToOrdinal !== undefined ? { upToOrdinal } : {}),
      });
      // Rebind read watermark to the new generation at empty cursor so post-wipe
      // confirm bubbles can surface as unread; stale generation mark-read fails closed.
      resetContactReadWatermarkForGeneration(db, row.assistant_id, generation, { updatedAt: now() });
      // Active contact turns stay until settle — wipe must not drop the green
      // dot while the clearing turn is still running.
      bump();
      db.exec('COMMIT');
      return { assistantID: row.assistant_id, reset: true, historyCleared: true, generation };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  /**
   * Advance the shared contact read watermark (multi-client).
   * Body: { generation, ordinal, messageID } — must match live generation;
   * only monotonic forward moves bump revision / assistants-changed.
   * Idempotent no-op when unchanged (no broadcast).
   */
  const markContactRead = (assistantID, input = {}) => {
    const row = editable(assistantID);
    if (!plainObject(input)) fail('validation_error');
    db.exec('BEGIN IMMEDIATE');
    try {
      let advanced;
      try {
        advanced = advanceContactReadWatermark(db, row.assistant_id, {
          generation: input.generation,
          ordinal: input.ordinal,
          messageID: input.messageID,
        }, { updatedAt: now() });
      } catch (error) {
        if (error?.code === 'contact_generation_conflict' || error?.code === 'validation_error') {
          fail(error.code, error.message);
        }
        throw error;
      }
      let tipRevision = revision();
      if (advanced.changed) {
        tipRevision = bump();
      }
      db.exec('COMMIT');
      return {
        assistantID: row.assistant_id,
        changed: advanced.changed,
        unreadCount: advanced.unreadCount,
        readWatermark: advanced.readWatermark,
        readTip: advanced.readTip,
        revision: tipRevision,
      };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
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
      if (card.cardType === 'session' && card.sessionID) {
        upsertContactWatch(db, {
          assistantID: row.assistant_id,
          sessionID: card.sessionID,
          directory: card.directory,
          status: card.status === 'error' || card.status === 'question' || card.status === 'complete' ? card.status : 'busy',
          updatedAt: now(),
        });
      }
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
  const abort = async (assistantID, input) => {
    const row = active(assistantID);
    if (!plainObject(input) || input.sessionID !== row.current_session_id || input.sessionGeneration !== row.session_generation) fail('revision_conflict');
    let interrupted = false;
    for (const turn of contactControllers.values()) {
      if (turn.assistantID !== assistantID) continue;
      turn.controller.abort();
      interrupted = true;
    }
    for (const turn of assignedResumes.values()) {
      if (turn.assistantID !== assistantID) continue;
      turn.controller.abort();
      interrupted = true;
    }
    db.prepare('UPDATE assistant_contact_watch SET resume_allowed=0 WHERE assistant_id=?').run(assistantID);
    if (interrupted) return { binding: binding(row), aborted: true };
    if (!row.current_session_id) fail('revision_conflict');
    const result = await client().session.abort({ sessionID: row.current_session_id, directory: effectiveWorkspace(row) });
    if (isMissing(result)) fail('not_found');
    if (result.error) fail('upstream_error');
    return { binding: binding(row), aborted: true };
  };
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
  const putAssistantContactAttachment = async (assistantID, uploadID, { stream, headers, signal, storeBytes } = {}) => {
    const row = editable(assistantID);
    try {
      return await putContactAttachment({
        db,
        dataDir,
        assistantID: row.assistant_id,
        uploadID,
        stream,
        headers,
        clock: now,
        signal,
        ...(storeBytes ? { storeBytes } : {}),
      });
    } catch (error) {
      if (error?.code) fail(error.code, error.message);
      throw error;
    }
  };
  const getAssistantContactAttachment = async (assistantID, attachmentID) => {
    const row = editable(assistantID);
    try {
      return await readContactAttachmentBytes({
        db,
        dataDir,
        assistantID: row.assistant_id,
        attachmentID,
        external: true,
      });
    } catch (error) {
      if (error?.code) fail(error.code, error.message);
      throw error;
    }
  };
  const migrateContactAttachments = async (assistantID = null) => migrateContactDataUrlParts({
    db,
    dataDir,
    assistantID,
    clock: now,
  });
  const snapshot = () => {
    const rows = db.prepare('SELECT * FROM assistant_v2 WHERE tombstone_at IS NULL ORDER BY created_at').all();
    const assistantIDs = rows.map((row) => row.assistant_id);
    // Per-assistant indexed LIMIT probes + one parts batch (catalog ≤100).
    const previews = getLatestContactMessagePreviews(db, assistantIDs);
    // Batch unread/watermark/tip — no per-assistant N+1 on snapshot.
    const unreadByID = getContactUnreadSnapshots(db, assistantIDs);
    return {
      revision: revision(),
      enabled: enabled(),
      assistants: rows.map((row) => output(
        row,
        previews.get(row.assistant_id) ?? null,
        unreadByID.get(row.assistant_id) ?? null,
      )),
    };
  };
  return { capability: async () => ({ supported: true, enabled: enabled(), revision: revision(), serverInstanceID: await getServerId() }), snapshot, createAssistant, updateAssistant, setEnabled: (input) => { if (!plainObject(input) || typeof input.enabled !== 'boolean' || input.expectedRevision !== revision()) fail('revision_conflict'); db.prepare("UPDATE assistant_meta SET value=? WHERE key='enabled'").run(input.enabled ? '1' : '0'); return { enabled: input.enabled, revision: bump() }; }, removeAssistant: (assistantID, expectedRevision) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = db.prepare('UPDATE assistant_v2 SET tombstone_at=?,revision=revision+1,updated_at=? WHERE assistant_id=? AND revision=? AND tombstone_at IS NULL').run(now(), now(), assistantID, expectedRevision);
      if (!result.changes) fail('revision_conflict');
      db.prepare('DELETE FROM assistant_session_history WHERE assistant_id=?').run(assistantID);
      db.prepare('DELETE FROM assistant_message_part_mirror WHERE assistant_id=?').run(assistantID);
      db.prepare('DELETE FROM assistant_message_mirror WHERE assistant_id=?').run(assistantID);
      db.prepare('DELETE FROM assistant_message_backfill WHERE assistant_id=?').run(assistantID);
      db.prepare('DELETE FROM assistant_scheduled_task WHERE assistant_id=?').run(assistantID);
      deleteContactMessages(db, assistantID);
      deleteContactReadState(db, assistantID);
      clearActiveContactTurns(assistantID);
      contactTurnLanguages.delete(assistantID);
      bump();
      db.exec('COMMIT');
      return { assistantID, tombstoneAt: now() };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }, ensure, createNew, compact, send, whenContactTurnSettled, abort, captureQueueDeliveryTarget, sendWithCapturedConfig, share, shareOperation, historicalMessages, contactMessages, clearContactMemory, resetContact, markContactRead, appendContactCard, deliverPeerMessage, listAssistantScheduledTasks, putAssistantContactAttachment, getAssistantContactAttachment, migrateContactAttachments, processEvent, reportAssignedSessionSettle: reportAssignedSession, reconcile,   close: () => {
    cancelAssignedResumes({});
    sessionAbortInflight.clear();
    for (const turn of contactControllers.values()) turn.controller.abort();
    if (!closed) {
      closed = true;
      try { contactAttachmentMigration.controller.abort(); } catch { /* ignore */ }
      clearActiveContactTurns();
      contactTurnLanguages.clear();
      unsubscribeEvents?.();
      clearIntervalFn(timer);
      db.close();
    }
  } };
};
