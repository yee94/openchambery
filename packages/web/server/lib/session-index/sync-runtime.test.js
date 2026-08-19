import { describe, expect, it, vi } from 'vitest';

import { createSessionIndexSyncRuntime } from './sync-runtime.js';

const session = (id, updated, directory = '/repo') => ({
  id,
  title: id,
  directory,
  time: { created: updated, updated },
});

const createService = (initialDirectories = []) => {
  let directories = initialDirectories;
  return {
    getRuntimeKey: () => 'runtime-a',
    snapshot: () => ({ directories }),
    replaceDirectory: vi.fn((input) => {
      const next = {
        ...input,
        lastSyncedAt: input.now,
        lastFullSyncedAt: input.fullSync
          ? input.now
          : (directories.find((entry) => entry.directory === input.directory)?.lastFullSyncedAt ?? 0),
      };
      directories = [...directories.filter((entry) => entry.directory !== input.directory), next];
    }),
    replaceChildSessions: vi.fn(),
  };
};

const waitUntil = async (predicate) => {
  for (let index = 0; index < 50; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('condition not reached');
};

const isFullyIdle = (runtime) => (
  runtime.snapshot().sync.active === false && runtime.snapshot().sync.enriching === false
);

describe('session index background sync runtime', () => {
  it('runs directory sync sequentially and publishes long-poll progress', async () => {
    const service = createService();
    let active = 0;
    let maxActive = 0;
    const fetchFn = vi.fn(async (url) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 0));
      active -= 1;
      const directory = url.searchParams.get('directory');
      return new Response(JSON.stringify([session(`ses_${directory}`, 10, directory)]), { status: 200 });
    });
    const runtime = createSessionIndexSyncRuntime({
      sessionIndexService: service,
      buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
      getOpenCodeAuthHeaders: () => ({ authorization: 'Basic test' }),
      waitForOpenCodeReady: async () => true,
      fetchFn,
    });

    const initial = runtime.enqueue(['/repo/a', '/repo/b']);
    const changed = await runtime.waitForChange(initial.revision);
    expect(changed.revision).toBeGreaterThan(initial.revision);
    await waitUntil(() => isFullyIdle(runtime));

    expect(maxActive).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(4);
    expect(fetchFn.mock.calls[0][0].pathname).toBe('/experimental/session');
    expect(service.replaceDirectory).toHaveBeenCalledTimes(2);
    expect(service.replaceChildSessions).toHaveBeenCalledTimes(2);
    expect(runtime.snapshot().sync).toMatchObject({ completed: 2, total: 2, failedDirectories: [] });
  });

  it('publishes session-index writes that happen outside the background queue', async () => {
    const runtime = createSessionIndexSyncRuntime({
      sessionIndexService: createService(),
      buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
      getOpenCodeAuthHeaders: () => ({}),
      waitForOpenCodeReady: async () => true,
    });
    const initialRevision = runtime.snapshot().revision;
    const changed = runtime.waitForChange(initialRevision);

    runtime.publishChange();

    await expect(changed).resolves.toMatchObject({ revision: initialRevision + 1 });
  });

  it('uses the persisted watermark for a true incremental merge', async () => {
    const service = createService([{
      directory: '/repo',
      sessions: [session('ses_old', 10)],
      cursor: 10,
      hasMore: true,
      lastSyncedAt: 1000,
      lastFullSyncedAt: 900,
    }]);
    let requestedUrl;
    const runtime = createSessionIndexSyncRuntime({
      sessionIndexService: service,
      buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
      getOpenCodeAuthHeaders: () => ({}),
      waitForOpenCodeReady: async () => true,
      fetchFn: async (url) => {
        if (url.pathname === '/experimental/session') requestedUrl = url;
        return new Response(JSON.stringify([session('ses_new', 20)]), { status: 200 });
      },
      now: () => 2000,
    });

    runtime.enqueue(['/repo']);
    await waitUntil(() => isFullyIdle(runtime));

    expect(requestedUrl.searchParams.get('start')).toBe('1000');
    expect(service.replaceDirectory.mock.calls[0][0]).toMatchObject({
      fullSync: false,
      sessions: [expect.objectContaining({ id: 'ses_new' }), expect.objectContaining({ id: 'ses_old' })],
    });
  });

  it('preempts and resumes a background list when an interactive session read arrives', async () => {
    const service = createService();
    let calls = 0;
    const runtime = createSessionIndexSyncRuntime({
      sessionIndexService: service,
      buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
      getOpenCodeAuthHeaders: () => ({}),
      waitForOpenCodeReady: async () => true,
      fetchFn: (_url, init) => {
        calls += 1;
        if (calls > 1) return Promise.resolve(new Response('[]', { status: 200 }));
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        });
      },
      now: (() => { let value = 0; return () => { value += 1000; return value; }; })(),
    });

    runtime.enqueue(['/repo']);
    await waitUntil(() => calls === 1);
    runtime.noteInteractiveRequest();
    await waitUntil(() => isFullyIdle(runtime));

    expect(calls).toBe(2);
    expect(runtime.snapshot().sync.completed).toBe(1);
  });

  it('allows a later UI reload to enqueue the same directory as a new batch', async () => {
    const service = createService();
    const fetchFn = vi.fn(async () => new Response('[]', { status: 200 }));
    const runtime = createSessionIndexSyncRuntime({
      sessionIndexService: service,
      buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
      getOpenCodeAuthHeaders: () => ({}),
      waitForOpenCodeReady: async () => true,
      fetchFn,
    });

    runtime.enqueue(['/repo']);
    await waitUntil(() => isFullyIdle(runtime));
    runtime.enqueue(['/repo']);
    await waitUntil(() => isFullyIdle(runtime));

    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('marks in-flight and queued directories failed when the runtime stops', async () => {
    const service = createService();
    let started = false;
    const runtime = createSessionIndexSyncRuntime({
      sessionIndexService: service,
      buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
      getOpenCodeAuthHeaders: () => ({}),
      waitForOpenCodeReady: async () => true,
      fetchFn: (_url, init) => new Promise((_resolve, reject) => {
        started = true;
        init.signal.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      }),
    });

    runtime.enqueue(['/repo/in-flight', '/repo/queued']);
    await waitUntil(() => started);
    runtime.stop();
    await waitUntil(() => runtime.snapshot().sync.active === false);

    expect(runtime.snapshot().sync).toMatchObject({
      active: false,
      pendingDirectories: [],
      failedDirectories: expect.arrayContaining(['/repo/in-flight', '/repo/queued']),
    });
  });

  it('omits start when recovering an empty cached directory', async () => {
    const service = createService([{
      directory: '/repo',
      sessions: [],
      cursor: null,
      hasMore: false,
      lastSyncedAt: 1000,
      lastFullSyncedAt: 1000,
    }]);
    let requestedUrl;
    const runtime = createSessionIndexSyncRuntime({
      sessionIndexService: service,
      buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
      getOpenCodeAuthHeaders: () => ({}),
      waitForOpenCodeReady: async () => true,
      fetchFn: async (url) => {
        if (url.pathname === '/experimental/session') requestedUrl = url;
        return new Response(JSON.stringify([session('ses_history', 10)]), { status: 200 });
      },
      now: () => 2000,
    });

    runtime.enqueue(['/repo']);
    await waitUntil(() => isFullyIdle(runtime));

    expect(requestedUrl.searchParams.has('start')).toBe(false);
    expect(service.replaceDirectory.mock.calls[0][0]).toMatchObject({
      fullSync: true,
      sessions: [expect.objectContaining({ id: 'ses_history' })],
    });
  });

  it('keeps the directory topology row when an empty cached directory still returns empty', async () => {
    const service = createService([{
      directory: '/repo',
      sessions: [],
      cursor: null,
      hasMore: false,
      lastSyncedAt: 1000,
      lastFullSyncedAt: 1000,
    }]);
    const runtime = createSessionIndexSyncRuntime({
      sessionIndexService: service,
      buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
      getOpenCodeAuthHeaders: () => ({}),
      waitForOpenCodeReady: async () => true,
      fetchFn: async () => new Response('[]', { status: 200 }),
      now: () => 2000,
    });

    runtime.enqueue(['/repo']);
    await waitUntil(() => isFullyIdle(runtime));

    expect(service.replaceDirectory).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/repo',
      sessions: [],
      fullSync: true,
    }));
    expect(runtime.snapshot().directories).toEqual([
      expect.objectContaining({ directory: '/repo', sessions: [] }),
    ]);
  });
});
