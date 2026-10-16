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

it('writes the generated title to OpenCode before reading and publishing the confirmed session', async () => {
  const f = fixture();
  f.session.title = 'Original title';
  let finishWrite;
  let startedWrite;
  const writing = new Promise((resolve) => { startedWrite = resolve; });
  const persisted = new Promise((resolve) => { finishWrite = resolve; });
  api.session.update.mockImplementationOnce(async ({ title }) => {
    startedWrite();
    await persisted;
    f.session.title = title;
    f.session.time.updated = 30;
  });

  const completion = f.access.update('ses_title', '/repo', { title: 'Generated summary title' });
  await writing;
  expect(f.session.title).toBe('Original title');
  expect(api.session.get).not.toHaveBeenCalled();
  expect(f.publish).not.toHaveBeenCalled();

  finishWrite();
  const confirmed = await completion;
  expect(f.session.title).toBe('Generated summary title');
  expect(confirmed).toMatchObject({ title: 'Generated summary title', time: { updated: 30 } });
  expect(f.publish).toHaveBeenCalledExactlyOnceWith(confirmed, '/repo');
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

it('reports a failed upstream title write without projecting or retrying the failed choice', async () => {
  const f = fixture();
  api.session.update.mockRejectedValue(new Error('offline'));
  await expect(f.access.update('ses_title', '/repo', {
    title: 'Failed', metadata: { openchamber: { titleRefresh: { lastAutoTitle: 'Failed' } } },
  })).rejects.toThrow('offline');
  expect(f.metadata().openchamber.titleAuthority.title).toBe('Failed');
  expect(f.publish).not.toHaveBeenCalled();
  await vi.runAllTimersAsync();
  expect(api.session.update).toHaveBeenCalledTimes(1);
  expect((await f.access.get('ses_title')).title).toBe('Updated title');
});

it('reads a later OpenCode rename without rewriting it to the previous summary', async () => {
  const f = fixture();
  await f.access.update('ses_title', '/repo', { title: 'Ours' });
  f.session.title = 'Native';
  expect((await f.access.get('ses_title')).title).toBe('Native');
  await vi.runAllTimersAsync();
  expect(f.session.title).toBe('Native');
  expect(api.session.update).toHaveBeenCalledTimes(1);
});

it('rejects stale generation after a manual rename', async () => {
  const f = fixture();
  await f.access.update('ses_title', '/repo', { title: 'Summary' });
  const previous = f.metadata().openchamber.titleAuthority.revision;
  await f.persist('ses_title', { openchamber: { titleAuthority: {
    sessionID: 'ses_title', title: 'Manual', revision: 'manual-1', source: 'manual',
  } } });
  await api.session.update({ sessionID: 'ses_title', title: 'Manual' });
  await f.access.update('ses_title', '/repo', { title: 'Late summary', expectedTitleRevision: previous });
  await vi.runAllTimersAsync();
  expect(f.session.title).toBe('Manual');
  expect(f.metadata().openchamber.titleAuthority.source).toBe('manual');
});

it('ignores persisted title choices on a fresh access instance', async () => {
  const f = fixture();
  await f.persist('ses_title', { openchamber: { titleAuthority: {
    sessionID: 'ses_title', title: 'Durable', revision: 'saved', source: 'summary',
  } } });
  expect((await f.access.get('ses_title')).title).toBe('Updated title');
  await vi.runAllTimersAsync();
  expect(api.session.update).not.toHaveBeenCalled();
});

it('does not adopt inherited fork authority or legacy lastAutoTitle as a lock', async () => {
  const f = fixture();
  await f.persist('ses_title', { openchamber: {
    titleRefresh: { lastAutoTitle: 'Old summary' },
    titleAuthority: { sessionID: 'ses_parent', title: 'Parent', revision: 'parent' },
  } });
  expect((await f.access.get('ses_title')).title).toBe('Updated title');
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

it('preserves authoritative deletion instead of serving a stored title', async () => {
  const f = fixture();
  await f.persist('ses_title', { openchamber: { titleAuthority: {
    sessionID: 'ses_title', title: 'Durable', revision: 'saved',
  } } });
  api.session.get.mockRejectedValue(Object.assign(new Error('deleted'), { status: 404 }));
  await expect(f.access.get('ses_title')).rejects.toThrow('deleted');
  await vi.runAllTimersAsync();
  expect(api.session.get).toHaveBeenCalledTimes(1);
  expect(api.session.update).not.toHaveBeenCalled();
});

it('propagates failed authoritative reads without falling back to a stored title', async () => {
  const f = fixture();
  await f.persist('ses_title', { openchamber: { titleAuthority: {
    sessionID: 'ses_title', title: 'Durable', revision: 'saved',
  } } });
  api.session.get.mockRejectedValue(new Error('offline'));
  await expect(f.access.get('ses_title')).rejects.toThrow('offline');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(api.session.get).toHaveBeenCalledTimes(1);
  expect(api.session.update).not.toHaveBeenCalled();
});

it('does not turn a failed or malformed message read into empty success', async () => {
  const f = fixture();
  api.message.list.mockRejectedValueOnce(new Error('offline'));
  await expect(f.access.messages('ses_title', '/repo', 16)).rejects.toThrow('offline');
  api.message.list.mockResolvedValueOnce({});
  await expect(f.access.messages('ses_title', '/repo', 16)).rejects.toThrow('invalid message page');
});
