import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createAssistantsService } from './service.js';

const require = createRequire(import.meta.url);
const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'assistants-proj-'));

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
        // Official contract fixture: refuse order+cursor combinations.
        if (input?.cursor && input?.order != null) {
          const error = new Error('InvalidRequestError');
          error.status = 400;
          error._tag = 'InvalidRequestError';
          throw error;
        }
        const result = await list(input);
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
    // Contact composer send needs a harness stub; body authority is OpenCode projection.
    runContactTurn: serviceOptions.runContactTurn ?? (async ({ userText }) => ({ text: `reply:${userText}`, bubbles: [`reply:${userText}`] })),
    ...serviceOptions,
  });
  if (enabled) {
    const snapshot = service.snapshot();
    if (!snapshot.enabled) service.setEnabled({ enabled: true, expectedRevision: snapshot.revision });
  }
  return service;
};
const assistantInput = { name: 'A', providerID: 'p', modelID: 'm' };

const projectionEntry = (sessionID, id, created, text = id, role = 'assistant') => ({
  info: { id, sessionID, role, time: { created } },
  parts: [{ id: `prt_${id}`, sessionID, messageID: id, type: 'text', text }],
});

/** Official v2 SessionMessageInfo-shaped user/assistant with content (not only parts). */
const syntheticContentEntry = (sessionID, id, created, role, text) => ({
  id,
  sessionID,
  type: role,
  time: { created },
  content: [{ type: 'text', text }],
});

/**
 * Official-shaped desc pager: non-empty pages always expose cursor.next (even the
 * logical last page); an empty follow-up page is the finite end.
 */
const createOfficialDescPager = (rowsBySession, pageLimitDefault = null) => {
  const state = new Map();
  for (const [sessionID, rows] of Object.entries(rowsBySession)) {
    state.set(sessionID, rows);
  }
  const calls = [];
  const list = async (input) => {
    const sessionID = input.sessionID;
    const limit = Number(input.limit) || pageLimitDefault || 50;
    const rows = state.get(sessionID) || [];
    calls.push({
      sessionID,
      limit,
      order: input.order ?? null,
      cursor: input.cursor ?? null,
      hasOrder: input.order != null,
    });
    let start = 0;
    if (input.cursor) {
      const marker = String(input.cursor).replace(/^next:/, '');
      const idx = rows.findIndex((row) => (row.info?.id ?? row.id) === marker);
      start = idx >= 0 ? idx + 1 : rows.length;
    }
    const page = rows.slice(start, start + limit);
    // Non-empty ⇒ always next (even past the last real row marker).
    const next = page.length > 0
      ? `next:${page[page.length - 1].info?.id ?? page[page.length - 1].id}`
      : null;
    return {
      data: page,
      cursor: next ? { previous: null, next } : { previous: null, next: null },
    };
  };
  return { list, calls };
};

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
      messages: async ({ sessionID, limit, order, cursor }) => {
        calls.push({ sessionID, limit, order, cursor });
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
    // First page of each binding may use order=desc; never with a cursor.
    expect(calls.every((call) => call.cursor == null || call.order == null)).toBe(true);
    expect(calls.some((call) => call.order === 'desc' && call.cursor == null)).toBe(true);
    expect(page.complete).toBe(true);
    expect(page.partial).toBe(false);
    service.close();
  });

  it('traverses source seq CBA across bindings with limit 1 (not time.created sort)', async () => {
    // ses_old (ordinal lower): source desc page [B created20, C created10]
    // ses_new: [A created30]
    // Public ascending walk with limit 1 must be A → B → C (source seq), not time sort tricks.
    let creates = 0;
    const pager = createOfficialDescPager({
      ses_1: [
        projectionEntry('ses_1', 'msg_B', 20, 'B'),
        projectionEntry('ses_1', 'msg_C', 10, 'C'),
      ],
      ses_2: [
        projectionEntry('ses_2', 'msg_A', 30, 'A'),
      ],
    });
    const service = setup(root(), {
      create: async () => ({ data: { id: `ses_${++creates}` } }),
      messages: pager.list,
    });
    const assistant = service.createAssistant({ ...assistantInput, mode: 'stateless' });
    await service.ensure(assistant.id); // ses_1
    await service.createNew(assistant.id); // ses_2 live
    const seen = [];
    let before;
    for (let step = 0; step < 5; step++) {
      const page = await service.historicalMessages(assistant.id, { before, limit: 1 });
      seen.push(...page.entries.map((entry) => entry.info.id));
      if (page.complete) break;
      before = page.nextCursor;
      expect(before).toEqual(expect.any(String));
    }
    expect(seen).toEqual(['msg_A', 'msg_B', 'msg_C']);
    // Continuations must never send order with cursor.
    expect(pager.calls.filter((call) => call.cursor).every((call) => call.hasOrder === false)).toBe(true);
    expect(pager.calls.filter((call) => !call.cursor).every((call) => call.order === 'desc')).toBe(true);
    service.close();
  });

  it('pages 8 rows with limit 2 and 3-page budget once each id, finite end (no tip loop)', async () => {
    const rows = Array.from({ length: 8 }, (_, index) => {
      const n = 8 - index;
      return projectionEntry('ses_1', `msg_${n}`, n * 10, `t${n}`);
    });
    const pager = createOfficialDescPager({ ses_1: rows });
    const service = setup(root(), {
      create: async () => ({ data: { id: 'ses_1' } }),
      messages: pager.list,
    });
    const assistant = service.createAssistant(assistantInput);
    await service.ensure(assistant.id);
    const pages = [];
    let before;
    let rounds = 0;
    do {
      const page = await service.historicalMessages(assistant.id, { before, limit: 2 });
      rounds += 1;
      pages.push(page);
      // Each demand page is ascending within itself.
      const ids = page.entries.map((entry) => entry.info.id);
      expect(ids).toEqual([...ids].sort((a, b) => Number(a.slice(4)) - Number(b.slice(4))));
      before = page.complete ? null : page.nextCursor;
      expect(rounds).toBeLessThanOrEqual(8);
    } while (before);
    // Infinite-query flatten (oldest page first) yields full chronological seq once.
    const seen = pages.slice().reverse().flatMap((page) => page.entries.map((entry) => entry.info.id));
    expect(seen).toEqual(['msg_1', 'msg_2', 'msg_3', 'msg_4', 'msg_5', 'msg_6', 'msg_7', 'msg_8']);
    expect(new Set(seen).size).toBe(8);
    // Tip (no cursor) is opened once; later calls only continue via opaque cursor
    // (page-local skip may re-hit the same upstream page, but never restarts the tip).
    const tipCalls = pager.calls.filter((call) => call.cursor == null);
    expect(tipCalls).toHaveLength(1);
    expect(pages.at(-1)?.complete).toBe(true);
    service.close();
  });

  it('marks middle binding 503 as partial with retryable cursor; recovery fills the gap', async () => {
    let creates = 0;
    let ses2Fail = true;
    const service = setup(root(), {
      create: async () => ({ data: { id: `ses_${++creates}` } }),
      messages: async ({ sessionID }) => {
        if (sessionID === 'ses_2' && ses2Fail) return { error: { status: 503 } };
        return { data: [projectionEntry(sessionID, `msg_${sessionID}`, 1)] };
      },
    });
    const assistant = service.createAssistant({ ...assistantInput, mode: 'stateless' });
    await service.ensure(assistant.id); // ses_1
    await service.createNew(assistant.id); // ses_2
    await service.createNew(assistant.id); // ses_3 live
    const first = await service.historicalMessages(assistant.id, { limit: 10 });
    // Newest success delivered; failed middle is not skipped permanently.
    expect(first.entries.map((entry) => [entry.sessionID, entry.info.id])).toEqual([
      ['ses_3', 'msg_ses_3'],
    ]);
    expect(first.complete).toBe(false);
    expect(first.partial).toBe(true);
    expect(first.failed).toEqual([
      expect.objectContaining({ sessionID: 'ses_2', status: 503 }),
    ]);
    expect(first.nextCursor).toEqual(expect.any(String));

    ses2Fail = false;
    const recovered = [];
    let before = first.nextCursor;
    for (let step = 0; step < 5; step++) {
      const page = await service.historicalMessages(assistant.id, { before, limit: 10 });
      recovered.push(...page.entries.map((entry) => [entry.sessionID, entry.info.id]));
      if (page.complete) {
        expect(page.partial).toBe(false);
        break;
      }
      before = page.nextCursor;
    }
    // Public pages stay ascending by binding ordinal (older session first).
    expect(recovered).toEqual([
      ['ses_1', 'msg_ses_1'],
      ['ses_2', 'msg_ses_2'],
    ]);
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
      ['ses_3', 'msg_ses_3'],
    ]);
    expect(page.entries.some((entry) => entry.sessionID === 'ses_2')).toBe(false);
    expect(page.partial).toBe(true);
    expect(page.complete).toBe(false);

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

  it('projects real user/assistant content synthetic rows from official shape', async () => {
    const pager = createOfficialDescPager({
      ses_1: [
        syntheticContentEntry('ses_1', 'msg_asst', 20, 'assistant', 'assistant-body'),
        syntheticContentEntry('ses_1', 'msg_user', 10, 'user', 'user-body'),
      ],
    });
    const service = setup(root(), {
      create: async () => ({ data: { id: 'ses_1' } }),
      messages: pager.list,
    });
    const assistant = service.createAssistant(assistantInput);
    await service.ensure(assistant.id);
    const page = await service.historicalMessages(assistant.id, { limit: 10 });
    expect(page.entries.map((entry) => [entry.info.id, entry.info.role, entry.parts[0]?.text])).toEqual([
      ['msg_user', 'user', 'user-body'],
      ['msg_asst', 'assistant', 'assistant-body'],
    ]);
    expect(page.complete).toBe(true);
    service.close();
  });

  it('uses official GET /api/session/:id/message when fetchImpl is provided', async () => {
    const directory = root();
    const urls = [];
    const service = setup(directory, {
      create: async () => ({ data: { id: 'ses_proj' } }),
    }, {
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        urls.push(url);
        return new Response(JSON.stringify({
          data: [projectionEntry('ses_proj', 'msg_fetch', 1)],
          cursor: { previous: null, next: null },
        }), {
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
    expect(urls[0].pathname).toBe('/api/session/ses_proj/message');
    expect(urls[0].searchParams.get('limit')).toBe('20');
    expect(urls[0].searchParams.get('order')).toBe('desc');
    expect(urls[0].searchParams.has('cursor')).toBe(false);
    expect(urls[0].searchParams.get('directory')).toEqual(expect.any(String));
    service.close();
  });

  it('fetchImpl continuation omits order and only sends cursor', async () => {
    const rows = [
      projectionEntry('ses_1', 'msg_2', 2),
      projectionEntry('ses_1', 'msg_1', 1),
    ];
    const urls = [];
    const service = setup(root(), {
      create: async () => ({ data: { id: 'ses_1' } }),
    }, {
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        urls.push(url);
        const cursor = url.searchParams.get('cursor');
        if (!cursor) {
          return new Response(JSON.stringify({
            data: [rows[0]],
            cursor: { next: 'opaque_next' },
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (cursor === 'opaque_next') {
          return new Response(JSON.stringify({
            data: [rows[1]],
            // Non-empty last page still exposes next; empty follow-up ends.
            cursor: { next: 'opaque_end' },
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({
          data: [],
          cursor: { next: null },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    const assistant = service.createAssistant(assistantInput);
    await service.ensure(assistant.id);
    const first = await service.historicalMessages(assistant.id, { limit: 1 });
    expect(first.entries.map((e) => e.info.id)).toEqual(['msg_2']);
    expect(first.complete).toBe(false);
    const second = await service.historicalMessages(assistant.id, { before: first.nextCursor, limit: 1 });
    expect(second.entries.map((e) => e.info.id)).toEqual(['msg_1']);
    expect(urls[0].searchParams.get('order')).toBe('desc');
    expect(urls[0].searchParams.has('cursor')).toBe(false);
    const cont = urls.filter((url) => url.searchParams.has('cursor'));
    expect(cont.length).toBeGreaterThanOrEqual(1);
    expect(cont.every((url) => !url.searchParams.has('order'))).toBe(true);
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
