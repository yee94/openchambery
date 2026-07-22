import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createAssistantsService } from './service.js';
import { assistantContractFixtures } from './contracts.js';

const require = createRequire(import.meta.url);
const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'assistants-'));
// Behavioral tests enable the global switch after boot; pass enabled:false to assert the fresh-install default.
const setup = (directory = root(), client = {}, options = {}) => {
  const { enabled = true, ...serviceOptions } = options;
  const service = createAssistantsService({ dbPath: path.join(directory, 'assistants.sqlite'), dataDir: directory, getAllowedRoots: () => [directory], buildOpenCodeUrl: () => 'http://127.0.0.1:1', getOpenCodeAuthHeaders: () => ({}), clientFactory: () => ({ session: { create: async () => ({ data: { id: crypto.randomUUID() } }), get: async () => ({ data: { id: 'present' } }), promptAsync: async () => ({ data: { info: { id: 'msg_1' } } }), summarize: async () => ({ data: true }), ...client } }), ...serviceOptions });
  if (enabled) {
    const snapshot = service.snapshot();
    if (!snapshot.enabled) service.setEnabled({ enabled: true, expectedRevision: snapshot.revision });
  }
  return service;
};
const assistantInput = { name: 'A', providerID: 'p', modelID: 'm' };

describe('assistants service', () => {
  it('migrates a legacy inbox binding once and exposes the v2 DTO', () => {
    const directory = root(); const Database = require('better-sqlite3'); const db = new Database(path.join(directory, 'assistants.sqlite'));
    db.exec("CREATE TABLE assistant_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE assistant (assistant_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, enabled INTEGER NOT NULL, name TEXT NOT NULL, default_prompt TEXT NOT NULL, workspace_path TEXT, skill_roots TEXT NOT NULL, provider_id TEXT NOT NULL, model_id TEXT NOT NULL, agent TEXT, mode TEXT NOT NULL, inbox_topic_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, tombstone_at INTEGER); CREATE TABLE assistant_topic (topic_id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL, title TEXT NOT NULL, session_id TEXT, session_workspace_path TEXT, revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, tombstone_at INTEGER); CREATE TABLE assistant_turn (turn_id TEXT PRIMARY KEY, topic_id TEXT NOT NULL, ordinal INTEGER NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL, parts TEXT NOT NULL, assistant_revision INTEGER NOT NULL, session_id TEXT, message_id TEXT, operation_id TEXT, created_at INTEGER NOT NULL); CREATE TABLE assistant_operation (operation_id TEXT PRIMARY KEY, topic_id TEXT, type TEXT, payload_hash TEXT NOT NULL, state TEXT NOT NULL, phase TEXT, response TEXT, error_code TEXT, attempt INTEGER, lease_expires_at INTEGER, session_id TEXT, message_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
    db.prepare('INSERT INTO assistant VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('a', 1, 1, 'A', '', directory, '[]', 'p', 'm', null, 'stateless', 'inbox', 1, 1, null); db.prepare('INSERT INTO assistant_topic VALUES (?,?,?,?,?,?,?,?,?)').run('inbox', 'a', 'Inbox', 'ses_old', directory, 1, 1, 1, null); db.close();
    const service = setup(directory); expect(service.snapshot().assistants[0]).toMatchObject({ id: 'a', sessionID: 'ses_old', sessionGeneration: 0, mode: 'stateless' }); expect(service.snapshot().assistants[0]).not.toHaveProperty('skillRoots'); expect(service.createAssistant(assistantInput).sessionID).toBeNull(); service.close(); const migrated = new Database(path.join(directory, 'assistants.sqlite')); expect(migrated.prepare("SELECT name FROM pragma_table_info('assistant_v2') WHERE name='skill_roots'").get()).toBeUndefined(); migrated.close();
  });

  it('migrates stored managed workspace paths to null configuration', () => {
    const directory = root(); const assistantID = 'managed'; const managed = path.join(directory, 'assistant-workspaces', assistantID); fs.mkdirSync(managed, { recursive: true }); const Database = require('better-sqlite3'); const db = new Database(path.join(directory, 'assistants.sqlite'));
    db.exec('CREATE TABLE assistant_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE assistant_v2 (assistant_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, enabled INTEGER NOT NULL, name TEXT NOT NULL, default_prompt TEXT NOT NULL, workspace_path TEXT NOT NULL, provider_id TEXT NOT NULL, model_id TEXT NOT NULL, agent TEXT, current_session_id TEXT, session_generation INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, tombstone_at INTEGER)'); db.prepare("INSERT INTO assistant_meta VALUES ('schema_version','4')").run(); db.prepare('INSERT INTO assistant_v2 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(assistantID, 1, 1, 'Managed', '', managed, 'p', 'm', null, 'ses_managed', 1, 1, 1, null); db.close();
    const service = setup(directory); expect(service.snapshot().assistants[0]).toMatchObject({ workspacePath: null, managedWorkspacePath: fs.realpathSync(managed), effectiveWorkspacePath: fs.realpathSync(managed) }); service.close(); const migrated = new Database(path.join(directory, 'assistants.sqlite')); expect(migrated.prepare('SELECT workspace_path FROM assistant_v2 WHERE assistant_id=?').get(assistantID).workspace_path).toBeNull(); expect(migrated.prepare("SELECT \"notnull\" AS required FROM pragma_table_info('assistant_v2') WHERE name='workspace_path'").get().required).toBe(0); migrated.close();
  });

  it('creates one winning binding under concurrent ensure', async () => {
    let creates = 0; const service = setup(root(), { create: async () => ({ data: { id: `ses_${++creates}` } }), get: async () => ({ error: { status: 404 } }) }); const assistant = service.createAssistant(assistantInput);
    const [first, second] = await Promise.all([service.ensure(assistant.id), service.ensure(assistant.id)]);
    expect(first).toEqual(second); expect(first.sessionGeneration).toBe(1); service.close();
  });

  it('creates managed assistants with null configuration and an effective session directory', async () => {
    const directory = root(); let created; const service = setup(directory, { create: async (input) => { created = input; return { data: { id: 'ses_managed' } }; } }); const assistant = service.createAssistant(assistantInput); const managed = path.join(directory, 'assistant-workspaces', assistant.id);
    expect(assistant).toMatchObject({ workspacePath: null, managedWorkspacePath: fs.realpathSync(managed), effectiveWorkspacePath: fs.realpathSync(managed) }); expect(fs.statSync(managed).isDirectory()).toBe(true); expect(await service.ensure(assistant.id)).toEqual({ sessionID: 'ses_managed', directory: fs.realpathSync(managed), sessionGeneration: 1 }); expect(created.directory).toBe(fs.realpathSync(managed)); const db = new (require('better-sqlite3'))(path.join(directory, 'assistants.sqlite')); expect(db.prepare('SELECT workspace_path FROM assistant_v2 WHERE assistant_id=?').get(assistant.id).workspace_path).toBeNull(); db.close(); service.close();
  });

  it('switches directory with a new OpenCode session', async () => {
    const directory = root(); const other = path.join(directory, 'other'); fs.mkdirSync(other); let created = 0; const service = setup(directory, { create: async () => ({ data: { id: `ses_${++created}` } }) }); const assistant = service.createAssistant(assistantInput); await service.ensure(assistant.id);
    const updated = await service.updateAssistant(assistant.id, { expectedRevision: 1, workspacePath: other }); expect(updated).toMatchObject({ workspacePath: fs.realpathSync(other), effectiveWorkspacePath: fs.realpathSync(other), sessionID: 'ses_2', sessionGeneration: 2 }); service.close();
  });

  it('exposes project Assistant workspace paths and restores the managed effective path', async () => {
    const directory = root(); const project = path.join(directory, 'project'); fs.mkdirSync(project); let created = 0; const service = setup(directory, { create: async () => ({ data: { id: `ses_${++created}` } }) }); const assistant = service.createAssistant({ ...assistantInput, workspacePath: project }); const projectDirectory = fs.realpathSync(project); const managedDirectory = fs.realpathSync(path.join(directory, 'assistant-workspaces', assistant.id)); expect(assistant).toMatchObject({ workspacePath: projectDirectory, managedWorkspacePath: managedDirectory, effectiveWorkspacePath: projectDirectory }); const first = await service.ensure(assistant.id);
    const managed = await service.updateAssistant(assistant.id, { expectedRevision: 1, workspacePath: null }); expect(managed).toMatchObject({ workspacePath: null, managedWorkspacePath: managedDirectory, effectiveWorkspacePath: managedDirectory, sessionID: 'ses_2', sessionGeneration: 2 }); expect(managed.effectiveWorkspacePath).toBe(managed.managedWorkspacePath); expect(await service.ensure(assistant.id)).toEqual({ sessionID: 'ses_2', directory: managedDirectory, sessionGeneration: 2 });
    const projectAgain = await service.updateAssistant(assistant.id, { expectedRevision: 2, workspacePath: project }); expect(projectAgain).toMatchObject({ workspacePath: projectDirectory, managedWorkspacePath: managedDirectory, effectiveWorkspacePath: projectDirectory, sessionID: 'ses_3', sessionGeneration: 3 }); const restoredManaged = await service.updateAssistant(assistant.id, { expectedRevision: 3, workspacePath: null }); expect(restoredManaged.effectiveWorkspacePath).toBe(restoredManaged.managedWorkspacePath); expect(first.directory).toBe(projectDirectory); service.close();
  });

  it('keeps the session binding across repeated workspace configuration patches', async () => {
    const directory = root(); const project = path.join(directory, 'project'); fs.mkdirSync(project); let created = 0; const service = setup(directory, { create: async () => ({ data: { id: `ses_${++created}` } }) }); const assistant = service.createAssistant(assistantInput); await service.ensure(assistant.id);
    const managed = await service.updateAssistant(assistant.id, { expectedRevision: 1, workspacePath: null }); expect(managed).toMatchObject({ sessionID: 'ses_1', sessionGeneration: 1, workspacePath: null }); const projectAssistant = await service.updateAssistant(assistant.id, { expectedRevision: 2, workspacePath: project }); const repeatedProject = await service.updateAssistant(assistant.id, { expectedRevision: 3, workspacePath: project }); expect(projectAssistant).toMatchObject({ sessionID: 'ses_2', sessionGeneration: 2 }); expect(repeatedProject).toMatchObject({ sessionID: 'ses_2', sessionGeneration: 2, workspacePath: fs.realpathSync(project) }); service.close();
  });

  it('creates a new binding and compacts only its expected generation', async () => {
    const service = setup(); const assistant = service.createAssistant(assistantInput); const current = await service.ensure(assistant.id); const next = await service.createNew(assistant.id); expect(next.sessionGeneration).toBe(current.sessionGeneration + 1); await expect(service.compact(assistant.id, current)).rejects.toMatchObject({ code: 'revision_conflict' }); expect(await service.compact(assistant.id, next)).toMatchObject({ binding: next, summarized: true }); service.close();
  });

  it('keeps ordinary composer history out of SQLite and restores a 404 binding', async () => {
    let gets = 0; let prompts = 0; const directory = root(); const service = setup(directory, { create: async () => ({ data: { id: `ses_${gets + 1}` } }), get: async () => (++gets === 1 ? { data: { id: 'ses_1' } } : { error: { status: 404 } }), promptAsync: async () => (++prompts === 1 ? { error: { status: 404 } } : { data: { info: { id: 'msg_2' } } }) }); const assistant = service.createAssistant(assistantInput); const current = await service.ensure(assistant.id); const sent = await service.send(assistant.id, { ...current, messageID: 'client_1', parts: [{ type: 'text', text: 'hello' }] }); expect(sent.binding.sessionGeneration).toBe(2); const db = new (require('better-sqlite3'))(path.join(directory, 'assistants.sqlite')); expect(db.prepare('SELECT COUNT(*) AS count FROM assistant_turn').get().count).toBe(0); db.close(); service.close();
  });

  it('returns the frozen compact and message admission DTO field sets', async () => {
    const service = setup(root(), { promptAsync: async () => ({ response: { status: 204 } }) }); const assistant = service.createAssistant(assistantInput); const current = await service.ensure(assistant.id);
    expect(await service.compact(assistant.id, current)).toEqual({ binding: current, summarized: true });
    expect(await service.send(assistant.id, { ...current, messageID: 'client_204', parts: [{ type: 'text', text: 'hello' }] })).toEqual({ binding: current, messageID: 'client_204', admitted: true });
    expect(Object.keys(assistantContractFixtures.assistant)).toContain('managedWorkspacePath'); expect(Object.keys(assistantContractFixtures.assistant)).not.toContain('skillRoots'); expect(Object.keys(assistantContractFixtures.compactResponse).sort()).toEqual(['binding', 'summarized']); expect(Object.keys(assistantContractFixtures.messageAdmission).sort()).toEqual(['admitted', 'binding', 'messageID']); service.close();
  });

  it('admits 33-part direct messages and 129-part shares', async () => {
    const prompts = []; const service = setup(root(), { promptAsync: async (input) => { prompts.push(input); return { response: { status: 204 } }; } }); const assistant = service.createAssistant(assistantInput); const binding = await service.ensure(assistant.id);
    const directParts = Array.from({ length: 33 }, (_, index) => ({ type: 'text', text: String(index) })); const shareParts = Array.from({ length: 129 }, (_, index) => ({ type: 'text', text: String(index) }));
    await service.send(assistant.id, { ...binding, messageID: 'parts-33', parts: directParts }); await service.share(assistant.id, { operationID: 'parts-129', payload: { messageID: 'share-parts-129', parts: shareParts } });
    const deliveryTarget = service.captureQueueDeliveryTarget({ assistantID: assistant.id, scope: { sessionID: binding.sessionID, directory: binding.directory } }); await service.sendWithCapturedConfig({ deliveryTarget, messageID: 'delivery-parts-129', parts: shareParts });
    expect(prompts.map((prompt) => prompt.parts.length)).toEqual([33, 129, 129]); service.close();
  });

  it('rejects 130-part direct messages and shares before claim', async () => {
    const service = setup(); const assistant = service.createAssistant(assistantInput); const binding = await service.ensure(assistant.id); const parts = Array.from({ length: 130 }, (_, index) => ({ type: 'text', text: String(index) }));
    await expect(service.send(assistant.id, { ...binding, messageID: 'parts-130', parts })).rejects.toMatchObject({ code: 'validation_error' }); await expect(service.share(assistant.id, { operationID: 'share-parts-130', payload: { messageID: 'share-parts-130', parts } })).rejects.toMatchObject({ code: 'validation_error' }); service.close();
  });

  it('accepts ordinary data URLs beyond the former 4096-character limit', async () => {
    const service = setup(); const assistant = service.createAssistant(assistantInput); const binding = await service.ensure(assistant.id);
    await expect(service.send(assistant.id, { ...binding, messageID: 'data-url', parts: [{ type: 'file', mime: 'application/octet-stream', url: `data:application/octet-stream;base64,${'A'.repeat(8_192)}` }] })).resolves.toMatchObject({ admitted: true });
    service.close();
  });

  it('applies the complete workspace patch and creates metadata with the final name', async () => {
    const directory = root(); const other = path.join(directory, 'other'); fs.mkdirSync(other); let created; const service = setup(directory, { create: async (input) => { created = input; return { data: { id: 'ses_workspace' } }; } }); const assistant = service.createAssistant(assistantInput);
    const updated = await service.updateAssistant(assistant.id, { expectedRevision: 1, workspacePath: other, name: 'Renamed', defaultPrompt: 'P', providerID: 'provider-2', modelID: 'model-2', agent: 'agent-2', enabled: false }); expect(updated).toMatchObject({ name: 'Renamed', defaultPrompt: 'P', providerID: 'provider-2', modelID: 'model-2', agent: 'agent-2', enabled: false, sessionID: 'ses_workspace' }); expect(updated).not.toHaveProperty('skillRoots'); expect(created).toMatchObject({ title: 'Renamed', metadata: { openchamber: { assistant: { name: 'Renamed' } } } }); service.close();
  });

  it('persists nullable variants and sends the captured OpenCode variant for messages and shares', async () => {
    const prompts = []; const service = setup(root(), { promptAsync: async (input) => { prompts.push(input); return { response: { status: 204 } }; } });
    const assistant = service.createAssistant({ ...assistantInput, variant: 'fast' });
    expect(assistant.variant).toBe('fast');
    const binding = await service.ensure(assistant.id);
    await service.send(assistant.id, { ...binding, messageID: 'variant-message', parts: [{ type: 'text', text: 'message' }] });
    await service.share(assistant.id, { operationID: 'variant-share', payload: { messageID: 'variant-share-message', parts: [{ type: 'text', text: 'share' }] } });
    expect(prompts).toEqual(expect.arrayContaining([expect.objectContaining({ variant: 'fast' })]));
    expect(await service.updateAssistant(assistant.id, { expectedRevision: 1, variant: null })).toMatchObject({ variant: null });
    service.close();
  });

  it('persists idempotent share work with its top-level identity DTO and keeps assistant sessions in the index', async () => {
    const service = setup(); const assistant = service.createAssistant(assistantInput); const payload = { messageID: 'client_share', parts: [{ type: 'text', text: 'shared' }] }; const first = await service.share(assistant.id, { operationID: 'share_1', payload }); const second = await service.share(assistant.id, { operationID: 'share_1', payload }); expect(second).toEqual(first); expect(service.shareOperation('share_1')).toMatchObject({ sessionID: expect.any(String), messageID: 'client_share', state: 'running', phase: 'submitted', attempt: 1 }); expect(first).not.toHaveProperty('binding'); expect(Object.keys(first).sort()).toEqual(Object.keys(assistantContractFixtures.shareOperation).sort()); service.close();
  });

  it('reuses one stateless share reservation for sequential duplicate requests', async () => {
    let creates = 0; let prompts = 0; const service = setup(root(), { create: async () => ({ data: { id: `ses_${++creates}` } }), promptAsync: async () => { prompts++; return { response: { status: 204 } }; } }); const assistant = service.createAssistant({ ...assistantInput, mode: 'stateless' }); const payload = { messageID: 'stateless-sequential-message', parts: [{ type: 'text', text: 'shared' }] };
    const first = await service.share(assistant.id, { operationID: 'stateless-sequential', payload }); const second = await service.share(assistant.id, { operationID: 'stateless-sequential', payload });
    expect(creates).toBe(1); expect(prompts).toBe(1); expect(second.sessionID).toBe(first.sessionID); service.close();
  });

  it('reuses one stateless share reservation for concurrent duplicate requests', async () => {
    let creates = 0; let prompts = 0; const service = setup(root(), { create: async () => ({ data: { id: `ses_${++creates}` } }), promptAsync: async () => { prompts++; return { response: { status: 204 } }; } }); const assistant = service.createAssistant({ ...assistantInput, mode: 'stateless' }); const payload = { messageID: 'stateless-concurrent-message', parts: [{ type: 'text', text: 'shared' }] };
    const [first, second] = await Promise.all([service.share(assistant.id, { operationID: 'stateless-concurrent', payload }), service.share(assistant.id, { operationID: 'stateless-concurrent', payload })]);
    expect(creates).toBe(1); expect(prompts).toBe(1); expect(second.sessionID).toBe(first.sessionID); service.close();
  });

  it('rejects conflicting stateless share payloads without creating another session', async () => {
    let creates = 0; let prompts = 0; const service = setup(root(), { create: async () => ({ data: { id: `ses_${++creates}` } }), promptAsync: async () => { prompts++; return { response: { status: 204 } }; } }); const assistant = service.createAssistant({ ...assistantInput, mode: 'stateless' });
    await service.share(assistant.id, { operationID: 'stateless-conflict', payload: { messageID: 'stateless-conflict-message', parts: [{ type: 'text', text: 'first' }] } }); await expect(service.share(assistant.id, { operationID: 'stateless-conflict', payload: { messageID: 'stateless-conflict-message', parts: [{ type: 'text', text: 'second' }] } })).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(creates).toBe(1); expect(prompts).toBe(1); service.close();
  });

  it('allows one claimant to submit a shared operation during concurrent admission', async () => {
    let release; let prompts = 0; const wait = new Promise((resolve) => { release = resolve; }); const service = setup(root(), { promptAsync: async () => { prompts++; await wait; return { response: { status: 204 } }; } }); const assistant = service.createAssistant(assistantInput); const payload = { messageID: 'client_concurrent', parts: [{ type: 'text', text: 'shared' }] };
    const first = service.share(assistant.id, { operationID: 'share_concurrent', payload }); const second = await service.share(assistant.id, { operationID: 'share_concurrent', payload }); expect(second).toMatchObject({ state: 'running', phase: 'submitting', attempt: 1 }); expect(prompts).toBe(1); release(); await first; service.close();
  });

  it('recovers a failed share through one CAS retry claimant', async () => {
    let prompts = 0; const service = setup(root(), { promptAsync: async () => (++prompts === 1 ? { error: { status: 503 } } : { response: { status: 204 } }) }); const assistant = service.createAssistant(assistantInput); const payload = { messageID: 'client_retry', parts: [{ type: 'text', text: 'shared' }] };
    expect(await service.share(assistant.id, { operationID: 'share_retry', payload })).toMatchObject({ state: 'failed', attempt: 1 }); const [first, second] = await Promise.all([service.share(assistant.id, { operationID: 'share_retry', payload }), service.share(assistant.id, { operationID: 'share_retry', payload })]); expect(prompts).toBe(2); expect([first.state, second.state]).toContain('running'); service.close();
  });

  it('marks an expired submitted lease unresolved after message-ID reconciliation', async () => {
    let time = 1_000; let scheduled; const service = setup(root(), { promptAsync: async () => ({ response: { status: 204 } }), messages: async () => ({ data: [] }) }, { clock: () => time, setIntervalFn: (work) => { scheduled = work; return 1; }, clearIntervalFn: () => {} }); const assistant = service.createAssistant(assistantInput); const payload = { messageID: 'client_lease', parts: [{ type: 'text', text: 'shared' }] };
    await service.share(assistant.id, { operationID: 'share_lease', payload }); time += 30_001; scheduled(); await new Promise((resolve) => setImmediate(resolve)); expect(service.shareOperation('share_lease')).toMatchObject({ state: 'unresolved', phase: 'submitted', errorCode: 'message_unresolved', leaseExpiresAt: null }); service.close();
  });

  it('uses the workspace directory for OpenCode skill discovery without catalog injection', async () => {
    const directory = root(); const workspace = path.join(directory, 'workspace'); const skill = path.join(workspace, '.agents', 'skills', 'project-skill'); fs.mkdirSync(skill, { recursive: true }); fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: project-skill\ndescription: Project skill\n---\nInstructions'); let created; let prompt; const service = setup(directory, { create: async (input) => { created = input; return { data: { id: 'ses_workspace' } }; }, promptAsync: async (input) => { prompt = input; return { response: { status: 204 } }; } }); const assistant = service.createAssistant({ ...assistantInput, workspacePath: workspace, defaultPrompt: 'Base prompt' }); const current = await service.ensure(assistant.id);
    await service.send(assistant.id, { ...current, messageID: 'client_skill', parts: [{ type: 'text', text: 'hello' }] }); expect(created.directory).toBe(fs.realpathSync(workspace)); expect(prompt.directory).toBe(fs.realpathSync(workspace)); expect(prompt.system).toBe('Base prompt'); expect(prompt.system).not.toContain('project-skill'); service.close();
  });

  it('rejects retired skillRoots input', async () => {
    const service = setup(); expect(() => service.createAssistant({ ...assistantInput, skillRoots: [] })).toThrow('validation_error'); const assistant = service.createAssistant(assistantInput); await expect(service.updateAssistant(assistant.id, { expectedRevision: 1, skillRoots: [] })).rejects.toThrow('validation_error'); service.close();
  });

  it('uses the workspace directory when submitting shares', async () => {
    const directory = root(); const workspace = path.join(directory, 'workspace'); fs.mkdirSync(workspace); let prompt; const service = setup(directory, { promptAsync: async (input) => { prompt = input; return { response: { status: 204 } }; } }); const assistant = service.createAssistant({ ...assistantInput, workspacePath: workspace });
    await service.share(assistant.id, { operationID: 'share_directory', payload: { messageID: 'client_share_directory', parts: [{ type: 'text', text: 'shared' }] } }); expect(prompt.directory).toBe(fs.realpathSync(workspace)); service.close();
  });

  it('defaults the global Assistants switch to off and preserves a persisted on value', async () => {
    const fresh = setup(root(), {}, { enabled: false }); expect(await fresh.capability()).toMatchObject({ supported: true, enabled: false, revision: 0 }); expect(fresh.snapshot()).toMatchObject({ enabled: false, revision: 0 }); expect(fresh.setEnabled({ enabled: true, expectedRevision: 0 })).toMatchObject({ enabled: true, revision: 1 }); fresh.close();
    const directory = root(); const Database = require('better-sqlite3'); const db = new Database(path.join(directory, 'assistants.sqlite'));
    db.exec('CREATE TABLE assistant_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)'); db.prepare("INSERT INTO assistant_meta VALUES ('enabled','1')").run(); db.prepare("INSERT INTO assistant_meta VALUES ('revision','3')").run(); db.prepare("INSERT INTO assistant_meta VALUES ('schema_version','8')").run(); db.close();
    const persisted = setup(directory, {}, { enabled: false }); expect(await persisted.capability()).toMatchObject({ supported: true, enabled: true, revision: 3 }); expect(persisted.snapshot()).toMatchObject({ enabled: true, revision: 3 }); persisted.close();
  });

  it('permits a disabled assistant to be re-enabled through an editable CAS patch', async () => {
    const service = setup(); const assistant = service.createAssistant({ ...assistantInput, enabled: false }); const updated = await service.updateAssistant(assistant.id, { expectedRevision: 1, enabled: true, name: 'Enabled again' }); expect(updated).toMatchObject({ enabled: true, name: 'Enabled again', revision: 2 }); service.close();
  });

  it('defaults assistants to continuous mode and persists a mode patch', async () => {
    const service = setup(); const assistant = service.createAssistant(assistantInput); expect(assistant.mode).toBe('continuous');
    expect(await service.updateAssistant(assistant.id, { expectedRevision: 1, mode: 'stateless' })).toMatchObject({ mode: 'stateless', revision: 2 });
    expect(await service.updateAssistant(assistant.id, { expectedRevision: 2, mode: 'continuous' })).toMatchObject({ mode: 'continuous', revision: 3 });
    service.close();
  });

  it('creates a fresh OpenCode session for every stateless composer send', async () => {
    let creates = 0; const prompts = [];
    const service = setup(root(), { create: async () => ({ data: { id: `ses_${++creates}` } }), promptAsync: async (input) => { prompts.push(input); return { response: { status: 204 } }; } });
    const assistant = service.createAssistant({ ...assistantInput, mode: 'stateless' });
    const first = await service.ensure(assistant.id);
    const sent = await service.send(assistant.id, { ...first, messageID: 'stateless-1', parts: [{ type: 'text', text: 'one' }] });
    expect(sent.binding.sessionID).not.toBe(first.sessionID);
    expect(sent.binding.sessionGeneration).toBe(first.sessionGeneration + 1);
    expect(prompts[0]?.sessionID).toBe(sent.binding.sessionID);
    const second = await service.send(assistant.id, { ...sent.binding, messageID: 'stateless-2', parts: [{ type: 'text', text: 'two' }] });
    expect(second.binding.sessionID).not.toBe(sent.binding.sessionID);
    expect(second.binding.sessionGeneration).toBe(sent.binding.sessionGeneration + 1);
    expect(prompts.map((prompt) => prompt.sessionID)).toEqual([sent.binding.sessionID, second.binding.sessionID]);
    expect(service.snapshot().assistants[0].historySessionIDs).toEqual([first.sessionID, sent.binding.sessionID]);
    service.close();
  });

  it('archives replaced bindings for continuous /new and workspace moves', async () => {
    let creates = 0;
    const directory = root();
    const project = path.join(directory, 'project');
    fs.mkdirSync(project, { recursive: true });
    const service = setup(directory, { create: async () => ({ data: { id: `ses_${++creates}` } }) });
    const assistant = service.createAssistant(assistantInput);
    const first = await service.ensure(assistant.id);
    const next = await service.createNew(assistant.id);
    expect(next.sessionID).not.toBe(first.sessionID);
    expect(service.snapshot().assistants[0].historySessionIDs).toEqual([first.sessionID]);
    const moved = await service.updateAssistant(assistant.id, { expectedRevision: service.snapshot().assistants[0].revision, workspacePath: project });
    expect(moved.sessionID).not.toBe(next.sessionID);
    expect(moved.historySessionIDs).toEqual([first.sessionID, next.sessionID]);
    service.close();
  });

  it('keeps continuous composer sends on the same binding', async () => {
    let creates = 0; const prompts = [];
    const service = setup(root(), { create: async () => ({ data: { id: `ses_${++creates}` } }), promptAsync: async (input) => { prompts.push(input); return { response: { status: 204 } }; } });
    const assistant = service.createAssistant({ ...assistantInput, mode: 'continuous' });
    const binding = await service.ensure(assistant.id);
    const sent = await service.send(assistant.id, { ...binding, messageID: 'continuous-1', parts: [{ type: 'text', text: 'hello' }] });
    expect(sent.binding).toEqual(binding);
    expect(prompts[0]?.sessionID).toBe(binding.sessionID);
    expect(creates).toBe(1);
    service.close();
  });
});
