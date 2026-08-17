import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createAssistantsService } from './service.js';

const require = createRequire(import.meta.url);
const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'assistants-proj-'));

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
const setup = (directory = root(), client = {}, options = {}) => {
  const { enabled = true, fetchImpl, ...serviceOptions } = options;
  const service = createAssistantsService({
    dbPath: path.join(directory, 'assistants.sqlite'),
    dataDir: directory,
    getAllowedRoots: () => [directory],
    buildOpenCodeUrl: () => 'http://opencode.test',
    getOpenCodeAuthHeaders: () => ({ authorization: 'Bearer test' }),
    fetchImpl,
    clientFactory: () => createV2Client(client),
    ...serviceOptions,
  });
  if (enabled) {
    const snapshot = service.snapshot();
    if (!snapshot.enabled) service.setEnabled({ enabled: true, expectedRevision: snapshot.revision });
  }
  return service;
};
const assistantInput = { name: 'A', providerID: 'p', modelID: 'm' };

const projectionEntry = (sessionID, id, created, text = id) => ({
  info: { id, sessionID, role: 'assistant', time: { created } },
  parts: [{ id: `prt_${id}`, sessionID, messageID: id, type: 'text', text }],
});

describe('ticket 11 assistants read from OpenCode projections', () => {
  it('does not persist message bodies after send, share, or live events', async () => {
    const directory = root();
    const service = setup(directory, {
      create: async () => ({ data: { id: 'ses_1' } }),
      prompt: async () => ({ id: 'inbox_1', type: 'user' }),
    });
    const assistant = service.createAssistant(assistantInput);
    const binding = await service.ensure(assistant.id);
    await service.send(assistant.id, { ...binding, messageID: 'msg_send', parts: [{ type: 'text', text: 'hello' }] });
    await service.share(assistant.id, { operationID: 'share_1', payload: { messageID: 'msg_share', parts: [{ type: 'text', text: 'shared' }] } });
    service.processEvent({ type: 'message.updated', properties: { info: { id: 'msg_event', sessionID: binding.sessionID, role: 'assistant', time: { created: 1 } } } });
    service.processEvent({ type: 'message.part.updated', properties: { sessionID: binding.sessionID, part: { id: 'prt_1', messageID: 'msg_event', type: 'text', text: 'live' } } });
    const db = new (require('better-sqlite3'))(path.join(directory, 'assistants.sqlite'));
    expect(db.prepare('SELECT COUNT(*) AS count FROM assistant_message_mirror').get().count).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM assistant_message_part_mirror').get().count).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM assistant_share_operation').get().count).toBe(1);
    expect(db.prepare('SELECT session_id, message_id FROM assistant_share_operation').get()).toMatchObject({ session_id: binding.sessionID, message_id: 'msg_share' });
    db.close();
    service.close();
  });

  it('opens history from OpenCode projections per binding and ignores leftover mirrors', async () => {
    const directory = root();
    let creates = 0;
    const calls = [];
    const service = setup(directory, {
      create: async () => ({ data: { id: `ses_${++creates}` } }),
      messages: async ({ sessionID, limit, order }) => {
        calls.push({ sessionID, limit, order });
        if (sessionID === 'ses_1') return { data: [projectionEntry('ses_1', 'msg_old', 1, 'from-projection')] };
        return { data: [projectionEntry(sessionID, 'msg_live', 2, 'current')] };
      },
    });
    const assistant = service.createAssistant({ ...assistantInput, mode: 'stateless' });
    const first = await service.ensure(assistant.id);
    await service.createNew(assistant.id);
    const Database = require('better-sqlite3');
    const seed = new Database(path.join(directory, 'assistants.sqlite'));
    seed.prepare('INSERT INTO assistant_message_mirror(assistant_id,session_id,message_id,info_json,ordinal,covered,updated_at) VALUES (?,?,?,?,?,?,?)').run(
      assistant.id,
      first.sessionID,
      'msg_mirror',
      JSON.stringify({ id: 'msg_mirror', sessionID: first.sessionID, role: 'user', time: { created: 99 }, openchamberAssistantAdmission: true }),
      99,
      1,
      1,
    );
    seed.close();
    const page = await service.historicalMessages(assistant.id, { limit: 10 });
    expect(page.entries.map((entry) => entry.info.id)).toEqual(['msg_old', 'msg_live']);
    expect(page.entries[0]?.parts[0]?.text).toBe('from-projection');
    expect(page.entries.some((entry) => entry.info.id === 'msg_mirror')).toBe(false);
    expect(calls.every((call) => call.order === 'desc')).toBe(true);
    expect(page.complete).toBe(true);
    service.close();
  });

  it('keeps complete sessions when one projection page fails and does not treat total failure as empty success', async () => {
    const directory = root();
    let creates = 0;
    const service = setup(directory, {
      create: async () => ({ data: { id: `ses_${++creates}` } }),
      messages: async ({ sessionID }) => {
        if (sessionID === 'ses_2') return { error: { status: 503 } };
        return { data: [projectionEntry(sessionID, `msg_${sessionID}`, 1)] };
      },
    });
    const assistant = service.createAssistant({ ...assistantInput, mode: 'stateless' });
    await service.ensure(assistant.id);
    await service.createNew(assistant.id);
    await service.createNew(assistant.id);
    const page = await service.historicalMessages(assistant.id, { limit: 10 });
    expect(page.entries.map((entry) => [entry.sessionID, entry.info.id])).toEqual([
      ['ses_1', 'msg_ses_1'],
      ['ses_3', 'msg_ses_3'],
    ]);
    expect(page.entries.some((entry) => entry.sessionID === 'ses_2')).toBe(false);

    const isolated = setup(root(), {
      create: async () => ({ data: { id: 'ses_only' } }),
      messages: async () => ({ error: { status: 500 } }),
    });
    const lonely = isolated.createAssistant(assistantInput);
    await isolated.ensure(lonely.id);
    await expect(isolated.historicalMessages(lonely.id, { limit: 10 })).rejects.toMatchObject({ code: 'upstream_error' });
    isolated.close();
    service.close();
  });

  it('uses ticket 03 projection GET /session/:id/message when fetchImpl is provided', async () => {
    const directory = root();
    const urls = [];
    const service = setup(directory, {
      create: async () => ({ data: { id: 'ses_proj' } }),
    }, {
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        urls.push(url);
        return new Response(JSON.stringify({ data: [projectionEntry('ses_proj', 'msg_fetch', 1)] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const assistant = service.createAssistant(assistantInput);
    await service.ensure(assistant.id);
    const page = await service.historicalMessages(assistant.id, { limit: 20 });
    expect(page.entries.map((entry) => entry.info.id)).toEqual(['msg_fetch']);
    expect(urls).toHaveLength(1);
    expect(urls[0].pathname).toBe('/session/ses_proj/message');
    expect(urls[0].searchParams.get('limit')).toBe('20');
    expect(urls[0].searchParams.get('order')).toBe('desc');
    expect(urls[0].searchParams.get('directory')).toEqual(expect.any(String));
    service.close();
  });

  it('exposes V2 sharing as unavailable and never reads mirrors to fake a share', async () => {
    const service = setup();
    expect(await service.capability()).toMatchObject({ sharingAvailable: false, archiveMetadataAvailable: false, sessionMetadataAvailable: false });
    const source = fs.readFileSync(new URL('./service.js', import.meta.url), 'utf8');
    expect(source).toContain('sharingAvailable: false');
    expect(/historicalMessages[\s\S]*JOIN assistant_message_mirror/.test(source)).toBe(false);
    expect(/sendWithConfig[\s\S]*mirrorAdmittedUserMessage\(/.test(source)).toBe(false);
    expect(/submitClaim[\s\S]*mirrorAdmittedUserMessage\(/.test(source)).toBe(false);
    service.close();
  });
});
