import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createAssistantsService } from './service.js';
import { assistantContractFixtures } from './contracts.js';

const require = createRequire(import.meta.url);
const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'assistants-'));

const v2Error = (result) => {
  if (!result?.error) return result;
  const error = new Error(result.error.code || 'upstream');
  error.status = result.error.status ?? result.error.statusCode ?? result.status;
  error.cause = { status: error.status };
  error.reason = 'UnexpectedStatus';
  throw error;
};
const createV2Client = (overrides = {}) => {
  const create = overrides.create ?? (async () => ({ id: crypto.randomUUID() }));
  const get = overrides.get ?? (async () => ({ id: 'present' }));
  const prompt = overrides.prompt ?? overrides.promptAsync ?? (async () => ({ id: 'inbox_1', type: 'user' }));
  const compact = overrides.compact ?? overrides.summarize ?? (async () => ({ id: 'inbox_compact', type: 'compaction' }));
  const interrupt = overrides.interrupt ?? overrides.abort ?? (async () => {});
  const rename = overrides.rename ?? (async () => {});
  const remove = overrides.remove ?? (async () => {});
  const list = overrides.messages ?? overrides.list ?? (async () => ({ data: [], cursor: {} }));
  const switchAgent = overrides.switchAgent ?? (async () => {});
  const switchModel = overrides.switchModel ?? (async () => {});
  const putInstruction = overrides.putInstruction ?? (async () => {});
  return {
    session: {
      create: async (input) => create(input),
      get: async (input) => get(input),
      rename,
      remove,
      prompt: async (input) => prompt(input),
      compact: async (input) => compact(input),
      interrupt: async (input) => interrupt(input),
      switchAgent,
      switchModel,
      instructions: { entry: { put: putInstruction } },
    },
    message: {
      list: async (input) => {
        const result = await list({ ...input, before: input?.cursor });
        if (result?.error) return result;
        if (Array.isArray(result?.data) || result?.cursor || result?.response) return result;
        if (Array.isArray(result)) return { data: result, cursor: {} };
        return result;
      },
    },
  };
};
// Behavioral tests enable the global switch after boot; pass enabled:false to assert the fresh-install default.
const setup = (directory = root(), client = {}, options = {}) => {
  const { enabled = true, ...serviceOptions } = options;
  const service = createAssistantsService({ dbPath: path.join(directory, 'assistants.sqlite'), dataDir: directory, getAllowedRoots: () => [directory], buildOpenCodeUrl: () => 'http://127.0.0.1:1', getOpenCodeAuthHeaders: () => ({}), clientFactory: () => createV2Client(client), ...serviceOptions });
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
    expect(assistant).toMatchObject({ workspacePath: null, managedWorkspacePath: fs.realpathSync(managed), effectiveWorkspacePath: fs.realpathSync(managed) }); expect(fs.statSync(managed).isDirectory()).toBe(true); expect(await service.ensure(assistant.id)).toEqual({ sessionID: 'ses_managed', directory: fs.realpathSync(managed), sessionGeneration: 1 }); expect(created.location.directory).toBe(fs.realpathSync(managed)); const db = new (require('better-sqlite3'))(path.join(directory, 'assistants.sqlite')); expect(db.prepare('SELECT workspace_path FROM assistant_v2 WHERE assistant_id=?').get(assistant.id).workspace_path).toBeNull(); db.close(); service.close();
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
    let gets = 0; let prompts = 0; const directory = root(); const service = setup(directory, { create: async () => ({ data: { id: `ses_${gets + 1}` } }), get: async () => (++gets === 1 ? { data: { id: 'ses_1' } } : { error: { status: 404 } }), prompt: async () => (++prompts === 1 ? { error: { status: 404 } } : { data: { info: { id: 'msg_2' } } }) }); const assistant = service.createAssistant(assistantInput); const current = await service.ensure(assistant.id); const sent = await service.send(assistant.id, { ...current, messageID: 'client_1', parts: [{ type: 'text', text: 'hello' }] }); expect(sent.binding.sessionGeneration).toBe(2); const db = new (require('better-sqlite3'))(path.join(directory, 'assistants.sqlite')); expect(db.prepare('SELECT COUNT(*) AS count FROM assistant_turn').get().count).toBe(0); db.close(); service.close();
  });

  it('returns the frozen compact and message admission DTO field sets', async () => {
    const service = setup(root(), { prompt: async () => ({ response: { status: 204 } }) }); const assistant = service.createAssistant(assistantInput); const current = await service.ensure(assistant.id);
    expect(await service.compact(assistant.id, current)).toEqual({ binding: current, summarized: true });
    expect(await service.send(assistant.id, { ...current, messageID: 'client_204', parts: [{ type: 'text', text: 'hello' }] })).toEqual({ binding: current, messageID: 'client_204', admitted: true });
    expect(Object.keys(assistantContractFixtures.assistant)).toContain('managedWorkspacePath'); expect(Object.keys(assistantContractFixtures.assistant)).not.toContain('skillRoots'); expect(Object.keys(assistantContractFixtures.compactResponse).sort()).toEqual(['binding', 'summarized']); expect(Object.keys(assistantContractFixtures.messageAdmission).sort()).toEqual(['admitted', 'binding', 'messageID']); service.close();
  });

  it('admits 33-part direct messages and 129-part shares', async () => {
    const prompts = []; const service = setup(root(), { prompt: async (input) => { prompts.push(input); return { response: { status: 204 } }; } }); const assistant = service.createAssistant(assistantInput); const binding = await service.ensure(assistant.id);
    const directParts = Array.from({ length: 33 }, (_, index) => ({ type: 'text', text: String(index) })); const shareParts = Array.from({ length: 129 }, (_, index) => ({ type: 'text', text: String(index) }));
    await service.send(assistant.id, { ...binding, messageID: 'parts-33', parts: directParts }); await service.share(assistant.id, { operationID: 'parts-129', payload: { messageID: 'share-parts-129', parts: shareParts } });
    const deliveryTarget = service.captureQueueDeliveryTarget({ assistantID: assistant.id, scope: { sessionID: binding.sessionID, directory: binding.directory } }); await service.sendWithCapturedConfig({ deliveryTarget, messageID: 'delivery-parts-129', parts: shareParts });
    expect(prompts.map((prompt) => prompt.text.split('\n').length)).toEqual([33, 129, 129]); expect(prompts.every((prompt) => prompt.delivery === 'steer' && prompt.id)).toBe(true); service.close();
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
    const updated = await service.updateAssistant(assistant.id, { expectedRevision: 1, workspacePath: other, name: 'Renamed', defaultPrompt: 'P', providerID: 'provider-2', modelID: 'model-2', agent: 'agent-2', enabled: false }); expect(updated).toMatchObject({ name: 'Renamed', defaultPrompt: 'P', providerID: 'provider-2', modelID: 'model-2', agent: 'agent-2', enabled: false, sessionID: 'ses_workspace' }); expect(updated).not.toHaveProperty('skillRoots'); expect(created).toMatchObject({ title: '[Assistant] Renamed', location: { directory: expect.any(String) } }); expect(created).not.toHaveProperty('metadata'); service.close();
  });

  it('creates Assistant sessions with a fixed title prefix and v2 location, without archive metadata', async () => {
    const directory = root();
    const order = [];
    let created;
    let archived = null;
    const service = setup(directory, {
      create: async (input) => {
        order.push('create');
        created = input;
        return { id: 'ses_assistant_new' };
      },
      update: async (input) => {
        order.push('update');
        archived = input;
        return { id: input.sessionID };
      },
    });
    const assistant = service.createAssistant({ ...assistantInput, name: 'Ops Bot' });
    const binding = await service.ensure(assistant.id);
    expect(binding).toEqual({ sessionID: 'ses_assistant_new', directory: expect.any(String), sessionGeneration: 1 });
    expect(created).toMatchObject({
      title: '[Assistant] Ops Bot',
      location: { directory: expect.any(String) },
    });
    expect(created).not.toHaveProperty('metadata');
    expect(archived).toBeNull();
    expect(order).toEqual(['create']);
    expect(await service.capability()).toMatchObject({ archiveMetadataAvailable: false, sessionMetadataAvailable: false, sharingAvailable: false });
    service.close();
  });

  it('binds after create when v2 has no archive metadata write', async () => {
    let creates = 0;
    let prompts = 0;
    let updates = 0;
    const service = setup(root(), {
      create: async () => ({ id: `ses_${++creates}` }),
      update: async () => { updates += 1; return { error: { status: 500 } }; },
      prompt: async () => { prompts += 1; return { id: 'inbox_1', type: 'user' }; },
    });
    const assistant = service.createAssistant(assistantInput);
    await expect(service.ensure(assistant.id)).resolves.toMatchObject({ sessionID: 'ses_1', sessionGeneration: 1 });
    expect(creates).toBe(1);
    expect(updates).toBe(0);
    expect(prompts).toBe(0);
    expect(await service.capability()).toMatchObject({ archiveMetadataAvailable: false });
    service.close();
  });

  it('renames the current v2 session when the Assistant name changes', async () => {
    const renames = [];
    const service = setup(root(), {
      create: async () => ({ id: 'ses_rename' }),
      rename: async (input) => { renames.push(input); },
    });
    const assistant = service.createAssistant({ ...assistantInput, name: 'Ops Bot' });
    await service.ensure(assistant.id);
    await service.updateAssistant(assistant.id, { expectedRevision: 1, name: 'Renamed' });
    expect(renames).toEqual([{ sessionID: 'ses_rename', title: '[Assistant] Renamed' }]);
    service.close();
  });

  it('persists nullable variants and sends the captured OpenCode variant for messages and shares', async () => {
    const prompts = []; const models = []; const service = setup(root(), { prompt: async (input) => { prompts.push(input); return { id: 'inbox_1', type: 'user' }; }, switchModel: async (input) => { models.push(input); } });
    const assistant = service.createAssistant({ ...assistantInput, variant: 'fast' });
    expect(assistant.variant).toBe('fast');
    const binding = await service.ensure(assistant.id);
    await service.send(assistant.id, { ...binding, messageID: 'variant-message', parts: [{ type: 'text', text: 'message' }] });
    await service.share(assistant.id, { operationID: 'variant-share', payload: { messageID: 'variant-share-message', parts: [{ type: 'text', text: 'share' }] } });
    expect(prompts).toEqual(expect.arrayContaining([expect.objectContaining({ delivery: 'steer' })]));
    expect(models).toEqual(expect.arrayContaining([expect.objectContaining({ model: expect.objectContaining({ id: 'm', providerID: 'p', variant: 'fast' }) })]));
    expect(await service.updateAssistant(assistant.id, { expectedRevision: 1, variant: null })).toMatchObject({ variant: null });
    service.close();
  });

  it('persists idempotent share work with its top-level identity DTO and keeps assistant sessions in the index', async () => {
    const service = setup(); const assistant = service.createAssistant(assistantInput); const payload = { messageID: 'client_share', parts: [{ type: 'text', text: 'shared' }] }; const first = await service.share(assistant.id, { operationID: 'share_1', payload }); const second = await service.share(assistant.id, { operationID: 'share_1', payload }); expect(second).toEqual(first); expect(service.shareOperation('share_1')).toMatchObject({ sessionID: expect.any(String), messageID: 'client_share', state: 'running', phase: 'submitted', attempt: 1 }); expect(first).not.toHaveProperty('binding'); expect(Object.keys(first).sort()).toEqual(Object.keys(assistantContractFixtures.shareOperation).sort()); service.close();
  });

  it('reuses one stateless share reservation for sequential duplicate requests', async () => {
    let creates = 0; let prompts = 0; const service = setup(root(), { create: async () => ({ data: { id: `ses_${++creates}` } }), prompt: async () => { prompts++; return { response: { status: 204 } }; } }); const assistant = service.createAssistant({ ...assistantInput, mode: 'stateless' }); const payload = { messageID: 'stateless-sequential-message', parts: [{ type: 'text', text: 'shared' }] };
    const first = await service.share(assistant.id, { operationID: 'stateless-sequential', payload }); const second = await service.share(assistant.id, { operationID: 'stateless-sequential', payload });
    expect(creates).toBe(1); expect(prompts).toBe(1); expect(second.sessionID).toBe(first.sessionID); service.close();
  });

  it('reuses one stateless share reservation for concurrent duplicate requests', async () => {
    let creates = 0; let prompts = 0; const service = setup(root(), { create: async () => ({ data: { id: `ses_${++creates}` } }), prompt: async () => { prompts++; return { response: { status: 204 } }; } }); const assistant = service.createAssistant({ ...assistantInput, mode: 'stateless' }); const payload = { messageID: 'stateless-concurrent-message', parts: [{ type: 'text', text: 'shared' }] };
    const [first, second] = await Promise.all([service.share(assistant.id, { operationID: 'stateless-concurrent', payload }), service.share(assistant.id, { operationID: 'stateless-concurrent', payload })]);
    expect(creates).toBe(1); expect(prompts).toBe(1); expect(second.sessionID).toBe(first.sessionID); service.close();
  });

  it('rejects conflicting stateless share payloads without creating another session', async () => {
    let creates = 0; let prompts = 0; const service = setup(root(), { create: async () => ({ data: { id: `ses_${++creates}` } }), prompt: async () => { prompts++; return { response: { status: 204 } }; } }); const assistant = service.createAssistant({ ...assistantInput, mode: 'stateless' });
    await service.share(assistant.id, { operationID: 'stateless-conflict', payload: { messageID: 'stateless-conflict-message', parts: [{ type: 'text', text: 'first' }] } }); await expect(service.share(assistant.id, { operationID: 'stateless-conflict', payload: { messageID: 'stateless-conflict-message', parts: [{ type: 'text', text: 'second' }] } })).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(creates).toBe(1); expect(prompts).toBe(1); service.close();
  });

  it('allows one claimant to submit a shared operation during concurrent admission', async () => {
    let release; let prompts = 0; const wait = new Promise((resolve) => { release = resolve; }); const service = setup(root(), { prompt: async () => { prompts++; await wait; return { response: { status: 204 } }; } }); const assistant = service.createAssistant(assistantInput); const payload = { messageID: 'client_concurrent', parts: [{ type: 'text', text: 'shared' }] };
    const first = service.share(assistant.id, { operationID: 'share_concurrent', payload }); const second = await service.share(assistant.id, { operationID: 'share_concurrent', payload }); expect(second).toMatchObject({ state: 'running', phase: 'submitting', attempt: 1 }); expect(prompts).toBe(1); release(); await first; service.close();
  });

  it('recovers a failed share through one CAS retry claimant', async () => {
    let prompts = 0; const service = setup(root(), { prompt: async () => (++prompts === 1 ? { error: { status: 503 } } : { response: { status: 204 } }) }); const assistant = service.createAssistant(assistantInput); const payload = { messageID: 'client_retry', parts: [{ type: 'text', text: 'shared' }] };
    expect(await service.share(assistant.id, { operationID: 'share_retry', payload })).toMatchObject({ state: 'failed', attempt: 1 }); const [first, second] = await Promise.all([service.share(assistant.id, { operationID: 'share_retry', payload }), service.share(assistant.id, { operationID: 'share_retry', payload })]); expect(prompts).toBe(2); expect([first.state, second.state]).toContain('running'); service.close();
  });

  it('marks an expired submitted lease unresolved after message-ID reconciliation', async () => {
    let time = 1_000; let scheduled; const service = setup(root(), { prompt: async () => ({ response: { status: 204 } }), messages: async () => ({ data: [] }) }, { clock: () => time, setIntervalFn: (work) => { scheduled = work; return 1; }, clearIntervalFn: () => {} }); const assistant = service.createAssistant(assistantInput); const payload = { messageID: 'client_lease', parts: [{ type: 'text', text: 'shared' }] };
    await service.share(assistant.id, { operationID: 'share_lease', payload }); time += 30_001; scheduled(); await new Promise((resolve) => setImmediate(resolve)); expect(service.shareOperation('share_lease')).toMatchObject({ state: 'unresolved', phase: 'submitted', errorCode: 'message_unresolved', leaseExpiresAt: null }); service.close();
  });

  it('uses the workspace directory for OpenCode skill discovery without catalog injection', async () => {
    const directory = root(); const workspace = path.join(directory, 'workspace'); const skill = path.join(workspace, '.agents', 'skills', 'project-skill'); fs.mkdirSync(skill, { recursive: true }); fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: project-skill\ndescription: Project skill\n---\nInstructions'); let created; let prompt; const instructions = []; const service = setup(directory, { create: async (input) => { created = input; return { id: 'ses_workspace' }; }, prompt: async (input) => { prompt = input; return { id: 'inbox_1', type: 'user' }; }, putInstruction: async (input) => { instructions.push(input); } }); const assistant = service.createAssistant({ ...assistantInput, workspacePath: workspace, defaultPrompt: 'Base prompt' }); const current = await service.ensure(assistant.id);
    await service.send(assistant.id, { ...current, messageID: 'client_skill', parts: [{ type: 'text', text: 'hello' }] }); expect(created.location.directory).toBe(fs.realpathSync(workspace)); expect(prompt.sessionID).toBe(current.sessionID); expect(prompt.text).toBe('hello'); expect(prompt.delivery).toBe('steer'); expect(instructions).toEqual([expect.objectContaining({ sessionID: current.sessionID, key: 'system', value: 'Base prompt' })]); expect(instructions[0].value).not.toContain('project-skill'); service.close();
  });

  it('rejects retired skillRoots input', async () => {
    const service = setup(); expect(() => service.createAssistant({ ...assistantInput, skillRoots: [] })).toThrow('validation_error'); const assistant = service.createAssistant(assistantInput); await expect(service.updateAssistant(assistant.id, { expectedRevision: 1, skillRoots: [] })).rejects.toThrow('validation_error'); service.close();
  });

  it('uses the workspace directory when submitting shares', async () => {
    const directory = root(); const workspace = path.join(directory, 'workspace'); fs.mkdirSync(workspace); let prompt; const service = setup(directory, { prompt: async (input) => { prompt = input; return { response: { status: 204 } }; } }); const assistant = service.createAssistant({ ...assistantInput, workspacePath: workspace });
    await service.share(assistant.id, { operationID: 'share_directory', payload: { messageID: 'client_share_directory', parts: [{ type: 'text', text: 'shared' }] } }); expect(prompt.sessionID).toEqual(expect.any(String)); expect(prompt.delivery).toBe('steer'); expect(prompt.text).toBe('shared'); service.close();
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
    const service = setup(root(), { create: async () => ({ data: { id: `ses_${++creates}` } }), prompt: async (input) => { prompts.push(input); return { response: { status: 204 } }; } });
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

  it('persists every stateless admission in Assistant SQLite before OpenCode history is available', async () => {
    let creates = 0; const directory = root(); const tips = [];
    const service = setup(directory, {
      create: async () => ({ data: { id: `ses_${++creates}` } }),
      prompt: async () => ({ response: { status: 204 } }),
      messages: async ({ sessionID }) => ({ data: [{ info: { id: sessionID === 'ses_2' ? 'msg_stateless_1' : 'msg_stateless_2', sessionID, role: 'user', time: { created: 1 } }, parts: [{ id: 'prt', sessionID, messageID: sessionID === 'ses_2' ? 'msg_stateless_1' : 'msg_stateless_2', type: 'text', text: sessionID === 'ses_2' ? 'one' : 'two' }] }] }),
    }, { onRevisionTip: (tip) => tips.push(tip) });
    const assistant = service.createAssistant({ ...assistantInput, mode: 'stateless' });
    const initial = await service.ensure(assistant.id);
    const first = await service.send(assistant.id, { ...initial, messageID: 'msg_stateless_1', parts: [{ type: 'text', text: 'one' }] });
    const second = await service.send(assistant.id, { ...first.binding, messageID: 'msg_stateless_2', parts: [{ type: 'text', text: 'two' }] });
    const db = new (require('better-sqlite3'))(path.join(directory, 'assistants.sqlite'));
    // Ticket 11: only bindings / operations persist — never message bodies.
    expect(db.prepare('SELECT COUNT(*) AS count FROM assistant_message_mirror').get().count).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM assistant_session_history').get().count).toBeGreaterThan(0);
    db.close();
    const page = await service.historicalMessages(assistant.id, { limit: 10 });
    expect(new Set(page.entries.map((entry) => entry.info.id))).toEqual(new Set(['msg_stateless_1', 'msg_stateless_2']));
    await new Promise((resolve) => setImmediate(resolve));
    expect(tips.at(-1)?.revision).toBe(service.snapshot().revision);
    service.close();
  });


  it('keeps stateless queued delivery bound to the Assistant after earlier turns replace the live Session', async () => {
    let creates = 0; let activePrompts = 0; let maxActivePrompts = 0; const prompts = [];
    const service = setup(root(), { create: async () => ({ data: { id: `ses_${++creates}` } }), prompt: async (input) => { activePrompts++; maxActivePrompts = Math.max(maxActivePrompts, activePrompts); await Promise.resolve(); prompts.push(input); activePrompts--; return { response: { status: 204 } }; } });
    const assistant = service.createAssistant({ ...assistantInput, mode: 'stateless' });
    const initial = await service.ensure(assistant.id);
    const scope = { sessionID: `assistant:${assistant.id}`, directory: initial.directory };
    const first = service.captureQueueDeliveryTarget({ assistantID: assistant.id, scope });
    const second = service.captureQueueDeliveryTarget({ assistantID: assistant.id, scope });

    const [firstResult, secondResult] = await Promise.all([
      service.sendWithCapturedConfig({ deliveryTarget: first, messageID: 'queued-stateless-1', parts: [{ type: 'text', text: 'one' }] }),
      service.sendWithCapturedConfig({ deliveryTarget: second, messageID: 'queued-stateless-2', parts: [{ type: 'text', text: 'two' }] }),
    ]);

    expect(firstResult.binding.sessionID).not.toBe(initial.sessionID);
    expect(secondResult.binding.sessionID).not.toBe(firstResult.binding.sessionID);
    expect(prompts.map((prompt) => prompt.sessionID)).toEqual([firstResult.binding.sessionID, secondResult.binding.sessionID]);
    expect(maxActivePrompts).toBe(1);
    await expect(service.send(assistant.id, { ...initial, messageID: 'stale-client-stateless', parts: [{ type: 'text', text: 'client wins' }] })).resolves.toMatchObject({ admitted: true });
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
    const service = setup(root(), { create: async () => ({ data: { id: `ses_${++creates}` } }), prompt: async (input) => { prompts.push(input); return { response: { status: 204 } }; } });
    const assistant = service.createAssistant({ ...assistantInput, mode: 'continuous' });
    const binding = await service.ensure(assistant.id);
    const sent = await service.send(assistant.id, { ...binding, messageID: 'continuous-1', parts: [{ type: 'text', text: 'hello' }] });
    expect(sent.binding).toEqual(binding);
    expect(prompts[0]?.sessionID).toBe(binding.sessionID);
    expect(creates).toBe(1);
    service.close();
  });

  it('persists historical event mirrors across restart with stable older cursors and raw OpenCode JSON', async () => {
    const directory = root(); let creates = 0;
    const info = (id, created, sessionID) => ({ id, sessionID, role: 'assistant', time: { created }, nested: { preserved: true } });
    const pageFor = (sessionID) => ({ data: [info('msg_3', 3, sessionID), { ...info('msg_2', 2, sessionID), parts: [{ id: 'part_2', sessionID, messageID: 'msg_2', type: 'text', text: 'updated', extra: { preserved: true } }] }, info('msg_1', 1, sessionID)].map((item) => item.parts ? item : { info: item, parts: [] }) });
    const service = setup(directory, { create: async () => ({ data: { id: `ses_${++creates}` } }), messages: async ({ sessionID }) => pageFor(sessionID) });
    const assistant = service.createAssistant({ ...assistantInput, mode: 'stateless' });
    const first = await service.ensure(assistant.id); const second = await service.createNew(assistant.id);
    const newest = await service.historicalMessages(assistant.id, { limit: 2 });
    expect(second.sessionID).not.toBe(first.sessionID);
    expect(newest.entries.map((entry) => entry.info.id)).toEqual(['msg_2', 'msg_3']);
    expect(newest.entries[0].parts[0]).toEqual({ id: 'part_2', sessionID: newest.entries[0].sessionID, messageID: 'msg_2', type: 'text', text: 'updated', extra: { preserved: true } });
    const oldest = await service.historicalMessages(assistant.id, { before: newest.nextCursor, limit: 4 });
    expect(oldest.entries.some((entry) => entry.info.id === 'msg_1')).toBe(true);
    service.close();
    const restarted = setup(directory, { messages: async ({ sessionID }) => pageFor(sessionID) });
    expect(new Set((await restarted.historicalMessages(assistant.id, { limit: 10 })).entries.map((entry) => entry.info.id))).toEqual(new Set(['msg_1', 'msg_2', 'msg_3']));
    restarted.close();
  });


  it('keeps prior mirrored pages when a bounded historical backfill fails', async () => {
    const directory = root(); let creates = 0;
    const service = setup(directory, {
      create: async () => ({ data: { id: `ses_${++creates}` } }),
      messages: async ({ sessionID }) => sessionID === 'ses_2' ? { error: { status: 503 } } : { data: [{ info: { id: 'msg_saved', sessionID, role: 'assistant', time: { created: 1 } }, parts: [] }] },
    });
    const assistant = service.createAssistant({ ...assistantInput, mode: 'stateless' });
    await service.ensure(assistant.id); await service.createNew(assistant.id);
    const page = await service.historicalMessages(assistant.id, { limit: 10 });
    // One session can fail without wiping the other complete projection.
    expect(page.entries.map((entry) => entry.info.id)).toEqual(['msg_saved']);
    const Database = require('better-sqlite3');
    const persisted = new Database(path.join(directory, 'assistants.sqlite'));
    expect(persisted.prepare('SELECT COUNT(*) AS count FROM assistant_message_mirror').get().count).toBe(0);
    persisted.close();
    service.close();
  });


  it('retries a transient session.messages failure once then succeeds', async () => {
    const directory = root(); let creates = 0; let calls = 0;
    const service = setup(directory, {
      create: async () => ({ data: { id: `ses_${++creates}` } }),
      messages: async ({ sessionID }) => {
        calls += 1;
        if (calls === 1) return { error: { status: 503 } };
        return { data: [{ info: { id: 'msg_ok', sessionID, role: 'assistant', time: { created: 1 } }, parts: [] }] };
      },
    });
    const assistant = service.createAssistant({ ...assistantInput, mode: 'stateless' });
    await service.ensure(assistant.id);
    await service.createNew(assistant.id);
    const page = await service.historicalMessages(assistant.id, { limit: 10 });
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(page.entries.some((entry) => entry.info.id === 'msg_ok')).toBe(true);
    expect(page.complete).toBe(true);
    service.close();
  });


  it('surfaces upstream_error after persistent transient session.messages failures', async () => {
    const directory = root(); let creates = 0; let calls = 0;
    const service = setup(directory, {
      create: async () => ({ data: { id: `ses_${++creates}` } }),
      messages: async () => { calls += 1; return { error: { status: 503 } }; },
    });
    const assistant = service.createAssistant({ ...assistantInput, mode: 'stateless' });
    await service.ensure(assistant.id);
    await service.createNew(assistant.id);
    await expect(service.historicalMessages(assistant.id, { limit: 10 })).rejects.toMatchObject({ code: 'upstream_error' });
    expect(calls).toBeGreaterThanOrEqual(3);
    service.close();
  });


  it('completes a missing archived session without deleting covered rows or blocking other history', async () => {
    const directory = root(); let creates = 0;
    const service = setup(directory, {
      create: async () => ({ data: { id: `ses_${++creates}` } }),
      messages: async ({ sessionID }) => {
        if (sessionID === 'ses_1') return { error: { status: 404 } };
        return { data: [{ info: { id: `msg_${sessionID}`, sessionID, role: 'assistant', time: { created: 1 } }, parts: [] }] };
      },
    });
    const assistant = service.createAssistant({ ...assistantInput, mode: 'stateless' });
    const first = await service.ensure(assistant.id);
    const second = await service.createNew(assistant.id);
    const third = await service.createNew(assistant.id);
    expect(first.sessionID).toBe('ses_1');
    expect(second.sessionID).toBe('ses_2');
    expect(third.sessionID).toBe('ses_3');
    const page = await service.historicalMessages(assistant.id, { limit: 10 });
    expect(page.entries.map((entry) => entry.info.id)).toEqual(['msg_ses_2', 'msg_ses_3']);
    expect(page.complete).toBe(true);
    service.close();
  });


  it('demand-backfills bounded history pages with stable cursors and archived directories', async () => {
    const directory = root(); const oldWorkspace = path.join(directory, 'old'); const newWorkspace = path.join(directory, 'new'); fs.mkdirSync(oldWorkspace); fs.mkdirSync(newWorkspace);
    const messages = Array.from({ length: 250 }, (_, index) => ({ info: { id: `msg_${String(250 - index).padStart(3, '0')}`, sessionID: 'ses_1', role: 'assistant', time: { created: 250 - index } }, parts: [] }));
    const service = setup(directory, { create: async () => ({ data: { id: 'ses_1' } }), messages: async ({ before }) => { const start = before ? messages.findIndex((entry) => entry.info.id === before) + 1 : 0; const page = messages.slice(start, start + 100); return { data: page, response: { headers: { get: (name) => name === 'x-next-cursor' && start + 100 < messages.length ? page.at(-1).info.id : null } } }; } });
    const assistant = service.createAssistant({ ...assistantInput, workspacePath: oldWorkspace }); await service.ensure(assistant.id);
    await service.updateAssistant(assistant.id, { expectedRevision: 1, workspacePath: newWorkspace });
    const first = await service.historicalMessages(assistant.id, { limit: 100 }); const second = await service.historicalMessages(assistant.id, { before: first.nextCursor, limit: 100 }); const third = await service.historicalMessages(assistant.id, { before: second.nextCursor, limit: 100 });
    expect(first.complete).toBe(false); expect(second.complete).toBe(false); expect(third.complete).toBe(true);
    const ids = [first, second, third].flatMap((page) => page.entries.map((entry) => entry.info.id)); expect(ids).toHaveLength(250); expect(new Set(ids)).toHaveLength(250); expect(first.entries[0]?.sessionID).toBe('ses_1'); expect(first.entries[0]?.directory).toBe(fs.realpathSync(oldWorkspace));
    service.close();
  });


  it('backfills a partial event mirror before serving history', async () => {
    const directory = root(); let calls = 0; let creates = 0; const service = setup(directory, { create: async () => ({ data: { id: `ses_${++creates}` } }), messages: async ({ sessionID }) => { calls++; return { data: [{ info: { id: 'msg_2', sessionID, role: 'assistant', time: { created: 2 } }, parts: [] }, { info: { id: 'msg_1', sessionID, role: 'assistant', time: { created: 1 } }, parts: [] }] }; } });
    const assistant = service.createAssistant({ ...assistantInput, mode: 'stateless' }); await service.ensure(assistant.id); await service.createNew(assistant.id);
    const page = await service.historicalMessages(assistant.id, { limit: 10 });
    expect(new Set(page.entries.map((entry) => entry.info.id))).toEqual(new Set(['msg_1', 'msg_2']));
    expect(calls).toBeGreaterThanOrEqual(1);
    service.close();
  });


  it('persists raw OpenCode header cursors for exact 100, 101, and 200 message scans', async () => {
    for (const count of [100, 101, 200]) {
      const directory = root(); const messages = Array.from({ length: count }, (_, index) => ({ info: { id: `msg_${count - index}`, sessionID: 'ses_1', role: 'assistant', time: { created: count - index } }, parts: [] }));
      const service = setup(directory, { create: async () => ({ data: { id: 'ses_1' } }), messages: async ({ before }) => { const start = before ? Number(String(before).split('-').at(-1)) + 100 : 0; const page = messages.slice(start, start + 100); const cursor = start + page.length < count ? `opaque-${count}-${start}` : null; return { data: page, response: { headers: { get: (name) => name === 'x-next-cursor' ? cursor : null } } }; } });
      const assistant = service.createAssistant(assistantInput); await service.ensure(assistant.id);
      let before; const received = []; do { const page = await service.historicalMessages(assistant.id, { before, limit: 100 }); received.push(...page.entries.map((entry) => entry.info.id)); before = page.nextCursor; } while (before);
      expect(received).toHaveLength(count); expect(new Set(received)).toHaveLength(count);
      service.close();
    }
  });


  it('resumes stateless history after three-page demand budgets without gaps', async () => {
    let creates = 0; const service = setup(root(), { create: async () => ({ data: { id: `ses_${++creates}` } }), messages: async ({ sessionID }) => ({ data: [{ info: { id: `msg_${sessionID}`, sessionID, role: 'assistant', time: { created: Number(sessionID.slice(4)) } }, parts: [] }], response: { headers: { get: () => null } } }) });
    const assistant = service.createAssistant({ ...assistantInput, mode: 'stateless' }); await service.ensure(assistant.id); for (let index = 0; index < 30; index++) await service.createNew(assistant.id);
    const received = []; let before; do { const page = await service.historicalMessages(assistant.id, { before, limit: 10 }); received.push(...page.entries.map((entry) => entry.info.id)); before = page.nextCursor; } while (before);
    expect(new Set(received).size).toBe(received.length);
    expect(received.length).toBeGreaterThanOrEqual(30);
    service.close();
  });


  it('reconciles removed event parts and starts a current-binding backfill after restart', async () => {
    const directory = root(); let creates = 0; const page = (sessionID) => ({ data: [{ info: { id: 'msg_1', sessionID, role: 'assistant', time: { created: 1 } }, parts: [{ id: 'part_1', sessionID, messageID: 'msg_1', type: 'text', text: 'authoritative' }] }], response: { headers: { get: () => null } } });
    const service = setup(directory, { create: async () => ({ data: { id: `ses_${++creates}` } }), messages: async ({ sessionID }) => page(sessionID) }); const assistant = service.createAssistant({ ...assistantInput, mode: 'stateless' });
    await service.ensure(assistant.id);
    const first = await service.historicalMessages(assistant.id, { limit: 10 });
    expect(first.entries[0]?.parts[0]?.text).toBe('authoritative');
    service.close();
    const restarted = setup(directory, { messages: async ({ sessionID }) => page(sessionID) });
    expect((await restarted.historicalMessages(assistant.id, { limit: 10 })).entries[0]?.parts[0]?.text).toBe('authoritative');
    const Database = require('better-sqlite3');
    const persisted = new Database(path.join(directory, 'assistants.sqlite'));
    expect(persisted.prepare('SELECT COUNT(*) AS count FROM assistant_message_mirror').get().count).toBe(0);
    persisted.close();
    restarted.close();
  });


  it('fills an existing null archive directory and resets its history coverage', async () => {
    const directory = root(); const workspace = path.join(directory, 'workspace'); fs.mkdirSync(workspace); let creates = 0; const service = setup(directory, { create: async () => ({ data: { id: `ses_${++creates}` } }) }); const assistant = service.createAssistant({ ...assistantInput, mode: 'stateless', workspacePath: workspace }); const first = await service.ensure(assistant.id); await service.createNew(assistant.id); service.close();
    const Database = require('better-sqlite3'); const db = new Database(path.join(directory, 'assistants.sqlite')); db.prepare('UPDATE assistant_session_history SET directory=NULL WHERE assistant_id=? AND session_id=?').run(assistant.id, first.sessionID); db.prepare('INSERT OR REPLACE INTO assistant_message_backfill(assistant_id,session_id,cursor,complete,updated_at) VALUES (?,?,?,?,?)').run(assistant.id, first.sessionID, null, 1, 1); db.prepare('UPDATE assistant_v2 SET current_session_id=? WHERE assistant_id=?').run(first.sessionID, assistant.id); db.close();
    const restarted = setup(directory, { create: async () => ({ data: { id: `ses_${++creates}` } }) }); await restarted.createNew(assistant.id); const persisted = new Database(path.join(directory, 'assistants.sqlite')); expect(persisted.prepare('SELECT directory FROM assistant_session_history WHERE assistant_id=? AND session_id=?').get(assistant.id, first.sessionID).directory).toBe(fs.realpathSync(workspace)); expect(persisted.prepare('SELECT complete FROM assistant_message_backfill WHERE assistant_id=? AND session_id=?').get(assistant.id, first.sessionID)).toBeUndefined(); persisted.close(); restarted.close();
  });

  it('backfills a legacy null archive directory from the authoritative session worktree', async () => {
    const directory = root(); const oldWorkspace = path.join(directory, 'old'); const currentWorkspace = path.join(directory, 'current'); fs.mkdirSync(oldWorkspace); fs.mkdirSync(currentWorkspace); let creates = 0; const service = setup(directory, { create: async () => ({ data: { id: `ses_${++creates}` } }) }); const assistant = service.createAssistant({ ...assistantInput, mode: 'stateless', workspacePath: oldWorkspace }); const first = await service.ensure(assistant.id); await service.updateAssistant(assistant.id, { expectedRevision: 1, workspacePath: currentWorkspace }); service.close();
    const Database = require('better-sqlite3'); const db = new Database(path.join(directory, 'assistants.sqlite')); db.prepare('UPDATE assistant_session_history SET directory=NULL WHERE assistant_id=? AND session_id=?').run(assistant.id, first.sessionID); db.close(); const messages = [];
    const restarted = setup(directory, { get: async ({ sessionID }) => ({ data: { id: sessionID, project: { worktree: oldWorkspace } } }), messages: async (input) => { messages.push(input); return { data: [{ info: { id: 'msg_1', sessionID: input.sessionID, role: 'assistant', time: { created: 1 } }, parts: [] }], response: { headers: { get: () => null } } }; } });
    expect((await restarted.historicalMessages(assistant.id)).entries[0]).toMatchObject({ sessionID: first.sessionID, directory: fs.realpathSync(oldWorkspace) }); expect(messages.find((input) => input.sessionID === first.sessionID)).toMatchObject({ sessionID: first.sessionID }); expect(messages.find((input) => input.sessionID === first.sessionID).directory).toBeUndefined(); const persisted = new Database(path.join(directory, 'assistants.sqlite')); expect(persisted.prepare('SELECT directory FROM assistant_session_history WHERE assistant_id=? AND session_id=?').get(assistant.id, first.sessionID).directory).toBe(fs.realpathSync(oldWorkspace)); persisted.close(); restarted.close();
  });

  it('keeps unresolved legacy archive directories null without using the current workspace', async () => {
    const directory = root(); const workspace = path.join(directory, 'workspace'); const outside = root(); fs.mkdirSync(workspace); let creates = 0; const service = setup(directory, { create: async () => ({ data: { id: `ses_${++creates}` } }) }); const assistant = service.createAssistant({ ...assistantInput, mode: 'stateless', workspacePath: workspace }); const first = await service.ensure(assistant.id); await service.createNew(assistant.id); service.close();
    const Database = require('better-sqlite3'); const db = new Database(path.join(directory, 'assistants.sqlite')); db.prepare('UPDATE assistant_session_history SET directory=NULL WHERE assistant_id=? AND session_id=?').run(assistant.id, first.sessionID); db.close(); const messages = [];
    const restarted = setup(directory, { get: async () => ({ data: { directory: outside } }), messages: async (input) => { messages.push(input); return { data: [{ info: { id: 'msg_1', sessionID: input.sessionID, role: 'assistant', time: { created: 1 } }, parts: [] }], response: { headers: { get: () => null } } }; } });
    expect((await restarted.historicalMessages(assistant.id)).entries[0]).toMatchObject({ sessionID: first.sessionID, directory: null }); const historicalRequest = messages.find((input) => input.sessionID === first.sessionID); expect(historicalRequest).toMatchObject({ sessionID: first.sessionID }); expect(historicalRequest.directory).toBeUndefined(); const persisted = new Database(path.join(directory, 'assistants.sqlite')); expect(persisted.prepare('SELECT directory FROM assistant_session_history WHERE assistant_id=? AND session_id=?').get(assistant.id, first.sessionID).directory).toBeNull(); persisted.close(); restarted.close();
  });

  it('keeps covered history visible across ordinary message events without re-backfill', async () => {
    const directory = root(); let creates = 0; let calls = 0;
    const service = setup(directory, {
      create: async () => ({ data: { id: `ses_${++creates}` } }),
      messages: async ({ sessionID }) => {
        calls += 1;
        return {
          data: [{ info: { id: 'msg_1', sessionID, role: 'assistant', time: { created: 1 } }, parts: [{ id: 'part_1', sessionID, messageID: 'msg_1', type: 'text', text: 'hello' }] }],
          response: { headers: { get: () => null } },
        };
      },
    });
    const assistant = service.createAssistant(assistantInput);
    await service.ensure(assistant.id);
    const first = await service.historicalMessages(assistant.id, { limit: 10 });
    service.processEvent({ type: 'message.updated', properties: { info: { id: 'msg_event', sessionID: first.entries[0]?.sessionID, role: 'assistant', time: { created: 2 } } } });
    const second = await service.historicalMessages(assistant.id, { limit: 10 });
    expect(second.entries.map((entry) => entry.info.id)).toEqual(['msg_1']);
    expect(calls).toBeGreaterThanOrEqual(1);
    service.close();
  });


  it('deletes message/part/backfill mirrors when an assistant is removed', async () => {
    const directory = root(); let creates = 0;
    const service = setup(directory, {
      create: async () => ({ data: { id: `ses_${++creates}` } }),
      messages: async ({ sessionID }) => ({
        data: [{ info: { id: 'msg_1', sessionID, role: 'assistant', time: { created: 1 } }, parts: [{ id: 'part_1', sessionID, messageID: 'msg_1', type: 'text', text: 'secret' }] }],
        response: { headers: { get: () => null } },
      }),
    });
    const assistant = service.createAssistant({ ...assistantInput, mode: 'stateless' });
    await service.ensure(assistant.id);
    await service.createNew(assistant.id);
    await service.historicalMessages(assistant.id);
    const revision = service.snapshot().assistants[0].revision;
    service.removeAssistant(assistant.id, revision);
    const Database = require('better-sqlite3');
    const db = new Database(path.join(directory, 'assistants.sqlite'));
    expect(db.prepare('SELECT COUNT(*) AS count FROM assistant_session_history WHERE assistant_id=?').get(assistant.id).count).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM assistant_message_mirror WHERE assistant_id=?').get(assistant.id).count).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM assistant_message_part_mirror WHERE assistant_id=?').get(assistant.id).count).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM assistant_message_backfill WHERE assistant_id=?').get(assistant.id).count).toBe(0);
    db.close();
    service.close();
  });
  it('uses OpenCode.make session/message methods and does not call 1.x SDK names', async () => {
    const source = fs.readFileSync(new URL('./service.js', import.meta.url), 'utf8');
    expect(source).toContain("from '@opencode-ai/client'");
    expect(source).toContain('OpenCode.make');
    expect(source).not.toContain("from '@opencode-ai/sdk/v2'");
    expect(source).not.toContain('createOpencodeClient');
    expect(source).not.toContain('promptAsync');
    expect(source).not.toContain('session.messages');
    expect(source).not.toContain('session.summarize');
    expect(source).not.toContain('session.abort(');
    const listed = [];
    const interrupted = [];
    const compacted = [];
    const service = setup(root(), {
      create: async () => ({ id: 'ses_v2' }),
      prompt: async () => ({ id: 'inbox_v2', type: 'user' }),
      messages: async (input) => { listed.push(input); return { data: [{ id: 'msg_v2', type: 'assistant', time: { created: 1 }, content: [{ type: 'text', text: 'from-v2' }] }], cursor: {} }; },
      interrupt: async (input) => { interrupted.push(input); },
      compact: async (input) => { compacted.push(input); return { id: 'inbox_compact', type: 'compaction' }; },
    });
    const assistant = service.createAssistant(assistantInput);
    const binding = await service.ensure(assistant.id);
    await service.send(assistant.id, { ...binding, messageID: 'client_v2', parts: [{ type: 'text', text: 'hi' }] });
    expect(await service.compact(assistant.id, binding)).toEqual({ binding, summarized: true });
    expect(await service.abort(assistant.id, binding)).toEqual({ binding, aborted: true });
    const page = await service.historicalMessages(assistant.id, { limit: 10 });
    expect(page.entries.map((entry) => entry.info.id)).toEqual(['msg_v2']);
    expect(page.entries[0]?.parts[0]?.text).toBe('from-v2');
    expect(listed[0]).toMatchObject({ sessionID: 'ses_v2', order: 'desc' });
    expect(interrupted).toEqual([{ sessionID: 'ses_v2' }]);
    expect(compacted).toEqual([{ sessionID: 'ses_v2' }]);
    service.close();
  });


});
