import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';

const require = createRequire(import.meta.url);
const MAX_ASSISTANTS = 100;
const MAX_SKILL_ROOTS = 16;
const MAX_SKILL_FILES = 256;
const MAX_SKILL_BYTES = 2 * 1024 * 1024;
const MAX_SKILL_DEPTH = 12;
const MAX_SKILL_ENTRIES = 2_048;
const MAX_SKILL_SCAN_MS = 2_000;
const MAX_PARTS = 32;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 16 * 1024 * 1024;
const OPERATION_LEASE_MS = 60_000;
const OPERATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const RECONCILE_INTERVAL_MS = 5_000;
const MAX_RECONCILIATION_ATTEMPTS = 3;
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/heic']);
const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const id = () => crypto.randomUUID();
const json = (value) => JSON.stringify(value);
const parse = (value) => JSON.parse(value);
const hash = (value) => crypto.createHash('sha256').update(json(value)).digest('hex');
export class AssistantError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = (code) => { throw new AssistantError(code); };
const string = (value, max = 10_000, required = false) => { if (value == null && !required) return null; if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail('validation_error'); return value.trim(); };
const outputAssistant = (row) => ({ id: row.assistant_id, revision: row.revision, enabled: Boolean(row.enabled), name: row.name, defaultPrompt: row.default_prompt, workspacePath: row.workspace_path, skillRoots: parse(row.skill_roots), providerID: row.provider_id, modelID: row.model_id, agent: row.agent, mode: row.mode, inboxTopicID: row.inbox_topic_id, createdAt: row.created_at, updatedAt: row.updated_at, tombstoneAt: row.tombstone_at });
const outputTopic = (row) => ({ id: row.topic_id, assistantID: row.assistant_id, title: row.title, sessionID: row.session_id, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at, tombstoneAt: row.tombstone_at });
const outputUserTurn = (turn, phase) => ({ id: turn.turn_id, topicID: turn.topic_id, ordinal: turn.ordinal, parentMessageID: null, phase, role: 'user', kind: turn.kind, source: turn.source, parts: parse(turn.parts), assistantRevision: turn.assistant_revision, sessionID: turn.session_id, messageID: turn.message_id, operationID: turn.operation_id, createdAt: turn.created_at, completedAt: null, error: null });

export const createAssistantsService = ({ dbPath, dataDir, buildOpenCodeUrl, getOpenCodeAuthHeaders, getServerId = async () => null, getAllowedRoots = () => [], clock = () => Date.now(), setIntervalFn = setInterval, clearIntervalFn = clearInterval, reconcileIntervalMs = RECONCILE_INTERVAL_MS, clientFactory } = {}) => {
  if (!dbPath || !dataDir) return null;
  const Database = require('better-sqlite3');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath); db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = ON');
  let closed = false;
  db.exec(`CREATE TABLE IF NOT EXISTS assistant_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS assistant (assistant_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, enabled INTEGER NOT NULL, name TEXT NOT NULL, default_prompt TEXT NOT NULL, workspace_path TEXT, skill_roots TEXT NOT NULL, provider_id TEXT NOT NULL, model_id TEXT NOT NULL, agent TEXT, mode TEXT NOT NULL, inbox_topic_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, tombstone_at INTEGER);
    CREATE TABLE IF NOT EXISTS assistant_topic (topic_id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL REFERENCES assistant(assistant_id), title TEXT NOT NULL, session_id TEXT, session_workspace_path TEXT, revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, tombstone_at INTEGER);
    CREATE TABLE IF NOT EXISTS assistant_turn (turn_id TEXT PRIMARY KEY, topic_id TEXT NOT NULL REFERENCES assistant_topic(topic_id), ordinal INTEGER NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'composer', parts TEXT NOT NULL, assistant_revision INTEGER NOT NULL, session_id TEXT, message_id TEXT, operation_id TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS assistant_operation (operation_id TEXT PRIMARY KEY, topic_id TEXT, type TEXT, payload_hash TEXT NOT NULL, state TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'admitted', response TEXT, error_code TEXT, attempt INTEGER NOT NULL DEFAULT 0, lease_expires_at INTEGER, session_id TEXT, message_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS assistant_turn_ordinal ON assistant_turn(topic_id, ordinal);
    CREATE INDEX IF NOT EXISTS assistant_topic_list ON assistant_topic(assistant_id, tombstone_at, updated_at DESC);
    CREATE INDEX IF NOT EXISTS assistant_operation_topic ON assistant_operation(topic_id, state, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS assistant_operation_one_active_topic ON assistant_operation(topic_id) WHERE state='running';`);
  const addColumn = (table, name, spec) => { const columns = new Set(db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((column) => column.name)); if (!columns.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${spec}`); };
  addColumn('assistant_topic', 'session_workspace_path', 'TEXT'); addColumn('assistant_turn', 'source', "TEXT NOT NULL DEFAULT 'composer'"); addColumn('assistant_turn', 'message_id', 'TEXT'); addColumn('assistant_turn', 'operation_id', 'TEXT');
  addColumn('assistant_operation', 'topic_id', 'TEXT'); addColumn('assistant_operation', 'type', 'TEXT'); addColumn('assistant_operation', 'phase', "TEXT NOT NULL DEFAULT 'admitted'"); addColumn('assistant_operation', 'attempt', 'INTEGER NOT NULL DEFAULT 0'); addColumn('assistant_operation', 'lease_expires_at', 'INTEGER'); addColumn('assistant_operation', 'session_id', 'TEXT'); addColumn('assistant_operation', 'message_id', 'TEXT'); addColumn('assistant_operation', 'reconciliation_attempt', 'INTEGER NOT NULL DEFAULT 0');
  db.prepare("INSERT OR IGNORE INTO assistant_meta(key,value) VALUES ('enabled','1')").run(); db.prepare("INSERT OR IGNORE INTO assistant_meta(key,value) VALUES ('revision','0')").run();
  const timestamp = () => Math.trunc(clock());
  const revision = () => Number(db.prepare("SELECT value FROM assistant_meta WHERE key='revision'").get().value);
  const bump = () => { const value = revision() + 1; db.prepare("UPDATE assistant_meta SET value=? WHERE key='revision'").run(String(value)); return value; };
  const enabled = () => db.prepare("SELECT value FROM assistant_meta WHERE key='enabled'").get().value === '1';
  const assistant = (assistantID) => db.prepare('SELECT * FROM assistant WHERE assistant_id=?').get(assistantID);
  const topic = (topicID) => db.prepare('SELECT * FROM assistant_topic WHERE topic_id=?').get(topicID);
  const activeTopic = (topicID) => { const row = topic(topicID); const owner = assistant(row?.assistant_id); if (!row || !owner || row.tombstone_at || owner.tombstone_at) fail('not_found'); if (!enabled() || !owner.enabled) fail('assistant_disabled'); return { row, owner }; };
  const workspaceFor = (assistantID) => path.join(dataDir, 'assistant-workspaces', assistantID);
  const containedBy = (candidate, root) => candidate === root || candidate.startsWith(`${root}${path.sep}`);
  const allowedRoots = () => [path.resolve(dataDir, 'assistant-workspaces'), ...getAllowedRoots().filter((root) => typeof root === 'string').map((root) => path.resolve(root))];
  const validateWorkspace = (candidate, assistantID, createDefault = false) => {
    const requested = candidate == null ? workspaceFor(assistantID) : path.resolve(string(candidate, 4096, true));
    if (!allowedRoots().some((root) => containedBy(requested, root))) fail('workspace_forbidden');
    if (createDefault && requested === workspaceFor(assistantID)) fs.mkdirSync(requested, { recursive: true });
    try { const resolved = fs.realpathSync(requested); if (!fs.statSync(resolved).isDirectory() || !allowedRoots().some((root) => containedBy(resolved, root))) fail('workspace_forbidden'); return resolved; } catch (error) { if (error instanceof AssistantError) throw error; fail('workspace_forbidden'); }
  };
  const validateRoots = (roots) => {
    if (!Array.isArray(roots) || roots.length > MAX_SKILL_ROOTS || roots.some((root) => typeof root !== 'string')) fail('validation_error');
    return roots.map((root) => { try { const resolved = fs.realpathSync(root); if (!fs.statSync(resolved).isDirectory() || !allowedRoots().some((allowed) => containedBy(resolved, allowed))) fail('workspace_forbidden'); return resolved; } catch (error) { if (error instanceof AssistantError) throw error; fail('validation_error'); } });
  };
  const skillCatalog = (roots) => {
    let files = 0; let bytes = 0; let entries = 0; const started = timestamp(); const catalog = [];
    for (const root of roots) {
      const rootReal = fs.realpathSync(root); const pending = [{ dir: rootReal, depth: 0 }];
      while (pending.length) {
        const { dir, depth } = pending.pop(); if (depth > MAX_SKILL_DEPTH || ++entries > MAX_SKILL_ENTRIES || timestamp() - started > MAX_SKILL_SCAN_MS) fail('skill_catalog_limit');
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const candidate = path.join(dir, entry.name);
          if (entry.isDirectory()) pending.push({ dir: candidate, depth: depth + 1 });
          if (entry.isFile() && entry.name === 'SKILL.md') { const real = fs.realpathSync(candidate); const stat = fs.statSync(real); if (!containedBy(real, rootReal) || ++files > MAX_SKILL_FILES || (bytes += stat.size) > MAX_SKILL_BYTES) fail('skill_catalog_limit'); catalog.push(path.relative(rootReal, real)); }
        }
      }
    }
    return catalog;
  };
  const validateParts = (parts) => {
    if (!Array.isArray(parts) || !parts.length || parts.length > MAX_PARTS) fail('validation_error');
    let totalImageBytes = 0;
    for (const part of parts) {
      if (!plainObject(part) || !['text', 'file'].includes(part.type)) fail('validation_error');
      if (part.type === 'text' && (typeof part.text !== 'string' || part.text.length > 200_000)) fail('validation_error');
      if (part.type === 'file') { if (!IMAGE_MIME_TYPES.has(part.mime) || typeof part.url !== 'string') fail('validation_error'); const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(part.url); if (!match || match[1] !== part.mime) fail('validation_error'); const bytes = Buffer.from(match[2], 'base64'); if (bytes.byteLength > MAX_IMAGE_BYTES) fail('image_too_large'); totalImageBytes += bytes.byteLength; if (totalImageBytes > MAX_TOTAL_IMAGE_BYTES) fail('images_too_large'); }
    }
  };
  const client = () => clientFactory ? clientFactory() : createOpencodeClient({ baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''), headers: getOpenCodeAuthHeaders() });
  const dto = (row) => ({ operationID: row.operation_id, topicID: row.topic_id, type: row.type, state: row.state, phase: row.phase, admission: { admitted: true, attempt: row.attempt, reconciliationAttempt: row.reconciliation_attempt, leaseExpiresAt: row.lease_expires_at }, result: row.state === 'completed' && row.response ? parse(row.response) : null, errorCode: row.error_code, payloadHash: row.payload_hash, sessionID: row.session_id, messageID: row.message_id, createdAt: row.created_at, updatedAt: row.updated_at });
  const finish = (operationID, state, response = null, errorCode = null) => closed ? null : db.prepare('UPDATE assistant_operation SET state=?,response=?,error_code=?,lease_expires_at=NULL,updated_at=? WHERE operation_id=? AND state=?').run(state, response ? json(response) : null, errorCode, timestamp(), operationID, 'running');
  const createSession = async (owner, topicRow) => {
    const workspace = validateWorkspace(topicRow.session_workspace_path || owner.workspace_path, owner.assistant_id, true);
    const result = await client().session.create({ directory: workspace, title: topicRow.title, metadata: { openchamber: { assistant: { assistantID: owner.assistant_id, topicID: topicRow.topic_id, kind: 'assistant' } } } });
    if (result.error || !result.data?.id) fail('upstream_error'); return { sessionID: result.data.id, workspace };
  };
  const upstreamMessages = async (sessionID, directory) => {
    const messages = []; let cursor;
    do { const response = await client().session.messages({ sessionID, directory, ...(cursor ? { cursor } : {}) }); if (response.error || !Array.isArray(response.data)) fail('upstream_error'); messages.push(...response.data); cursor = response.next ?? response.data.next ?? null; } while (cursor);
    return messages;
  };
  const reconcile = async (row) => {
    if (row.state !== 'running' || row.type === 'new' || row.type === 'compact') return dto(row);
    try {
      const { owner, row: currentTopic } = activeTopic(row.topic_id);
      const records = await upstreamMessages(row.session_id, currentTopic.session_workspace_path || owner.workspace_path);
      if (closed) return dto(row); const relevant = records.filter((record) => record?.info?.role === 'assistant' && record.info?.parentID === row.message_id); const last = relevant.at(-1);
      if (last?.info?.error) finish(row.operation_id, 'failed', null, 'upstream_error');
      else if (last?.info?.time?.completed) finish(row.operation_id, 'completed', { topicID: row.topic_id, sessionID: row.session_id, messageID: row.message_id, deliveredAt: last.info.time.completed });
    } catch (error) { if (!closed && error instanceof AssistantError) finish(row.operation_id, 'failed', null, error.code); }
    return dto(db.prepare('SELECT * FROM assistant_operation WHERE operation_id=?').get(row.operation_id));
  };
  const messageIDFromPrompt = (result) => result?.data?.info?.id ?? result?.data?.id ?? result?.data?.message?.info?.id ?? null;
  const runMessage = async (operationID) => {
    const operation = db.prepare('SELECT * FROM assistant_operation WHERE operation_id=?').get(operationID); if (!operation || operation.state !== 'running') return;
    try {
      const { row: topicRow, owner } = activeTopic(operation.topic_id);
      const payload = parse(operation.response); const { parts, snapshot } = payload; validateParts(parts); if (!plainObject(snapshot)) fail('recovery_ambiguous');
      const snapshotOwner = { ...owner, revision: snapshot.assistantRevision, default_prompt: snapshot.prompt, provider_id: snapshot.providerID, model_id: snapshot.modelID, agent: snapshot.agent, mode: snapshot.mode, workspace_path: snapshot.workspacePath };
      validateWorkspace(snapshot.workspacePath, owner.assistant_id, false);
      let sessionID = operation.session_id || topicRow.session_id; let workspace = snapshot.workspacePath;
      if (operation.phase === 'submitting') return;
      if (snapshot.mode === 'stateless' || !sessionID) { db.prepare("UPDATE assistant_operation SET phase='creating_session',updated_at=? WHERE operation_id=? AND state='running'").run(timestamp(), operationID); const created = await createSession(snapshotOwner, topicRow); if (closed || db.prepare('SELECT state FROM assistant_operation WHERE operation_id=?').get(operationID)?.state !== 'running') return; sessionID = created.sessionID; workspace = created.workspace; db.exec('BEGIN IMMEDIATE'); try { if (snapshot.mode === 'continuous') { const changed = db.prepare('UPDATE assistant_topic SET session_id=?,session_workspace_path=?,revision=revision+1,updated_at=? WHERE topic_id=? AND revision=?').run(sessionID, workspace, timestamp(), topicRow.topic_id, topicRow.revision); if (!changed.changes) fail('revision_conflict'); } const prepared = db.prepare("UPDATE assistant_operation SET session_id=?,phase='prepared',updated_at=? WHERE operation_id=? AND state='running'").run(sessionID, timestamp(), operationID); if (!prepared.changes) fail('lease_expired'); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; } }
      const promptParts = [...(snapshot.prompt ? [{ type: 'text', text: `${snapshot.prompt}${snapshot.skills.length ? `\nAvailable skills: ${snapshot.skills.join(', ')}` : ''}` }] : []), ...parts];
      db.prepare("UPDATE assistant_operation SET phase='submitting',session_id=?,updated_at=? WHERE operation_id=? AND state='running'").run(sessionID, timestamp(), operationID);
      const result = await client().session.promptAsync({ sessionID, directory: workspace, model: { providerID: snapshot.providerID, modelID: snapshot.modelID }, ...(snapshot.agent ? { agent: snapshot.agent } : {}), parts: promptParts });
      const messageID = messageIDFromPrompt(result); if (closed || db.prepare('SELECT state FROM assistant_operation WHERE operation_id=?').get(operationID)?.state !== 'running') return; if (result.error || !messageID) fail('upstream_error');
      const latestTopic = topic(topicRow.topic_id);
      db.exec('BEGIN IMMEDIATE'); try { const ordinal = Number(db.prepare('SELECT COALESCE(MAX(ordinal),0)+1 AS ordinal FROM assistant_turn WHERE topic_id=?').get(topicRow.topic_id).ordinal); db.prepare('INSERT INTO assistant_turn(turn_id,topic_id,ordinal,kind,source,parts,assistant_revision,session_id,message_id,operation_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id(), topicRow.topic_id, ordinal, 'message', payload.source, json(parts), owner.revision, sessionID, messageID, operationID, timestamp()); db.prepare("UPDATE assistant_operation SET session_id=?,message_id=?,phase='submitted',attempt=attempt+1,lease_expires_at=?,updated_at=? WHERE operation_id=? AND state='running'").run(sessionID, messageID, timestamp() + OPERATION_LEASE_MS, timestamp(), operationID); const changed = db.prepare('UPDATE assistant_topic SET updated_at=?,revision=revision+1 WHERE topic_id=? AND revision=? AND tombstone_at IS NULL').run(timestamp(), topicRow.topic_id, latestTopic?.revision); if (!changed.changes) fail('revision_conflict'); bump(); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
      await reconcile(db.prepare('SELECT * FROM assistant_operation WHERE operation_id=?').get(operationID));
    } catch (error) { if (!closed) finish(operationID, 'failed', null, error instanceof AssistantError ? error.code : 'upstream_error'); }
  };
  const admit = (operationID, topicID, type, payload) => {
    string(operationID, 128, true); const payloadHash = hash({ type, topicID, ...payload }); const existing = db.prepare('SELECT * FROM assistant_operation WHERE operation_id=?').get(operationID);
    if (existing) { if (existing.payload_hash !== payloadHash) fail('idempotency_conflict'); return { operation: dto(existing), created: false }; }
    const at = timestamp();
    db.exec('BEGIN IMMEDIATE'); try { const active = db.prepare("SELECT operation_id FROM assistant_operation WHERE topic_id=? AND state='running'").get(topicID); if (active) fail('topic_busy'); db.prepare('INSERT INTO assistant_operation(operation_id,topic_id,type,payload_hash,state,phase,response,attempt,lease_expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(operationID, topicID, type, payloadHash, 'running', 'admitted', json(payload), 0, at + OPERATION_LEASE_MS, at, at); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
    const operation = dto(db.prepare('SELECT * FROM assistant_operation WHERE operation_id=?').get(operationID));
    if (type === 'message') queueMicrotask(() => { void runMessage(operationID); });
    return { operation, created: true };
  };
  const renewOrFail = (row) => { const attempts = row.reconciliation_attempt + 1; if (attempts > MAX_RECONCILIATION_ATTEMPTS) finish(row.operation_id, 'failed', null, 'reconciliation_unresolved'); else db.prepare('UPDATE assistant_operation SET reconciliation_attempt=?,lease_expires_at=?,updated_at=? WHERE operation_id=? AND state=?').run(attempts, timestamp() + OPERATION_LEASE_MS, timestamp(), row.operation_id, 'running'); };
  const reconciliationFlights = new Map();
  const reconcileExpired = (row) => {
    const active = reconciliationFlights.get(row.operation_id); if (active) return active;
    const work = (async () => { if (row.type === 'message' && row.session_id && row.message_id) { await reconcile(row); const current = db.prepare('SELECT * FROM assistant_operation WHERE operation_id=?').get(row.operation_id); if (current?.state === 'running') renewOrFail(current); return; } if (row.type === 'message' && row.phase === 'admitted') { queueMicrotask(() => { void runMessage(row.operation_id); }); return; } finish(row.operation_id, 'failed', null, row.type === 'message' ? 'recovery_ambiguous' : 'lease_expired'); })().finally(() => reconciliationFlights.delete(row.operation_id));
    reconciliationFlights.set(row.operation_id, work); return work;
  };
  const recover = () => { for (const row of db.prepare("SELECT * FROM assistant_operation WHERE state='running'").all()) void reconcileExpired(row); db.prepare('DELETE FROM assistant_operation WHERE state IN (\'completed\',\'failed\') AND updated_at<?').run(timestamp() - OPERATION_RETENTION_MS); };
  const reconcileRunning = () => { for (const row of db.prepare("SELECT * FROM assistant_operation WHERE state='running'").all()) { if (row.lease_expires_at == null || row.lease_expires_at <= timestamp()) void reconcileExpired(row); else if (row.type === 'message' && row.session_id && row.message_id) void reconcile(row); } };
  recover(); const reconciliationTimer = setIntervalFn(reconcileRunning, reconcileIntervalMs);
  const createAssistant = (input) => {
    if (!plainObject(input)) fail('validation_error'); const name = string(input.name, 256, true); const providerID = string(input.providerID, 256, true); const modelID = string(input.modelID, 256, true); const mode = input.mode === 'stateless' || input.mode === 'continuous' ? input.mode : fail('validation_error'); const assistantID = id(); const workspace = validateWorkspace(input.workspacePath, assistantID, input.workspacePath == null); const roots = validateRoots(input.skillRoots ?? []); const inboxTopicID = id(); const at = timestamp();
    db.exec('BEGIN IMMEDIATE'); try { if (Number(db.prepare('SELECT COUNT(*) AS count FROM assistant WHERE tombstone_at IS NULL').get().count) >= MAX_ASSISTANTS) fail('assistant_limit'); db.prepare('INSERT INTO assistant VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(assistantID, 1, input.enabled === false ? 0 : 1, name, input.defaultPrompt ? string(input.defaultPrompt, 200_000) : '', workspace, json(roots), providerID, modelID, input.agent == null ? null : string(input.agent, 256), mode, inboxTopicID, at, at, null); db.prepare('INSERT INTO assistant_topic VALUES (?,?,?,?,?,?,?,?,?)').run(inboxTopicID, assistantID, 'Inbox', null, null, 1, at, at, null); bump(); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; } return outputAssistant(assistant(assistantID));
  };
  const operationSnapshot = (owner, topicRow) => {
    const workspacePath = validateWorkspace(topicRow.session_workspace_path || owner.workspace_path, owner.assistant_id, false);
    return { assistantRevision: owner.revision, prompt: owner.default_prompt, providerID: owner.provider_id, modelID: owner.model_id, agent: owner.agent, mode: owner.mode, skills: skillCatalog(validateRoots(parse(owner.skill_roots))), workspacePath };
  };
  return {
    capability: async () => ({ supported: true, enabled: enabled(), revision: revision(), serverInstanceID: await getServerId() }), snapshot: () => ({ revision: revision(), enabled: enabled(), assistants: db.prepare('SELECT * FROM assistant WHERE tombstone_at IS NULL ORDER BY created_at').all().map(outputAssistant) }),
    setEnabled: (input) => { if (!plainObject(input) || typeof input.enabled !== 'boolean' || !Number.isInteger(input.expectedRevision)) fail('validation_error'); db.exec('BEGIN IMMEDIATE'); try { if (input.expectedRevision !== revision()) fail('revision_conflict'); db.prepare("UPDATE assistant_meta SET value=? WHERE key='enabled'").run(input.enabled ? '1' : '0'); const result = { enabled: input.enabled, revision: bump() }; db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } }, createAssistant,
    updateAssistant: (assistantID, input) => { const row = assistant(assistantID); if (!row || row.tombstone_at) fail('not_found'); const allowed = new Set(['expectedRevision', 'enabled', 'name', 'defaultPrompt', 'skillRoots', 'providerID', 'modelID', 'agent', 'mode', 'workspacePath']); if (!plainObject(input) || !Number.isInteger(input.expectedRevision) || Object.keys(input).some((key) => !allowed.has(key))) fail('validation_error'); const roots = input.skillRoots === undefined ? parse(row.skill_roots) : validateRoots(input.skillRoots); const workspace = input.workspacePath === undefined ? row.workspace_path : validateWorkspace(input.workspacePath, assistantID, false); db.exec('BEGIN IMMEDIATE'); try { const result = db.prepare('UPDATE assistant SET enabled=?,name=?,default_prompt=?,workspace_path=?,skill_roots=?,provider_id=?,model_id=?,agent=?,mode=?,revision=revision+1,updated_at=? WHERE assistant_id=? AND revision=? AND tombstone_at IS NULL').run(input.enabled === undefined ? row.enabled : input.enabled ? 1 : 0, input.name === undefined ? row.name : string(input.name, 256, true), input.defaultPrompt === undefined ? row.default_prompt : string(input.defaultPrompt, 200_000), workspace, json(roots), input.providerID === undefined ? row.provider_id : string(input.providerID, 256, true), input.modelID === undefined ? row.model_id : string(input.modelID, 256, true), input.agent === undefined ? row.agent : input.agent === null ? null : string(input.agent, 256), input.mode === undefined ? row.mode : input.mode === 'continuous' || input.mode === 'stateless' ? input.mode : fail('validation_error'), timestamp(), assistantID, input.expectedRevision); if (!result.changes) fail('revision_conflict'); bump(); db.exec('COMMIT'); return outputAssistant(assistant(assistantID)); } catch (error) { db.exec('ROLLBACK'); throw error; } },
    removeAssistant: (assistantID, expectedRevision) => { const row = assistant(assistantID); if (!row || row.tombstone_at) fail('not_found'); db.exec('BEGIN IMMEDIATE'); try { const result = db.prepare('UPDATE assistant SET tombstone_at=?,revision=revision+1,updated_at=? WHERE assistant_id=? AND revision=? AND tombstone_at IS NULL').run(timestamp(), timestamp(), assistantID, expectedRevision); if (!result.changes) fail('revision_conflict'); bump(); db.exec('COMMIT'); return { assistantID, tombstoneAt: timestamp() }; } catch (error) { db.exec('ROLLBACK'); throw error; } },
    listTopics: (assistantID) => { const row = assistant(assistantID); if (!row || row.tombstone_at) fail('not_found'); return db.prepare('SELECT * FROM assistant_topic WHERE assistant_id=? AND tombstone_at IS NULL ORDER BY updated_at DESC').all(assistantID).map(outputTopic); },
    createTopic: (assistantID, title = 'New topic') => { const row = assistant(assistantID); if (!row || row.tombstone_at) fail('not_found'); const at = timestamp(); const topicID = id(); db.exec('BEGIN IMMEDIATE'); try { db.prepare('INSERT INTO assistant_topic VALUES (?,?,?,?,?,?,?,?,?)').run(topicID, assistantID, string(title, 256, true), null, null, 1, at, at, null); bump(); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; } return outputTopic(topic(topicID)); },
    updateTopic: (topicID, input) => { const row = topic(topicID); if (!row || row.tombstone_at) fail('not_found'); if (!plainObject(input) || !Number.isInteger(input.expectedRevision)) fail('validation_error'); db.exec('BEGIN IMMEDIATE'); try { const result = db.prepare('UPDATE assistant_topic SET title=?,revision=revision+1,updated_at=? WHERE topic_id=? AND revision=? AND tombstone_at IS NULL').run(string(input.title, 256, true), timestamp(), topicID, input.expectedRevision); if (!result.changes) fail('revision_conflict'); bump(); db.exec('COMMIT'); return outputTopic(topic(topicID)); } catch (error) { db.exec('ROLLBACK'); throw error; } },
    removeTopic: (topicID, expectedRevision) => { const row = topic(topicID); if (!row || row.tombstone_at) fail('not_found'); if (assistant(row.assistant_id).inbox_topic_id === topicID) fail('revision_conflict'); db.exec('BEGIN IMMEDIATE'); try { const result = db.prepare('UPDATE assistant_topic SET tombstone_at=?,revision=revision+1,updated_at=? WHERE topic_id=? AND revision=? AND tombstone_at IS NULL').run(timestamp(), timestamp(), topicID, expectedRevision); if (!result.changes) fail('revision_conflict'); bump(); db.exec('COMMIT'); return { topicID, tombstoneAt: timestamp() }; } catch (error) { db.exec('ROLLBACK'); throw error; } },
    getTurns: async (topicID) => { const { row, owner } = activeTopic(topicID); const turns = db.prepare('SELECT * FROM assistant_turn WHERE topic_id=? ORDER BY ordinal').all(topicID); const operations = new Map(db.prepare('SELECT operation_id,state FROM assistant_operation WHERE topic_id=?').all(topicID).map((operation) => [operation.operation_id, operation.state])); const sessions = [...new Set(turns.map((turn) => turn.session_id).filter(Boolean))]; const settled = await Promise.allSettled(sessions.map(async (sessionID) => [sessionID, await upstreamMessages(sessionID, row.session_workspace_path || owner.workspace_path)])); const records = new Map(settled.map((result, index) => [sessions[index], result.status === 'fulfilled' ? result.value[1] : null])); const failedSessions = new Set(settled.flatMap((result, index) => result.status === 'rejected' ? [sessions[index]] : [])); const output = []; for (const turn of turns) { const error = failedSessions.has(turn.session_id) ? { code: 'upstream_error' } : null; const phase = error ? 'unresolved' : operations.get(turn.operation_id) ?? 'unresolved'; output.push(outputUserTurn(turn, phase)); for (const message of records.get(turn.session_id)?.filter((message) => message?.info?.role === 'assistant' && message.info?.parentID === turn.message_id) ?? []) { const messageError = message.info?.error ?? null; const completedAt = message.info?.time?.completed ?? null; output.push({ id: message.info.id, topicID, ordinal: turn.ordinal, parentMessageID: turn.message_id, phase: messageError ? 'failed' : completedAt !== null ? 'completed' : phase === 'failed' ? 'failed' : 'running', role: 'assistant', parts: message.parts ?? [], sessionID: turn.session_id, messageID: message.info?.id ?? null, createdAt: message.info?.time?.created ?? null, completedAt, error: messageError, operationID: turn.operation_id }); } } return output; },
    submit: (operationID, topicID, parts, source = 'composer') => { if (!['composer', 'ios-share', 'android-share'].includes(source)) fail('validation_error'); const { row, owner } = activeTopic(topicID); validateParts(parts); return admit(operationID, topicID, 'message', { parts, source, snapshot: operationSnapshot(owner, row) }).operation; },
    newTopic: async (operationID, topicID) => { const { row, owner } = activeTopic(topicID); const admission = admit(operationID, topicID, 'new', { snapshot: operationSnapshot(owner, row) }); if (!admission.created) return admission.operation; try { const snapshot = parse(db.prepare('SELECT response FROM assistant_operation WHERE operation_id=?').get(operationID).response).snapshot; db.prepare("UPDATE assistant_operation SET phase='creating_session',updated_at=? WHERE operation_id=?").run(timestamp(), operationID); const created = await createSession({ ...owner, workspace_path: snapshot.workspacePath }, row); if (closed) return admission.operation; if (db.prepare('SELECT state FROM assistant_operation WHERE operation_id=?').get(operationID)?.state !== 'running') return dto(db.prepare('SELECT * FROM assistant_operation WHERE operation_id=?').get(operationID)); db.exec('BEGIN IMMEDIATE'); try { const result = db.prepare('UPDATE assistant_topic SET session_id=?,session_workspace_path=?,revision=revision+1,updated_at=? WHERE topic_id=? AND revision=? AND tombstone_at IS NULL').run(created.sessionID, created.workspace, timestamp(), topicID, row.revision); if (!result.changes) fail('revision_conflict'); bump(); finish(operationID, 'completed', { topicID, sessionID: created.sessionID, workspacePath: created.workspace }); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; } } catch (error) { if (!closed) finish(operationID, 'failed', null, error instanceof AssistantError ? error.code : 'upstream_error'); } return closed ? admission.operation : dto(db.prepare('SELECT * FROM assistant_operation WHERE operation_id=?').get(operationID)); },
    compact: async (operationID, topicID) => { const { row, owner } = activeTopic(topicID); if (!row.session_id) fail('validation_error'); const admission = admit(operationID, topicID, 'compact', { snapshot: operationSnapshot(owner, row) }); if (!admission.created) return admission.operation; try { const snapshot = parse(db.prepare('SELECT response FROM assistant_operation WHERE operation_id=?').get(operationID).response).snapshot; validateWorkspace(snapshot.workspacePath, owner.assistant_id, false); db.prepare("UPDATE assistant_operation SET phase='submitting',updated_at=? WHERE operation_id=?").run(timestamp(), operationID); const result = await client().session.summarize({ sessionID: row.session_id, directory: snapshot.workspacePath, providerID: snapshot.providerID, modelID: snapshot.modelID }); if (result.error || result.data !== true) fail('upstream_error'); finish(operationID, 'completed', { topicID, sessionID: row.session_id, summarized: true }); } catch (error) { finish(operationID, 'failed', null, error instanceof AssistantError ? error.code : 'upstream_error'); } return dto(db.prepare('SELECT * FROM assistant_operation WHERE operation_id=?').get(operationID)); },
    operation: async (operationID) => { const row = db.prepare('SELECT * FROM assistant_operation WHERE operation_id=?').get(operationID); if (!row) return undefined; return reconcile(row); }, close: () => { if (closed) return; closed = true; clearIntervalFn(reconciliationTimer); db.close(); },
  };
};
