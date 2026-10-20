import { afterEach, expect, it, vi } from 'vitest';
import { createSessionRuntime } from './session-runtime.js';
import { createSessionDeliveryRuntime, registerSessionDeliveryRoute } from './session-delivery-runtime.js';

afterEach(() => vi.unstubAllGlobals());
const item = { id: 'message-a', sessionID: 'session-a', type: 'user', delivery: 'steer', payload: { text: 'pending' } };
const emit = (runtime, type, data = {}) => runtime.processOpenCodeSsePayload({ type, data: { sessionID: 'session-a', ...data } });

it('keeps steering and compaction for two clients after the originating client leaves', async () => {
  const runtime = createSessionRuntime({ getNotificationClients: () => new Set(), writeSseEvent() {} });
  try {
    emit(runtime, 'session.inbox.enqueued', { inboxID: item.id, item });
    emit(runtime, 'session.compaction.started');
    runtime.markSessionViewed('session-a', 'client-a');
    runtime.markSessionUnviewed('session-a', 'client-a');
    runtime.markSessionViewed('session-b', 'client-a');
    const load = async () => [item];
    expect(await runtime.delivery.readSnapshot('session-a', load)).toEqual({ data: [item], compactionRunning: true });
    expect(await runtime.delivery.readSnapshot('session-a', load)).toEqual({ data: [item], compactionRunning: true });
    emit(runtime, 'session.compaction.ended');
    expect(await runtime.delivery.readSnapshot('session-a', load)).toEqual({ data: [item], compactionRunning: false });
    emit(runtime, 'session.inbox.delivered', { inboxID: item.id });
    expect((await runtime.delivery.readSnapshot('session-a', async () => [])).data).toEqual([]);
  } finally { runtime.dispose(); }
});

it('refetches when consumption races a snapshot rather than reviving the message', async () => {
  const delivery = createSessionDeliveryRuntime();
  let resolve;
  const load = vi.fn().mockImplementationOnce(() => new Promise((done) => { resolve = done; })).mockResolvedValueOnce([]);
  const pending = delivery.readSnapshot('session-a', load);
  delivery.processEvent({ type: 'session.inbox.delivered', data: { sessionID: 'session-a', inboxID: item.id } });
  resolve([item]);
  expect((await pending).data).toEqual([]);
  expect(load).toHaveBeenCalledTimes(2);
});

it('explicit cancellation releases a queued compaction, while consumption waits for its terminal event', async () => {
  const delivery = createSessionDeliveryRuntime();
  const event = (type, extra = {}) => delivery.processEvent({ type, data: { sessionID: 'session-a', inboxID: 'compact-a', ...extra } });
  event('session.inbox.enqueued', { item: { type: 'compaction' } });
  event('session.inbox.cancelled');
  expect((await delivery.readSnapshot('session-a', async () => [item])).compactionRunning).toBe(false);
  event('session.inbox.enqueued', { item: { type: 'compaction' } });
  event('session.inbox.delivered');
  event('session.compaction.started');
  expect((await delivery.readSnapshot('session-a', async () => [item])).compactionRunning).toBe(true);
  event('session.compaction.failed');
  expect((await delivery.readSnapshot('session-a', async () => [item])).compactionRunning).toBe(false);
});

it('cold recovery restores compaction from upstream and failed reads never return empty success', async () => {
  const delivery = createSessionDeliveryRuntime();
  const rows = [item, { id: 'compact-a', sessionID: 'session-a', type: 'compaction' }];
  expect(await delivery.readSnapshot('session-a', async () => ({ data: rows }))).toEqual({ data: rows, compactionRunning: true });
  await expect(delivery.readSnapshot('session-a', async () => { throw new Error('offline'); })).rejects.toThrow('offline');
  expect(await delivery.readSnapshot('session-a', async () => [item])).toEqual({ data: [item], compactionRunning: true });
  delivery.reset();
  expect(await delivery.readSnapshot('session-a', async () => [item])).toEqual({ data: [item], compactionRunning: null });
});

it('fences late snapshots and held phases when the upstream runtime changes', async () => {
  let runtimeIdentity = 'runtime-a';
  const delivery = createSessionDeliveryRuntime({ getRuntimeIdentity: () => runtimeIdentity });
  delivery.processEvent({ type: 'session.compaction.started', data: { sessionID: 'session-a' } });
  let resolve;
  const pending = delivery.readSnapshot('session-a', () => new Promise((done) => { resolve = done; }));
  runtimeIdentity = 'runtime-b';
  resolve([item]);
  await expect(pending).rejects.toThrow('scope changed');
  expect(await delivery.readSnapshot('session-a', async () => [])).toEqual({ data: [], compactionRunning: null });
});

it('route forwards captured session/directory/auth and exposes failure as 503', async () => {
  const routes = new Map();
  const app = { get: (path, handler) => routes.set(path, handler) };
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([item]), { headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  registerSessionDeliveryRoute(app, {
    delivery: createSessionDeliveryRuntime(),
    buildOpenCodeUrl: (path) => `http://upstream.test/api${path}`,
    getOpenCodeAuthHeaders: () => ({ 'x-test-auth': 'fixture' }),
  });
  const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };
  const handler = routes.get('/api/sessions/:sessionID/delivery');
  await handler({ params: { sessionID: 'session-a' }, query: { directory: '/project a' } }, res);
  expect(fetchMock).toHaveBeenCalledWith('http://upstream.test/api/session/session-a/inbox?directory=%2Fproject+a', expect.objectContaining({ headers: expect.objectContaining({ 'x-test-auth': 'fixture' }), signal: expect.any(AbortSignal) }));
  expect(res.json).toHaveBeenCalledWith({ data: [item], compactionRunning: null });
  fetchMock.mockRejectedValueOnce(new Error('offline'));
  await handler({ params: { sessionID: 'session-a' }, query: {} }, res);
  expect(res.status).toHaveBeenCalledWith(503);
});
