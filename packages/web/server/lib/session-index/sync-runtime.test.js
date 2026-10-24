import { describe, expect, it, vi } from 'vitest';

import { createSessionIndexSyncRuntime, extractSessionListCursorToken } from './sync-runtime.js';

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
  it('rechecks missing directories periodically and stops maintenance on shutdown', async () => {
    const service = createService([{ directory: '/repo', sessions: [], hasMore: false }]);
    service.removeEmptyDirectory = vi.fn(() => true);
    const isDirectoryMissing = vi.fn(async () => false);
    const timers = [];
    const clearTimer = vi.fn();
    const runtime = createSessionIndexSyncRuntime({
      sessionIndexService: service,
      isDirectoryMissing,
      setTimer: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
      clearTimer,
    });
    await waitUntil(() => timers.length === 1);
    expect(timers[0].ms).toBe(60_000);
    expect(service.removeEmptyDirectory).not.toHaveBeenCalled();
    isDirectoryMissing.mockResolvedValue(true);
    await timers[0].fn();
    expect(service.removeEmptyDirectory).toHaveBeenCalledWith('/repo');
    expect(runtime.snapshot().revision).toBe(1);
    runtime.stop();
    expect(clearTimer).toHaveBeenCalledWith(timers[1]);
    const calls = isDirectoryMissing.mock.calls.length;
    await timers[1].fn();
    expect(isDirectoryMissing).toHaveBeenCalledTimes(calls);
    expect(timers).toHaveLength(2);
  });

  it('coalesces hundreds of directory/child checks and immediately publishes the final revision', async () => {
    vi.useFakeTimers();
    try {
      const service = createService();
      const revisionsAtDelivery = [];
      const tips = vi.fn(() => { revisionsAtDelivery.push(runtime.snapshot().revision); });
      const runtime = createSessionIndexSyncRuntime({
        sessionIndexService: service,
        buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
        getOpenCodeAuthHeaders: () => ({}),
        onRevisionTip: tips,
        setTimer: setTimeout,
        clearTimer: clearTimeout,
        fetchFn: async (url) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          const directory = url.searchParams.get('directory');
          return new Response(JSON.stringify({ data: url.searchParams.has('parentID') ? []
            : Array.from({ length: 20 }, (_, i) => session(`${directory}-${i}`, 100 - i, directory)) }));
        },
      });
      runtime.enqueue(Array.from({ length: 15 }, (_, i) => `/repo/${i}`));
      expect(tips).toHaveBeenCalledTimes(1);
      expect(tips.mock.calls[0][0]).toMatchObject({ revision: 1, sync: { active: true } });
      await vi.advanceTimersByTimeAsync(499);
      expect(tips).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(tips).toHaveBeenCalledTimes(2);
      const progress = runtime.waitForChange(runtime.snapshot().revision);
      await vi.advanceTimersByTimeAsync(10);
      expect((await progress).revision).toBe(runtime.snapshot().revision);
      const final = (async () => {
        let value = runtime.snapshot();
        while (value.sync.active || value.sync.enriching) value = await runtime.waitForChange(value.revision);
        return value;
      })();
      await vi.advanceTimersByTimeAsync(2640);
      expect(service.replaceDirectory).toHaveBeenCalledTimes(15);
      expect(service.replaceChildSessions).toHaveBeenCalledTimes(300);
      expect(isFullyIdle(runtime)).toBe(true);
      // Relay cold-start budget: 315 internal revisions must reach SSE as a handful
      // of tips (one per 500ms window + immediate edges), never one per directory or
      // child check. Each tip costs every Relay client a full snapshot GET; the
      // uncoalesced Host measured ~316 tips per mobile cold start.
      expect(runtime.snapshot().revision).toBeGreaterThan(300);
      expect(tips.mock.calls.length).toBeLessThanOrEqual(Math.ceil(2650 / 500) + 3);
      expect(tips).toHaveBeenCalledTimes(8);
      expect(tips.mock.calls.map(([tip]) => tip.revision)).toEqual(revisionsAtDelivery);
      for (const [tip] of tips.mock.calls) expect(tip).not.toHaveProperty('cause');
      expect(tips.mock.lastCall[0]).toMatchObject({ revision: runtime.snapshot().revision, sync: { active: false, enriching: false } });
      expect((await final).revision).toBe(runtime.snapshot().revision);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(500);
      expect(tips).toHaveBeenCalledTimes(8);
      runtime.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('publishes external changes immediately while busy and stop cancels the pending tip', async () => {
    vi.useFakeTimers();
    try {
      const tips = vi.fn();
      let releaseReady;
      const runtime = createSessionIndexSyncRuntime({
        sessionIndexService: createService(),
        onRevisionTip: tips,
        waitForOpenCodeReady: () => new Promise((resolve) => { releaseReady = resolve; }),
        setTimer: setTimeout,
        clearTimer: clearTimeout,
      });
      runtime.enqueue(['/repo']);
      expect(vi.getTimerCount()).toBe(1);
      expect(tips.mock.lastCall[0]).not.toHaveProperty('cause');
      runtime.publishChange();
      expect(tips).toHaveBeenCalledTimes(2);
      expect(tips.mock.lastCall[0]).toMatchObject({ cause: 'change', sync: { active: true } });
      expect(tips.mock.lastCall[0].revision).toBe(runtime.snapshot().revision);
      expect(vi.getTimerCount()).toBe(0);
      runtime.enqueue(['/repo/second']);
      expect(vi.getTimerCount()).toBe(1);
      const final = runtime.waitForChange(runtime.snapshot().revision);
      runtime.stop();
      const stoppedRevision = runtime.snapshot().revision;
      expect(tips).toHaveBeenCalledTimes(3);
      expect(tips.mock.lastCall[0]).toMatchObject({ revision: stoppedRevision, sync: { active: false, enriching: false } });
      expect(tips.mock.lastCall[0]).not.toHaveProperty('cause');
      await expect(final).resolves.toMatchObject({ revision: stoppedRevision, sync: { active: false, failedDirectories: ['/repo', '/repo/second'] } });
      expect(vi.getTimerCount()).toBe(0);
      releaseReady(true);
      await vi.advanceTimersByTimeAsync(1000);
      expect(runtime.snapshot().revision).toBe(stoppedRevision);
      expect(tips).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stopping during enrichment flushes idle and fences late worker notifications', async () => {
    vi.useFakeTimers();
    try {
      const tips = vi.fn();
      const runtime = createSessionIndexSyncRuntime({
        sessionIndexService: createService(),
        buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
        getOpenCodeAuthHeaders: () => ({}),
        onRevisionTip: tips,
        fetchFn: async (url, { signal }) => {
          if (!url.searchParams.has('parentID')) return new Response(JSON.stringify([session('root', 1)]));
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
          });
        },
      });
      runtime.enqueue(['/repo']);
      await vi.advanceTimersByTimeAsync(0);
      expect(runtime.snapshot().sync.enriching).toBe(true);
      const final = runtime.waitForChange(runtime.snapshot().revision);
      runtime.stop();
      const revision = runtime.snapshot().revision;
      await expect(final).resolves.toMatchObject({ revision, sync: { active: false, enriching: false } });
      await vi.advanceTimersByTimeAsync(1000);
      expect(tips).toHaveBeenCalledTimes(2);
      expect(tips.mock.lastCall[0]).toMatchObject({ revision, sync: { active: false, enriching: false } });
      expect(runtime.snapshot().revision).toBe(revision);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([1, 20, 21])('only advertises more when terminal pages contain over 20 visible roots (%i roots)', async (rootCount) => {
    const service = createService();
    const rows = Array.from({ length: Math.max(20, rootCount) }, (_, i) => ({
      ...session(`ses_${i}`, 100 - i),
      ...(i >= rootCount ? { parentID: 'ses_0' } : {}),
    }));
    const runtime = createSessionIndexSyncRuntime({
      sessionIndexService: service,
      buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
      getOpenCodeAuthHeaders: () => ({}),
      waitForOpenCodeReady: async () => true,
      fetchFn: async (url) => {
        if (url.pathname !== '/session' || url.searchParams.has('parentID')) return new Response(JSON.stringify([]));
        const secondPage = url.searchParams.has('cursor');
        return new Response(JSON.stringify({
          data: secondPage ? rows.slice(20) : rows.slice(0, 20),
          cursor: { next: !secondPage && rows.length > 20 ? 'next-page' : null },
        }));
      },
    });
    runtime.enqueue(['/repo']);
    await waitUntil(() => isFullyIdle(runtime));
    expect(service.snapshot().directories[0].sessions).toHaveLength(Math.min(rootCount, 20));
    expect(service.snapshot().directories[0].hasMore).toBe(rootCount > 20);
    runtime.stop();
  });

  it('skips a full background-tagged page without consuming the active session budget', async () => {
    const service = createService();
    const cursors = [];
    const runtime = createSessionIndexSyncRuntime({
      sessionIndexService: service,
      buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
      getOpenCodeAuthHeaders: () => ({}),
      waitForOpenCodeReady: async () => true,
      fetchFn: async (url) => {
        if (url.pathname !== '/session' || url.searchParams.has('parentID')) return new Response(JSON.stringify([]));
        const cursor = url.searchParams.get('cursor');
        cursors.push(cursor);
        return new Response(JSON.stringify(cursor ? {
          data: Array.from({ length: 20 }, (_, i) => session(`visible-${i}`, 100 - i)), cursor: null,
        } : {
          data: Array.from({ length: 20 }, (_, i) => ({ ...session(`background-${i}`, 200 - i), title: '[Scheduled] Run' })),
          cursor: { next: 'ordinary' },
        }));
      },
    });
    runtime.enqueue(['/repo']);
    await waitUntil(() => isFullyIdle(runtime));
    expect(cursors).toEqual([null, 'ordinary']);
    expect(service.replaceDirectory.mock.calls[0][0].sessions.map((row) => row.id)).toEqual(
      Array.from({ length: 20 }, (_, i) => `visible-${i}`),
    );
    runtime.stop();
  });

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
    expect(fetchFn.mock.calls[0][0].pathname).toBe('/session');
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

  it('extracts cursor.next without stringifying objects', () => {
    expect(extractSessionListCursorToken({ next: 'abc' })).toBe('abc');
    expect(extractSessionListCursorToken({ next: 42 })).toBe('42');
    expect(extractSessionListCursorToken({ foo: 1 })).toBeNull();
    expect(extractSessionListCursorToken('plain')).toBe('plain');
  });

  it('continues paging when a short page still carries cursor.next', async () => {
    const service = createService();
    const cursors = [];
    const runtime = createSessionIndexSyncRuntime({
      sessionIndexService: service,
      buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
      getOpenCodeAuthHeaders: () => ({}),
      waitForOpenCodeReady: async () => true,
      projectSessions: (sessions) => sessions,
      fetchFn: async (url) => {
        if (url.pathname !== '/session') {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        cursors.push(url.searchParams.get('cursor'));
        if (!url.searchParams.get('cursor')) {
          // Short page (not limit=20) but v2 still offers next — must continue.
          return new Response(JSON.stringify({
            data: [
              { ...session('ses_arch_a', 30), time: { created: 1, updated: 30, archived: 9 } },
              { ...session('ses_arch_b', 29), time: { created: 1, updated: 29, archived: 9 } },
            ],
            cursor: { next: 'more-after-short' },
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          data: [session('ses_active', 10)],
          cursor: null,
        }), { status: 200 });
      },
    });
    runtime.enqueue(['/repo']);
    await waitUntil(() => isFullyIdle(runtime));
    expect(cursors).toContain('more-after-short');
    expect(service.replaceDirectory.mock.calls[0][0].sessions).toEqual([
      expect.objectContaining({ id: 'ses_active' }),
    ]);
  });

  it('uses cursor.next for paging and does not write [object Object]', async () => {
    const service = createService();
    const cursors = [];
    const runtime = createSessionIndexSyncRuntime({
      sessionIndexService: service,
      buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
      getOpenCodeAuthHeaders: () => ({}),
      waitForOpenCodeReady: async () => true,
      projectSessions: (sessions) => sessions,
      fetchFn: async (url) => {
        if (url.pathname !== '/session') {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        cursors.push(url.searchParams.get('cursor'));
        if (!url.searchParams.get('cursor')) {
          const archivedPage = Array.from({ length: 20 }, (_, index) => ({
            ...session(`ses_arch_${index}`, 100 - index),
            time: { created: 1, updated: 100 - index, archived: 9 },
          }));
          return new Response(JSON.stringify({
            data: archivedPage,
            cursor: { next: 'page-2-token' },
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          data: [session('ses_active', 10)],
          cursor: { next: null },
        }), { status: 200 });
      },
    });

    runtime.enqueue(['/repo']);
    await waitUntil(() => isFullyIdle(runtime));
    expect(cursors[0]).toBeNull();
    expect(cursors).toContain('page-2-token');
    expect(cursors.some((value) => value === '[object Object]')).toBe(false);
    expect(service.replaceDirectory.mock.calls[0][0].sessions).toEqual([
      expect.objectContaining({ id: 'ses_active' }),
    ]);
  });

  it('keeps prior directory rows when projectSessions fails', async () => {
    const service = createService([{
      directory: '/repo',
      sessions: [session('ses_old', 10)],
      cursor: null,
      hasMore: false,
    }]);
    const runtime = createSessionIndexSyncRuntime({
      sessionIndexService: service,
      buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
      getOpenCodeAuthHeaders: () => ({}),
      waitForOpenCodeReady: async () => true,
      projectSessions: () => {
        throw new Error('metadata unavailable');
      },
      fetchFn: async () => new Response(JSON.stringify([session('ses_new', 20)]), { status: 200 }),
    });
    runtime.enqueue(['/repo']);
    await waitUntil(() => isFullyIdle(runtime));
    // replaceDirectory must not have replaced with empty/new on failure.
    expect(service.replaceDirectory).not.toHaveBeenCalled();
    expect(runtime.snapshot().sync.failedDirectories).toContain('/repo');
  });

  it('skips Host-archived rows and pages within budget to fill active slots', async () => {
    const service = createService();
    const urls = [];
    const runtime = createSessionIndexSyncRuntime({
      sessionIndexService: service,
      buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
      getOpenCodeAuthHeaders: () => ({}),
      waitForOpenCodeReady: async () => true,
      projectSessions: (sessions) => sessions.map((item) => (
        String(item.id).startsWith('ses_arch')
          ? { ...item, time: { ...item.time, archived: 9 } }
          : item
      )),
      fetchFn: async (url) => {
        if (url.pathname !== '/session') {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        urls.push(url.searchParams.get('cursor'));
        if (!url.searchParams.get('cursor')) {
          // Full page of archived rows — sync must continue with cursor.
          const archivedPage = Array.from({ length: 20 }, (_, index) => session(`ses_arch_${index}`, 100 - index));
          return new Response(JSON.stringify({
            data: archivedPage,
            cursor: 'page-2',
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          data: [session('ses_active', 10)],
          cursor: null,
        }), { status: 200 });
      },
    });

    runtime.enqueue(['/repo']);
    await waitUntil(() => isFullyIdle(runtime));

    expect(urls[0]).toBeNull();
    expect(urls).toContain('page-2');
    expect(service.replaceDirectory.mock.calls[0][0].sessions).toEqual([
      expect.objectContaining({ id: 'ses_active' }),
    ]);
    expect(service.replaceDirectory.mock.calls[0][0].sessions.some((item) => String(item.id).startsWith('ses_arch'))).toBe(false);
  });

  it('v2 session.list has no incremental start — always fetches a full page', async () => {
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
        if (url.pathname === '/session') requestedUrl = url;
        return new Response(JSON.stringify([session('ses_new', 20)]), { status: 200 });
      },
      now: () => 2000,
    });

    runtime.enqueue(['/repo']);
    await waitUntil(() => isFullyIdle(runtime));

    expect(requestedUrl.searchParams.get('start')).toBeNull();
    expect(requestedUrl.searchParams.get('roots')).toBeNull();
    expect(service.replaceDirectory.mock.calls[0][0]).toMatchObject({
      fullSync: true,
      sessions: [expect.objectContaining({ id: 'ses_new' })],
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

  it('recovers an empty cached directory with a full page', async () => {
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
        if (url.pathname === '/session') requestedUrl = url;
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
