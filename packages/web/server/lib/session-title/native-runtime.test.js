import { afterEach, expect, it, vi } from 'vitest';
import { createSessionTitleRuntime } from './runtime.js';
import { mergeMetadataPatch } from '../session-metadata/session-metadata-store.js';
import { createTitleSessionAccess } from './session-access.js';
import { configureServerOpenCodeFetchGate } from '../opencode/server-opencode-fetch.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  configureServerOpenCodeFetchGate(null);
});

it('runs a Host smart-title request through generating, title publication, and cleared state', async () => {
  vi.useFakeTimers();
  const metadata = { openchamber: { titleRefresh: { lastAutoTitle: 'Original', requestedAt: 1000 } } };
  const session = { id: 'ses_title', title: 'Original', directory: '/repo', metadata };
  const updates = [];
  const sessionAccess = {
    get: vi.fn(async () => structuredClone(session)),
    update: vi.fn(async (_id, _directory, patch) => {
      if (patch.title) session.title = patch.title;
      if (patch.metadata) session.metadata = mergeMetadataPatch(session.metadata, patch.metadata);
      updates.push(structuredClone(session));
    }),
    messages: vi.fn(async () => [
      { info: { id: 'u1', role: 'user' }, parts: [{ type: 'text', text: 'Implement a title refresh' }] },
      { info: { id: 'a1', role: 'assistant' }, parts: [{ type: 'text', text: 'Done' }] },
    ]),
  };
  const generate = vi.fn(async () => {
    expect(session.metadata.openchamber.titleRefresh.isGenerating).toBe(true);
    return { text: 'Title refresh', providerID: 'test', modelID: 'test' };
  });
  const runtime = createSessionTitleRuntime({
    sessionAccess,
    buildOpenCodeUrl: (path) => `http://opencode${path}`,
    getOpenCodeAuthHeaders: () => ({}),
    getSmallModelService: async () => ({ generateSmallModelText: generate }),
    now: () => 1000,
  });
  try {
    runtime.processPayload({ type: 'openchamber:session-metadata', properties: {
      sessionID: session.id, directory: '/repo', metadata,
    } });
    await vi.runAllTimersAsync();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(session.title).toBe('Title refresh');
    expect(session.metadata.openchamber.titleRefresh.isGenerating).not.toBe(true);
    expect(session.metadata.openchamber.titleRefresh.requestedAt).toBeUndefined();
    expect(updates.some((row) => row.metadata.openchamber.titleRefresh.isGenerating)).toBe(true);
  } finally {
    runtime.stop();
  }
});

it('uses the real v2 client and publishes the generated title without another session click', async () => {
  vi.useFakeTimers();
  configureServerOpenCodeFetchGate(null, { allowMissingContract: true });
  let metadata = { openchamber: { titleRefresh: { lastAutoTitle: 'Original', requestedAt: 1000 } } };
  const session = { id: 'ses_title', title: 'Original', location: { directory: '/repo' }, time: { created: 1, updated: 2 } };
  const requests = [];
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    requests.push(`${request.method} ${url.pathname}`);
    if (url.pathname.endsWith('/message')) {
      expect(url.searchParams.get('order')).toBe('desc');
      return Response.json({ data: [
        { id: 'a1', type: 'assistant', content: [{ type: 'text', text: 'Done' }] },
        { id: 'u1', type: 'user', text: 'Implement title refresh' },
      ] });
    }
    if (request.method === 'PATCH') {
      const body = await request.json();
      expect(Object.keys(body)).toEqual(['title']);
      session.title = body.title;
    }
    return Response.json({ data: session });
  }));
  const events = [];
  const access = createTitleSessionAccess({
    buildOpenCodeUrl: (path) => `http://opencode${path}`,
    getOpenCodeAuthHeaders: () => ({}),
    readSessionMetadata: async () => metadata,
    persistSessionMetadata: async (_id, patch) => {
      metadata = mergeMetadataPatch(metadata, patch);
      events.push({ type: 'metadata', metadata: structuredClone(metadata) });
    },
    publishSession: (row) => events.push({ type: 'session', row }),
  });
  const runtime = createSessionTitleRuntime({
    sessionAccess: access,
    getSmallModelService: async () => ({ generateSmallModelText: async () => ({ text: 'Title refresh' }) }),
    now: () => 1000,
  });
  try {
    runtime.processPayload({ type: 'openchamber:session-metadata', properties: {
      sessionID: session.id, metadata, directory: '/repo',
    } });
    await vi.runAllTimersAsync();
    expect(events.some((event) => event.metadata?.openchamber?.titleRefresh?.isGenerating === true)).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'session', row: { title: 'Title refresh', directory: '/repo' } });
    expect(metadata.openchamber.titleRefresh.isGenerating).toBeUndefined();
    expect(requests).toContain('PATCH /api/session/ses_title');
  } finally {
    runtime.stop();
  }
});
