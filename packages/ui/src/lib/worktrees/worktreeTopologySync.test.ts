import { describe, expect, test } from 'bun:test';
import { createWorktreeTopologyCoordinator } from './worktreeTopologySync';

const fakeTimers = () => {
  const callbacks = new Map<number, () => void>(); let next = 0;
  return {
    setTimer: ((callback: () => void) => { const id = ++next; callbacks.set(id, callback); return id; }) as unknown as typeof setTimeout,
    clearTimer: ((id: number) => { callbacks.delete(id); }) as unknown as typeof clearTimeout,
    flush: () => { const current = [...callbacks.values()]; callbacks.clear(); current.forEach((callback) => callback()); },
  };
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; });
  return { promise, resolve, reject };
};

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const emptyResult: { worktrees: []; addedDirectories: string[]; removedDirectories: string[] } = { worktrees: [], addedDirectories: [], removedDirectories: [] };

describe('worktree topology coordinator', () => {
  test('coalesces topology bursts and syncs added directories only once', async () => {
    let eventListener: ((event: { type: string; projectDirectory?: string }) => void) | undefined;
    const refreshed: string[] = [];
    const synced: string[][] = [];
    const timers = fakeTimers();
    const coordinator = createWorktreeTopologyCoordinator({
      isVSCode: () => false, getProjects: () => [{ id: 'p', path: '/repo' }], getCatalog: () => new Map(), getActiveDirectories: () => [],
      refresh: async (project) => { refreshed.push(project.path); return { worktrees: [], addedDirectories: ['/repo/feature'], removedDirectories: ['/repo/old'] }; },
      syncAdded: async (directories) => { synced.push(directories); },
      subscribeProjects: () => () => {}, subscribeCatalog: () => () => {}, subscribeSessions: () => () => {},
      subscribeEvents: (listener) => { eventListener = listener; return () => {}; }, subscribeRuntime: () => () => {}, generation: () => 1,
      setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    });
    coordinator.start();
    timers.flush(); await Promise.resolve();
    refreshed.length = 0; synced.length = 0;
    eventListener?.({ type: 'worktree-topology-changed', projectDirectory: '/repo' });
    eventListener?.({ type: 'worktree-topology-changed', projectDirectory: '/repo' });
    timers.flush(); await Promise.resolve();
    expect(refreshed).toEqual(['/repo']);
    expect(synced).toEqual([['/repo/feature']]);
    coordinator.stop();
  });

  test('ready reconciles all projects and removed deltas skip session sync', async () => {
    const timers = fakeTimers(); let eventListener: ((event: { type: string; projectDirectory?: string }) => void) | undefined;
    const refreshed: string[] = []; const synced: string[][] = [];
    const coordinator = createWorktreeTopologyCoordinator({
      isVSCode: () => false, getProjects: () => [{ id: 'a', path: '/a' }, { id: 'b', path: '/b' }], getCatalog: () => new Map(), getActiveDirectories: () => [],
      refresh: async (project) => { refreshed.push(project.path); return { worktrees: [], addedDirectories: [], removedDirectories: ['/removed'] }; }, syncAdded: async (directories) => { synced.push(directories); },
      subscribeProjects: () => () => {}, subscribeCatalog: () => () => {}, subscribeSessions: () => () => {}, subscribeEvents: (listener) => { eventListener = listener; return () => {}; }, subscribeRuntime: () => () => {}, generation: () => 1, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    });
    coordinator.start(); timers.flush(); await Promise.resolve(); refreshed.length = 0;
    eventListener?.({ type: 'event-stream-ready' }); timers.flush(); await Promise.resolve();
    expect(refreshed.sort()).toEqual(['/a', '/b']); expect(synced).toEqual([]); coordinator.stop();
  });

  test('syncs persisted catalog worktrees whose session directories are still unloaded', async () => {
    const timers = fakeTimers(); const synced: string[][] = [];
    const coordinator = createWorktreeTopologyCoordinator({
      isVSCode: () => false, getProjects: () => [{ id: 'a', path: '/a' }], getCatalog: () => new Map(), getActiveDirectories: () => [],
      needsSessionSync: (directory) => directory === '/a/feature',
      refresh: async () => ({ worktrees: [
        { path: '/a/feature', projectDirectory: '/a', branch: 'feature', label: 'feature' },
        { path: '/a/loaded', projectDirectory: '/a', branch: 'loaded', label: 'loaded' },
      ], addedDirectories: [], removedDirectories: [] }),
      syncAdded: async (directories) => { synced.push(directories); },
      subscribeProjects: () => () => {}, subscribeCatalog: () => () => {}, subscribeSessions: () => () => {}, subscribeEvents: () => () => {}, subscribeRuntime: () => () => {}, generation: () => 1, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    });

    coordinator.start(); timers.flush(); await settle();

    expect(synced).toEqual([['/a/feature']]); coordinator.stop();
  });

  test('catalog notifications only reevaluate unknown directories', async () => {
    const timers = fakeTimers(); let catalogListener: (() => void) | undefined; let refreshes = 0;
    const coordinator = createWorktreeTopologyCoordinator({
      isVSCode: () => false, getProjects: () => [{ id: 'a', path: '/a' }], getCatalog: () => new Map(), getActiveDirectories: () => [], refresh: async () => { refreshes += 1; return { worktrees: [], addedDirectories: [], removedDirectories: [] }; }, syncAdded: async () => {},
      subscribeProjects: () => () => {}, subscribeCatalog: (listener) => { catalogListener = listener; return () => {}; }, subscribeSessions: () => () => {}, subscribeEvents: () => () => {}, subscribeRuntime: () => () => {}, generation: () => 1, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    });
    coordinator.start(); timers.flush(); await Promise.resolve(); refreshes = 0; catalogListener?.(); timers.flush(); await Promise.resolve();
    expect(refreshes).toBe(0); coordinator.stop();
  });

  test('suppresses an unchanged unknown directory after every project succeeds', async () => {
    const timers = fakeTimers(); let catalogListener: (() => void) | undefined; let sessionsListener: (() => void) | undefined;
    const refreshed: string[] = [];
    const coordinator = createWorktreeTopologyCoordinator({
      isVSCode: () => false, getProjects: () => [{ id: 'a', path: '/a' }, { id: 'b', path: '/b' }], getCatalog: () => new Map(), getActiveDirectories: () => ['/unknown'],
      refresh: async (project) => { refreshed.push(project.path); return emptyResult; }, syncAdded: async () => {},
      subscribeProjects: () => () => {}, subscribeCatalog: (listener) => { catalogListener = listener; return () => {}; }, subscribeSessions: (listener) => { sessionsListener = listener; return () => {}; }, subscribeEvents: () => () => {}, subscribeRuntime: () => () => {}, generation: () => 1, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    });
    coordinator.start(); timers.flush(); await settle();
    expect(refreshed.sort()).toEqual(['/a', '/b']);
    catalogListener?.(); sessionsListener?.(); timers.flush(); await settle();
    expect(refreshed).toHaveLength(2); coordinator.stop();
  });

  test('retries a failed unknown recovery without concurrent project refreshes', async () => {
    const timers = fakeTimers(); let calls = 0; let active = 0; let greatestActive = 0;
    const coordinator = createWorktreeTopologyCoordinator({
      isVSCode: () => false, getProjects: () => [{ id: 'a', path: '/a' }], getCatalog: () => new Map(), getActiveDirectories: () => ['/unknown'],
      refresh: async () => { calls += 1; active += 1; greatestActive = Math.max(greatestActive, active); active -= 1; if (calls === 1) throw new Error('failed'); return emptyResult; }, syncAdded: async () => {},
      subscribeProjects: () => () => {}, subscribeCatalog: () => () => {}, subscribeSessions: () => () => {}, subscribeEvents: () => () => {}, subscribeRuntime: () => () => {}, generation: () => 1, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    });
    coordinator.start(); timers.flush(); await settle();
    expect(calls).toBe(1); timers.flush(); await settle();
    expect(calls).toBe(2); expect(greatestActive).toBe(1); coordinator.stop();
  });

  test('retries rejected added-directory session sync on a timer', async () => {
    const timers = fakeTimers(); let syncCalls = 0;
    const coordinator = createWorktreeTopologyCoordinator({
      isVSCode: () => false, getProjects: () => [{ id: 'a', path: '/a' }], getCatalog: () => new Map(), getActiveDirectories: () => [], refresh: async () => ({ ...emptyResult, addedDirectories: ['/a/feature'] }),
      syncAdded: async () => { syncCalls += 1; if (syncCalls === 1) throw new Error('failed'); },
      subscribeProjects: () => () => {}, subscribeCatalog: () => () => {}, subscribeSessions: () => () => {}, subscribeEvents: () => () => {}, subscribeRuntime: () => () => {}, generation: () => 1, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    });
    coordinator.start(); timers.flush(); await settle();
    expect(syncCalls).toBe(1); timers.flush(); await settle();
    expect(syncCalls).toBe(2); coordinator.stop();
  });

  test('reconciles projects only when sorted id and path signatures change', async () => {
    const timers = fakeTimers(); let projects: Array<{ id: string; path: string; active: boolean; label: string; order: number }> = [{ id: 'a', path: '/a', active: true, label: 'A', order: 1 }]; let projectListener: (() => void) | undefined; let refreshes = 0;
    const coordinator = createWorktreeTopologyCoordinator({
      isVSCode: () => false, getProjects: () => projects, getCatalog: () => new Map(), getActiveDirectories: () => [], refresh: async () => { refreshes += 1; return emptyResult; }, syncAdded: async () => {},
      subscribeProjects: (listener) => { projectListener = listener; return () => {}; }, subscribeCatalog: () => () => {}, subscribeSessions: () => () => {}, subscribeEvents: () => () => {}, subscribeRuntime: () => () => {}, generation: () => 1, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    });
    coordinator.start(); timers.flush(); await settle(); refreshes = 0;
    projects = [{ id: 'a', path: '/a', active: false, label: 'Renamed', order: 99 }]; projectListener?.(); timers.flush(); await settle();
    expect(refreshes).toBe(0);
    projects = [{ id: 'b', path: '/a', active: false, label: 'Renamed', order: 99 }]; projectListener?.(); timers.flush(); await settle();
    expect(refreshes).toBe(1); coordinator.stop();
  });

  test('isolates stale stop/start refreshes by lifecycle and runtime generation', async () => {
    const timers = fakeTimers(); const oldA = deferred<typeof emptyResult>(); const oldB = deferred<typeof emptyResult>(); const newA = deferred<typeof emptyResult>(); const newB = deferred<typeof emptyResult>(); const newC = deferred<typeof emptyResult>(); let generation = 1; let refreshes = 0; const syncs: string[][] = []; const currentChecks: Array<() => boolean> = [];
    const coordinator = createWorktreeTopologyCoordinator({
      isVSCode: () => false, getProjects: () => [{ id: 'a', path: '/a' }, { id: 'b', path: '/b' }, { id: 'c', path: '/c' }], getCatalog: () => new Map(), getActiveDirectories: () => [],
      refresh: (_project, options) => { currentChecks.push(options.isCurrent); refreshes += 1; return [oldA, oldB, newA, newB, newC][refreshes - 1]!.promise; }, syncAdded: async (directories) => { syncs.push(directories); },
      subscribeProjects: () => () => {}, subscribeCatalog: () => () => {}, subscribeSessions: () => () => {}, subscribeEvents: () => () => {}, subscribeRuntime: () => () => {}, generation: () => generation, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    });
    coordinator.start(); timers.flush(); await settle(); coordinator.stop(); generation = 2; coordinator.start(); timers.flush(); await settle();
    expect(currentChecks[0]?.()).toBe(false); expect(currentChecks[2]?.()).toBe(true); expect(refreshes).toBe(4);
    oldA.resolve({ ...emptyResult, addedDirectories: ['/a/old'] }); await settle();
    expect(refreshes).toBe(4);
    newA.resolve({ ...emptyResult, addedDirectories: ['/a/new'] }); await settle();
    expect(refreshes).toBe(5); newB.resolve(emptyResult); newC.resolve(emptyResult); await settle();
    expect(syncs).toEqual([['/a/new']]); coordinator.stop();
  });

  test('skips blank directories and never syncs removed deltas', async () => {
    const timers = fakeTimers(); let refreshes = 0; const syncs: string[][] = [];
    const coordinator = createWorktreeTopologyCoordinator({
      isVSCode: () => false, getProjects: () => [{ id: 'a', path: '/a' }], getCatalog: () => new Map(), getActiveDirectories: () => ['   '], refresh: async () => { refreshes += 1; return { ...emptyResult, removedDirectories: ['/a/old'] }; }, syncAdded: async (directories) => { syncs.push(directories); },
      subscribeProjects: () => () => {}, subscribeCatalog: () => () => {}, subscribeSessions: () => () => {}, subscribeEvents: () => () => {}, subscribeRuntime: () => () => {}, generation: () => 1, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    });
    coordinator.start(); timers.flush(); await settle();
    expect(refreshes).toBe(1); expect(syncs).toEqual([]); coordinator.stop();
  });

  test('empty active sessions with new cachedDirectories triggers recovery', async () => {
    const timers = fakeTimers();
    let sessionsListener: (() => void) | undefined;
    let candidates: string[] = [];
    const refreshed: string[] = [];
    const coordinator = createWorktreeTopologyCoordinator({
      isVSCode: () => false,
      getProjects: () => [{ id: 'a', path: '/a' }],
      getCatalog: () => new Map(),
      getActiveDirectories: () => candidates,
      refresh: async (project) => { refreshed.push(project.path); return emptyResult; },
      syncAdded: async () => {},
      subscribeProjects: () => () => {},
      subscribeCatalog: () => () => {},
      subscribeSessions: (listener) => { sessionsListener = listener; return () => {}; },
      subscribeEvents: () => () => {},
      subscribeRuntime: () => () => {},
      generation: () => 1,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    coordinator.start();
    timers.flush();
    await settle();
    expect(refreshed).toEqual(['/a']);
    refreshed.length = 0;
    // Session-index snapshot directories alone (no live sessions) still recover.
    candidates = ['/unknown-cached'];
    sessionsListener?.();
    timers.flush();
    await settle();
    expect(refreshed).toEqual(['/a']);
    coordinator.stop();
  });

  test('same candidate membership does not refresh again', async () => {
    const timers = fakeTimers();
    let sessionsListener: (() => void) | undefined;
    let candidates = ['/unknown'];
    const refreshed: string[] = [];
    const coordinator = createWorktreeTopologyCoordinator({
      isVSCode: () => false,
      getProjects: () => [{ id: 'a', path: '/a' }],
      getCatalog: () => new Map(),
      getActiveDirectories: () => candidates,
      refresh: async (project) => { refreshed.push(project.path); return emptyResult; },
      syncAdded: async () => {},
      subscribeProjects: () => () => {},
      subscribeCatalog: () => () => {},
      subscribeSessions: (listener) => { sessionsListener = listener; return () => {}; },
      subscribeEvents: () => () => {},
      subscribeRuntime: () => () => {},
      generation: () => 1,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    coordinator.start();
    timers.flush();
    await settle();
    expect(refreshed).toEqual(['/a']);
    // New array/Set identity, identical semantic membership.
    candidates = ['/unknown'];
    sessionsListener?.();
    timers.flush();
    await settle();
    expect(refreshed).toEqual(['/a']);
    coordinator.stop();
  });

  test('removed then re-added candidate can recover again', async () => {
    const timers = fakeTimers();
    let sessionsListener: (() => void) | undefined;
    let candidates = ['/unknown'];
    const refreshed: string[] = [];
    const coordinator = createWorktreeTopologyCoordinator({
      isVSCode: () => false,
      getProjects: () => [{ id: 'a', path: '/a' }],
      getCatalog: () => new Map(),
      getActiveDirectories: () => candidates,
      refresh: async (project) => { refreshed.push(project.path); return emptyResult; },
      syncAdded: async () => {},
      subscribeProjects: () => () => {},
      subscribeCatalog: () => () => {},
      subscribeSessions: (listener) => { sessionsListener = listener; return () => {}; },
      subscribeEvents: () => () => {},
      subscribeRuntime: () => () => {},
      generation: () => 1,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    coordinator.start();
    timers.flush();
    await settle();
    expect(refreshed).toEqual(['/a']);
    // Leave the candidate set so suppression/unknown bookkeeping is cleared.
    candidates = [];
    sessionsListener?.();
    timers.flush();
    await settle();
    expect(refreshed).toEqual(['/a']);
    // Reappear: recovery must run again in the same ready epoch.
    candidates = ['/unknown'];
    sessionsListener?.();
    timers.flush();
    await settle();
    expect(refreshed).toEqual(['/a', '/a']);
    coordinator.stop();
  });
});
