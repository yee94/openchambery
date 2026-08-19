import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Session } from '@opencode-ai/sdk/v2';

const mocks = vi.hoisted(() => {
  const upsertedSessions: Session[] = [];
  const registeredDirectories: Array<{ sessionID: string; directory: string }> = [];
  const ensureChildCalls: Array<{ directory: string; bootstrap?: boolean }> = [];
  const worktreeMetadataCalls: Array<{ sessionId: string; path: string }> = [];
  const worktreeCreateCalls: Array<{ project: { id?: string; path: string }; args: Record<string, unknown>; options: unknown }> = [];
  const worktreeBootstrapWaitCalls: string[] = [];
  const operationOrder: string[] = [];
  const childState = {
    session: [] as Session[],
    sessionTotal: 0,
    limit: 20,
  };
  const state = {
    isGitRepository: false,
    waitForWorktreeSetup: false,
    currentDirectory: '/repo',
  };
  return {
    upsertedSessions,
    registeredDirectories,
    ensureChildCalls,
    worktreeMetadataCalls,
    worktreeCreateCalls,
    worktreeBootstrapWaitCalls,
    operationOrder,
    childState,
    state,
  };
});

vi.mock('@/sync/session-ui-store', () => ({
  routeMessage: vi.fn(() => Promise.resolve()),
  useSessionUIStore: {
    getState: () => ({
      markSessionAsOpenChamberCreated: vi.fn(() => undefined),
      setWorktreeMetadata: (sessionId: string, metadata: { path: string }) => {
        mocks.worktreeMetadataCalls.push({ sessionId, path: metadata.path });
      },
    }),
  },
}));

vi.mock('@/lib/opencode/client', () => ({
  opencodeClient: {
    setDirectory: vi.fn(),
    withDirectory: async (directory: string, fn: () => Promise<Session>) => {
      const previous = mocks.state.currentDirectory;
      mocks.state.currentDirectory = directory;
      try {
        return await fn();
      } finally {
        mocks.state.currentDirectory = previous;
      }
    },
    createSession: async (params?: { title?: string }): Promise<Session> => {
      mocks.operationOrder.push(`createSession:${mocks.state.currentDirectory}`);
      return {
        id: 'ses_multirun',
        title: params?.title ?? '',
        directory: mocks.state.currentDirectory,
        time: { created: 1, updated: 1 },
      } as Session;
    },
  },
}));

vi.mock('@/lib/gitApi', () => ({
  checkIsGitRepository: vi.fn(() => Promise.resolve(mocks.state.isGitRepository)),
}));

vi.mock('@/lib/worktrees/worktreeCreate', () => ({
  createWorktreeWithDefaults: vi.fn((project: { id?: string; path: string }, args: Record<string, unknown>, options: unknown) => {
    mocks.worktreeCreateCalls.push({ project, args, options });
    return Promise.resolve({
      source: 'sdk',
      name: 'fix-thing',
      path: '/repo-worktrees/fix-thing',
      projectDirectory: '/repo',
      branch: 'fix-thing',
      label: 'fix-thing',
      worktreeRoot: '/repo-worktrees/fix-thing',
      worktreeStatus: 'pending',
      headState: 'branch',
      worktreeSource: 'created-for-session',
    });
  }),
  resolveRootTrackingRemote: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('@/lib/worktrees/worktreeBootstrap', () => ({
  waitForWorktreeBootstrap: (directory: string) => {
    mocks.worktreeBootstrapWaitCalls.push(directory);
    mocks.operationOrder.push(`wait:${directory}`);
    return Promise.resolve();
  },
}));

vi.mock('@/lib/worktrees/worktreeStatus', () => ({
  getRootBranch: vi.fn(() => Promise.resolve('main')),
}));

vi.mock('@/lib/openchamberConfig', () => ({
  getWorktreeSetupWaitEnabled: vi.fn(() => Promise.resolve(mocks.state.waitForWorktreeSetup)),
  saveWorktreeSetupCommands: vi.fn(() => Promise.resolve()),
}));

vi.mock('./useDirectoryStore', () => ({
  useDirectoryStore: {
    getState: () => ({ currentDirectory: '/repo' }),
  },
}));

vi.mock('./useProjectsStore', () => ({
  useProjectsStore: {
    getState: () => ({
      activeProjectId: 'project-1',
      projects: [{ id: 'project-1', path: '/repo' }],
    }),
  },
}));

vi.mock('./useSnippetsStore', () => ({
  useSnippetsStore: {
    getState: () => ({
      expandText: (value: string) => Promise.resolve(value),
    }),
  },
}));

vi.mock('./useGlobalSessionsStore', () => ({
  useGlobalSessionsStore: {
    getState: () => ({
      upsertSession: (session: Session) => {
        mocks.upsertedSessions.push(session);
      },
    }),
  },
}));

vi.mock('@/sync/sync-refs', () => ({
  registerSessionDirectory: (sessionID: string, directory: string) => {
    mocks.registeredDirectories.push({ sessionID, directory });
  },
  getSyncChildStores: () => ({
    ensureChild: (directory: string, options?: { bootstrap?: boolean }) => {
      mocks.ensureChildCalls.push({ directory, bootstrap: options?.bootstrap });
      return {
        setState: (updater: typeof mocks.childState | ((state: typeof mocks.childState) => Partial<typeof mocks.childState> | typeof mocks.childState)) => {
          const patch = typeof updater === 'function' ? updater(mocks.childState) : updater;
          if (patch !== mocks.childState) {
            Object.assign(mocks.childState, patch);
          }
        },
      };
    },
  }),
}));

const { useMultiRunStore } = await import('./useMultiRunStore');

describe('useMultiRunStore', () => {
  beforeEach(() => {
    mocks.upsertedSessions.length = 0;
    mocks.registeredDirectories.length = 0;
    mocks.ensureChildCalls.length = 0;
    mocks.worktreeMetadataCalls.length = 0;
    mocks.worktreeCreateCalls.length = 0;
    mocks.worktreeBootstrapWaitCalls.length = 0;
    mocks.operationOrder.length = 0;
    mocks.state.isGitRepository = false;
    mocks.state.waitForWorktreeSetup = false;
    mocks.childState.session = [];
    mocks.childState.sessionTotal = 0;
    mocks.childState.limit = 20;
    mocks.state.currentDirectory = '/repo';
    useMultiRunStore.setState({ isLoading: false, error: null });
  });

  test('registers created sessions without waiting for a sidebar refresh', async () => {
    const result = await useMultiRunStore.getState().createMultiRun({
      name: 'Fix thing',
      isolateRuns: false,
      groups: [{
        prompt: 'Fix it',
        models: [{ providerID: 'anthropic', modelID: 'claude-sonnet-4-5' }],
      }],
    });

    expect(result?.sessionIds).toEqual(['ses_multirun']);
    expect(mocks.upsertedSessions.map((session) => session.id)).toEqual(['ses_multirun']);
    expect(mocks.registeredDirectories).toEqual([{ sessionID: 'ses_multirun', directory: '/repo' }]);
    expect(mocks.ensureChildCalls).toEqual([{ directory: '/repo', bootstrap: false }]);
    expect(mocks.childState.session.map((session) => session.id)).toEqual(['ses_multirun']);
  });

  test('uses fast background worktree creation for isolated runs', async () => {
    mocks.state.isGitRepository = true;

    const result = await useMultiRunStore.getState().createMultiRun({
      name: 'Fix thing',
      isolateRuns: true,
      groups: [{
        prompt: 'Fix it',
        models: [{ providerID: 'anthropic', modelID: 'claude-sonnet-4-5' }],
      }],
    });

    expect(result?.sessionIds).toEqual(['ses_multirun']);
    expect(mocks.worktreeCreateCalls.length).toBe(1);
    expect(mocks.worktreeCreateCalls[0]?.project).toEqual({ id: 'project-1', path: '/repo' });
    expect(mocks.worktreeCreateCalls[0]?.args.returnAfterDirectoryCreated).toBe(true);
    expect(mocks.worktreeCreateCalls[0]?.options).toEqual({ resolvedRootTrackingRemote: null });
    expect(mocks.worktreeBootstrapWaitCalls).toEqual([]);
    expect(mocks.operationOrder).toEqual(['createSession:/repo-worktrees/fix-thing']);
    expect(mocks.registeredDirectories).toEqual([{ sessionID: 'ses_multirun', directory: '/repo-worktrees/fix-thing' }]);
    expect(mocks.worktreeMetadataCalls).toEqual([{ sessionId: 'ses_multirun', path: '/repo-worktrees/fix-thing' }]);
  });

  test('waits for isolated worktree bootstrap when setup wait is enabled', async () => {
    mocks.state.isGitRepository = true;
    mocks.state.waitForWorktreeSetup = true;

    const result = await useMultiRunStore.getState().createMultiRun({
      name: 'Fix thing',
      isolateRuns: true,
      groups: [{
        prompt: 'Fix it',
        models: [{ providerID: 'anthropic', modelID: 'claude-sonnet-4-5' }],
      }],
    });

    expect(result?.sessionIds).toEqual(['ses_multirun']);
    expect(mocks.worktreeBootstrapWaitCalls).toEqual(['/repo-worktrees/fix-thing']);
    expect(mocks.operationOrder).toEqual([
      'wait:/repo-worktrees/fix-thing',
      'createSession:/repo-worktrees/fix-thing',
    ]);
  });
});
