import { beforeEach, describe, expect, mock, test } from 'bun:test';

const bootstrapStatusCalls: string[] = [];
let bootstrapStatusResult: { status: 'pending' | 'ready' | 'failed'; error: string | null; updatedAt: number } = {
  status: 'ready',
  error: null,
  updatedAt: 1,
};
let bootstrapStatusHandler: ((directory: string) => Promise<typeof bootstrapStatusResult>) | null = null;
const toastErrors: Array<{ title: string; description?: string }> = [];
type OpenChamberListener = (event: {
  type: string;
  directory?: string;
  status?: 'pending' | 'ready' | 'failed';
  error?: string | null;
  updatedAt?: number;
}) => void;
const openchamberListeners = new Set<OpenChamberListener>();

mock.module('@/components/ui', () => ({
  toast: {
    error: (title: string, options?: { description?: string }) => {
      toastErrors.push({ title, description: options?.description });
    },
  },
}));

mock.module('@/lib/i18n', () => ({
  formatMessage: (_dictionary: Record<string, string>, key: string) => key,
  useI18nStore: {
    getState: () => ({ dictionary: {} }),
  },
}));

const resolveBootstrapStatus = (directory: string) => {
  bootstrapStatusCalls.push(directory);
  if (bootstrapStatusHandler) {
    return bootstrapStatusHandler(directory);
  }
  return Promise.resolve(bootstrapStatusResult);
};

mock.module('@/contexts/runtimeAPIRegistry', () => ({
  getRegisteredRuntimeAPIs: () => ({
    git: {
      worktree: {
        bootstrapStatus: (directory: string) => resolveBootstrapStatus(directory),
      },
    },
  }),
}));

mock.module('@/lib/gitApiHttp', () => ({
  getGitWorktreeBootstrapStatus: (directory: string) => resolveBootstrapStatus(directory),
}));

mock.module('@/lib/openchamberEvents', () => ({
  subscribeOpenchamberEvents: (listener: OpenChamberListener) => {
    openchamberListeners.add(listener);
    return () => {
      openchamberListeners.delete(listener);
    };
  },
}));

const {
  applyWorktreeBootstrapStatusEvent,
  clearWorktreeBootstrapState,
  getWorktreeBootstrapState,
  markWorktreeBootstrapPending,
  startWorktreeBootstrapWatcher,
  waitForWorktreeBootstrap,
} = await import('./worktreeBootstrap');

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for condition');
};

const emitBootstrapStatus = (
  directory: string,
  status: 'pending' | 'ready' | 'failed',
  error: string | null = null,
  updatedAt = Date.now(),
) => {
  const event = {
    type: 'worktree-bootstrap-status',
    directory,
    status,
    error,
    updatedAt,
  };
  for (const listener of openchamberListeners) listener(event);
};

describe('worktreeBootstrap.waitForWorktreeBootstrap', () => {
  beforeEach(() => {
    bootstrapStatusCalls.length = 0;
    toastErrors.length = 0;
    bootstrapStatusHandler = null;
    bootstrapStatusResult = { status: 'ready', error: null, updatedAt: 1 };
    clearWorktreeBootstrapState('/repo');
    clearWorktreeBootstrapState('/repo-wt');
  });

  test('does not seed directories that were not marked pending', async () => {
    await waitForWorktreeBootstrap('/repo');

    expect(bootstrapStatusCalls).toEqual([]);
  });

  test('seeds once when the directory was explicitly marked pending', async () => {
    markWorktreeBootstrapPending('/repo-wt');

    await waitForWorktreeBootstrap('/repo-wt');

    expect(bootstrapStatusCalls).toEqual(['/repo-wt']);
  });

  test('background watcher seeds pending worktrees and settles on events without polling', async () => {
    bootstrapStatusResult = { status: 'pending', error: null, updatedAt: 2 };
    markWorktreeBootstrapPending('/repo-wt');
    const readyStatuses: Array<{ status: 'pending' | 'ready' | 'failed'; error: string | null; updatedAt: number }> = [];

    startWorktreeBootstrapWatcher('/repo-wt', {
      onReady: (status) => readyStatuses.push(status),
    });

    await waitFor(() => bootstrapStatusCalls.length === 1);
    emitBootstrapStatus('/repo-wt', 'ready');
    await waitFor(() => readyStatuses.length === 1);

    expect(bootstrapStatusCalls).toEqual(['/repo-wt']);
    expect(readyStatuses.map((status) => status.status)).toEqual(['ready']);
    expect(toastErrors).toEqual([]);
  });

  test('background watcher settles from an authoritative compensation read after a missed ready event', async () => {
    let requestCount = 0;
    bootstrapStatusHandler = async () => {
      requestCount += 1;
      return requestCount === 1
        ? { status: 'pending', error: null, updatedAt: 2 }
        : { status: 'ready', error: null, updatedAt: 3 };
    };
    markWorktreeBootstrapPending('/repo-wt');
    const readyStatuses: Array<{ status: 'pending' | 'ready' | 'failed'; error: string | null; updatedAt: number }> = [];

    startWorktreeBootstrapWatcher('/repo-wt', {
      pollIntervalMs: 1,
      onReady: (status) => readyStatuses.push(status),
    });

    await waitFor(() => readyStatuses.length === 1);

    expect(bootstrapStatusCalls).toEqual(['/repo-wt', '/repo-wt']);
    expect(getWorktreeBootstrapState('/repo-wt')?.status).toBe('ready');
    expect(readyStatuses.map((status) => status.status)).toEqual(['ready']);
    expect(toastErrors).toEqual([]);
  });

  test('background watcher shows a toast when bootstrap fails via event', async () => {
    bootstrapStatusResult = { status: 'pending', error: null, updatedAt: 2 };
    markWorktreeBootstrapPending('/repo-wt');

    startWorktreeBootstrapWatcher('/repo-wt');
    await waitFor(() => bootstrapStatusCalls.length === 1);
    emitBootstrapStatus('/repo-wt', 'failed', 'setup failed');

    await waitFor(() => toastErrors.length === 1);
    expect(toastErrors).toEqual([{ title: 'worktree.bootstrap.toast.failed', description: 'setup failed' }]);
  });

  test('background watcher marks failed and toasts when bootstrap times out', async () => {
    bootstrapStatusResult = { status: 'pending', error: null, updatedAt: 2 };
    markWorktreeBootstrapPending('/repo-wt');
    const failedStatuses: Array<{ status: 'pending' | 'ready' | 'failed'; error: string | null; updatedAt: number }> = [];

    startWorktreeBootstrapWatcher('/repo-wt', {
      timeoutMs: 0,
      onFailed: (status) => failedStatuses.push(status),
    });

    await waitFor(() => toastErrors.length === 1);
    expect(getWorktreeBootstrapState('/repo-wt')?.status).toBe('failed');
    expect(failedStatuses.map((status) => status.status)).toEqual(['failed']);
    expect(toastErrors).toEqual([{
      title: 'worktree.bootstrap.toast.failed',
      description: 'worktree.bootstrap.toast.timeoutDescription',
    }]);
  });

  test('background watcher is deduped per directory', async () => {
    bootstrapStatusResult = { status: 'pending', error: null, updatedAt: 2 };
    markWorktreeBootstrapPending('/repo-wt');

    startWorktreeBootstrapWatcher('/repo-wt');
    startWorktreeBootstrapWatcher('/repo-wt');

    await waitFor(() => bootstrapStatusCalls.length === 1);
    expect(bootstrapStatusCalls).toEqual(['/repo-wt']);
    clearWorktreeBootstrapState('/repo-wt');
  });

  test('applyWorktreeBootstrapStatusEvent updates local state for WS consumers', () => {
    markWorktreeBootstrapPending('/repo-wt');
    applyWorktreeBootstrapStatusEvent('/repo-wt', {
      status: 'ready',
      error: null,
      updatedAt: 9,
    });
    expect(getWorktreeBootstrapState('/repo-wt')).toEqual({
      status: 'ready',
      error: null,
      updatedAt: 9,
    });
  });

  test('rejects an older pending seed after a newer ready event', async () => {
    let releaseSeed: ((value: typeof bootstrapStatusResult) => void) | null = null;
    bootstrapStatusHandler = () => new Promise((resolve) => {
      releaseSeed = resolve;
    });

    markWorktreeBootstrapPending('/repo-wt');
    startWorktreeBootstrapWatcher('/repo-wt');
    await waitFor(() => bootstrapStatusCalls.length === 1);

    const readyAt = Date.now() + 100;
    emitBootstrapStatus('/repo-wt', 'ready', null, readyAt);
    expect(getWorktreeBootstrapState('/repo-wt')?.status).toBe('ready');

    const release = releaseSeed as ((value: typeof bootstrapStatusResult) => void) | null;
    release?.({ status: 'pending', error: null, updatedAt: readyAt - 50 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getWorktreeBootstrapState('/repo-wt')).toEqual({
      status: 'ready',
      error: null,
      updatedAt: readyAt,
    });
    expect(toastErrors).toEqual([]);
  });

  test('clear disposes the old timeout so a restarted watcher is not failed by it', async () => {
    bootstrapStatusResult = { status: 'pending', error: null, updatedAt: 2 };
    markWorktreeBootstrapPending('/repo-wt');

    const firstFailed: Array<{ status: string }> = [];
    startWorktreeBootstrapWatcher('/repo-wt', {
      timeoutMs: 30,
      onFailed: (status) => firstFailed.push(status),
    });
    await waitFor(() => bootstrapStatusCalls.length === 1);

    clearWorktreeBootstrapState('/repo-wt');
    markWorktreeBootstrapPending('/repo-wt');
    const secondReady: Array<{ status: string }> = [];
    startWorktreeBootstrapWatcher('/repo-wt', {
      timeoutMs: 5_000,
      onReady: (status) => secondReady.push(status),
    });
    await waitFor(() => bootstrapStatusCalls.length === 2);

    await new Promise((resolve) => setTimeout(resolve, 50));
    emitBootstrapStatus('/repo-wt', 'ready', null, Date.now());
    await waitFor(() => secondReady.length === 1);

    expect(firstFailed).toEqual([]);
    expect(getWorktreeBootstrapState('/repo-wt')?.status).toBe('ready');
    expect(toastErrors).toEqual([]);
  });

  test('clear bumps epoch so a late seed from a cancelled watcher cannot rewrite state', async () => {
    let releaseSeed: ((value: typeof bootstrapStatusResult) => void) | null = null;
    bootstrapStatusHandler = () => new Promise((resolve) => {
      releaseSeed = resolve;
    });

    markWorktreeBootstrapPending('/repo-wt');
    startWorktreeBootstrapWatcher('/repo-wt');
    await waitFor(() => bootstrapStatusCalls.length === 1);

    clearWorktreeBootstrapState('/repo-wt');
    markWorktreeBootstrapPending('/repo-wt');
    expect(getWorktreeBootstrapState('/repo-wt')?.status).toBe('pending');

    const release = releaseSeed as ((value: typeof bootstrapStatusResult) => void) | null;
    release?.({ status: 'failed', error: 'stale seed', updatedAt: Date.now() + 1_000 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getWorktreeBootstrapState('/repo-wt')?.status).toBe('pending');
    expect(getWorktreeBootstrapState('/repo-wt')?.error).toBeNull();
    expect(toastErrors).toEqual([]);
  });
});
