import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mergeMetadataPatch } from '../session-metadata/session-metadata-store.js';

const { api } = vi.hoisted(() => ({ api: {
  session: { get: vi.fn(), update: vi.fn() },
  message: { list: vi.fn() },
} }));
vi.mock('../opencode/v2-client.js', () => ({ makeOpenCodeV2Client: () => api }));
import { createTitleSessionAccess } from './session-access.js';

const accesses = [];
beforeEach(() => { vi.resetAllMocks(); vi.useFakeTimers(); });
afterEach(() => { for (const access of accesses.splice(0)) access.stop(); vi.useRealTimers(); });

function fixture() {
  let metadata = { openchamber: {
    goal: { status: 'active' },
    titleRefresh: { isGenerating: true, requestedAt: 1000, lastError: 'old failure', failedAt: 1 },
  } };
  const session = {
    id: 'ses_title', title: 'Updated title', location: { directory: '/repo' },
    time: { created: 10, updated: 20 },
  };
  api.session.get.mockImplementation(async () => structuredClone(session));
  api.session.update.mockImplementation(async ({ title }) => { session.title = title; });
  const persist = vi.fn(async (_id, patch) => { metadata = mergeMetadataPatch(metadata, patch); });
  const publish = vi.fn();
  const access = createTitleSessionAccess({
    buildOpenCodeUrl: (path) => `http://opencode${path}`,
    getOpenCodeAuthHeaders: () => ({}),
    readSessionMetadata: async () => metadata,
    persistSessionMetadata: persist,
    mutateSessionMetadata: async (id, decide) => {
      const decision = decide(metadata);
      if (!decision.ok) return { committed: false, metadata };
      await persist(id, decision.patch);
      return { committed: true, metadata };
    },
    listSessionMetadata: async () => ({ ses_title: metadata }),
    publishSession: publish,
  });
  accesses.push(access);
  return { access, persist, publish, session, metadata: () => metadata };
}

it('publishes the full authoritative title row and clears Host loading without overwriting unrelated state', async () => {
  const f = fixture();
  await f.access.update('ses_title', '/repo', {
    title: 'Updated title',
    metadata: { openchamber: { goal: { status: 'stale' }, titleRefresh: {
      lastAutoTitle: 'Updated title', isGenerating: null, requestedAt: null, lastError: null, failedAt: null,
    } } },
  });
  expect(api.session.update.mock.calls[0][0]).toEqual({ sessionID: 'ses_title', title: 'Updated title' });
  expect(f.metadata()).toEqual({ openchamber: {
    goal: { status: 'active' }, titleRefresh: { lastAutoTitle: 'Updated title' },
    titleAuthority: { sessionID: 'ses_title', title: 'Updated title', revision: expect.any(String), source: 'summary' },
  } });
  expect(f.publish).toHaveBeenCalledWith(expect.objectContaining({
    id: 'ses_title', title: 'Updated title', directory: '/repo', metadata: f.metadata(),
  }), '/repo');
});

it('projects only the bounded newest message page in conversation order', async () => {
  const f = fixture();
  api.message.list.mockResolvedValue({ data: [
    { id: 'a1', type: 'assistant', content: [{ type: 'text', text: 'Finished' }] },
    { id: 'u1', type: 'user', text: 'Implement title refresh' },
  ] });
  const messages = await f.access.messages('ses_title', '/repo', 16);
  expect(api.message.list.mock.calls[0][0]).toEqual({ sessionID: 'ses_title', limit: 16, order: 'desc' });
  expect(messages.map((row) => row.info.id)).toEqual(['u1', 'a1']);
  expect(messages[0].parts[0].text).toBe('Implement title refresh');
  expect(messages[1].parts[0].text).toBe('Finished');
});

it('publishes a full loading row before the new session exists in client catalogs', async () => {
  const f = fixture();
  await f.access.update('ses_title', '/repo', { metadata: { openchamber: { titleRefresh: { isGenerating: true } } } });
  expect(f.publish).toHaveBeenCalledWith(expect.objectContaining({
    id: 'ses_title', directory: '/repo', metadata: expect.objectContaining({
      openchamber: expect.objectContaining({ titleRefresh: expect.objectContaining({ isGenerating: true }) }),
    }),
  }), '/repo');
  expect(api.session.update).not.toHaveBeenCalled();
});

it('retains durable intent and retries a failed upstream title write without publishing success', async () => {
  const f = fixture();
  api.session.update.mockRejectedValue(new Error('offline'));
  await expect(f.access.update('ses_title', '/repo', {
    title: 'Failed', metadata: { openchamber: { titleRefresh: { lastAutoTitle: 'Failed' } } },
  })).rejects.toThrow('offline');
  expect(f.metadata().openchamber.titleAuthority.title).toBe('Failed');
  expect(f.publish).not.toHaveBeenCalled();
  api.session.update.mockImplementation(async ({ title }) => { f.session.title = title; });
  await vi.runAllTimersAsync();
  expect(f.session.title).toBe('Failed');
});

it.each(['before', 'after', 'during'])('rectifies upstream title writes %s our write', async (timing) => {
  const f = fixture();
  if (timing === 'before') f.session.title = 'Native';
  await f.access.update('ses_title', '/repo', { title: 'Ours' });
  if (timing !== 'before') f.session.title = 'Native';
  if (timing === 'during') {
    api.session.update.mockImplementationOnce(async () => { f.session.title = 'Native again'; });
  }
  for (let i = 0; i < 100; i++) f.access.reconcile('ses_title');
  await vi.runAllTimersAsync();
  expect(f.session.title).toBe('Ours');
  expect(api.session.update.mock.calls.length).toBeLessThanOrEqual(3);
  const writes = api.session.update.mock.calls.length;
  f.access.reconcile('ses_title');
  await vi.runAllTimersAsync();
  expect(api.session.update).toHaveBeenCalledTimes(writes);
});

it('rejects stale generation after a manual rename and repairs from the newest authority', async () => {
  const f = fixture();
  await f.access.update('ses_title', '/repo', { title: 'Summary' });
  const previous = f.metadata().openchamber.titleAuthority.revision;
  await f.persist('ses_title', { openchamber: { titleAuthority: {
    sessionID: 'ses_title', title: 'Manual', revision: 'manual-1', source: 'manual',
  } } });
  await f.access.update('ses_title', '/repo', { title: 'Late summary', expectedTitleRevision: previous });
  await vi.runAllTimersAsync();
  expect(f.session.title).toBe('Manual');
  expect(f.metadata().openchamber.titleAuthority.source).toBe('manual');
});

it('re-reads authority when manual rename lands during an upstream repair', async () => {
  const f = fixture();
  await f.access.update('ses_title', '/repo', { title: 'Summary' });
  f.session.title = 'Native';
  api.session.get.mockImplementationOnce(async () => {
    await f.persist('ses_title', { openchamber: { titleAuthority: {
      sessionID: 'ses_title', title: 'Manual', revision: 'manual-2', source: 'manual',
    } } });
    return structuredClone(f.session);
  });
  await vi.runAllTimersAsync();
  expect(f.session.title).toBe('Manual');
  expect(f.publish.mock.calls.at(-1)[0].title).toBe('Manual');
});

it('recovers missed rename events after reconnect without regenerating a title', async () => {
  const f = fixture();
  await f.persist('ses_title', { openchamber: { titleAuthority: {
    sessionID: 'ses_title', title: 'Durable', revision: 'saved', source: 'summary',
  } } });
  await f.access.reconcileAll();
  await vi.runAllTimersAsync();
  expect(f.session.title).toBe('Durable');
});

it('does not adopt inherited fork authority or legacy lastAutoTitle as a lock', async () => {
  const f = fixture();
  await f.persist('ses_title', { openchamber: {
    titleRefresh: { lastAutoTitle: 'Old summary' },
    titleAuthority: { sessionID: 'ses_parent', title: 'Parent', revision: 'parent' },
  } });
  f.access.reconcile('ses_title');
  await vi.runAllTimersAsync();
  expect(api.session.update).not.toHaveBeenCalled();
});

it('does not write a title if durable authority persistence fails', async () => {
  const f = fixture();
  f.persist.mockRejectedValue(new Error('disk unavailable'));
  await expect(f.access.update('ses_title', '/repo', { title: 'Unsaved' })).rejects.toThrow('disk unavailable');
  await vi.runAllTimersAsync();
  expect(api.session.update).not.toHaveBeenCalled();
  expect(f.publish).not.toHaveBeenCalled();
});

it('stops repair after authoritative deletion', async () => {
  const f = fixture();
  await f.persist('ses_title', { openchamber: { titleAuthority: {
    sessionID: 'ses_title', title: 'Durable', revision: 'saved',
  } } });
  api.session.get.mockRejectedValue(Object.assign(new Error('deleted'), { status: 404 }));
  f.access.reconcile('ses_title');
  await vi.runAllTimersAsync();
  expect(api.session.get).toHaveBeenCalledTimes(1);
  expect(api.session.update).not.toHaveBeenCalled();
});

it('backs off transient failures and cancels retry on stop', async () => {
  const f = fixture();
  await f.persist('ses_title', { openchamber: { titleAuthority: {
    sessionID: 'ses_title', title: 'Durable', revision: 'saved',
  } } });
  api.session.get.mockRejectedValue(new Error('offline'));
  f.access.reconcile('ses_title');
  await vi.advanceTimersByTimeAsync(3000);
  expect(api.session.get).toHaveBeenCalledTimes(3);
  f.access.stop();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(api.session.get).toHaveBeenCalledTimes(3);
});

it('does not turn a failed or malformed message read into empty success', async () => {
  const f = fixture();
  api.message.list.mockRejectedValueOnce(new Error('offline'));
  await expect(f.access.messages('ses_title', '/repo', 16)).rejects.toThrow('offline');
  api.message.list.mockResolvedValueOnce({});
  await expect(f.access.messages('ses_title', '/repo', 16)).rejects.toThrow('invalid message page');
});
