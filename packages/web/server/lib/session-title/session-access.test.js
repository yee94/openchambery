import { beforeEach, expect, it, vi } from 'vitest';
import { mergeMetadataPatch } from '../session-metadata/session-metadata-store.js';

const { api } = vi.hoisted(() => ({ api: {
  session: { get: vi.fn(), update: vi.fn() },
  message: { list: vi.fn() },
} }));
vi.mock('../opencode/v2-client.js', () => ({ makeOpenCodeV2Client: () => api }));
import { createTitleSessionAccess } from './session-access.js';

beforeEach(() => vi.resetAllMocks());

function fixture() {
  let metadata = { openchamber: {
    goal: { status: 'active' },
    titleRefresh: { isGenerating: true, requestedAt: 1000, lastError: 'old failure', failedAt: 1 },
  } };
  api.session.get.mockResolvedValue({
    id: 'ses_title', title: 'Updated title', location: { directory: '/repo' },
    time: { created: 10, updated: 20 },
  });
  const persist = vi.fn(async (_id, patch) => { metadata = mergeMetadataPatch(metadata, patch); });
  const publish = vi.fn();
  const access = createTitleSessionAccess({
    buildOpenCodeUrl: (path) => `http://opencode${path}`,
    getOpenCodeAuthHeaders: () => ({}),
    readSessionMetadata: async () => metadata,
    persistSessionMetadata: persist,
    publishSession: publish,
  });
  return { access, persist, publish, metadata: () => metadata };
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

it('does not publish success on a failed title write', async () => {
  const f = fixture();
  api.session.update.mockRejectedValue(new Error('offline'));
  await expect(f.access.update('ses_title', '/repo', {
    title: 'Failed', metadata: { openchamber: { titleRefresh: { lastAutoTitle: 'Failed' } } },
  })).rejects.toThrow('offline');
  expect(f.persist).not.toHaveBeenCalled();
  expect(f.publish).not.toHaveBeenCalled();
});

it('does not turn a failed or malformed message read into empty success', async () => {
  const f = fixture();
  api.message.list.mockRejectedValueOnce(new Error('offline'));
  await expect(f.access.messages('ses_title', '/repo', 16)).rejects.toThrow('offline');
  api.message.list.mockResolvedValueOnce({});
  await expect(f.access.messages('ses_title', '/repo', 16)).rejects.toThrow('invalid message page');
});
