import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { OpencodeClient, Session } from '@opencode-ai/sdk/v2';

// Clear sticky mocks from other suites before installing this file's doubles.
mock.restore();

type OpenChamberEvent = {
  type: string;
  revision?: number;
  occurredAt?: number;
  sync?: { active: boolean; enriching: boolean };
};
const tipListeners = new Set<(event: OpenChamberEvent) => void>();
/** Deliver a tip (or ready) event to every active OpenChamber tip subscriber. */
const emitOpenchamberTip = (event: OpenChamberEvent) => {
  for (const listener of [...tipListeners]) listener(event);
};
const realOpenchamberEvents = await import('@/lib/openchamberEvents');
mock.module('@/lib/openchamberEvents', () => ({
  subscribeOpenchamberEvents: (listener: (event: OpenChamberEvent) => void) => {
    tipListeners.add(listener);
    return () => { tipListeners.delete(listener); };
  },
  // Keep the real parser so sibling suites can still assert envelope contracts.
  parseOpenchamberEventEnvelope: realOpenchamberEvents.parseOpenchamberEventEnvelope,
}));

// Load after the tip mock so waitForSessionIndexInvalidation binds the double.
const {
  mergeLiveSessionWithGlobalSession,
  refreshStartupGlobalSessionsForDirectories,
  resolveGlobalSessionDirectory,
  useGlobalSessionsStore,
} = await import('./useGlobalSessionsStore');
import { opencodeClient } from '@/lib/opencode/client';
import { resetOpenCodeReadiness } from '@/lib/runtime-readiness';
import { useSessionFoldersStore } from './useSessionFoldersStore';

type SessionExtra = Partial<Session> & {
  directory?: string | null;
  project?: { worktree?: string | null } | null;
};

const buildSession = (shareUrl: string, extra: SessionExtra = {}): Session => ({
  id: 'ses_1',
  title: 'Shared session',
  time: { created: 1, updated: 2 },
  share: { url: shareUrl },
  ...extra,
} as Session);

describe('useGlobalSessionsStore', () => {
  let restoreGetSdkClient: (() => void) | null = null;
  let restoreCheckHealth: (() => void) | null = null;

  afterAll(() => {
    mock.restore();
  });
  beforeEach(async () => {
    tipListeners.clear();
    resetOpenCodeReadiness();
    const { queryClient } = await import('@/lib/queryRuntime');
    queryClient.clear();
    const originalCheckHealth = opencodeClient.checkHealth;
    opencodeClient.checkHealth = async () => true;
    restoreCheckHealth = () => { opencodeClient.checkHealth = originalCheckHealth; };
    useGlobalSessionsStore.setState({
      activeSessions: [],
      archivedSessions: [],
      sessionsByDirectory: new Map(),
      loadedDirectories: new Set(),
      loadingDirectories: new Set(),
      refreshingDirectories: new Set(),
      archivedLoadedDirectories: new Set(),
      archivedLoadingDirectories: new Set(),
      activePaginationByDirectory: new Map(),
      cachedDirectories: new Set(),
      hasHydratedSessionIndex: false,
      hasCachedSessionIndex: false,
      sessionIndexSyncByDirectory: new Map(),
      hasLoadedFullCatalog: false,
      fullCatalogSessionIds: new Set(),
      fullCatalogGeneration: 0,
      pendingDeletionIds: new Set(),
      hasLoaded: false,
      status: 'idle',
      startupSyncProgress: { active: false, phase: 'idle', completed: 0, total: 0 },
    });
  });

  afterEach(() => {
    useGlobalSessionsStore.getState().resetForRuntimeSwitch();
    restoreGetSdkClient?.();
    restoreGetSdkClient = null;
    restoreCheckHealth?.();
    restoreCheckHealth = null;
    resetOpenCodeReadiness();
  });

  test('gates concurrent directory refreshes behind one runtime readiness probe', async () => {
    let healthCalls = 0;
    let releaseHealth: (ready: boolean) => void = () => undefined;
    opencodeClient.checkHealth = () => {
      healthCalls += 1;
      return new Promise<boolean>((resolve) => { releaseHealth = resolve; });
    };
    const listCalls: Array<Record<string, unknown>> = [];
    const list = async (input: Record<string, unknown>) => {
      listCalls.push(input);
      return { data: [], error: undefined, response: new Response(null, { status: 200 }) };
    };
    const sdk = { experimental: { session: { list } } } as unknown as OpencodeClient;
    const originalGetSdkClient = opencodeClient.getSdkClient;
    opencodeClient.getSdkClient = () => sdk;
    restoreGetSdkClient = () => { opencodeClient.getSdkClient = originalGetSdkClient; };

    const refresh = useGlobalSessionsStore.getState().refreshSessionsForDirectories(['/repo/a', '/repo/b']);
    await Promise.resolve();

    expect(healthCalls).toBe(1);
    expect(listCalls).toHaveLength(0);
    releaseHealth(true);
    await refresh;
    expect(listCalls).toHaveLength(2);
  });

  test('removes a SmartFetch secondary session received through a live update', () => {
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/temporary', {
      id: 'ses_temporary',
      title: 'smartfetch-secondary',
    }));

    expect(useGlobalSessionsStore.getState().activeSessions).toEqual([]);
  });

  test('keeps the same activeSessions reference for recency-only upserts', () => {
    const session = buildSession('https://share.example/recency', {
      id: 'ses_recency',
      title: 'stable title',
      time: { created: 1_000, updated: 2_000 },
    });
    useGlobalSessionsStore.getState().upsertSession(session);
    const first = useGlobalSessionsStore.getState().activeSessions;

    useGlobalSessionsStore.getState().upsertSession({
      ...session,
      time: { created: 1_000, updated: 9_999 },
    });
    const second = useGlobalSessionsStore.getState().activeSessions;

    expect(second).toBe(first);
    expect(second[0]?.time?.updated).toBe(2_000);
  });

  test('replaces activeSessions when a structural field changes on upsert', () => {
    const session = buildSession('https://share.example/title', {
      id: 'ses_title',
      title: 'before',
      time: { created: 1_000, updated: 2_000 },
    });
    useGlobalSessionsStore.getState().upsertSession(session);
    const first = useGlobalSessionsStore.getState().activeSessions;

    useGlobalSessionsStore.getState().upsertSession({
      ...session,
      title: 'after',
      time: { created: 1_000, updated: 2_001 },
    });
    const second = useGlobalSessionsStore.getState().activeSessions;

    expect(second).not.toBe(first);
    expect(second[0]?.title).toBe('after');
  });

  test('reclassifies archived-list sessions without time.archived as active', () => {
    const mislabeled = buildSession('https://share.example/mislabeled', {
      id: 'ses_mislabeled',
      directory: '/repo/app',
      time: { created: 1, updated: 2 },
    });
    const trulyArchived = buildSession('https://share.example/archived', {
      id: 'ses_archived',
      directory: '/repo/app',
      time: { created: 1, updated: 2, archived: 3 },
    });

    useGlobalSessionsStore.getState().applySnapshot([], [mislabeled, trulyArchived]);

    expect(useGlobalSessionsStore.getState().activeSessions.map((session) => session.id)).toEqual(['ses_mislabeled']);
    expect(useGlobalSessionsStore.getState().archivedSessions.map((session) => session.id)).toEqual(['ses_archived']);
    expect(useGlobalSessionsStore.getState().sessionsByDirectory.get('/repo/app')?.map((session) => session.id)).toEqual(['ses_mislabeled']);
  });

  test('reclassifies active-list sessions with time.archived as archived', () => {
    const drifted = buildSession('https://share.example/drifted', {
      id: 'ses_drifted',
      directory: '/repo/app',
      time: { created: 1, updated: 2, archived: 9 },
    });

    useGlobalSessionsStore.getState().applySnapshot([drifted], []);

    expect(useGlobalSessionsStore.getState().activeSessions).toEqual([]);
    expect(useGlobalSessionsStore.getState().archivedSessions.map((session) => session.id)).toEqual(['ses_drifted']);
  });

  test('treats time.archived 0 as active when collapsing duplicate list ids', () => {
    const fromActive = buildSession('https://share.example/dup-active', {
      id: 'ses_dup',
      title: 'from active list',
      directory: '/repo/app',
      time: { created: 1, updated: 5 },
    });
    const fromArchived = buildSession('https://share.example/dup-archived', {
      id: 'ses_dup',
      title: 'from archived list',
      directory: '/repo/app',
      time: { created: 1, updated: 4, archived: 0 },
    });

    useGlobalSessionsStore.getState().applySnapshot([fromActive], [fromArchived]);

    expect(useGlobalSessionsStore.getState().activeSessions).toHaveLength(1);
    expect(useGlobalSessionsStore.getState().archivedSessions).toHaveLength(0);
    expect(useGlobalSessionsStore.getState().activeSessions[0]?.id).toBe('ses_dup');
  });

  test('keeps pending deletes hidden through snapshots and live upserts until cleared', () => {
    const session = buildSession('https://share.example/pending', { id: 'ses_pending' });
    const store = useGlobalSessionsStore.getState();

    expect(store.pendingDeletionIds).toEqual(new Set());
    store.markSessionsPendingDeletion([session.id]);
    store.applySnapshot([session], []);
    store.upsertSession(session);

    expect(useGlobalSessionsStore.getState().activeSessions).toEqual([]);
    expect(useGlobalSessionsStore.getState().pendingDeletionIds).toEqual(new Set([session.id]));

    useGlobalSessionsStore.getState().clearSessionsPendingDeletion([session.id]);
    useGlobalSessionsStore.getState().upsertSession(session);
    expect(useGlobalSessionsStore.getState().activeSessions).toEqual([session]);

    useGlobalSessionsStore.getState().markSessionsPendingDeletion([session.id]);
    useGlobalSessionsStore.getState().resetForRuntimeSwitch();
    expect(useGlobalSessionsStore.getState().pendingDeletionIds).toEqual(new Set());
  });

  test('starts with three cold directory summaries before adaptive recovery', async () => {
    type ListResult = { data: Session[]; error: undefined; response: Response };
    const resolvers: Array<(value: ListResult) => void> = [];
    const listCalls: Array<Record<string, unknown>> = [];
    const list = (input: Record<string, unknown>) => new Promise<ListResult>((resolve) => {
      listCalls.push(input);
      resolvers.push(resolve);
    });
    const sdk = { experimental: { session: { list } } } as unknown as OpencodeClient;
    const originalGetSdkClient = opencodeClient.getSdkClient;
    opencodeClient.getSdkClient = () => sdk;
    restoreGetSdkClient = () => { opencodeClient.getSdkClient = originalGetSdkClient; };

    const refresh = useGlobalSessionsStore.getState().refreshSessionsForDirectories(
      Array.from({ length: 8 }, (_, index) => `/repo/${index}`),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(listCalls).toHaveLength(3);
    while (listCalls.length < 8 || resolvers.length > 0) {
      resolvers.splice(0).forEach((resolve) => resolve({
        data: [],
        error: undefined,
        response: new Response(null, { status: 200 }),
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await refresh;
  });

  test('reports blocking cold-start progress as each project directory settles', async () => {
    type ListResult = { data: Session[]; error: undefined; response: Response };
    const resolvers: Array<(value: ListResult) => void> = [];
    const list = () => new Promise<ListResult>((resolve) => {
      resolvers.push(resolve);
    });
    const sdk = { experimental: { session: { list } } } as unknown as OpencodeClient;
    const originalGetSdkClient = opencodeClient.getSdkClient;
    opencodeClient.getSdkClient = () => sdk;
    restoreGetSdkClient = () => { opencodeClient.getSdkClient = originalGetSdkClient; };

    const refresh = refreshStartupGlobalSessionsForDirectories([
      '/repo/a',
      '/repo/b',
      '/repo/c',
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(useGlobalSessionsStore.getState().startupSyncProgress).toEqual({
      active: true,
      phase: 'syncing',
      completed: 0,
      total: 3,
    });

    resolvers[0]?.({ data: [], error: undefined, response: new Response(null, { status: 200 }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useGlobalSessionsStore.getState().startupSyncProgress.completed).toBe(1);

    resolvers.slice(1).forEach((resolve) => resolve({
      data: [],
      error: undefined,
      response: new Response(null, { status: 200 }),
    }));
    await refresh;

    expect(useGlobalSessionsStore.getState().startupSyncProgress).toEqual({
      active: false,
      phase: 'idle',
      completed: 3,
      total: 3,
    });
  });

  test('keeps a first run blocked until its initial root-session refresh settles', async () => {
    type ListResult = { data: Session[]; error: undefined; response: Response };
    let listStarted = false;
    let resolveList: (value: ListResult) => void = () => undefined;
    const list = () => {
      listStarted = true;
      return new Promise<ListResult>((resolve) => { resolveList = resolve; });
    };
    const sdk = { experimental: { session: { list } } } as unknown as OpencodeClient;
    const originalGetSdkClient = opencodeClient.getSdkClient;
    opencodeClient.getSdkClient = () => sdk;
    restoreGetSdkClient = () => { opencodeClient.getSdkClient = originalGetSdkClient; };

    let finished = false;
    const startup = useGlobalSessionsStore.getState().startSessionIndexStartup(['/repo/first-run'])
      .then(() => { finished = true; });
    const deadline = Date.now() + 2_000;
    while (!listStarted && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(listStarted).toBe(true);
    expect(finished).toBe(false);
    expect(['restoring', 'syncing']).toContain(useGlobalSessionsStore.getState().startupSyncProgress.phase);

    resolveList({ data: [], error: undefined, response: new Response(null, { status: 200 }) });
    await startup;
    expect(finished).toBe(true);
  });

  test('retries failed first-run directories after adaptive concurrency drops', async () => {
    let calls = 0;
    const list = async () => {
      calls += 1;
      if (calls <= 2) {
        return {
          data: undefined,
          error: { message: 'service unavailable' },
          response: new Response(null, { status: 503 }),
        };
      }
      return {
        data: [buildSession('https://share.example/retry', { directory: '/repo/retry' })],
        error: undefined,
        response: new Response(null, { status: 200 }),
      };
    };
    const sdk = { experimental: { session: { list } } } as unknown as OpencodeClient;
    const originalGetSdkClient = opencodeClient.getSdkClient;
    opencodeClient.getSdkClient = () => sdk;
    restoreGetSdkClient = () => { opencodeClient.getSdkClient = originalGetSdkClient; };

    await useGlobalSessionsStore.getState().startSessionIndexStartup(['/repo/retry']);

    expect(calls).toBe(3);
    expect(useGlobalSessionsStore.getState().loadedDirectories.has('/repo/retry')).toBe(true);
    expect(useGlobalSessionsStore.getState().sessionsByDirectory.get('/repo/retry')).toHaveLength(1);
  });

  test('releases startup after the local restore while OpenCode validation continues in background', async () => {
    type ListResult = { data: Session[]; error: undefined; response: Response };
    let resolveList: (value: ListResult) => void = () => undefined;
    const list = () => new Promise<ListResult>((resolve) => { resolveList = resolve; });
    const sdk = { experimental: { session: { list } } } as unknown as OpencodeClient;
    const originalGetSdkClient = opencodeClient.getSdkClient;
    opencodeClient.getSdkClient = () => sdk;
    restoreGetSdkClient = () => { opencodeClient.getSdkClient = originalGetSdkClient; };
    useGlobalSessionsStore.setState({
      cachedDirectories: new Set(['/repo/cached']),
      hasCachedSessionIndex: true,
    });

    let finished = false;
    await useGlobalSessionsStore.getState().startSessionIndexStartup(['/repo/cached'])
      .then(() => { finished = true; });

    expect(finished).toBe(true);
    expect(useGlobalSessionsStore.getState().startupSyncProgress.active).toBe(true);
    expect(useGlobalSessionsStore.getState().startupSyncProgress.phase).toBe('syncing');

    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveList({ data: [], error: undefined, response: new Response(null, { status: 200 }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  test('with cache, syncs only priority directories immediately and defers the rest', async () => {
    const originalWindow = globalThis.window;
    const originalFetch = globalThis.fetch;
    const originalGetSdkClient = opencodeClient.getSdkClient;
    const syncBodies: string[][] = [];
    const cachedA = buildSession('https://share.example/a', { id: 'ses_a', directory: '/repo/a' });
    const cachedB = buildSession('https://share.example/b', { id: 'ses_b', directory: '/repo/b' });
    const snapshot = {
      revision: 1,
      sync: {
        active: false,
        completed: 1,
        total: 1,
        pendingDirectories: [] as string[],
        completedDirectories: ['/repo/a'],
        failedDirectories: [] as string[],
      },
      directories: [
        {
          directory: '/repo/a',
          cursor: 2,
          hasMore: false,
          lastSyncedAt: 1000,
          lastFullSyncedAt: 1000,
          lastAccessedAt: 1000,
          sessions: [cachedA],
        },
        {
          directory: '/repo/b',
          cursor: 2,
          hasMore: false,
          lastSyncedAt: 1000,
          lastFullSyncedAt: 1000,
          lastAccessedAt: 1000,
          sessions: [cachedB],
        },
      ],
    };
    try {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { location: { origin: 'http://localhost', href: 'http://localhost/' } },
      });
      globalThis.fetch = async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        const pathname = new URL(url, 'http://localhost').pathname;
        if (pathname === '/api/openchamber/session-index') {
          return new Response(JSON.stringify({ available: true, ...snapshot }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (pathname === '/api/openchamber/session-index/sync') {
          const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { directories?: string[] } : {};
          syncBodies.push([...(body.directories ?? [])].sort());
          return new Response(JSON.stringify(snapshot), {
            status: 202,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify(snapshot), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };
      opencodeClient.getSdkClient = () => ({
        experimental: { session: { list: async () => ({ data: [], error: undefined, response: new Response(null, { status: 200 }) }) } },
      } as unknown as OpencodeClient);

      // Seed cache flag the way hydrate would after a non-empty snapshot GET.
      useGlobalSessionsStore.setState({ hasCachedSessionIndex: true });

      let finished = false;
      await useGlobalSessionsStore.getState().startSessionIndexStartup(
        ['/repo/a', '/repo/b'],
        { priorityDirectories: ['/repo/a'] },
      ).then(() => { finished = true; });

      expect(finished).toBe(true);
      expect(useGlobalSessionsStore.getState().startupSyncProgress.active).toBe(false);
      expect(syncBodies).toEqual([['/repo/a']]);

      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(syncBodies).toEqual([['/repo/a'], ['/repo/b']]);
    } finally {
      useGlobalSessionsStore.getState().resetForRuntimeSwitch();
      opencodeClient.getSdkClient = originalGetSdkClient;
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      globalThis.fetch = originalFetch;
    }
  });

  test('without cache, still blocks on a full-directory sync even when priority is provided', async () => {
    const originalWindow = globalThis.window;
    const originalFetch = globalThis.fetch;
    const originalGetSdkClient = opencodeClient.getSdkClient;
    const syncBodies: string[][] = [];
    let revision = 1;
    let syncActive = true;
    const emptySnapshot = {
      revision: 1,
      sync: {
        active: true,
        completed: 0,
        total: 2,
        pendingDirectories: ['/repo/a', '/repo/b'],
        completedDirectories: [] as string[],
        failedDirectories: [] as string[],
      },
      directories: [] as Array<{ directory: string; sessions: Session[] }>,
    };
    const completedSnapshot = {
      revision: 2,
      sync: {
        active: false,
        completed: 2,
        total: 2,
        pendingDirectories: [] as string[],
        completedDirectories: ['/repo/a', '/repo/b'],
        failedDirectories: [] as string[],
      },
      directories: [] as Array<{ directory: string; sessions: Session[] }>,
    };
    try {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { location: { origin: 'http://localhost', href: 'http://localhost/' } },
      });
      globalThis.fetch = async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        const pathname = new URL(url, 'http://localhost').pathname;
        if (pathname === '/api/openchamber/session-index') {
          const payload = syncActive ? emptySnapshot : completedSnapshot;
          return new Response(JSON.stringify({ available: true, ...payload, revision }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (pathname === '/api/openchamber/session-index/sync') {
          const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { directories?: string[] } : {};
          syncBodies.push([...(body.directories ?? [])].sort());
          return new Response(JSON.stringify(emptySnapshot), {
            status: 202,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify(emptySnapshot), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };
      opencodeClient.getSdkClient = () => ({
        experimental: { session: { list: async () => ({ data: [], error: undefined, response: new Response(null, { status: 200 }) }) } },
      } as unknown as OpencodeClient);

      let finished = false;
      const startup = useGlobalSessionsStore.getState().startSessionIndexStartup(
        ['/repo/a', '/repo/b'],
        { priorityDirectories: ['/repo/a'] },
      ).then(() => { finished = true; });

      while (tipListeners.size === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      expect(finished).toBe(false);
      expect(syncBodies).toEqual([['/repo/a', '/repo/b']]);

      syncActive = false;
      revision = 2;
      emitOpenchamberTip({ type: 'session-index-changed', revision: 2, occurredAt: 1 });
      await startup;
      expect(finished).toBe(true);
      // No deferred second sync when cache miss forces full immediate set.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(syncBodies).toEqual([['/repo/a', '/repo/b']]);
    } finally {
      useGlobalSessionsStore.getState().resetForRuntimeSwitch();
      opencodeClient.getSdkClient = originalGetSdkClient;
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      globalThis.fetch = originalFetch;
    }
  });

  test('uses the Electron server job without issuing browser-side OpenCode session lists', async () => {
    const originalWindow = globalThis.window;
    const originalFetch = globalThis.fetch;
    const originalGetSdkClient = opencodeClient.getSdkClient;
    let sdkListCalls = 0;
    const requests: string[] = [];
    const cached = buildSession('https://share.example/server-cache', { directory: '/repo/server' });
    const snapshot = {
      revision: 1,
      sync: {
        active: false,
        completed: 1,
        total: 1,
        pendingDirectories: [],
        completedDirectories: ['/repo/server'],
        failedDirectories: [],
      },
      directories: [{
        directory: '/repo/server',
        cursor: 2,
        hasMore: false,
        lastSyncedAt: 1000,
        lastFullSyncedAt: 1000,
        lastAccessedAt: 1000,
        sessions: [cached],
      }],
    };
    try {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { location: { origin: 'http://localhost', href: 'http://localhost/' } },
      });
      globalThis.fetch = (input) => {
        const url = input instanceof Request ? input.url : String(input);
        const pathname = new URL(url, 'http://localhost').pathname;
        requests.push(pathname);
        if (pathname === '/api/openchamber/session-index') {
          return Promise.resolve(new Response(JSON.stringify({ available: true, ...snapshot }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }));
        }
        return Promise.resolve(new Response(JSON.stringify(snapshot), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        }));
      };
      opencodeClient.getSdkClient = () => ({
        experimental: { session: { list: async () => {
          sdkListCalls += 1;
          return { data: [], error: undefined, response: new Response(null, { status: 200 }) };
        } } },
      } as unknown as OpencodeClient);

      await useGlobalSessionsStore.getState().startSessionIndexStartup(['/repo/server']);
      while (requests.length < 2) await new Promise((resolve) => setTimeout(resolve, 0));

      expect(sdkListCalls).toBe(0);
      expect(requests).toEqual([
        '/api/openchamber/session-index',
        '/api/openchamber/session-index/sync',
      ]);
      expect(useGlobalSessionsStore.getState().sessionsByDirectory.get('/repo/server')).toEqual([cached]);
    } finally {
      useGlobalSessionsStore.getState().resetForRuntimeSwitch();
      opencodeClient.getSdkClient = originalGetSdkClient;
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      globalThis.fetch = originalFetch;
    }
  });

  test('keeps observing the session index and promotes a session after user activity', async () => {
    const originalWindow = globalThis.window;
    const originalFetch = globalThis.fetch;
    const older = buildSession('https://share.example/older', {
      id: 'ses_older',
      directory: '/repo/activity',
      time: { created: 1, updated: 10 },
    });
    const newer = buildSession('https://share.example/newer', {
      id: 'ses_newer',
      directory: '/repo/activity',
      time: { created: 2, updated: 20 },
    });
    const sync = {
      active: false,
      completed: 1,
      total: 1,
      pendingDirectories: [],
      completedDirectories: ['/repo/activity'],
      failedDirectories: [],
    };
    const initialSnapshot = {
      revision: 1,
      sync,
      directories: [{
        directory: '/repo/activity',
        cursor: null,
        hasMore: false,
        lastSyncedAt: 1000,
        lastFullSyncedAt: 1000,
        lastAccessedAt: 1000,
        sessions: [newer, older],
      }],
    };
    const activitySnapshot = {
      ...initialSnapshot,
      revision: 2,
      directories: [{
        ...initialSnapshot.directories[0],
        sessions: [{
          ...older,
          metadata: {
            openchamber: {
              titleRefresh: { activityUpdatedAt: 30 },
            },
          },
        }, newer],
      }],
    };
    try {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { location: { origin: 'http://localhost', href: 'http://localhost/' } },
      });
      let requestCount = 0;
      globalThis.fetch = (input) => {
        requestCount += 1;
        const pathname = new URL(input instanceof Request ? input.url : String(input), 'http://localhost').pathname;
        if (pathname === '/api/openchamber/session-index' && requestCount === 1) {
          return Promise.resolve(new Response(JSON.stringify({ available: true, ...initialSnapshot }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }));
        }
        if (pathname === '/api/openchamber/session-index/sync') {
          return Promise.resolve(new Response(JSON.stringify(initialSnapshot), {
            status: 202,
            headers: { 'Content-Type': 'application/json' },
          }));
        }
        return Promise.resolve(new Response(JSON.stringify({ available: true, ...activitySnapshot }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      };

      const startup = useGlobalSessionsStore.getState().startSessionIndexStartup(['/repo/activity']);
      for (let i = 0; i < 50 && tipListeners.size === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
      emitOpenchamberTip({ type: 'session-index-changed', revision: 2, occurredAt: 1 });
      await startup;
      while (useGlobalSessionsStore.getState().activeSessions[0]?.id !== 'ses_older') {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      expect(useGlobalSessionsStore.getState().sessionsByDirectory.get('/repo/activity')?.map((session) => session.id))
        .toEqual(['ses_older', 'ses_newer']);
      expect(requestCount).toBeGreaterThanOrEqual(3);
    } finally {
      useGlobalSessionsStore.getState().resetForRuntimeSwitch();
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      globalThis.fetch = originalFetch;
    }
  });

  test('tip observer keeps last success across transient GET failure then applies later tips', async () => {
    // Extend the activity tip path: fail the first tip-driven snapshot GET, keep prior
    // sessions/cachedDirectories, then recover and process a subsequent tip.
    const originalWindow = globalThis.window;
    const originalFetch = globalThis.fetch;
    const { queryClient } = await import('@/lib/queryRuntime');
    queryClient.clear();
    queryClient.setDefaultOptions({ queries: { retry: false } });

    const dir = '/repo/activity';
    const older = buildSession('https://share.example/older', {
      id: 'ses_older',
      directory: dir,
      time: { created: 1, updated: 10 },
    });
    const newer = buildSession('https://share.example/newer', {
      id: 'ses_newer',
      directory: dir,
      time: { created: 2, updated: 20 },
    });
    const recovered = buildSession('https://share.example/recovered', {
      id: 'ses_recovered',
      directory: dir,
      time: { created: 3, updated: 40 },
    });
    const later = buildSession('https://share.example/later', {
      id: 'ses_later',
      directory: dir,
      time: { created: 4, updated: 50 },
    });
    const sync = {
      active: false,
      completed: 1,
      total: 1,
      pendingDirectories: [] as string[],
      completedDirectories: [dir],
      failedDirectories: [] as string[],
    };
    const initialSnapshot = {
      revision: 1,
      sync,
      directories: [{
        directory: dir,
        cursor: null,
        hasMore: false,
        lastSyncedAt: 1000,
        lastFullSyncedAt: 1000,
        lastAccessedAt: 1000,
        sessions: [newer, older],
      }],
    };
    const recoveredSnapshot = {
      ...initialSnapshot,
      revision: 2,
      directories: [{
        ...initialSnapshot.directories[0],
        sessions: [recovered, newer, older],
      }],
    };
    const laterSnapshot = {
      ...initialSnapshot,
      revision: 3,
      directories: [{
        ...initialSnapshot.directories[0],
        sessions: [later, recovered, newer, older],
      }],
    };

    try {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { location: { origin: 'http://localhost', href: 'http://localhost/' } },
      });
      let requestCount = 0;
      let failNextSessionIndexGet = false;
      let failSeen = false;
      let concurrentGets = 0;
      let maxConcurrentGets = 0;
      let phase: 'initial' | 'recovered' | 'later' = 'initial';
      globalThis.fetch = async (input) => {
        const pathname = new URL(input instanceof Request ? input.url : String(input), 'http://localhost').pathname;
        if (pathname === '/api/openchamber/session-index/sync') {
          return new Response(JSON.stringify(initialSnapshot), {
            status: 202,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (pathname === '/api/openchamber/session-index') {
          requestCount += 1;
          concurrentGets += 1;
          maxConcurrentGets = Math.max(maxConcurrentGets, concurrentGets);
          try {
            if (failNextSessionIndexGet) {
              failNextSessionIndexGet = false;
              failSeen = true;
              throw new Error('Failed to fetch');
            }
            if (phase === 'initial') {
              return new Response(JSON.stringify({ available: true, ...initialSnapshot }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              });
            }
            if (phase === 'recovered') {
              return new Response(JSON.stringify({ available: true, ...recoveredSnapshot }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              });
            }
            return new Response(JSON.stringify({ available: true, ...laterSnapshot }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          } finally {
            concurrentGets -= 1;
          }
        }
        return new Response(JSON.stringify({ available: true, ...initialSnapshot }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const startup = useGlobalSessionsStore.getState().startSessionIndexStartup([dir]);
      for (let i = 0; i < 50 && tipListeners.size === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      await startup;
      expect(useGlobalSessionsStore.getState().sessionsByDirectory.get(dir)?.map((s) => s.id))
        .toEqual(['ses_older', 'ses_newer']);

      const sessionsBeforeFailure = useGlobalSessionsStore.getState().sessionsByDirectory.get(dir);
      const cachedDirsBeforeFailure = [...useGlobalSessionsStore.getState().cachedDirectories];
      failNextSessionIndexGet = true;
      phase = 'recovered';
      emitOpenchamberTip({ type: 'session-index-changed', revision: 2, occurredAt: 1 });
      while (!failSeen) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(useGlobalSessionsStore.getState().sessionsByDirectory.get(dir)).toEqual(sessionsBeforeFailure);
      expect([...useGlobalSessionsStore.getState().cachedDirectories]).toEqual(cachedDirsBeforeFailure);

      while (useGlobalSessionsStore.getState().activeSessions[0]?.id !== 'ses_recovered') {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(useGlobalSessionsStore.getState().sessionsByDirectory.get(dir)?.map((s) => s.id))
        .toEqual(['ses_recovered', 'ses_older', 'ses_newer']);

      phase = 'later';
      emitOpenchamberTip({ type: 'session-index-changed', revision: 3, occurredAt: 2 });
      while (useGlobalSessionsStore.getState().activeSessions[0]?.id !== 'ses_later') {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(useGlobalSessionsStore.getState().sessionsByDirectory.get(dir)?.map((s) => s.id))
        .toEqual(['ses_later', 'ses_recovered', 'ses_older', 'ses_newer']);
      expect(maxConcurrentGets).toBe(1);
      expect(requestCount).toBeGreaterThanOrEqual(3);
      expect(failSeen).toBe(true);
    } finally {
      queryClient.setDefaultOptions({ queries: { retry: 1 } });
      queryClient.clear();
      useGlobalSessionsStore.getState().resetForRuntimeSwitch();
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      globalThis.fetch = originalFetch;
    }
  });

  test('tip observer stops retry after runtime switch abort', async () => {
    const originalWindow = globalThis.window;
    const originalFetch = globalThis.fetch;
    const { queryClient } = await import('@/lib/queryRuntime');
    queryClient.clear();
    queryClient.setDefaultOptions({ queries: { retry: false } });

    const dir = '/repo/activity';
    const cached = buildSession('https://share.example/tip-abort', {
      id: 'ses_abort',
      directory: dir,
      time: { created: 1, updated: 10 },
    });
    const stale = buildSession('https://share.example/tip-stale', {
      id: 'ses_stale',
      directory: dir,
      time: { created: 2, updated: 20 },
    });
    const initialSnapshot = {
      revision: 1,
      sync: {
        active: false,
        completed: 1,
        total: 1,
        pendingDirectories: [] as string[],
        completedDirectories: [dir],
        failedDirectories: [] as string[],
      },
      directories: [{
        directory: dir,
        cursor: null,
        hasMore: false,
        lastSyncedAt: 1000,
        lastFullSyncedAt: 1000,
        lastAccessedAt: 1000,
        sessions: [cached],
      }],
    };
    const staleSnapshot = {
      ...initialSnapshot,
      revision: 99,
      directories: [{
        ...initialSnapshot.directories[0],
        sessions: [stale],
      }],
    };
    const hungGet: { resolve: null | ((response: Response) => void) } = { resolve: null };

    try {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { location: { origin: 'http://localhost', href: 'http://localhost/' } },
      });
      let tipDrivenAttempts = 0;
      let armTips = false;
      globalThis.fetch = async (input) => {
        const pathname = new URL(input instanceof Request ? input.url : String(input), 'http://localhost').pathname;
        if (pathname === '/api/openchamber/session-index/sync') {
          return new Response(JSON.stringify(initialSnapshot), {
            status: 202,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (pathname === '/api/openchamber/session-index') {
          if (!armTips) {
            return new Response(JSON.stringify({ available: true, ...initialSnapshot }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          tipDrivenAttempts += 1;
          return await new Promise<Response>((resolve) => {
            hungGet.resolve = resolve;
          });
        }
        return new Response(JSON.stringify({ available: true, ...initialSnapshot }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const startup = useGlobalSessionsStore.getState().startSessionIndexStartup([dir]);
      for (let i = 0; i < 50 && tipListeners.size === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      await startup;

      armTips = true;
      emitOpenchamberTip({ type: 'session-index-changed', revision: 2, occurredAt: 1 });
      while (hungGet.resolve === null) await new Promise((resolve) => setTimeout(resolve, 10));

      const attemptsAtSwitch = tipDrivenAttempts;
      useGlobalSessionsStore.getState().resetForRuntimeSwitch();
      hungGet.resolve?.(new Response(JSON.stringify({ available: true, ...staleSnapshot }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
      for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));

      expect(useGlobalSessionsStore.getState().activeSessions).toEqual([]);
      expect(useGlobalSessionsStore.getState().sessionsByDirectory.size).toBe(0);
      expect(tipDrivenAttempts).toBe(attemptsAtSwitch);
    } finally {
      hungGet.resolve?.(new Response(JSON.stringify({ available: true, ...initialSnapshot }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
      queryClient.setDefaultOptions({ queries: { retry: 1 } });
      queryClient.clear();
      useGlobalSessionsStore.getState().resetForRuntimeSwitch();
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      globalThis.fetch = originalFetch;
    }
  });

  test('syncs selected directories through the Electron session index', async () => {
    const originalWindow = globalThis.window;
    const originalFetch = globalThis.fetch;
    const originalGetSdkClient = opencodeClient.getSdkClient;
    let sdkListCalls = 0;
    const requests: string[] = [];
    const synced = buildSession('https://share.example/manual-sync', { directory: '/repo/manual-sync' });
    const snapshot = {
      revision: 1,
      sync: {
        active: false,
        completed: 1,
        total: 1,
        pendingDirectories: [],
        completedDirectories: ['/repo/manual-sync'],
        failedDirectories: [],
      },
      directories: [{
        directory: '/repo/manual-sync',
        cursor: 2,
        hasMore: false,
        lastSyncedAt: 1000,
        lastFullSyncedAt: 1000,
        lastAccessedAt: 1000,
        sessions: [synced],
      }],
    };
    try {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { location: { origin: 'http://localhost', href: 'http://localhost/' } },
      });
      globalThis.fetch = async (input) => {
        const url = input instanceof Request ? input.url : String(input);
        requests.push(new URL(url, 'http://localhost').pathname);
        return new Response(JSON.stringify(snapshot), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        });
      };
      opencodeClient.getSdkClient = () => ({
        experimental: { session: { list: async () => {
          sdkListCalls += 1;
          return { data: [], error: undefined, response: new Response(null, { status: 200 }) };
        } } },
      } as unknown as OpencodeClient);

      await useGlobalSessionsStore.getState().syncSessionsForDirectories(['/repo/manual-sync']);

      expect(sdkListCalls).toBe(0);
      expect(requests).toEqual(['/api/openchamber/session-index/sync']);
      expect(useGlobalSessionsStore.getState().sessionsByDirectory.get('/repo/manual-sync')).toEqual([synced]);
    } finally {
      opencodeClient.getSdkClient = originalGetSdkClient;
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      globalThis.fetch = originalFetch;
    }
  });

  test('replaces an empty directory snapshot with recovered historical sessions', async () => {
    const originalWindow = globalThis.window;
    const originalFetch = globalThis.fetch;
    const historyA = buildSession('https://share.example/history-a', {
      id: 'ses_history_a',
      directory: '/repo/empty-lock',
      title: '招商业务独立页面服务方案',
      time: { created: 1, updated: 20 },
    });
    const historyB = buildSession('https://share.example/history-b', {
      id: 'ses_history_b',
      directory: '/repo/empty-lock',
      title: 'Hermes 招商活动代码分析机器人方案设计',
      time: { created: 1, updated: 10 },
    });
    const other = buildSession('https://share.example/other', {
      id: 'ses_other',
      directory: '/repo/other',
    });
    useGlobalSessionsStore.setState({
      activeSessions: [other],
      sessionsByDirectory: new Map([
        ['/repo/empty-lock', []],
        ['/repo/other', [other]],
      ]),
      loadedDirectories: new Set(['/repo/empty-lock', '/repo/other']),
      cachedDirectories: new Set(['/repo/empty-lock', '/repo/other']),
      sessionIndexSyncByDirectory: new Map([
        ['/repo/empty-lock', { lastSyncedAt: 5000, lastFullSyncedAt: 5000 }],
        ['/repo/other', { lastSyncedAt: 1000, lastFullSyncedAt: 1000 }],
      ]),
      activePaginationByDirectory: new Map([
        ['/repo/empty-lock', { cursor: null, hasMore: false, loadingMore: false }],
        ['/repo/other', { cursor: 2, hasMore: false, loadingMore: false }],
      ]),
      hasLoaded: true,
      status: 'ready',
    });
    const pending = {
      revision: 1,
      sync: {
        active: true,
        completed: 0,
        total: 1,
        pendingDirectories: ['/repo/empty-lock'],
        completedDirectories: [] as string[],
        failedDirectories: [] as string[],
      },
      directories: [{
        directory: '/repo/empty-lock',
        cursor: null,
        hasMore: false,
        lastSyncedAt: 5000,
        lastFullSyncedAt: 5000,
        lastAccessedAt: 5000,
        sessions: [] as Session[],
      }, {
        directory: '/repo/other',
        cursor: 2,
        hasMore: false,
        lastSyncedAt: 1000,
        lastFullSyncedAt: 1000,
        lastAccessedAt: 1000,
        sessions: [other],
      }],
    };
    const recovered = {
      revision: 2,
      sync: {
        active: false,
        completed: 1,
        total: 1,
        pendingDirectories: [] as string[],
        completedDirectories: ['/repo/empty-lock'],
        failedDirectories: [] as string[],
      },
      directories: [{
        directory: '/repo/empty-lock',
        cursor: null,
        hasMore: false,
        lastSyncedAt: 6000,
        lastFullSyncedAt: 6000,
        lastAccessedAt: 6000,
        sessions: [historyA, historyB],
      }, {
        directory: '/repo/other',
        cursor: 2,
        hasMore: false,
        lastSyncedAt: 1000,
        lastFullSyncedAt: 1000,
        lastAccessedAt: 1000,
        sessions: [other],
      }],
    };
    try {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { location: { origin: 'http://localhost', href: 'http://localhost/' } },
      });
      globalThis.fetch = async (input) => {
        const pathname = new URL(input instanceof Request ? input.url : String(input), 'http://localhost').pathname;
        if (pathname === '/api/openchamber/session-index/sync') {
          return new Response(JSON.stringify(pending), {
            status: 202,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ available: true, ...recovered }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const sync = useGlobalSessionsStore.getState().syncSessionsForDirectories(['/repo/empty-lock']);
      while (tipListeners.size === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      emitOpenchamberTip({ type: 'session-index-changed', revision: 2, occurredAt: 1 });
      await sync;

      expect(useGlobalSessionsStore.getState().sessionsByDirectory.get('/repo/empty-lock')?.map((session) => session.id))
        .toEqual(['ses_history_a', 'ses_history_b']);
      expect(useGlobalSessionsStore.getState().sessionsByDirectory.get('/repo/other')).toEqual([other]);
      expect(useGlobalSessionsStore.getState().activePaginationByDirectory.get('/repo/other')).toEqual({
        cursor: 2,
        hasMore: false,
        loadingMore: false,
      });
    } finally {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      globalThis.fetch = originalFetch;
    }
  });

  test('recovers manual session-index sync when the completion tip is missed', async () => {
    const originalWindow = globalThis.window;
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    const pending = {
      revision: 1,
      sync: {
        active: true,
        completed: 0,
        total: 1,
        pendingDirectories: ['/repo/missed-tip'],
        completedDirectories: [],
        failedDirectories: [],
      },
      directories: [],
    };
    const completedSession = buildSession('https://share.example/missed-tip', { directory: '/repo/missed-tip' });
    const completed = {
      revision: 2,
      sync: {
        active: false,
        completed: 1,
        total: 1,
        pendingDirectories: [],
        completedDirectories: ['/repo/missed-tip'],
        failedDirectories: [],
      },
      directories: [{
        directory: '/repo/missed-tip',
        cursor: null,
        hasMore: false,
        lastSyncedAt: 2000,
        lastFullSyncedAt: 2000,
        lastAccessedAt: 2000,
        sessions: [completedSession],
      }],
    };
    try {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { location: { origin: 'http://localhost', href: 'http://localhost/' } },
      });
      globalThis.fetch = async (input) => {
        const pathname = new URL(input instanceof Request ? input.url : String(input), 'http://localhost').pathname;
        requests.push(pathname);
        if (pathname === '/api/openchamber/session-index/sync') {
          return new Response(JSON.stringify(pending), {
            status: 202,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        // No tip is emitted: safety timeout must re-GET and observe completion.
        return new Response(JSON.stringify({ available: true, ...completed }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      await useGlobalSessionsStore.getState().syncSessionsForDirectories(['/repo/missed-tip']);

      expect(requests[0]).toBe('/api/openchamber/session-index/sync');
      expect(requests).toContain('/api/openchamber/session-index');
      expect(useGlobalSessionsStore.getState().sessionsByDirectory.get('/repo/missed-tip')).toEqual([completedSession]);
    } finally {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      globalThis.fetch = originalFetch;
    }
  });

  test('clears residual session-index loading when a later batch drops a directory from pending', async () => {
    const originalWindow = globalThis.window;
    const originalFetch = globalThis.fetch;
    const p0Pending = {
      revision: 1,
      sync: {
        active: true,
        completed: 0,
        total: 1,
        pendingDirectories: ['/repo/a'],
        completedDirectories: [] as string[],
        failedDirectories: [] as string[],
      },
      directories: [] as Array<{ directory: string; sessions: Session[] }>,
    };
    // New server batch: only /repo/b is pending; completed lists are cleared per job,
    // so /repo/a must be released by observer residual cleanup, not completed/failed.
    const p1Batch = {
      revision: 2,
      sync: {
        active: true,
        completed: 0,
        total: 1,
        pendingDirectories: ['/repo/b'],
        completedDirectories: [] as string[],
        failedDirectories: [] as string[],
      },
      directories: [] as Array<{ directory: string; sessions: Session[] }>,
    };
    try {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { location: { origin: 'http://localhost', href: 'http://localhost/' } },
      });
      globalThis.fetch = async (input) => {
        const pathname = new URL(input instanceof Request ? input.url : String(input), 'http://localhost').pathname;
        if (pathname === '/api/openchamber/session-index/sync') {
          return new Response(JSON.stringify(p0Pending), {
            status: 202,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ available: true, ...p1Batch }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const sync = useGlobalSessionsStore.getState().syncSessionsForDirectories(['/repo/a', '/repo/b']);
      while (tipListeners.size === 0) await new Promise((resolve) => setTimeout(resolve, 0));

      expect(useGlobalSessionsStore.getState().loadingDirectories.has('/repo/a')).toBe(true);
      expect(useGlobalSessionsStore.getState().loadingDirectories.has('/repo/b')).toBe(false);

      emitOpenchamberTip({ type: 'session-index-changed', revision: 2, occurredAt: 1 });
      while (
        useGlobalSessionsStore.getState().loadingDirectories.has('/repo/a')
        || !useGlobalSessionsStore.getState().loadingDirectories.has('/repo/b')
      ) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      expect(useGlobalSessionsStore.getState().loadingDirectories.has('/repo/a')).toBe(false);
      expect(useGlobalSessionsStore.getState().refreshingDirectories.has('/repo/a')).toBe(false);
      expect(useGlobalSessionsStore.getState().loadingDirectories.has('/repo/b')).toBe(true);
      expect(useGlobalSessionsStore.getState().refreshingDirectories.has('/repo/b')).toBe(false);

      // End the observer so the suite does not leak tip listeners / inflight work.
      useGlobalSessionsStore.getState().resetForRuntimeSwitch();
      await sync;
    } finally {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      globalThis.fetch = originalFetch;
    }
  });

  test('clears session-index loading when its revalidation fails', async () => {
    const originalWindow = globalThis.window;
    const originalFetch = globalThis.fetch;
    const pending = {
      revision: 1,
      sync: {
        active: true,
        completed: 0,
        total: 1,
        pendingDirectories: ['/repo/revalidation-failure'],
        completedDirectories: [],
        failedDirectories: [],
      },
      directories: [],
    };
    try {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { location: { origin: 'http://localhost', href: 'http://localhost/' } },
      });
      globalThis.fetch = async (input) => {
        const pathname = new URL(input instanceof Request ? input.url : String(input), 'http://localhost').pathname;
        if (pathname === '/api/openchamber/session-index/sync') {
          return new Response(JSON.stringify(pending), {
            status: 202,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        throw new Error('session index revalidation failed');
      };

      const sync = useGlobalSessionsStore.getState().syncSessionsForDirectories(['/repo/revalidation-failure']);
      while (tipListeners.size === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      emitOpenchamberTip({ type: 'session-index-changed', revision: 2, occurredAt: 1 });
      await sync;

      expect(useGlobalSessionsStore.getState().loadingDirectories.has('/repo/revalidation-failure')).toBe(false);
      expect(useGlobalSessionsStore.getState().refreshingDirectories.has('/repo/revalidation-failure')).toBe(false);
    } finally {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      globalThis.fetch = originalFetch;
    }
  });

  test('keeps an overlapping SDK refresh loading after session-index revalidation fails', async () => {
    const originalWindow = globalThis.window;
    const originalFetch = globalThis.fetch;
    const originalGetSdkClient = opencodeClient.getSdkClient;
    let resolveList: (value: { data: Session[]; error: undefined; response: Response }) => void = () => undefined;
    const list = () => new Promise<{ data: Session[]; error: undefined; response: Response }>((resolve) => {
      resolveList = resolve;
    });
    const pending = {
      revision: 1,
      sync: {
        active: true,
        completed: 0,
        total: 1,
        pendingDirectories: ['/repo/overlap'],
        completedDirectories: [],
        failedDirectories: [],
      },
      directories: [],
    };
    try {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { location: { origin: 'http://localhost', href: 'http://localhost/' } },
      });
      globalThis.fetch = async (input) => {
        const pathname = new URL(input instanceof Request ? input.url : String(input), 'http://localhost').pathname;
        if (pathname === '/api/openchamber/session-index/sync') {
          return new Response(JSON.stringify(pending), {
            status: 202,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (pathname === '/api/openchamber/session-index/directory') {
          return new Response(null, { status: 204 });
        }
        throw new Error('session index revalidation failed');
      };
      opencodeClient.getSdkClient = () => ({
        experimental: { session: { list } },
      } as unknown as OpencodeClient);

      const sync = useGlobalSessionsStore.getState().syncSessionsForDirectories(['/repo/overlap']);
      while (tipListeners.size === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      const refresh = useGlobalSessionsStore.getState().refreshSessionsForDirectories(['/repo/overlap']);
      await new Promise((resolve) => setTimeout(resolve, 0));
      emitOpenchamberTip({ type: 'session-index-changed', revision: 2, occurredAt: 1 });
      await sync;

      expect(useGlobalSessionsStore.getState().loadingDirectories.has('/repo/overlap')).toBe(true);
      expect(useGlobalSessionsStore.getState().refreshingDirectories.has('/repo/overlap')).toBe(true);

      resolveList({ data: [], error: undefined, response: new Response(null, { status: 200 }) });
      await refresh;

      expect(useGlobalSessionsStore.getState().loadingDirectories.has('/repo/overlap')).toBe(false);
      expect(useGlobalSessionsStore.getState().refreshingDirectories.has('/repo/overlap')).toBe(false);
    } finally {
      opencodeClient.getSdkClient = originalGetSdkClient;
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      globalThis.fetch = originalFetch;
    }
  });

  test('drops a session-index snapshot that resolves after a runtime switch', async () => {
    const originalWindow = globalThis.window;
    const originalFetch = globalThis.fetch;
    const stale = buildSession('https://share.example/stale-index', { directory: '/repo/stale-index' });
    let resolveSync: (response: Response) => void = () => undefined;
    const snapshot = {
      revision: 7,
      sync: {
        active: false,
        completed: 1,
        total: 1,
        pendingDirectories: [],
        completedDirectories: ['/repo/stale-index'],
        failedDirectories: [],
      },
      directories: [{
        directory: '/repo/stale-index',
        cursor: null,
        hasMore: false,
        lastSyncedAt: 1000,
        lastFullSyncedAt: 1000,
        lastAccessedAt: 1000,
        sessions: [stale],
      }],
    };
    try {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { location: { origin: 'http://localhost', href: 'http://localhost/' } },
      });
      globalThis.fetch = () => new Promise<Response>((resolve) => { resolveSync = resolve; });

      const sync = useGlobalSessionsStore.getState().syncSessionsForDirectories(['/repo/stale-index']);
      await new Promise((resolve) => setTimeout(resolve, 0));
      useGlobalSessionsStore.getState().resetForRuntimeSwitch();
      resolveSync(new Response(JSON.stringify(snapshot), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }));
      await sync;

      expect(useGlobalSessionsStore.getState().activeSessions).toEqual([]);
      expect(useGlobalSessionsStore.getState().sessionIndexSyncByDirectory).toEqual(new Map());
    } finally {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      globalThis.fetch = originalFetch;
    }
  });

  test('keeps first-run cache provenance stable while the server writes its first directory', async () => {
    const originalWindow = globalThis.window;
    const originalFetch = globalThis.fetch;
    const firstSession = buildSession('https://share.example/first-run', { directory: '/repo/a' });
    let finished = false;
    const emptySnapshot = {
      revision: 0,
      sync: {
        active: false,
        completed: 0,
        total: 0,
        pendingDirectories: [],
        completedDirectories: [],
        failedDirectories: [],
      },
      directories: [],
    };
    const initialSync = {
      ...emptySnapshot,
      revision: 1,
      sync: {
        ...emptySnapshot.sync,
        active: true,
        total: 2,
        pendingDirectories: ['/repo/a', '/repo/b'],
      },
    };
    const partialSync = {
      revision: 2,
      sync: {
        active: true,
        completed: 1,
        total: 2,
        pendingDirectories: ['/repo/b'],
        completedDirectories: ['/repo/a'],
        failedDirectories: [],
      },
      directories: [{
        directory: '/repo/a',
        cursor: 2,
        hasMore: false,
        lastSyncedAt: 1000,
        lastFullSyncedAt: 1000,
        lastAccessedAt: 1000,
        sessions: [firstSession],
      }],
    };
    const completedSync = {
      ...partialSync,
      revision: 3,
      sync: {
        ...partialSync.sync,
        active: false,
        completed: 2,
        pendingDirectories: [],
        completedDirectories: ['/repo/a', '/repo/b'],
      },
    };

    try {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { location: { origin: 'http://localhost', href: 'http://localhost/' } },
      });
      let snapshotLoads = 0;
      globalThis.fetch = async (input) => {
        const pathname = new URL(input instanceof Request ? input.url : String(input), 'http://localhost').pathname;
        if (pathname === '/api/openchamber/session-index/sync') {
          return new Response(JSON.stringify(initialSync), {
            status: 202,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        snapshotLoads += 1;
        if (snapshotLoads === 1) {
          return new Response(JSON.stringify({ available: true, ...emptySnapshot }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (snapshotLoads === 2) {
          return new Response(JSON.stringify({ available: true, ...partialSync }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ available: true, ...completedSync }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const startup = useGlobalSessionsStore.getState().startSessionIndexStartup(['/repo/a', '/repo/b'])
        .then(() => { finished = true; });
      while (tipListeners.size === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      emitOpenchamberTip({ type: 'session-index-changed', revision: 2, occurredAt: 1 });
      while (!useGlobalSessionsStore.getState().sessionsByDirectory.get('/repo/a')) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      expect(useGlobalSessionsStore.getState().hasCachedSessionIndex).toBe(false);
      expect(useGlobalSessionsStore.getState().sessionsByDirectory.get('/repo/a')).toEqual([firstSession]);
      expect(finished).toBe(false);

      emitOpenchamberTip({ type: 'session-index-changed', revision: 3, occurredAt: 2 });
      await startup;
      expect(finished).toBe(true);
    } finally {
      useGlobalSessionsStore.getState().resetForRuntimeSwitch();
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      globalThis.fetch = originalFetch;
    }
  });

  test('coalesces overlapping active refreshes by directory and keeps a cached snapshot visible', async () => {
    type ListResult = { data?: Session[]; error?: { message: string }; response: Response };
    let resolveList: (value: ListResult) => void = () => undefined;
    const calls: Array<Record<string, unknown>> = [];
    const list = (input: Record<string, unknown>) => new Promise<ListResult>((resolve) => {
      calls.push(input);
      resolveList = resolve;
    });
    const sdk = { experimental: { session: { list } } } as unknown as OpencodeClient;
    const originalGetSdkClient = opencodeClient.getSdkClient;
    opencodeClient.getSdkClient = () => sdk;
    restoreGetSdkClient = () => { opencodeClient.getSdkClient = originalGetSdkClient; };

    const cached = buildSession('https://share.example/a', { directory: '/repo/app' });
    useGlobalSessionsStore.setState({
      activeSessions: [cached],
      sessionsByDirectory: new Map([['/repo/app', [cached]]]),
      loadedDirectories: new Set(['/repo/app']),
      hasLoaded: true,
      status: 'ready',
    });

    const first = useGlobalSessionsStore.getState().refreshSessionsForDirectories(['/repo/app']);
    const second = useGlobalSessionsStore.getState().refreshSessionsForDirectories(['/repo/app']);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual({ directory: '/repo/app', archived: false, roots: true, limit: 20 });
    expect(useGlobalSessionsStore.getState().activeSessions[0]?.id).toBe('ses_1');
    expect(useGlobalSessionsStore.getState().loadingDirectories.has('/repo/app')).toBe(false);
    expect(useGlobalSessionsStore.getState().refreshingDirectories.has('/repo/app')).toBe(true);

    resolveList({
      data: [{ ...cached, title: 'Fresh session', time: { created: 1, updated: 3 } }],
      error: undefined,
      response: new Response(null, { status: 200 }),
    });
    await Promise.all([first, second]);

    expect(calls.length).toBe(1);
    expect(useGlobalSessionsStore.getState().activeSessions[0]?.title).toBe('Fresh session');
    expect(useGlobalSessionsStore.getState().refreshingDirectories.has('/repo/app')).toBe(false);
  });

  test('preserves the complete cleanup catalog through a bounded directory refresh', async () => {
    const complete = Array.from({ length: 25 }, (_, index) => buildSession(`https://share.example/${index}`, {
      id: `ses_${index + 1}`,
      directory: '/repo/app',
      time: { created: index, updated: index },
    }));
    const list = async (input: Record<string, unknown>) => {
      if (input.directory) {
        return { data: complete.slice(0, 20), error: undefined, response: new Response(null, { status: 200 }) };
      }
      return { data: input.archived ? [] : complete, error: undefined, response: new Response(null, { status: 200 }) };
    };
    const sdk = { experimental: { session: { list } } } as unknown as OpencodeClient;
    const originalGetSdkClient = opencodeClient.getSdkClient;
    opencodeClient.getSdkClient = () => sdk;
    restoreGetSdkClient = () => { opencodeClient.getSdkClient = originalGetSdkClient; };

    await useGlobalSessionsStore.getState().loadSessions();
    const completeIds = useGlobalSessionsStore.getState().fullCatalogSessionIds;
    const generation = useGlobalSessionsStore.getState().fullCatalogGeneration;
    await useGlobalSessionsStore.getState().refreshSessionsForDirectories(['/repo/app']);

    expect(useGlobalSessionsStore.getState().activeSessions).toHaveLength(20);
    expect(useGlobalSessionsStore.getState().fullCatalogSessionIds).toBe(completeIds);
    expect(useGlobalSessionsStore.getState().fullCatalogGeneration).toBe(generation);

    useSessionFoldersStore.setState({
      foldersMap: { '/repo/app': [{ id: 'folder', name: 'Folder', sessionIds: ['ses_25'], createdAt: 1 }] },
      sessionOrderByScope: { '/repo/app': ['ses_25'] },
    });
    useSessionFoldersStore.getState().cleanupSessions('/repo/app', completeIds);
    expect(useSessionFoldersStore.getState().foldersMap['/repo/app']?.[0]?.sessionIds).toEqual(['ses_25']);
    expect(useSessionFoldersStore.getState().sessionOrderByScope['/repo/app']).toEqual(['ses_25']);
  });

  test('keeps the current global load flight after a stale runtime load settles', async () => {
    type ListResult = { data: Session[]; error: undefined; response: Response };
    const resolvers: Array<(value: ListResult) => void> = [];
    const list = () => new Promise<ListResult>((resolve) => { resolvers.push(resolve); });
    const sdk = { experimental: { session: { list } } } as unknown as OpencodeClient;
    const originalGetSdkClient = opencodeClient.getSdkClient;
    opencodeClient.getSdkClient = () => sdk;
    restoreGetSdkClient = () => { opencodeClient.getSdkClient = originalGetSdkClient; };

    const staleLoad = useGlobalSessionsStore.getState().loadSessions();
    while (resolvers.length < 2) await new Promise((resolve) => setTimeout(resolve, 0));

    useGlobalSessionsStore.getState().resetForRuntimeSwitch();
    const currentLoad = useGlobalSessionsStore.getState().loadSessions();
    while (resolvers.length < 4) await new Promise((resolve) => setTimeout(resolve, 0));

    resolvers.splice(0, 2).forEach((resolve) => resolve({
      data: [],
      error: undefined,
      response: new Response(null, { status: 200 }),
    }));
    await staleLoad;

    const dedupedCurrentLoad = useGlobalSessionsStore.getState().loadSessions();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolvers).toHaveLength(2);

    resolvers.splice(0).forEach((resolve) => resolve({
      data: [],
      error: undefined,
      response: new Response(null, { status: 200 }),
    }));
    await Promise.all([currentLoad, dedupedCurrentLoad]);
  });

  test('merges an incremental start-window response without erasing cached sessions', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const list = async (input: Record<string, unknown>) => {
      calls.push(input);
      return { data: [], error: undefined, response: new Response(null, { status: 200 }) };
    };
    const sdk = { experimental: { session: { list } } } as unknown as OpencodeClient;
    const originalGetSdkClient = opencodeClient.getSdkClient;
    opencodeClient.getSdkClient = () => sdk;
    restoreGetSdkClient = () => { opencodeClient.getSdkClient = originalGetSdkClient; };
    const cached = buildSession('https://share.example/cached', { directory: '/repo/incremental' });
    useGlobalSessionsStore.setState({
      activeSessions: [cached],
      sessionsByDirectory: new Map([['/repo/incremental', [cached]]]),
    });

    await useGlobalSessionsStore.getState().refreshSessionsForDirectories(
      ['/repo/incremental'],
      undefined,
      { persist: false, incrementalStart: 1234 },
    );

    expect(calls[0]).toEqual({
      directory: '/repo/incremental',
      archived: false,
      roots: true,
      start: 1234,
      limit: 20,
    });
    expect(useGlobalSessionsStore.getState().sessionsByDirectory.get('/repo/incremental')).toEqual([cached]);
  });

  test('does not advance startup progress for a cached directory whose incremental refresh failed', async () => {
    const list = async () => ({
      data: undefined,
      error: { message: 'bad request' },
      response: new Response(null, { status: 400 }),
    });
    const sdk = { experimental: { session: { list } } } as unknown as OpencodeClient;
    const originalGetSdkClient = opencodeClient.getSdkClient;
    opencodeClient.getSdkClient = () => sdk;
    restoreGetSdkClient = () => { opencodeClient.getSdkClient = originalGetSdkClient; };
    const cached = buildSession('https://share.example/cached-failure', { directory: '/repo/cached-failure' });
    useGlobalSessionsStore.setState({
      activeSessions: [cached],
      sessionsByDirectory: new Map([['/repo/cached-failure', [cached]]]),
      loadedDirectories: new Set(['/repo/cached-failure']),
      hasLoaded: true,
      status: 'ready',
    });

    await refreshStartupGlobalSessionsForDirectories(
      ['/repo/cached-failure'],
      [cached],
      { incrementalStartByDirectory: new Map([['/repo/cached-failure', 1234]]) },
    );

    expect(useGlobalSessionsStore.getState().startupSyncProgress.completed).toBe(0);
    expect(useGlobalSessionsStore.getState().sessionsByDirectory.get('/repo/cached-failure')).toEqual([cached]);
  });

  test('loadSessions classifies OpenCode archived=true pages by time.archived', async () => {
    const live = buildSession('https://share.example/live', {
      id: 'ses_live',
      directory: '/repo/app',
      time: { created: 1, updated: 8 },
    });
    const mislabeled = buildSession('https://share.example/mislabeled', {
      id: 'ses_mislabeled',
      directory: '/repo/app',
      time: { created: 1, updated: 7 },
    });
    const trulyArchived = buildSession('https://share.example/archived', {
      id: 'ses_archived',
      directory: '/repo/app',
      time: { created: 1, updated: 6, archived: 5 },
    });
    const list = async (input: Record<string, unknown>) => ({
      data: input.archived ? [mislabeled, trulyArchived] : [live],
      error: undefined,
      response: new Response(null, { status: 200 }),
    });
    const sdk = { experimental: { session: { list } } } as unknown as OpencodeClient;
    const originalGetSdkClient = opencodeClient.getSdkClient;
    opencodeClient.getSdkClient = () => sdk;
    restoreGetSdkClient = () => { opencodeClient.getSdkClient = originalGetSdkClient; };

    const result = await useGlobalSessionsStore.getState().loadSessions();

    expect(result.activeSessions.map((session) => session.id)).toEqual(['ses_live', 'ses_mislabeled']);
    expect(result.archivedSessions.map((session) => session.id)).toEqual(['ses_archived']);
    expect(useGlobalSessionsStore.getState().activeSessions.map((session) => session.id)).toEqual(['ses_live', 'ses_mislabeled']);
    expect(useGlobalSessionsStore.getState().archivedSessions.map((session) => session.id)).toEqual(['ses_archived']);
  });

  test('loads archived sessions through the independent lazy path', async () => {
    const archived = buildSession('https://share.example/a', {
      directory: '/repo/app',
      time: { created: 1, updated: 2, archived: 3 },
    });
    const calls: Array<Record<string, unknown>> = [];
    const list = async (input: Record<string, unknown>) => {
      calls.push(input);
      return {
      data: [archived],
      error: undefined,
      response: new Response(null, { status: 200 }),
      };
    };
    const sdk = { experimental: { session: { list } } } as unknown as OpencodeClient;
    const originalGetSdkClient = opencodeClient.getSdkClient;
    opencodeClient.getSdkClient = () => sdk;
    restoreGetSdkClient = () => { opencodeClient.getSdkClient = originalGetSdkClient; };

    await useGlobalSessionsStore.getState().refreshArchivedSessionsForDirectories(['/repo/app']);

    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual({ directory: '/repo/app', archived: true, roots: true, limit: 20 });
    expect(useGlobalSessionsStore.getState().archivedSessions[0]?.id).toBe('ses_1');
    expect(useGlobalSessionsStore.getState().archivedLoadedDirectories.has('/repo/app')).toBe(true);
    expect(useGlobalSessionsStore.getState().archivedLoadingDirectories.has('/repo/app')).toBe(false);
  });

  test('refreshArchivedSessionsForDirectories moves unlabeled sessions into active', async () => {
    const mislabeled = buildSession('https://share.example/mislabeled', {
      id: 'ses_mislabeled',
      directory: '/repo/app',
      time: { created: 1, updated: 4 },
    });
    const trulyArchived = buildSession('https://share.example/archived', {
      id: 'ses_archived',
      directory: '/repo/app',
      time: { created: 1, updated: 3, archived: 2 },
    });
    const list = async () => ({
      data: [mislabeled, trulyArchived],
      error: undefined,
      response: new Response(null, { status: 200 }),
    });
    const sdk = { experimental: { session: { list } } } as unknown as OpencodeClient;
    const originalGetSdkClient = opencodeClient.getSdkClient;
    opencodeClient.getSdkClient = () => sdk;
    restoreGetSdkClient = () => { opencodeClient.getSdkClient = originalGetSdkClient; };

    await useGlobalSessionsStore.getState().refreshArchivedSessionsForDirectories(['/repo/app']);

    expect(useGlobalSessionsStore.getState().activeSessions.map((session) => session.id)).toEqual(['ses_mislabeled']);
    expect(useGlobalSessionsStore.getState().archivedSessions.map((session) => session.id)).toEqual(['ses_archived']);
    expect(useGlobalSessionsStore.getState().sessionsByDirectory.get('/repo/app')?.map((session) => session.id)).toEqual(['ses_mislabeled']);
  });

  test('preserves cached active sessions and clears refresh state after a fetch failure', async () => {
    const cached = buildSession('https://share.example/a', { directory: '/repo/app' });
    const list = async () => ({
      data: undefined,
      error: { message: 'bad request' },
      response: new Response(null, { status: 400 }),
    });
    const sdk = { experimental: { session: { list } } } as unknown as OpencodeClient;
    const originalGetSdkClient = opencodeClient.getSdkClient;
    opencodeClient.getSdkClient = () => sdk;
    restoreGetSdkClient = () => { opencodeClient.getSdkClient = originalGetSdkClient; };
    useGlobalSessionsStore.setState({
      activeSessions: [cached],
      sessionsByDirectory: new Map([['/repo/app', [cached]]]),
      loadedDirectories: new Set(['/repo/app']),
      hasLoaded: true,
      status: 'ready',
    });

    await useGlobalSessionsStore.getState().refreshSessionsForDirectories(['/repo/app']);

    expect(useGlobalSessionsStore.getState().activeSessions).toEqual([cached]);
    expect(useGlobalSessionsStore.getState().loadingDirectories.has('/repo/app')).toBe(false);
    expect(useGlobalSessionsStore.getState().refreshingDirectories.has('/repo/app')).toBe(false);
  });

  test('loads the next 20 root sessions from the stored cursor and appends them', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const makePage = (start: number) => Array.from({ length: 20 }, (_, index) => ({
      id: `ses_${start + index}`,
      title: `Session ${start + index}`,
      directory: '/repo/app',
      time: { created: 100 - start - index, updated: 100 - start - index },
    } as Session));
    const list = async (input: Record<string, unknown>) => {
      calls.push(input);
      return {
        data: input.cursor === undefined ? makePage(0) : makePage(20),
        error: undefined,
        response: new Response(null, { status: 200 }),
      };
    };
    const sdk = { experimental: { session: { list } } } as unknown as OpencodeClient;
    const originalGetSdkClient = opencodeClient.getSdkClient;
    opencodeClient.getSdkClient = () => sdk;
    restoreGetSdkClient = () => { opencodeClient.getSdkClient = originalGetSdkClient; };

    await useGlobalSessionsStore.getState().refreshSessionsForDirectories(['/repo/app']);
    await useGlobalSessionsStore.getState().loadMoreSessionsForDirectory('/repo/app');

    expect(calls.length).toBe(2);
    expect(calls[1]).toEqual({
      directory: '/repo/app',
      archived: false,
      roots: true,
      cursor: 81,
      limit: 20,
    });
    expect(useGlobalSessionsStore.getState().sessionsByDirectory.get('/repo/app')?.length).toBe(40);
    expect(useGlobalSessionsStore.getState().activePaginationByDirectory.get('/repo/app')).toEqual({
      cursor: 61,
      hasMore: true,
      loadingMore: false,
    });
  });

  test('authoritative tip snapshot keeps loadMore tail and deeper pagination cursor', async () => {
    const originalWindow = globalThis.window;
    const originalFetch = globalThis.fetch;
    const makePage = (start: number) => Array.from({ length: 20 }, (_, index) => ({
      id: `ses_${start + index}`,
      title: `Session ${start + index}`,
      directory: '/repo/app',
      time: { created: 100 - start - index, updated: 100 - start - index },
    } as Session));
    const list = async (input: Record<string, unknown>) => ({
      data: input.cursor === undefined ? makePage(0) : makePage(20),
      error: undefined,
      response: new Response(null, { status: 200 }),
    });
    const sdk = { experimental: { session: { list } } } as unknown as OpencodeClient;
    const originalGetSdkClient = opencodeClient.getSdkClient;
    opencodeClient.getSdkClient = () => sdk;
    restoreGetSdkClient = () => { opencodeClient.getSdkClient = originalGetSdkClient; };

    await useGlobalSessionsStore.getState().refreshSessionsForDirectories(['/repo/app']);
    await useGlobalSessionsStore.getState().loadMoreSessionsForDirectory('/repo/app');
    expect(useGlobalSessionsStore.getState().sessionsByDirectory.get('/repo/app')?.length).toBe(40);
    const deeperPagination = useGlobalSessionsStore.getState().activePaginationByDirectory.get('/repo/app');
    expect(deeperPagination).toEqual({ cursor: 61, hasMore: true, loadingMore: false });

    const headWindow = [
      {
        id: 'ses_new',
        title: 'New session',
        directory: '/repo/app',
        time: { created: 101, updated: 101 },
      } as Session,
      ...makePage(0).slice(0, 19),
    ];
    const tipSnapshot = {
      revision: 9,
      sync: {
        active: false,
        completed: 1,
        total: 1,
        pendingDirectories: [],
        completedDirectories: ['/repo/app'],
        failedDirectories: [],
      },
      directories: [{
        directory: '/repo/app',
        cursor: 81,
        hasMore: true,
        lastSyncedAt: 2000,
        lastFullSyncedAt: 2000,
        lastAccessedAt: 2000,
        sessions: headWindow,
      }],
    };

    try {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { location: { origin: 'http://localhost', href: 'http://localhost/' } },
      });
      globalThis.fetch = async () => new Response(JSON.stringify(tipSnapshot), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      });

      await useGlobalSessionsStore.getState().syncSessionsForDirectories(['/repo/app']);

      const ids = useGlobalSessionsStore.getState().sessionsByDirectory.get('/repo/app')?.map((session) => session.id) ?? [];
      expect(ids[0]).toBe('ses_new');
      // New head item pushes former ses_19 past the head window; keep it with the loadMore tail.
      expect(ids).toContain('ses_19');
      expect(ids).toContain('ses_20');
      expect(ids).toContain('ses_39');
      expect(ids.length).toBe(41);
      expect(useGlobalSessionsStore.getState().activePaginationByDirectory.get('/repo/app')).toEqual({
        cursor: 61,
        hasMore: true,
        loadingMore: false,
      });
    } finally {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      globalThis.fetch = originalFetch;
    }
  });

  test('authoritative complete snapshot clears loadMore tail and resets pagination', async () => {
    const originalWindow = globalThis.window;
    const originalFetch = globalThis.fetch;
    const makePage = (start: number) => Array.from({ length: 20 }, (_, index) => ({
      id: `ses_${start + index}`,
      title: `Session ${start + index}`,
      directory: '/repo/app',
      time: { created: 100 - start - index, updated: 100 - start - index },
    } as Session));
    const list = async (input: Record<string, unknown>) => ({
      data: input.cursor === undefined ? makePage(0) : makePage(20),
      error: undefined,
      response: new Response(null, { status: 200 }),
    });
    const sdk = { experimental: { session: { list } } } as unknown as OpencodeClient;
    const originalGetSdkClient = opencodeClient.getSdkClient;
    opencodeClient.getSdkClient = () => sdk;
    restoreGetSdkClient = () => { opencodeClient.getSdkClient = originalGetSdkClient; };

    await useGlobalSessionsStore.getState().refreshSessionsForDirectories(['/repo/app']);
    await useGlobalSessionsStore.getState().loadMoreSessionsForDirectory('/repo/app');
    expect(useGlobalSessionsStore.getState().sessionsByDirectory.get('/repo/app')?.length).toBe(40);

    const completeHead = makePage(0).slice(0, 5);
    const tipSnapshot = {
      revision: 11,
      sync: {
        active: false,
        completed: 1,
        total: 1,
        pendingDirectories: [],
        completedDirectories: ['/repo/app'],
        failedDirectories: [],
      },
      directories: [{
        directory: '/repo/app',
        cursor: null,
        hasMore: false,
        lastSyncedAt: 3000,
        lastFullSyncedAt: 3000,
        lastAccessedAt: 3000,
        sessions: completeHead,
      }],
    };

    try {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { location: { origin: 'http://localhost', href: 'http://localhost/' } },
      });
      globalThis.fetch = async () => new Response(JSON.stringify(tipSnapshot), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      });

      await useGlobalSessionsStore.getState().syncSessionsForDirectories(['/repo/app']);

      expect(useGlobalSessionsStore.getState().sessionsByDirectory.get('/repo/app')?.map((session) => session.id))
        .toEqual(completeHead.map((session) => session.id));
      expect(useGlobalSessionsStore.getState().activePaginationByDirectory.get('/repo/app')).toEqual({
        cursor: null,
        hasMore: false,
        loadingMore: false,
      });
    } finally {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      globalThis.fetch = originalFetch;
    }
  });

  test('authoritative empty complete snapshot clears directory sessions and pagination', async () => {
    const originalWindow = globalThis.window;
    const originalFetch = globalThis.fetch;
    const kept = buildSession('https://share.example/kept-empty', {
      id: 'ses_kept_empty',
      directory: '/repo/empty',
      time: { created: 2, updated: 20 },
    });
    const tail = buildSession('https://share.example/tail-empty', {
      id: 'ses_tail_empty',
      directory: '/repo/empty',
      time: { created: 1, updated: 5 },
    });
    useGlobalSessionsStore.setState({
      activeSessions: [kept, tail],
      sessionsByDirectory: new Map([['/repo/empty', [kept, tail]]]),
      loadedDirectories: new Set(['/repo/empty']),
      activePaginationByDirectory: new Map([
        ['/repo/empty', { cursor: 4, hasMore: true, loadingMore: false }],
      ]),
      hasLoaded: true,
      status: 'ready',
    });

    const snapshot = {
      revision: 12,
      sync: {
        active: false,
        completed: 1,
        total: 1,
        pendingDirectories: [],
        completedDirectories: ['/repo/empty'],
        failedDirectories: [],
      },
      directories: [{
        directory: '/repo/empty',
        cursor: null,
        hasMore: false,
        lastSyncedAt: 4000,
        lastFullSyncedAt: 4000,
        lastAccessedAt: 4000,
        sessions: [],
      }],
    };

    try {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { location: { origin: 'http://localhost', href: 'http://localhost/' } },
      });
      globalThis.fetch = async () => new Response(JSON.stringify(snapshot), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      });

      await useGlobalSessionsStore.getState().syncSessionsForDirectories(['/repo/empty']);

      expect(useGlobalSessionsStore.getState().sessionsByDirectory.get('/repo/empty') ?? []).toEqual([]);
      expect(useGlobalSessionsStore.getState().activePaginationByDirectory.get('/repo/empty')).toEqual({
        cursor: null,
        hasMore: false,
        loadingMore: false,
      });
    } finally {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      globalThis.fetch = originalFetch;
    }
  });

  test('authoritative cold-start snapshot still drops missing head-window sessions', async () => {
    const originalWindow = globalThis.window;
    const originalFetch = globalThis.fetch;
    const kept = buildSession('https://share.example/kept', {
      id: 'ses_kept',
      directory: '/repo/cold',
      time: { created: 2, updated: 20 },
    });
    const ghost = buildSession('https://share.example/ghost', {
      id: 'ses_ghost',
      directory: '/repo/cold',
      time: { created: 1, updated: 10 },
    });
    useGlobalSessionsStore.setState({
      activeSessions: [kept, ghost],
      sessionsByDirectory: new Map([['/repo/cold', [kept, ghost]]]),
      loadedDirectories: new Set(['/repo/cold']),
      activePaginationByDirectory: new Map([
        ['/repo/cold', { cursor: 10, hasMore: true, loadingMore: false }],
      ]),
      hasLoaded: true,
      status: 'ready',
    });

    const snapshot = {
      revision: 1,
      sync: {
        active: false,
        completed: 1,
        total: 1,
        pendingDirectories: [],
        completedDirectories: ['/repo/cold'],
        failedDirectories: [],
      },
      directories: [{
        directory: '/repo/cold',
        cursor: 20,
        hasMore: true,
        lastSyncedAt: 1000,
        lastFullSyncedAt: 1000,
        lastAccessedAt: 1000,
        sessions: [kept],
      }],
    };

    try {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { location: { origin: 'http://localhost', href: 'http://localhost/' } },
      });
      globalThis.fetch = async () => new Response(JSON.stringify(snapshot), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      });

      await useGlobalSessionsStore.getState().syncSessionsForDirectories(['/repo/cold']);

      expect(useGlobalSessionsStore.getState().sessionsByDirectory.get('/repo/cold')?.map((session) => session.id))
        .toEqual(['ses_kept']);
      expect(useGlobalSessionsStore.getState().activePaginationByDirectory.get('/repo/cold')).toEqual({
        cursor: 20,
        hasMore: true,
        loadingMore: false,
      });
    } finally {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      globalThis.fetch = originalFetch;
    }
  });

  test('aborts an in-flight directory request on runtime reset', async () => {
    let requestSignal: AbortSignal | undefined;
    const list = (_input: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
      requestSignal = options?.signal;
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    };
    const sdk = { experimental: { session: { list } } } as unknown as OpencodeClient;
    const originalGetSdkClient = opencodeClient.getSdkClient;
    opencodeClient.getSdkClient = () => sdk;
    restoreGetSdkClient = () => { opencodeClient.getSdkClient = originalGetSdkClient; };

    const refresh = useGlobalSessionsStore.getState().refreshSessionsForDirectories(['/repo/app']);
    await new Promise((resolve) => setTimeout(resolve, 0));
    useGlobalSessionsStore.getState().resetForRuntimeSwitch();
    await refresh;

    expect(requestSignal?.aborted).toBe(true);
    expect(useGlobalSessionsStore.getState().status).toBe('idle');
    expect(useGlobalSessionsStore.getState().activeSessions).toEqual([]);
  });

  test('updates an existing session when the share URL changes', () => {
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/a'));
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/b'));

    expect(useGlobalSessionsStore.getState().activeSessions[0]?.share?.url).toBe('https://share.example/b');
  });

  test('preserves directory metadata when a live update omits it', () => {
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/a', { directory: '/repo/app' }));
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/b', {
      time: { created: 1, updated: 3 },
    }));

    const session = useGlobalSessionsStore.getState().activeSessions[0];
    expect(resolveGlobalSessionDirectory(session)).toBe('/repo/app');
    expect(useGlobalSessionsStore.getState().sessionsByDirectory.get('/repo/app')?.[0]?.id).toBe('ses_1');
  });

  test('preserves raw directory metadata when a live update only has project worktree', () => {
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/a', { directory: '/repo/app' }));
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/b', {
      project: { worktree: '/repo/app' },
      time: { created: 1, updated: 3 },
    }));

    const session = useGlobalSessionsStore.getState().activeSessions[0] as Session & { directory?: string | null };
    expect(session.directory).toBe('/repo/app');
    expect(resolveGlobalSessionDirectory(session)).toBe('/repo/app');
  });

  test('trusts explicit incoming raw directory metadata', () => {
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/a', { directory: '/repo/app' }));
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/b', {
      directory: '/repo/app-worktree',
      time: { created: 1, updated: 3 },
    }));

    expect(resolveGlobalSessionDirectory(useGlobalSessionsStore.getState().activeSessions[0])).toBe('/repo/app-worktree');
    expect(useGlobalSessionsStore.getState().sessionsByDirectory.get('/repo/app')).toBe(undefined);
    expect(useGlobalSessionsStore.getState().sessionsByDirectory.get('/repo/app-worktree')?.[0]?.id).toBe('ses_1');
  });

  test('preserves directory metadata when moving a session to archived', () => {
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/a', { directory: '/repo/app' }));
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/b', {
      time: { created: 1, updated: 3, archived: 4 },
    }));

    expect(useGlobalSessionsStore.getState().activeSessions).toEqual([]);
    expect(resolveGlobalSessionDirectory(useGlobalSessionsStore.getState().archivedSessions[0])).toBe('/repo/app');
  });
});

describe('session-index client SWR + cold startup seed', () => {
  test('projects a runtimeKey storage seed before GET and keeps it when GET fails', async () => {
    const originalWindow = globalThis.window;
    const originalFetch = globalThis.fetch;
    const { writeSessionIndexSnapshotQuery } = await import('@/queries/sessionIndexQueries');
    const { queryClient } = await import('@/lib/queryRuntime');
    const cached = buildSession('https://share.example/stale-seed', {
      id: 'ses_stale_seed',
      directory: '/repo/seed',
    });
    const seedSnapshot = {
      revision: 4,
      sync: {
        active: false,
        completed: 1,
        total: 1,
        pendingDirectories: [] as string[],
        completedDirectories: ['/repo/seed'],
        failedDirectories: [] as string[],
      },
      directories: [{
        directory: '/repo/seed',
        cursor: null as number | null,
        hasMore: false,
        lastSyncedAt: 1000,
        lastFullSyncedAt: 1000,
        lastAccessedAt: 1000,
        sessions: [cached],
      }],
    };
    try {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { location: { origin: 'http://localhost', href: 'http://localhost/' } },
      });
      // Seed Query memory + persistent cache through the same helper the store uses.
      writeSessionIndexSnapshotQuery(seedSnapshot);
      globalThis.fetch = async () => {
        throw new Error('offline');
      };

      const hydrate = useGlobalSessionsStore.getState().hydrateSessionIndex();
      // Seed projection is synchronous before the failed GET settles.
      expect(useGlobalSessionsStore.getState().sessionsByDirectory.get('/repo/seed')).toEqual([cached]);
      expect(useGlobalSessionsStore.getState().hasCachedSessionIndex).toBe(true);
      expect(useGlobalSessionsStore.getState().hasHydratedSessionIndex).toBe(false);

      await hydrate;
      expect(useGlobalSessionsStore.getState().sessionsByDirectory.get('/repo/seed')).toEqual([cached]);
      expect(useGlobalSessionsStore.getState().hasCachedSessionIndex).toBe(true);
      // Transport failure leaves hasHydrated false so startup can retry.
      expect(useGlobalSessionsStore.getState().hasHydratedSessionIndex).toBe(false);
    } finally {
      useGlobalSessionsStore.getState().resetForRuntimeSwitch();
      queryClient.clear();
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      globalThis.fetch = originalFetch;
    }
  });

  test('authoritative GET success replaces the storage seed projection', async () => {
    const originalWindow = globalThis.window;
    const originalFetch = globalThis.fetch;
    const { writeSessionIndexSnapshotQuery, readSessionIndexSnapshotQuery } = await import('@/queries/sessionIndexQueries');
    const { readSessionIndexStartupSnapshot } = await import('@/queries/sessionIndexStartupCache');
    const { queryClient } = await import('@/lib/queryRuntime');
    const { getRuntimeKey } = await import('@/lib/runtime-switch');
    const { getDeferredSafeStorage } = await import('@/stores/utils/safeStorage');
    const stale = buildSession('https://share.example/stale', {
      id: 'ses_stale',
      directory: '/repo/live',
    });
    const live = buildSession('https://share.example/live', {
      id: 'ses_live',
      directory: '/repo/live',
    });
    const seedSnapshot = {
      revision: 1,
      sync: {
        active: false,
        completed: 1,
        total: 1,
        pendingDirectories: [] as string[],
        completedDirectories: ['/repo/live'],
        failedDirectories: [] as string[],
      },
      directories: [{
        directory: '/repo/live',
        cursor: null as number | null,
        hasMore: false,
        lastSyncedAt: 1,
        lastFullSyncedAt: 1,
        lastAccessedAt: 1,
        sessions: [stale],
      }],
    };
    const liveSnapshot = {
      ...seedSnapshot,
      revision: 2,
      directories: [{
        ...seedSnapshot.directories[0],
        sessions: [live],
      }],
    };
    try {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { location: { origin: 'http://localhost', href: 'http://localhost/' } },
      });
      writeSessionIndexSnapshotQuery(seedSnapshot);
      globalThis.fetch = async (input) => {
        const pathname = new URL(input instanceof Request ? input.url : String(input), 'http://localhost').pathname;
        if (pathname === '/api/openchamber/session-index') {
          return new Response(JSON.stringify({ available: true, ...liveSnapshot }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('{}', { status: 404 });
      };

      await useGlobalSessionsStore.getState().hydrateSessionIndex();

      // Non-authoritative hydrate merges; live row must appear after the GET.
      const liveDirectory = useGlobalSessionsStore.getState().sessionsByDirectory.get('/repo/live') ?? [];
      expect(liveDirectory.some((session) => session.id === live.id)).toBe(true);
      expect(useGlobalSessionsStore.getState().hasCachedSessionIndex).toBe(true);
      expect(useGlobalSessionsStore.getState().hasHydratedSessionIndex).toBe(true);
      expect(readSessionIndexSnapshotQuery()?.revision).toBe(2);
      expect(readSessionIndexStartupSnapshot(getRuntimeKey(), getDeferredSafeStorage())?.revision).toBe(2);
    } finally {
      useGlobalSessionsStore.getState().resetForRuntimeSwitch();
      queryClient.clear();
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      globalThis.fetch = originalFetch;
    }
  });
});

describe('mergeLiveSessionWithGlobalSession', () => {
  test('preserves global share over live share', () => {
    const live = buildSession('https://live.example/s', { time: { created: 1, updated: 5 } });
    const global = buildSession('https://global.example/s', { time: { created: 1, updated: 3 } });

    const merged = mergeLiveSessionWithGlobalSession(live, global);
    expect(merged.share?.url).toBe('https://global.example/s');
    expect(merged.time?.updated).toBe(5);
  });

  test('preserves directory from global when live omits it', () => {
    const live = buildSession('https://live.example/s', { time: { created: 1, updated: 5 } });
    const global = buildSession('https://global.example/s', { directory: '/repo/app' });

    const merged = mergeLiveSessionWithGlobalSession(live, global);
    expect(resolveGlobalSessionDirectory(merged)).toBe('/repo/app');
  });

  test('live directory takes precedence over global when present', () => {
    const live = buildSession('https://live.example/s', { directory: '/repo/worktree' });
    const global = buildSession('https://global.example/s', { directory: '/repo/app' });

    const merged = mergeLiveSessionWithGlobalSession(live, global);
    expect(resolveGlobalSessionDirectory(merged)).toBe('/repo/worktree');
  });
});
