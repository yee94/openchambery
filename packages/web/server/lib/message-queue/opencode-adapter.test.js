import { describe, expect, it, vi } from 'vitest';

vi.mock('../opencode/v2-client.js', () => ({ makeOpenCodeV2Client: vi.fn() }));
const { makeOpenCodeV2Client } = await import('../opencode/v2-client.js');
const { createOpenCodeMessageQueueAdapter } = await import('./opencode-adapter.js');
const { createSessionTurnGate } = await import('./session-turn-gate.js');

const notFound = (status = 404) => Object.assign(new Error('not_found'), { status, code: 'not_found' });
const v2Client = ({ active = {}, list = { data: [] }, inbox = [], message } = {}) => ({
  session: {
    active: vi.fn(async () => active),
    inbox: { list: vi.fn(async () => inbox) },
    message: vi.fn(async ({ messageID }) => {
      if (typeof message === 'function') return message(messageID);
      if (message && typeof message === 'object' && messageID in message) return message[messageID];
      throw notFound();
    }),
  },
  message: { list: vi.fn(async () => list) },
});

describe('OpenCode message queue adapter', () => {
  it('waits for readiness without forwarding worker options', async () => {
    const waitForReady = vi.fn(); const adapter = createOpenCodeMessageQueueAdapter({ waitForReady });
    await adapter.waitForReady({ signal: new AbortController().signal });
    expect(waitForReady).toHaveBeenCalledWith();
  });
  it('captures runtime, materializes text and files, and applies sendConfig before prompt', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 204, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
    makeOpenCodeV2Client.mockReturnValue(v2Client());
    let generation = 1;
    const adapter = createOpenCodeMessageQueueAdapter({ waitForReady: vi.fn(), buildOpenCodeUrl: () => 'http://open.code/', getOpenCodeAuthHeaders: () => ({ Authorization: 'secret' }), getRuntimeConfig: () => ({ apiBaseUrl: 'http://open.code' }), getRuntimeGeneration: () => generation, getSessionEligibility: () => ({ idle: true, settled: true }), getLatestMessageID: () => 'old', readAttachment: () => ({ type: 'file', url: 'file:///attachment' }) });
    const runtime = adapter.captureRuntime(); const scope = { sessionID: 'session', directory: '/repo' }; expect(await adapter.checkEligibility(scope)).toMatchObject({ available: true, idle: true, settled: true, latestMessageID: 'old' });
    const parts = await adapter.materializeAttachments({ content: 'text', attachments: [{}] }); expect(parts).toEqual([{ type: 'text', text: 'text' }, { type: 'file', url: 'file:///attachment' }]);
    await adapter.send({ scope, messageID: 'message', runtime, sendConfig: { providerID: 'p', modelID: 'm', agent: 'a', variant: 'v' }, parts });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/session/session/agent');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ agent: 'a' });
    expect(String(fetchMock.mock.calls[1][0])).toContain('/api/session/session/model');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ model: { id: 'm', providerID: 'p', variant: 'v' } });
    expect(String(fetchMock.mock.calls[2][0])).toContain('/api/session/session/prompt');
    const promptBody = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(promptBody).toEqual(expect.objectContaining({ id: 'message', delivery: 'steer', text: 'text' }));
    expect(promptBody.model).toBeUndefined();
    expect(promptBody.agent).toBeUndefined();
    expect(promptBody.variant).toBeUndefined();
    generation = 2; expect(await adapter.send({ scope, runtime, sendConfig: { providerID: 'p', modelID: 'm' } })).toMatchObject({ code: 'runtime_stale' });
    vi.unstubAllGlobals();
  });
  it('materializes Assistant attachment IDs in delivery order', async () => {
    const readAttachment = vi.fn((attachment) => ({ type: 'file', url: `file:///${attachment.attachmentID}`, filename: attachment.filename }));
    const adapter = createOpenCodeMessageQueueAdapter({ buildOpenCodeUrl: () => 'http://open.code/', getOpenCodeAuthHeaders: () => ({}), readAttachment });
    await expect(adapter.materializeAssistantDeliveryParts({
      deliveryParts: [{ type: 'text', text: 'before' }, { type: 'file', mime: 'image/png', attachmentID: 'image' }, { type: 'text', text: 'after' }],
      attachments: [{ attachmentID: 'image', filename: 'image.png' }],
    })).resolves.toEqual([{ type: 'text', text: 'before' }, { type: 'file', mime: 'image/png', url: 'file:///image' }, { type: 'text', text: 'after' }]);
    expect(readAttachment).toHaveBeenCalledWith({ attachmentID: 'image', filename: 'image.png' }, expect.any(Object), expect.any(Object));
  });
  it('uses the injected upstream runtime URL and detects its changes', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 204, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
    makeOpenCodeV2Client.mockReturnValue(v2Client());
    let upstreamUrl = 'http://opencode-upstream:4096/';
    const adapter = createOpenCodeMessageQueueAdapter({ buildOpenCodeUrl: () => upstreamUrl, getOpenCodeAuthHeaders: () => ({}), getRuntimeConfig: () => ({ apiBaseUrl: upstreamUrl }), readAttachment: () => null });
    const runtime = adapter.captureRuntime();
    await adapter.send({ scope: { sessionID: 's', directory: '/repo' }, messageID: 'msg_1', runtime, sendConfig: { providerID: 'p', modelID: 'm' }, parts: [] });
    const promptCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/prompt'));
    expect(String(promptCall[0])).toContain('http://opencode-upstream:4096/api/session/s/prompt');
    upstreamUrl = 'http://opencode-upstream:4097/';
    expect(adapter.isCurrent(runtime)).toBe(false);
    vi.unstubAllGlobals();
  });
  it('classifies SDK results and exact reconciliation matches without exposing transport details', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
    makeOpenCodeV2Client.mockReturnValue(v2Client({ inbox: [{ id: 'wanted', sessionID: 's' }] }));
    const adapter = createOpenCodeMessageQueueAdapter({ buildOpenCodeUrl: () => 'http://open.code/', getOpenCodeAuthHeaders: () => ({}), getSessionEligibility: () => ({ idle: true, settled: true }), getLatestMessageID: () => null, readAttachment: () => null });
    // Prompt-only path (no sendConfig) classifies transport status on the POST itself.
    expect(await adapter.send({ scope: { sessionID: 's', directory: '/d' }, messageID: 'm', parts: [] })).toMatchObject({ kind: 'ambiguous', status: 503 });
    expect(await adapter.findMessage({ sessionID: 's', directory: '/d' }, 'wanted')).toEqual({ found: true });
    vi.unstubAllGlobals();
  });
  it('treats explicit 2xx empty bodies as ok and never treats undefined/malformed results as success', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 204, json: async () => undefined })
      .mockResolvedValueOnce({ ok: true, status: 202, json: async () => undefined })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({});
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createOpenCodeMessageQueueAdapter({ buildOpenCodeUrl: () => 'http://open.code/', getOpenCodeAuthHeaders: () => ({}), getRuntimeConfig: () => ({ apiBaseUrl: 'http://open.code' }), readAttachment: () => null });
    const base = { scope: { sessionID: 's', directory: '/d' }, messageID: 'm', parts: [] };
    await expect(adapter.send(base)).resolves.toMatchObject({ ok: true, status: 204 });
    await expect(adapter.send(base)).resolves.toMatchObject({ ok: true, status: 202 });
    await expect(adapter.send(base)).resolves.toMatchObject({ ok: true, status: 200 });
    await expect(adapter.send(base)).resolves.toMatchObject({ ok: false, kind: 'ambiguous', code: 'malformed_result' });
    await expect(adapter.send(base)).resolves.toMatchObject({ ok: false, kind: 'ambiguous', code: 'malformed_result' });
    await expect(adapter.send(base)).resolves.toMatchObject({ ok: false, kind: 'ambiguous', code: 'malformed_result' });
    vi.unstubAllGlobals();
  });
  it('reads failure status from error.status and classifies definitive 4xx failures', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: false, status: 422, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: false, status: 408, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ _tag: 'SessionBusyError' }) });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createOpenCodeMessageQueueAdapter({ buildOpenCodeUrl: () => 'http://open.code/', getOpenCodeAuthHeaders: () => ({}), readAttachment: () => null });
    const base = { scope: { sessionID: 's', directory: '/d' }, messageID: 'm', parts: [] };
    await expect(adapter.send(base)).resolves.toMatchObject({ ok: false, kind: 'failed', status: 400 });
    await expect(adapter.send(base)).resolves.toMatchObject({ ok: false, kind: 'failed', status: 422 });
    await expect(adapter.send(base)).resolves.toMatchObject({ ok: false, kind: 'ambiguous', status: 429 });
    await expect(adapter.send(base)).resolves.toMatchObject({ ok: false, kind: 'ambiguous', status: 408 });
    await expect(adapter.send(base)).resolves.toMatchObject({ ok: false, kind: 'retry', code: 'session_busy' });
    vi.unstubAllGlobals();
  });
  it('prefers client.v2.session.message exact lookup and treats 404 as found:false', async () => {
    const api = v2Client({
      inbox: [],
      message: { wanted: { id: 'wanted', type: 'user' } },
    });
    makeOpenCodeV2Client.mockReturnValue(api);
    const adapter = createOpenCodeMessageQueueAdapter({ buildOpenCodeUrl: () => 'http://open.code/', getOpenCodeAuthHeaders: () => ({}), readAttachment: () => null });
    await expect(adapter.findMessage({ sessionID: 's', directory: '/d' }, 'wanted')).resolves.toEqual({ found: true });
    await expect(adapter.findMessage({ sessionID: 's', directory: '/d' }, 'missing')).resolves.toEqual({ found: false });
    expect(api.session.inbox.list).toHaveBeenCalled();
    expect(api.session.message).toHaveBeenCalledWith({ sessionID: 's', messageID: 'wanted' }, expect.any(Object));
  });
  it('reconciles inbox then session.message without session.messages or 1.x fallback', async () => {
    const api = v2Client({
      inbox: [{ id: 'legacy-hit' }],
      message: { 'bounded-hit': { id: 'bounded-hit', type: 'user' } },
    });
    makeOpenCodeV2Client.mockReturnValue(api);
    const adapter = createOpenCodeMessageQueueAdapter({ buildOpenCodeUrl: () => 'http://open.code/', getOpenCodeAuthHeaders: () => ({}), readAttachment: () => null });
    await expect(adapter.findMessage({ sessionID: 's', directory: '/d' }, 'legacy-hit')).resolves.toEqual({ found: true });
    await expect(adapter.findMessage({ sessionID: 's', directory: '/d' }, 'missing')).resolves.toEqual({ found: false });
    await expect(adapter.findMessage({ sessionID: 's', directory: '/d' }, 'bounded-hit')).resolves.toEqual({ found: true });
    expect(api.session.status).toBeUndefined();
    expect(api.session.messages).toBeUndefined();
    expect(api.session.promptAsync).toBeUndefined();
  });
  it('marks non-404 inbox/message failures unavailable instead of falling back', async () => {
    const api = v2Client();
    api.session.inbox.list.mockRejectedValue(Object.assign(new Error('unsupported'), { status: 405 }));
    makeOpenCodeV2Client.mockReturnValue(api);
    const adapter = createOpenCodeMessageQueueAdapter({ buildOpenCodeUrl: () => 'http://open.code/', getOpenCodeAuthHeaders: () => ({}), readAttachment: () => null });
    await expect(adapter.findMessage({ sessionID: 's', directory: '/d' }, 'wanted')).resolves.toEqual({ unavailable: true });
  });
  it('uses absent session.active membership as idle and derives settlement from type and time.completed', async () => {
    const list = vi.fn(async () => ({ data: [] }));
    const active = vi.fn(async () => ({}));
    makeOpenCodeV2Client.mockReturnValue({ session: { active, inbox: { list: vi.fn() }, message: vi.fn() }, message: { list } });
    const adapter = createOpenCodeMessageQueueAdapter({ buildOpenCodeUrl: () => 'http://open.code/', getOpenCodeAuthHeaders: () => ({}), readAttachment: () => null });
    expect(await adapter.checkEligibility({ sessionID: 's', directory: '/d' })).toMatchObject({ idle: true, settled: true });
    list.mockResolvedValueOnce({ data: [{ id: 'user', type: 'user', time: { created: 1 } }] });
    expect((await adapter.checkEligibility({ sessionID: 's', directory: '/d' })).settled).toBe(false);
    list.mockResolvedValueOnce({ data: [{ id: 'assistant', type: 'assistant', time: { completed: 1 } }] });
    expect((await adapter.checkEligibility({ sessionID: 's', directory: '/d' })).settled).toBe(true);
    expect(list).toHaveBeenCalledWith({ sessionID: 's', limit: 1, order: 'desc' }, expect.any(Object));
  });
  it('treats a sessionID present in session.active as not idle', async () => {
    makeOpenCodeV2Client.mockReturnValue(v2Client({
      active: { s: { type: 'running' } },
      list: { data: [{ id: 'assistant', type: 'assistant', time: { completed: 1 } }] },
    }));
    const adapter = createOpenCodeMessageQueueAdapter({ buildOpenCodeUrl: () => 'http://open.code/', getOpenCodeAuthHeaders: () => ({}), readAttachment: () => null });
    expect(await adapter.checkEligibility({ sessionID: 's', directory: '/d' })).toMatchObject({ available: true, idle: false });
  });
  it('recovers an idle incomplete assistant tail without treating fetch failure as empty', async () => {
    let now = 0; const turnGate = createSessionTurnGate({ clock: () => now });
    const list = vi.fn(async () => ({ data: [{ id: 'assistant', type: 'assistant', time: { created: 1 } }] }));
    const active = vi.fn(async () => ({}));
    makeOpenCodeV2Client.mockReturnValue({ session: { active, inbox: { list: vi.fn() }, message: vi.fn() }, message: { list } });
    const adapter = createOpenCodeMessageQueueAdapter({ buildOpenCodeUrl: () => 'http://open.code/', getOpenCodeAuthHeaders: () => ({}), readAttachment: () => null, turnGate });
    expect(await adapter.checkEligibility({ sessionID: 's', directory: '/d' })).toMatchObject({ settled: false, settlementReason: 'tail_unsettled' });
    active.mockRejectedValueOnce(Object.assign(new Error('upstream'), { status: 500 })); now = 3_000;
    await expect(adapter.checkEligibility({ sessionID: 's', directory: '/d' })).resolves.toEqual({ available: false, idle: false, settled: false });
    expect(await adapter.checkEligibility({ sessionID: 's', directory: '/d' })).toMatchObject({ settled: false, settlementReason: 'tail_unsettled' });
    now = 6_000;
    expect(await adapter.checkEligibility({ sessionID: 's', directory: '/d' })).toMatchObject({ settled: true, settlementReason: 'stopped_assistant' });
  });
  it('marks malformed or failed authoritative eligibility reads unavailable', async () => {
    makeOpenCodeV2Client.mockReturnValue({
      session: { active: vi.fn(async () => { throw Object.assign(new Error('upstream'), { status: 500 }); }), inbox: { list: vi.fn() }, message: vi.fn() },
      message: { list: vi.fn(async () => ({ data: [] })) },
    });
    const adapter = createOpenCodeMessageQueueAdapter({ buildOpenCodeUrl: () => 'http://open.code/', getOpenCodeAuthHeaders: () => ({}), readAttachment: () => null });
    await expect(adapter.checkEligibility({ sessionID: 's', directory: '/d' })).resolves.toEqual({ available: false, idle: false, settled: false });
  });
});

describe('sendConfig serial boundary (v2 prompt contract)', () => {
  it('applies different models in agent→model→prompt order per item', async () => {
    const calls = [];
    const fetchMock = vi.fn(async (url, init) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
      return { ok: true, status: 204, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createOpenCodeMessageQueueAdapter({
      buildOpenCodeUrl: () => 'http://open.code/',
      getOpenCodeAuthHeaders: () => ({}),
      readAttachment: () => null,
    });
    const scope = { sessionID: 's', directory: '/d' };
    await adapter.send({
      scope, messageID: 'msg_a', parts: [{ type: 'text', text: 'first' }],
      sendConfig: { providerID: 'openai', modelID: 'gpt-a', agent: 'build', variant: 'fast' },
    });
    await adapter.send({
      scope, messageID: 'msg_b', parts: [{ type: 'text', text: 'second' }],
      sendConfig: { providerID: 'anthropic', modelID: 'claude-b', agent: 'plan' },
    });
    expect(calls.map((c) => c.url.replace(/^.*\/api\/session\/s\//, ''))).toEqual([
      'agent?directory=%2Fd',
      'model?directory=%2Fd',
      'prompt?directory=%2Fd',
      'agent?directory=%2Fd',
      'model?directory=%2Fd',
      'prompt?directory=%2Fd',
    ]);
    expect(calls[0].body).toEqual({ agent: 'build' });
    expect(calls[1].body).toEqual({ model: { id: 'gpt-a', providerID: 'openai', variant: 'fast' } });
    expect(calls[2].body).toEqual(expect.objectContaining({ id: 'msg_a', text: 'first', delivery: 'steer' }));
    expect(calls[2].body.model).toBeUndefined();
    expect(calls[3].body).toEqual({ agent: 'plan' });
    expect(calls[4].body).toEqual({ model: { id: 'claude-b', providerID: 'anthropic' } });
    expect(calls[5].body).toEqual(expect.objectContaining({ id: 'msg_b', text: 'second' }));
    vi.unstubAllGlobals();
  });

  it('does not POST prompt when model switch fails', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes('/model')) return { ok: false, status: 400, json: async () => ({ _tag: 'InvalidRequestError' }) };
      return { ok: true, status: 204, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createOpenCodeMessageQueueAdapter({
      buildOpenCodeUrl: () => 'http://open.code/',
      getOpenCodeAuthHeaders: () => ({}),
      readAttachment: () => null,
    });
    const result = await adapter.send({
      scope: { sessionID: 's', directory: '/d' },
      messageID: 'msg_fail',
      parts: [{ type: 'text', text: 'nope' }],
      sendConfig: { providerID: 'p', modelID: 'm', agent: 'a' },
    });
    expect(result).toMatchObject({ ok: false, kind: 'failed', code: 'config_switch_failed', status: 400 });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/prompt'))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/agent'))).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/model'))).toBe(true);
    vi.unstubAllGlobals();
  });

  it('treats session busy on switch as retry without prompt', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes('/agent')) return { ok: false, status: 409, json: async () => ({ _tag: 'SessionBusyError' }) };
      return { ok: true, status: 200, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createOpenCodeMessageQueueAdapter({
      buildOpenCodeUrl: () => 'http://open.code/',
      getOpenCodeAuthHeaders: () => ({}),
      readAttachment: () => null,
    });
    const result = await adapter.send({
      scope: { sessionID: 's', directory: '/d' },
      messageID: 'msg_busy',
      parts: [{ type: 'text', text: 'wait' }],
      sendConfig: { providerID: 'p', modelID: 'm', agent: 'a' },
    });
    expect(result).toMatchObject({ ok: false, kind: 'retry', code: 'session_busy' });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/prompt'))).toBe(false);
    vi.unstubAllGlobals();
  });

  it('maps MessageNotFoundError _tag from projection to found:false', async () => {
    const api = v2Client({ inbox: [] });
    api.session.message.mockRejectedValue({
      _tag: 'MessageNotFoundError',
      sessionID: 's',
      messageID: 'missing',
      message: 'not found',
    });
    makeOpenCodeV2Client.mockReturnValue(api);
    const adapter = createOpenCodeMessageQueueAdapter({
      buildOpenCodeUrl: () => 'http://open.code/',
      getOpenCodeAuthHeaders: () => ({}),
      readAttachment: () => null,
    });
    await expect(adapter.findMessage({ sessionID: 's', directory: '/d' }, 'missing')).resolves.toEqual({ found: false });
  });

  it('awaits projection rejections so non-404 stays unavailable instead of escaping', async () => {
    const api = v2Client({ inbox: [] });
    api.session.message.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));
    makeOpenCodeV2Client.mockReturnValue(api);
    const adapter = createOpenCodeMessageQueueAdapter({
      buildOpenCodeUrl: () => 'http://open.code/',
      getOpenCodeAuthHeaders: () => ({}),
      readAttachment: () => null,
    });
    await expect(adapter.findMessage({ sessionID: 's', directory: '/d' }, 'wanted')).resolves.toEqual({ unavailable: true });
  });
});

describe('intent queue prompt/inbox authority (ticket 12)', () => {
  const jsonResponse = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => 'application/json' },
  });

  it('sends via v2 prompt/inbox and does not treat local parts as the body of record', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {
      id: 'msg_inbox',
      sessionID: 's',
      delivery: 'steer',
      payload: { text: 'from-projection' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createOpenCodeMessageQueueAdapter({
      buildOpenCodeUrl: (pathname) => `http://open.code${pathname}`,
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic secret' }),
      readAttachment: () => ({ type: 'file', url: 'file:///staged' }),
    });
    const localParts = [{ type: 'text', text: 'stale-local-parts' }];
    const result = await adapter.send({
      scope: { sessionID: 's', directory: '/d' },
      messageID: 'msg_inbox',
      sendConfig: { providerID: 'p', modelID: 'm' },
      parts: localParts,
      content: 'stale-local-parts',
    });
    expect(result).toMatchObject({ ok: true, status: 200 });
    const promptCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/prompt'));
    expect(promptCall).toBeTruthy();
    const [url, init] = promptCall;
    expect(String(url)).toContain('/api/session/s/prompt');
    const body = JSON.parse(init.body);
    expect(body.delivery).toMatch(/steer|queue/);
    expect(body.id).toBe('msg_inbox');
    expect(body.model).toBeUndefined();
    expect(init.method).toBe('POST');
    vi.unstubAllGlobals();
  });

  it('reconciles only against OpenCode inbox and projection, never a local parts scan', async () => {
    const list = vi.fn(async () => ({ data: [{ id: 'wanted', type: 'user', text: 'local-scan' }] }));
    const api = v2Client({
      inbox: [{ id: 'wanted', sessionID: 's', delivery: 'steer', payload: { text: 'inbox' } }],
      message: { wanted: { id: 'wanted', type: 'user' } },
    });
    api.message.list = list;
    makeOpenCodeV2Client.mockReturnValue(api);
    const adapter = createOpenCodeMessageQueueAdapter({
      buildOpenCodeUrl: (pathname) => `http://open.code${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      readAttachment: () => null,
    });
    await expect(adapter.findMessage({ sessionID: 's', directory: '/d' }, 'wanted')).resolves.toEqual({ found: true });
    expect(list).not.toHaveBeenCalled();
    expect(api.session.inbox.list).toHaveBeenCalledWith({ sessionID: 's' }, expect.any(Object));
  });

  it('keeps staged attachment files until prompt is accepted, then projection wins', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {
      id: 'msg_att',
      sessionID: 's',
      delivery: 'steer',
      payload: { text: 'accepted' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const readAttachment = vi.fn(() => ({ type: 'file', url: 'file:///staged-disk', filename: 'note.txt' }));
    const adapter = createOpenCodeMessageQueueAdapter({
      buildOpenCodeUrl: (pathname) => `http://open.code${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      readAttachment,
    });
    const parts = await adapter.materializeAttachments({
      content: 'caption',
      attachments: [{ attachmentID: 'att-1', filename: 'note.txt' }],
    });
    expect(parts).toEqual([
      { type: 'text', text: 'caption' },
      { type: 'file', url: 'file:///staged-disk', filename: 'note.txt' },
    ]);
    const result = await adapter.send({
      scope: { sessionID: 's', directory: '/d' },
      messageID: 'msg_att',
      sendConfig: { providerID: 'p', modelID: 'm' },
      parts,
    });
    expect(result.ok).toBe(true);
    expect(readAttachment).toHaveBeenCalled();
    const promptCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/prompt'));
    const body = JSON.parse(promptCall[1].body);
    expect(body.files?.length || body.parts).toBeTruthy();
    expect(body.model).toBeUndefined();
    vi.unstubAllGlobals();
  });
});
