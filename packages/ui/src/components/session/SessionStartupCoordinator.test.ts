import { afterEach, describe, expect, test } from 'bun:test';

import {
  beginSessionStartupBarrier,
  isSessionStartupBarrierActive,
  releaseSessionStartupBarrier,
} from '@/lib/session-startup-barrier';

import {
  collectSessionStartupDirectories,
  planSessionStartupDirectories,
  runSessionStartup,
  runSessionStartupAfterSettingsHydration,
} from './runSessionStartup';

describe('runSessionStartup', () => {
  afterEach(() => {
    releaseSessionStartupBarrier();
  });

  test('passes known project directories to the shared startup flow', async () => {
    const calls: string[][] = [];
    const start = async (directories: Iterable<string>) => {
      calls.push([...directories]);
      return { activeSessions: [], archivedSessions: [] };
    };

    await runSessionStartup(['/repo/a', '/repo/b'], start);

    expect(calls).toEqual([['/repo/a', '/repo/b']]);
  });

  test('forwards priority directories when provided', async () => {
    const calls: Array<{ directories: string[]; priority?: string[] }> = [];
    const start = async (
      directories: Iterable<string>,
      options?: { priorityDirectories?: Iterable<string> },
    ) => {
      calls.push({
        directories: [...directories],
        priority: options?.priorityDirectories ? [...options.priorityDirectories] : undefined,
      });
      return { activeSessions: [], archivedSessions: [] };
    };

    await runSessionStartup(['/repo/a', '/repo/b', '/repo/a-feature'], start, {
      priorityDirectories: ['/repo/a', '/repo/a-feature'],
    });

    expect(calls).toEqual([{
      directories: ['/repo/a', '/repo/b', '/repo/a-feature'],
      priority: ['/repo/a', '/repo/a-feature'],
    }]);
  });

  test('collects persisted worktree directories for registered projects', () => {
    const directories = collectSessionStartupDirectories(
      ['/repo/a/', '/repo/b'],
      new Map([
        ['/repo/a', [{ path: '/repo/a-feature/' }, { path: '/repo/a-feature' }]],
        ['/stale', [{ path: '/stale/feature' }]],
      ]),
    );

    expect(directories).toEqual(['/repo/a', '/repo/a-feature', '/repo/b']);
  });

  test('plans priority directories for the active project and its worktrees', () => {
    const plan = planSessionStartupDirectories(
      ['/repo/a', '/repo/b'],
      new Map([
        ['/repo/a', [{ path: '/repo/a-feature' }]],
        ['/repo/b', [{ path: '/repo/b-feature' }]],
      ]),
      { currentDirectory: '/repo/a/src' },
    );

    expect(plan.directories).toEqual(['/repo/a', '/repo/a-feature', '/repo/b', '/repo/b-feature']);
    expect(plan.priorityDirectories).toEqual(['/repo/a', '/repo/a-feature']);
  });

  test('plans priority from a worktree current directory', () => {
    const plan = planSessionStartupDirectories(
      ['/repo/a', '/repo/b'],
      new Map([['/repo/a', [{ path: '/repo/a-feature' }]]]),
      { currentDirectory: '/repo/a-feature' },
    );

    expect(plan.priorityDirectories).toEqual(['/repo/a', '/repo/a-feature']);
  });

  test('omits priority when current directory is unknown (full-set fallback)', () => {
    const plan = planSessionStartupDirectories(
      ['/repo/a', '/repo/b'],
      new Map(),
      { currentDirectory: '/unrelated' },
    );

    expect(plan.directories).toEqual(['/repo/a', '/repo/b']);
    expect(plan.priorityDirectories).toEqual(undefined);
  });

  test('reads project directories after settings hydration completes', async () => {
    let releaseSettings: (() => void) | undefined;
    const settingsHydration = new Promise<void>((resolve) => { releaseSettings = resolve; });
    let plan: { directories: string[]; priorityDirectories?: string[] } = { directories: [] };
    const calls: Array<{ directories: string[]; priority?: string[] }> = [];
    const startup = runSessionStartupAfterSettingsHydration(
      settingsHydration,
      () => plan,
      async (nextDirectories, options) => {
        calls.push({
          directories: [...nextDirectories],
          priority: options?.priorityDirectories ? [...options.priorityDirectories] : undefined,
        });
        return { activeSessions: [], archivedSessions: [] };
      },
      async () => undefined,
    );

    plan = {
      directories: ['/repo/restored', '/repo/other'],
      priorityDirectories: ['/repo/restored'],
    };
    expect(calls).toEqual([]);
    releaseSettings?.();
    await startup;

    expect(calls).toEqual([{
      directories: ['/repo/restored', '/repo/other'],
      priority: ['/repo/restored'],
    }]);
  });

  test('starts session-index hydrate before settings hydration settles', async () => {
    let releaseSettings: (() => void) | undefined;
    const settingsHydration = new Promise<void>((resolve) => { releaseSettings = resolve; });
    const order: string[] = [];
    let resolveHydrate: (() => void) | undefined;
    const hydrate = () => new Promise<void>((resolve) => {
      order.push('hydrate-start');
      resolveHydrate = () => {
        order.push('hydrate-done');
        resolve();
      };
    });
    const startup = runSessionStartupAfterSettingsHydration(
      settingsHydration,
      () => ({ directories: ['/repo/a'] }),
      async () => {
        order.push('start');
        return { activeSessions: [], archivedSessions: [] };
      },
      hydrate,
    );

    await Promise.resolve();
    expect(order).toEqual(['hydrate-start']);
    resolveHydrate?.();
    releaseSettings?.();
    await startup;
    expect(order).toEqual(['hydrate-start', 'hydrate-done', 'start']);
  });

  test('releases the startup barrier after success', async () => {
    beginSessionStartupBarrier();

    await runSessionStartup([], async () => ({ activeSessions: [], archivedSessions: [] }));

    expect(isSessionStartupBarrierActive()).toBe(false);
  });

  test('releases the startup barrier after failure', async () => {
    beginSessionStartupBarrier();
    const originalWarn = console.warn;
    console.warn = () => undefined;

    try {
      await runSessionStartup([], async () => {
        throw new Error('unavailable');
      });
    } finally {
      console.warn = originalWarn;
    }

    expect(isSessionStartupBarrierActive()).toBe(false);
  });
});
