import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { SessionWorktreeAttachment } from '@/stores/types/sessionTypes';
import type { WorktreeMetadata } from '@/types/worktree';
import * as runtimeSwitch from '@/lib/runtime-switch';

type WorktreeListEntry = {
  path?: string;
  branch?: string;
  head?: string;
  name?: string;
};

const listCalls: string[] = [];
const listResolvers: Array<(value: WorktreeListEntry[]) => void> = [];
const listRejectors: Array<(reason?: unknown) => void> = [];
let runtimeIdentity = 'runtime-0';
let runtimeSequence = 0;
const createdWorktree = {
  name: 'feature',
  branch: 'feature',
  path: '/repo-feature',
  directoryCreated: true as const,
  bootstrapStatus: { status: 'pending' as const, error: null, updatedAt: 1 },
};

const sessionState = {
  availableWorktreesByProject: new Map<string, WorktreeMetadata[]>(),
  availableWorktrees: [] as WorktreeMetadata[],
  worktreeMetadata: new Map<string, WorktreeMetadata>(),
};
const clearedAttachmentSessions: string[] = [];
const sessionWorktreeState = {
  attachments: new Map<string, SessionWorktreeAttachment>(),
  clearAttachment: (sessionId: string) => {
    clearedAttachmentSessions.push(sessionId);
    sessionWorktreeState.attachments.delete(sessionId);
  },
};
const removeWorktreeCalls: Array<[string, { directory: string; deleteLocalBranch: boolean }]> = [];
const removeWorktree = (directory: string, options: { directory: string; deleteLocalBranch: boolean }) => {
  removeWorktreeCalls.push([directory, options]);
  return Promise.resolve({ success: true });
};

mock.module('@/lib/yuriConfig', () => ({
  substituteCommandVariables: (command: string) => command,
}));

mock.module('@/lib/worktrees/worktreeBootstrap', () => ({
  clearWorktreeBootstrapState: mock(),
  getWorktreeBootstrapState: () => null,
  markWorktreeBootstrapPending: mock(),
  setWorktreeBootstrapState: mock(),
  startWorktreeBootstrapWatcher: mock(),
}));

mock.module('@/lib/worktrees/worktreeStatus', () => ({
  invalidateResolvedProjectRootCache: mock(),
  resolveProjectRoot: (directory: string) => Promise.resolve(directory),
}));

mock.module('@/lib/runtime-switch', () => ({
  ...runtimeSwitch,
  getRuntimeTransportIdentity: () => runtimeIdentity,
}));

mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: {
    getState: () => sessionState,
    setState: (patch: Partial<typeof sessionState> | ((state: typeof sessionState) => Partial<typeof sessionState>)) => {
      const next = typeof patch === 'function' ? patch(sessionState) : patch;
      Object.assign(sessionState, next);
    },
  },
}));

mock.module('@/sync/session-worktree-store', () => ({
  useSessionWorktreeStore: {
    getState: () => sessionWorktreeState,
  },
}));

mock.module('@/lib/gitApi', () => ({
  deleteRemoteBranch: mock(),
  git: {
    worktree: {
      list: (directory: string) => {
        listCalls.push(directory);
        return new Promise<WorktreeListEntry[]>((resolve, reject) => {
          listResolvers.push(resolve);
          listRejectors.push(reject);
        });
      },
      create: mock(() => Promise.resolve(createdWorktree)),
      remove: removeWorktree,
    },
  },
}));

const { createWorktree, forceRefreshProjectWorktreeCatalog, listProjectWorktrees, removeProjectWorktree, worktreeMapsEqual } = await import('./worktreeManager');

const waitForListCallCount = async (count: number): Promise<void> => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (listCalls.length >= count) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(`Expected ${count} worktree list calls, got ${listCalls.length}`);
};

describe('worktreeManager list invalidation', () => {
  beforeEach(() => {
    listCalls.length = 0;
    listResolvers.length = 0;
    listRejectors.length = 0;
    runtimeIdentity = `runtime-${++runtimeSequence}`;
    sessionState.availableWorktreesByProject = new Map();
    sessionState.availableWorktrees = [];
    sessionState.worktreeMetadata = new Map();
    sessionWorktreeState.attachments.clear();
    clearedAttachmentSessions.length = 0;
    removeWorktreeCalls.length = 0;
  });

  test('retries an in-flight list when a worktree is created before it resolves', async () => {
    const project = { id: 'project-1', path: '/repo' };
    const listing = listProjectWorktrees(project);

    await waitForListCallCount(1);

    await createWorktree(project, {
      preferredName: 'feature',
      mode: 'new',
      branchName: 'feature',
      worktreeName: 'feature',
    });

    listResolvers[0]([]);
    await waitForListCallCount(2);
    listResolvers[1]([createdWorktree]);

    const result = await listing;

    expect(listCalls).toEqual(['/repo', '/repo']);
    expect(result.map((entry) => entry.path)).toEqual(['/repo-feature']);
  });

  test('marks fast-created worktrees pending until bootstrap settles', async () => {
    const metadata = await createWorktree({ id: 'project-1', path: '/repo' }, {
      preferredName: 'feature',
      mode: 'new',
      branchName: 'feature',
      worktreeName: 'feature',
      returnAfterDirectoryCreated: true,
    });

    expect(metadata.worktreeStatus).toBe('pending');
    expect(sessionState.availableWorktrees[0]?.worktreeStatus).toBe('pending');
  });

  test('force refresh bypasses cache, clears successful empty catalogs, and preserves other project references', async () => {
    const existing = [{ path: '/repo/feature', branch: 'feature', projectDirectory: '/repo', label: 'feature' }];
    const other = [{ path: '/other/feature', branch: 'feature', projectDirectory: '/other', label: 'feature' }];
    sessionState.availableWorktreesByProject = new Map([['/repo', existing], ['/other', other]]);
    const refresh = forceRefreshProjectWorktreeCatalog({ id: 'project-1', path: '/repo' });
    await waitForListCallCount(1);
    listResolvers[0]([]);
    const result = await refresh;
    expect(result.removedDirectories).toEqual(['/repo/feature']);
    expect(sessionState.availableWorktreesByProject.get('/repo')).toEqual([]);
    expect(sessionState.availableWorktreesByProject.get('/other')).toBe(other);
  });

  test('path-upserts an already discovered worktree as one pending entry', async () => {
    const existing = { path: '/repo-feature', branch: 'feature', projectDirectory: '/repo', label: 'feature', worktreeStatus: 'ready' as const };
    sessionState.availableWorktreesByProject = new Map([['/repo', [existing]]]);
    await createWorktree({ id: 'project-1', path: '/repo' }, { preferredName: 'feature', mode: 'new', branchName: 'feature', worktreeName: 'feature', returnAfterDirectoryCreated: true });
    const entries = sessionState.availableWorktreesByProject.get('/repo') ?? [];
    expect(entries).toHaveLength(1); expect(entries[0]?.path).toBe('/repo-feature'); expect(entries[0]?.worktreeStatus).toBe('pending');
  });

  test('keeps a pending create as one entry through force-refresh invalidation races', async () => {
    const project = { id: 'project-1', path: '/repo' };
    const refresh = forceRefreshProjectWorktreeCatalog(project);
    await waitForListCallCount(1);
    await createWorktree(project, { preferredName: 'feature', mode: 'new', branchName: 'feature', worktreeName: 'feature', returnAfterDirectoryCreated: true });
    listResolvers[0]([]);
    await waitForListCallCount(2);
    listResolvers[1]([createdWorktree]);
    const result = await refresh;
    const entries = sessionState.availableWorktreesByProject.get('/repo') ?? [];
    expect(entries).toHaveLength(1); expect(entries[0]?.worktreeStatus).toBe('pending'); expect(result.addedDirectories).toEqual([]);
  });

  test('clears metadata and matching attachments after a successful empty force refresh', async () => {
    const removed = { path: '/repo/feature', branch: 'feature', projectDirectory: '/repo', label: 'feature' };
    const retained = { path: '/other/feature', branch: 'feature', projectDirectory: '/other', label: 'feature' };
    sessionState.availableWorktreesByProject = new Map([['/repo', [removed]], ['/other', [retained]]]);
    sessionState.worktreeMetadata = new Map([['removed', removed], ['retained', retained]]);
    sessionWorktreeState.attachments = new Map([
      ['removed', { worktreeRoot: '/repo/feature', cwd: '/repo/feature', branch: 'feature', headState: 'branch', worktreeStatus: 'ready', worktreeSource: 'existing', legacy: false, degraded: false }],
      ['retained', { worktreeRoot: '/other/feature', cwd: '/other/feature', branch: 'feature', headState: 'branch', worktreeStatus: 'ready', worktreeSource: 'existing', legacy: false, degraded: false }],
    ]);
    const refresh = forceRefreshProjectWorktreeCatalog({ id: 'project-1', path: '/repo' }); await waitForListCallCount(1); listResolvers[0]([]); await refresh;
    expect(sessionState.worktreeMetadata).toEqual(new Map([['retained', retained]])); expect([...sessionWorktreeState.attachments.keys()]).toEqual(['retained']); expect(clearedAttachmentSessions).toEqual(['removed']);
  });

  test('commits matching path and branch when discovered head state or name changes', async () => {
    const current = { path: '/repo/feature', branch: '', name: 'old', label: 'old', projectDirectory: '/repo', headState: 'unborn' as const, worktreeRoot: '/repo/feature', worktreeStatus: 'ready' as const, worktreeSource: 'existing' as const, source: 'sdk' as const };
    sessionState.availableWorktreesByProject = new Map([['/repo', [current]]]);
    const refresh = forceRefreshProjectWorktreeCatalog({ id: 'project-1', path: '/repo' }); await waitForListCallCount(1); listResolvers[0]([{ path: '/repo/feature', branch: '', head: 'abc', name: 'new' }]); await refresh;
    expect(sessionState.availableWorktreesByProject.get('/repo')?.[0]?.name).toBe('new'); expect(sessionState.availableWorktreesByProject.get('/repo')?.[0]?.headState).toBe('detached');
  });

  test('isolates cache and stale completions by runtime transport identity', async () => {
    const project = { id: 'project-1', path: '/repo' };
    runtimeIdentity = 'A'; const requestA = listProjectWorktrees(project); await waitForListCallCount(1);
    runtimeIdentity = 'B'; const requestB = listProjectWorktrees(project); await waitForListCallCount(2);
    listResolvers[0]([{ path: '/repo/a', branch: 'a' }]); await requestA;
    listResolvers[1]([{ path: '/repo/b', branch: 'b' }]); await requestB;
    runtimeIdentity = 'A'; const requestAAgain = listProjectWorktrees(project); await waitForListCallCount(3); listResolvers[2]([{ path: '/repo/a2', branch: 'a2' }]);
    expect((await requestAAgain).map((entry) => entry.path)).toEqual(['/repo/a2']);
  });
});

describe('removeProjectWorktree', () => {
  test('clears removed worktree state while retaining attachments for other directories', async () => {
    const project = { id: 'project-1', path: '/repo' };
    const removed = {
      path: '/repo/feature/',
      branch: 'feature',
      projectDirectory: '/repo',
      label: 'feature',
    };
    const retained = {
      path: '/repo/other',
      branch: 'other',
      projectDirectory: '/repo',
      label: 'other',
    };
    sessionState.availableWorktreesByProject = new Map([['/repo', [removed, retained]]]);
    sessionState.availableWorktrees = [removed, retained];
    sessionState.worktreeMetadata = new Map([
      ['removed-session', removed],
      ['retained-session', retained],
    ]);
    sessionWorktreeState.attachments = new Map([
      ['root-session', {
        worktreeRoot: '/repo/feature', cwd: '/repo', branch: 'feature', headState: 'branch',
        worktreeStatus: 'ready', worktreeSource: 'existing', legacy: false, degraded: false,
      }],
      ['cwd-session', {
        worktreeRoot: '/repo', cwd: '/repo/feature/', branch: 'feature', headState: 'branch',
        worktreeStatus: 'ready', worktreeSource: 'existing', legacy: false, degraded: false,
      }],
      ['retained-session', {
        worktreeRoot: '/repo/other', cwd: '/repo/other', branch: 'other', headState: 'branch',
        worktreeStatus: 'ready', worktreeSource: 'existing', legacy: false, degraded: false,
      }],
    ]);

    await removeProjectWorktree(project, removed, { deleteLocalBranch: true });

    expect(removeWorktreeCalls).toEqual([['/repo', {
      directory: '/repo/feature/',
      deleteLocalBranch: true,
    }]]);
    expect(sessionState.availableWorktreesByProject.get('/repo')).toEqual([retained]);
    expect(sessionState.availableWorktrees).toEqual([retained]);
    expect(sessionState.worktreeMetadata).toEqual(new Map([['retained-session', retained]]));
    expect([...sessionWorktreeState.attachments.keys()]).toEqual(['retained-session']);
    expect(clearedAttachmentSessions).toEqual(['root-session', 'cwd-session']);
  });
});

describe('worktreeMapsEqual', () => {
  const wt = (
    path: string,
    branch: string,
    overrides: Partial<WorktreeMetadata> = {},
  ): WorktreeMetadata => ({
    path,
    branch,
    projectDirectory: '/repo',
    label: branch,
    ...overrides,
  });

  test('returns true for two empty maps', () => {
    const a = new Map<string, WorktreeMetadata[]>();
    const b = new Map<string, WorktreeMetadata[]>();
    expect(worktreeMapsEqual(a, b)).toBe(true);
  });

  test('returns true when paths and branches match in order', () => {
    const a = new Map([['/repo', [wt('/r/main', 'main'), wt('/r/feat', 'feat')]]]);
    const b = new Map([['/repo', [wt('/r/main', 'main'), wt('/r/feat', 'feat')]]]);
    expect(worktreeMapsEqual(a, b)).toBe(true);
  });

  test('returns false when same path has a different branch (external git checkout)', () => {
    const a = new Map([['/repo', [wt('/r/main', 'main')]]]);
    const b = new Map([['/repo', [wt('/r/main', 'develop')]]]);
    expect(worktreeMapsEqual(a, b)).toBe(false);
  });

  test('returns false when head state changes without a branch change', () => {
    const a = new Map([['/repo', [wt('/r/main', '', { headState: 'unborn' })]]]);
    const b = new Map([['/repo', [wt('/r/main', '', { headState: 'detached' })]]]);
    expect(worktreeMapsEqual(a, b)).toBe(false);
  });

  test('returns false when discovered display metadata changes', () => {
    const a = new Map([['/repo', [wt('/r/main', '', { name: 'old', label: 'old' })]]]);
    const b = new Map([['/repo', [wt('/r/main', '', { name: 'new', label: 'new' })]]]);
    expect(worktreeMapsEqual(a, b)).toBe(false);
  });

  test('returns false when paths differ', () => {
    const a = new Map([['/repo', [wt('/r/main', 'main')]]]);
    const b = new Map([['/repo', [wt('/r/other', 'main')]]]);
    expect(worktreeMapsEqual(a, b)).toBe(false);
  });

  test('returns false when per-project array lengths differ', () => {
    const a = new Map([['/repo', [wt('/r/main', 'main')]]]);
    const b = new Map([['/repo', [wt('/r/main', 'main'), wt('/r/feat', 'feat')]]]);
    expect(worktreeMapsEqual(a, b)).toBe(false);
  });

  test('returns false when number of project keys differ', () => {
    const a = new Map<string, WorktreeMetadata[]>([['/repo', [wt('/r/main', 'main')]]]);
    const b = new Map<string, WorktreeMetadata[]>([
      ['/repo', [wt('/r/main', 'main')]],
      ['/repo-2', [wt('/r2/main', 'main')]],
    ]);
    expect(worktreeMapsEqual(a, b)).toBe(false);
  });

  test('returns false when worktrees are reordered (positional compare)', () => {
    const a = new Map([['/repo', [wt('/r/main', 'main'), wt('/r/feat', 'feat')]]]);
    const b = new Map([['/repo', [wt('/r/feat', 'feat'), wt('/r/main', 'main')]]]);
    expect(worktreeMapsEqual(a, b)).toBe(false);
  });

  test('returns false when a non-first worktree differs (subset of entries)', () => {
    const a = new Map([
      ['/repo', [wt('/r/main', 'main'), wt('/r/feat', 'feat'), wt('/r/old', 'old')]],
    ]);
    const b = new Map([
      ['/repo', [wt('/r/main', 'main'), wt('/r/feat', 'feat'), wt('/r/old', 'new-branch')]],
    ]);
    expect(worktreeMapsEqual(a, b)).toBe(false);
  });
});
