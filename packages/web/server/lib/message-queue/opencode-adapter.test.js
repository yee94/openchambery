import { describe, expect, it, vi } from 'vitest';

vi.mock('@opencode-ai/sdk/v2', () => ({ createOpencodeClient: vi.fn() }));
const { createOpencodeClient } = await import('@opencode-ai/sdk/v2');
const { createOpenCodeMessageQueueAdapter } = await import('./opencode-adapter.js');
const { createSessionTurnGate } = await import('./session-turn-gate.js');

describe('OpenCode message queue adapter', () => {
  it('waits for readiness without forwarding worker options', async () => {
    const waitForReady = vi.fn(); const adapter = createOpenCodeMessageQueueAdapter({ waitForReady });
    await adapter.waitForReady({ signal: new AbortController().signal });
    expect(waitForReady).toHaveBeenCalledWith();
  });
  it('captures runtime, materializes text and files, and sends the captured configuration', async () => {
    const promptAsync = vi.fn(() => ({ data: {}, response: { status: 204 } })); createOpencodeClient.mockReturnValue({ session: { promptAsync, messages: vi.fn(() => ({ data: [] })) } });
    let generation = 1;
    const adapter = createOpenCodeMessageQueueAdapter({ waitForReady: vi.fn(), buildOpenCodeUrl: () => 'http://open.code/', getOpenCodeAuthHeaders: () => ({ Authorization: 'secret' }), getRuntimeConfig: () => ({ apiBaseUrl: 'http://open.code' }), getRuntimeGeneration: () => generation, getSessionEligibility: () => ({ idle: true, settled: true }), getLatestMessageID: () => 'old', readAttachment: () => ({ type: 'file', url: 'file:///attachment' }) });
    const runtime = adapter.captureRuntime(); const scope = { sessionID: 'session', directory: '/repo' }; expect(await adapter.checkEligibility(scope)).toMatchObject({ available: true, idle: true, settled: true, latestMessageID: 'old' });
    const parts = await adapter.materializeAttachments({ content: 'text', attachments: [{}] }); expect(parts).toEqual([{ type: 'text', text: 'text' }, { type: 'file', url: 'file:///attachment' }]);
    await adapter.send({ scope, messageID: 'message', runtime, sendConfig: { providerID: 'p', modelID: 'm', agent: 'a', variant: 'v' }, parts }); expect(promptAsync).toHaveBeenCalledWith(expect.objectContaining({ sessionID: 'session', directory: '/repo', messageID: 'message', model: { providerID: 'p', modelID: 'm' }, agent: 'a', variant: 'v', parts }), expect.any(Object));
    generation = 2; expect(await adapter.send({ scope, runtime, sendConfig: { providerID: 'p', modelID: 'm' } })).toMatchObject({ code: 'runtime_stale' });
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
    const promptAsync = vi.fn(() => ({ data: {}, response: { status: 204 } }));
    createOpencodeClient.mockReturnValue({ session: { promptAsync, messages: vi.fn(() => ({ data: [] })) } });
    let upstreamUrl = 'http://opencode-upstream:4096/';
    const adapter = createOpenCodeMessageQueueAdapter({ buildOpenCodeUrl: () => upstreamUrl, getOpenCodeAuthHeaders: () => ({}), getRuntimeConfig: () => ({ apiBaseUrl: upstreamUrl }), readAttachment: () => null });
    const runtime = adapter.captureRuntime();
    await adapter.send({ scope: { sessionID: 's', directory: '/repo' }, messageID: 'msg_1', runtime, sendConfig: { providerID: 'p', modelID: 'm' }, parts: [] });
    expect(createOpencodeClient).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: 'http://opencode-upstream:4096' }));
    upstreamUrl = 'http://opencode-upstream:4097/';
    expect(adapter.isCurrent(runtime)).toBe(false);
  });
  it('classifies SDK results and exact reconciliation matches without exposing transport details', async () => {
    const messages = vi.fn(() => ({ data: [{ id: 'other' }, { id: 'wanted' }] })); createOpencodeClient.mockReturnValue({ session: { promptAsync: vi.fn(() => ({ error: {}, response: { status: 503 } })), messages } });
    const adapter = createOpenCodeMessageQueueAdapter({ buildOpenCodeUrl: () => 'http://open.code/', getOpenCodeAuthHeaders: () => ({}), getSessionEligibility: () => ({ idle: true, settled: true }), getLatestMessageID: () => null, readAttachment: () => null });
    expect(await adapter.send({ scope: { sessionID: 's', directory: '/d' }, messageID: 'm', sendConfig: { providerID: 'p', modelID: 'm' } })).toMatchObject({ kind: 'ambiguous', status: 503 }); expect(await adapter.findMessage({ sessionID: 's', directory: '/d' }, 'wanted')).toEqual({ found: true });
  });
  it('treats explicit 2xx empty bodies as ok and never treats undefined/malformed results as success', async () => {
    const promptAsync = vi.fn()
      .mockReturnValueOnce({ data: undefined, error: null, response: { status: 204 } })
      .mockReturnValueOnce({ data: undefined, error: undefined, response: { status: 202 } })
      .mockReturnValueOnce({ data: {}, error: null, response: { status: 200 } })
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({});
    createOpencodeClient.mockReturnValue({ session: { promptAsync, messages: vi.fn(() => ({ data: [] })) } });
    const adapter = createOpenCodeMessageQueueAdapter({ buildOpenCodeUrl: () => 'http://open.code/', getOpenCodeAuthHeaders: () => ({}), getRuntimeConfig: () => ({ apiBaseUrl: 'http://open.code' }), readAttachment: () => null });
    const base = { scope: { sessionID: 's', directory: '/d' }, messageID: 'm', sendConfig: { providerID: 'p', modelID: 'm' }, parts: [] };
    await expect(adapter.send(base)).resolves.toMatchObject({ ok: true, status: 204 });
    await expect(adapter.send(base)).resolves.toMatchObject({ ok: true, status: 202 });
    await expect(adapter.send(base)).resolves.toMatchObject({ ok: true, status: 200 });
    await expect(adapter.send(base)).resolves.toMatchObject({ ok: false, kind: 'ambiguous', code: 'malformed_result' });
    await expect(adapter.send(base)).resolves.toMatchObject({ ok: false, kind: 'ambiguous', code: 'malformed_result' });
    await expect(adapter.send(base)).resolves.toMatchObject({ ok: false, kind: 'ambiguous', code: 'malformed_result' });
  });
  it('reads failure status from error.status and classifies definitive 4xx failures', async () => {
    const promptAsync = vi.fn()
      .mockReturnValueOnce({ error: { status: 400 }, response: undefined })
      .mockReturnValueOnce({ error: {}, response: { status: 422 } })
      .mockReturnValueOnce({ error: { status: 429 } })
      .mockReturnValueOnce({ error: { status: 408 } });
    createOpencodeClient.mockReturnValue({ session: { promptAsync, messages: vi.fn(() => ({ data: [] })) } });
    const adapter = createOpenCodeMessageQueueAdapter({ buildOpenCodeUrl: () => 'http://open.code/', getOpenCodeAuthHeaders: () => ({}), readAttachment: () => null });
    const base = { scope: { sessionID: 's', directory: '/d' }, messageID: 'm', sendConfig: { providerID: 'p', modelID: 'm' }, parts: [] };
    await expect(adapter.send(base)).resolves.toMatchObject({ ok: false, kind: 'failed', status: 400 });
    await expect(adapter.send(base)).resolves.toMatchObject({ ok: false, kind: 'failed', status: 422 });
    await expect(adapter.send(base)).resolves.toMatchObject({ ok: false, kind: 'ambiguous', status: 429 });
    await expect(adapter.send(base)).resolves.toMatchObject({ ok: false, kind: 'ambiguous', status: 408 });
  });
  it('prefers client.v2.session.message exact lookup and treats 404 as found:false', async () => {
    const exact = vi.fn()
      .mockReturnValueOnce({ data: { info: { id: 'wanted' } } })
      .mockReturnValueOnce({ error: { status: 404 }, response: { status: 404 } });
    const messages = vi.fn(() => ({ data: [{ id: 'other' }] }));
    createOpencodeClient.mockReturnValue({ v2: { session: { message: exact } }, session: { messages, promptAsync: vi.fn() } });
    const adapter = createOpenCodeMessageQueueAdapter({ buildOpenCodeUrl: () => 'http://open.code/', getOpenCodeAuthHeaders: () => ({}), readAttachment: () => null });
    await expect(adapter.findMessage({ sessionID: 's', directory: '/d' }, 'wanted')).resolves.toEqual({ found: true });
    await expect(adapter.findMessage({ sessionID: 's', directory: '/d' }, 'missing')).resolves.toEqual({ found: false });
    expect(messages).not.toHaveBeenCalled();
    expect(exact).toHaveBeenCalledWith({ sessionID: 's', messageID: 'wanted', directory: '/d' }, expect.any(Object));
  });
  it('falls back from unsupported exact lookup to legacy session.message then bounded messages', async () => {
    const legacyMessage = vi.fn()
      .mockReturnValueOnce({ data: { info: { id: 'legacy-hit' } } })
      .mockReturnValueOnce({ error: { status: 404 }, response: { status: 404 } });
    const messages = vi.fn(() => ({ data: [{ id: 'bounded-hit' }] }));
    createOpencodeClient
      .mockReturnValueOnce({ session: { message: legacyMessage, messages, promptAsync: vi.fn() } })
      .mockReturnValueOnce({ session: { message: legacyMessage, messages, promptAsync: vi.fn() } })
      .mockReturnValueOnce({ session: { messages, promptAsync: vi.fn() } });
    const adapter = createOpenCodeMessageQueueAdapter({ buildOpenCodeUrl: () => 'http://open.code/', getOpenCodeAuthHeaders: () => ({}), readAttachment: () => null });
    await expect(adapter.findMessage({ sessionID: 's', directory: '/d' }, 'legacy-hit')).resolves.toEqual({ found: true });
    await expect(adapter.findMessage({ sessionID: 's', directory: '/d' }, 'missing')).resolves.toEqual({ found: false });
    await expect(adapter.findMessage({ sessionID: 's', directory: '/d' }, 'bounded-hit')).resolves.toEqual({ found: true });
    expect(messages).toHaveBeenCalledTimes(1);
  });
  it('falls back when v2 exact lookup returns 405/501 unsupported', async () => {
    const exact = vi.fn().mockReturnValueOnce({ error: { status: 405 }, response: { status: 405 } });
    const messages = vi.fn(() => ({ data: [{ info: { id: 'wanted' } }] }));
    createOpencodeClient.mockReturnValue({ v2: { session: { message: exact } }, session: { messages, promptAsync: vi.fn() } });
    const adapter = createOpenCodeMessageQueueAdapter({ buildOpenCodeUrl: () => 'http://open.code/', getOpenCodeAuthHeaders: () => ({}), readAttachment: () => null });
    await expect(adapter.findMessage({ sessionID: 's', directory: '/d' }, 'wanted')).resolves.toEqual({ found: true });
    expect(messages).toHaveBeenCalledTimes(1);
  });
  it('uses absent session status as idle and derives settlement from the message tail', async () => {
    const messages = vi.fn(() => ({ data: [] })); createOpencodeClient.mockReturnValue({ session: { messages, status: vi.fn(() => ({ data: {} })) } });
    const adapter = createOpenCodeMessageQueueAdapter({ buildOpenCodeUrl: () => 'http://open.code/', getOpenCodeAuthHeaders: () => ({}), readAttachment: () => null });
    expect(await adapter.checkEligibility({ sessionID: 's', directory: '/d' })).toMatchObject({ idle: true, settled: true });
    messages.mockReturnValueOnce({ data: [{ info: { id: 'user', role: 'user' } }] }); expect((await adapter.checkEligibility({ sessionID: 's', directory: '/d' })).settled).toBe(false);
    messages.mockReturnValueOnce({ data: [{ info: { id: 'assistant', role: 'assistant', time: { completed: 1 } } }] }); expect((await adapter.checkEligibility({ sessionID: 's', directory: '/d' })).settled).toBe(true);
  });
  it('recovers an idle incomplete assistant tail without treating fetch failure as empty', async () => {
    let now = 0; const turnGate = createSessionTurnGate({ clock: () => now });
    const messages = vi.fn(() => ({ data: [{ info: { id: 'assistant', role: 'assistant', time: { created: 1 } } }] }));
    const status = vi.fn(() => ({ data: {} })); createOpencodeClient.mockReturnValue({ session: { messages, status } });
    const adapter = createOpenCodeMessageQueueAdapter({ buildOpenCodeUrl: () => 'http://open.code/', getOpenCodeAuthHeaders: () => ({}), readAttachment: () => null, turnGate });
    expect(await adapter.checkEligibility({ sessionID: 's', directory: '/d' })).toMatchObject({ settled: false, settlementReason: 'tail_unsettled' });
    status.mockReturnValueOnce({ error: {} }); now = 3_000;
    await expect(adapter.checkEligibility({ sessionID: 's', directory: '/d' })).resolves.toEqual({ available: false, idle: false, settled: false });
    expect(await adapter.checkEligibility({ sessionID: 's', directory: '/d' })).toMatchObject({ settled: false, settlementReason: 'tail_unsettled' });
    now = 6_000;
    expect(await adapter.checkEligibility({ sessionID: 's', directory: '/d' })).toMatchObject({ settled: true, settlementReason: 'stopped_assistant' });
  });
  it('marks malformed or failed authoritative eligibility reads unavailable', async () => {
    createOpencodeClient.mockReturnValue({ session: { messages: vi.fn(() => ({ data: [] })), status: vi.fn(() => ({ error: {} })) } });
    const adapter = createOpenCodeMessageQueueAdapter({ buildOpenCodeUrl: () => 'http://open.code/', getOpenCodeAuthHeaders: () => ({}), readAttachment: () => null });
    await expect(adapter.checkEligibility({ sessionID: 's', directory: '/d' })).resolves.toEqual({ available: false, idle: false, settled: false });
  });
});
