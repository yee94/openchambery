import { beforeEach, describe, expect, test } from 'bun:test';
import type { GitBranch, GitStatus } from '@/lib/api/types';
import { useGitStore } from './useGitStore';
import { queryClient } from '@/lib/queryRuntime';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

type GitAPI = Parameters<ReturnType<typeof useGitStore.getState>['fetchStatus']>[1];
type DirectoryGitState = NonNullable<ReturnType<ReturnType<typeof useGitStore.getState>['getDirectoryState']>>;

const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const createStatus = (diffStats?: GitStatus['diffStats'], files: GitStatus['files'] = []): GitStatus => ({
  current: 'main',
  tracking: null,
  ahead: 0,
  behind: 0,
  files,
  isClean: files.length === 0,
  diffStats,
});

const createDirectoryState = (status: GitStatus): DirectoryGitState => ({
  isGitRepo: true,
  status,
  branches: null,
  branchesTransportIdentity: null,
  log: null,
  identity: null,
  diffCache: new Map(),
  indexRevision: 0,
  lastRepoCheckAt: 0,
  lastStatusFetch: 0,
  lastStatusChange: 0,
  lastLogFetch: 0,
  lastBranchesFetch: 0,
  lastIdentityFetch: 0,
  logMaxCount: 25,
  isLoadingStatus: false,
  isLoadingLog: false,
  isLoadingBranches: false,
  isLoadingIdentity: false,
});

const setDirectoryStatus = (status: GitStatus) => {
  useGitStore.setState({
    directories: new Map([['/repo', createDirectoryState(status)]]),
    activeDirectory: '/repo',
  });
};

const createGitApi = (getGitStatus: GitAPI['getGitStatus']): GitAPI => ({
  checkIsGitRepository: async () => true,
  getGitStatus,
  getGitBranches: async () => ({ all: [], current: 'main', branches: {} }),
  getGitLog: async () => ({ all: [], latest: null, total: 0 }),
  getCurrentGitIdentity: async () => null,
  getGitFileDiff: async (_directory, options) => ({ original: '', modified: '', path: options.path }),
});

describe('useGitStore', () => {
  beforeEach(() => {
    queryClient.clear();
    useGitStore.setState({
      directories: new Map(),
      activeDirectory: null,
    });
  });

  test('mirrors the Query branches snapshot and force refreshes it', async () => {
    let calls = 0;
    const git = createGitApi(async () => createStatus());
    git.getGitBranches = async () => {
      calls += 1;
      return { all: [calls === 1 ? 'main' : 'next'], current: calls === 1 ? 'main' : 'next', branches: {} };
    };

    await useGitStore.getState().fetchBranches('/repo', git);
    await useGitStore.getState().fetchBranches('/repo', git);
    await useGitStore.getState().fetchBranches('/repo', git, { force: true });

    expect(calls).toBe(2);
    expect(useGitStore.getState().getDirectoryState('/repo')?.branches?.current).toBe('next');
  });

  test('keeps the latest branches fetch loading while an earlier runtime request completes', async () => {
    const oldRequest = createDeferred<GitBranch>();
    const newRequest = createDeferred<GitBranch>();
    const oldGit = createGitApi(async () => createStatus());
    oldGit.getGitBranches = () => oldRequest.promise;
    const newGit = createGitApi(async () => createStatus());
    newGit.getGitBranches = () => newRequest.promise;
    switchRuntimeEndpoint({ apiBaseUrl: 'http://runtime-a.test' });
    const oldFetch = useGitStore.getState().fetchBranches('/repo', oldGit);
    await Promise.resolve();

    switchRuntimeEndpoint({ apiBaseUrl: 'http://runtime-b.test' });
    const newFetch = useGitStore.getState().fetchBranches('/repo', newGit);
    await Promise.resolve();

    oldRequest.resolve({ all: ['old'], current: 'old', branches: {} });
    await oldFetch;
    expect(useGitStore.getState().getDirectoryState('/repo')?.branches).toBeNull();
    expect(useGitStore.getState().getDirectoryState('/repo')?.isLoadingBranches).toBe(true);

    newRequest.resolve({ all: ['new'], current: 'new', branches: {} });
    await newFetch;
    expect(useGitStore.getState().getDirectoryState('/repo')?.branches).toEqual({ all: ['new'], current: 'new', branches: {} });
    expect(useGitStore.getState().getDirectoryState('/repo')?.isLoadingBranches).toBe(false);
  });

  test('keeps the latest branches fetch loading when an earlier runtime request fails', async () => {
    const oldRequest = createDeferred<GitBranch>();
    const newRequest = createDeferred<GitBranch>();
    const oldGit = createGitApi(async () => createStatus());
    oldGit.getGitBranches = () => oldRequest.promise;
    const newGit = createGitApi(async () => createStatus());
    newGit.getGitBranches = () => newRequest.promise;
    switchRuntimeEndpoint({ apiBaseUrl: 'http://runtime-c.test' });
    const oldFetch = useGitStore.getState().fetchBranches('/repo', oldGit);
    await Promise.resolve();

    switchRuntimeEndpoint({ apiBaseUrl: 'http://runtime-d.test' });
    const newFetch = useGitStore.getState().fetchBranches('/repo', newGit);
    await Promise.resolve();

    oldRequest.reject(new Error('offline'));
    await oldFetch;
    expect(useGitStore.getState().getDirectoryState('/repo')?.isLoadingBranches).toBe(true);

    newRequest.resolve({ all: ['new'], current: 'new', branches: {} });
    await newFetch;
    expect(useGitStore.getState().getDirectoryState('/repo')?.isLoadingBranches).toBe(false);
  });

  test('does not reuse an in-flight light status request for full status', async () => {
    const requests: Deferred<GitStatus>[] = [];
    const statusCalls: Array<{ directory: string; options?: { mode?: 'light' } }> = [];
    const git = createGitApi((directory, options) => {
      statusCalls.push({ directory, options });
      const request = createDeferred<GitStatus>();
      requests.push(request);
      return request.promise;
    });

    const lightPromise = useGitStore.getState().fetchStatus('/repo', git, { mode: 'light', silent: true });
    const fullPromise = useGitStore.getState().fetchStatus('/repo', git, { silent: true });
    await Promise.resolve();

    expect(statusCalls).toEqual([
      { directory: '/repo', options: { mode: 'light' } },
      { directory: '/repo', options: undefined },
    ]);

    requests[0].resolve(createStatus());
    requests[1].resolve(createStatus({ 'src/index.ts': { insertions: 1, deletions: 0 } }));
    await Promise.all([lightPromise, fullPromise]);
  });

  test('reuses an in-flight full status request for light status', async () => {
    const requests: Deferred<GitStatus>[] = [];
    const statusCalls: Array<{ directory: string; options?: { mode?: 'light' } }> = [];
    const git = createGitApi((directory, options) => {
      statusCalls.push({ directory, options });
      const request = createDeferred<GitStatus>();
      requests.push(request);
      return request.promise;
    });

    const fullPromise = useGitStore.getState().fetchStatus('/repo', git, { silent: true });
    const lightPromise = useGitStore.getState().fetchStatus('/repo', git, { mode: 'light', silent: true });
    await Promise.resolve();

    expect(statusCalls).toEqual([{ directory: '/repo', options: undefined }]);

    requests[0].resolve(createStatus({ 'src/index.ts': { insertions: 1, deletions: 0 } }));
    const [fullResult, lightResult] = await Promise.all([fullPromise, lightPromise]);
    expect(lightResult).toBe(fullResult);
  });

  test('keeps the stored status reference when a large identical snapshot arrives', async () => {
    const createLarge = () => createStatus(undefined, Array.from({ length: 60_000 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      index: ' ',
      working_dir: 'M',
    })));
    const initial = createLarge();
    setDirectoryStatus(initial);
    const before = useGitStore.getState().getDirectoryState('/repo');

    const changed = await useGitStore.getState().fetchStatus('/repo', createGitApi(async () => createLarge()), { silent: true });

    const after = useGitStore.getState().getDirectoryState('/repo');
    expect(changed).toBe(false);
    expect(after?.status).toBe(initial);
    expect(after?.indexRevision).toBe(before?.indexRevision);
  });

  test('a transport that re-delivers the same snapshot object skips change detection entirely', async () => {
    let pathReads = 0;
    const files = Array.from({ length: 1_000 }, (_, index) => new Proxy(
      { path: `src/file-${index}.ts`, index: ' ', working_dir: 'M' },
      {
        get(target, property, receiver) {
          if (property === 'path') pathReads += 1;
          return Reflect.get(target, property, receiver);
        },
      },
    ));
    const snapshot = createStatus(undefined, files);
    const git = createGitApi(async () => snapshot);
    await useGitStore.getState().fetchStatus('/repo', git, { silent: true });
    const stored = useGitStore.getState().getDirectoryState('/repo')?.status;
    pathReads = 0;

    const changed = await useGitStore.getState().fetchStatus('/repo', git, { silent: true });

    expect(changed).toBe(false);
    expect(pathReads).toBe(0);
    expect(useGitStore.getState().getDirectoryState('/repo')?.status).toBe(stored);
  });

  test('reports a single-file change inside a large snapshot and invalidates only that diff', async () => {
    const files = Array.from({ length: 20_000 }, (_, index) => ({ path: `src/file-${index}.ts`, index: ' ', working_dir: 'M' }));
    const initial = createStatus(undefined, files);
    useGitStore.setState({
      directories: new Map([['/repo', {
        ...createDirectoryState(initial),
        diffCache: new Map([
          ['src/file-1.ts', { original: 'a', modified: 'b', fetchedAt: 1 }],
          ['src/file-2.ts', { original: 'a', modified: 'b', fetchedAt: 1 }],
        ]),
      }]]),
      activeDirectory: '/repo',
    });
    const nextFiles = files.map((file) => (file.path === 'src/file-1.ts' ? { ...file, index: 'M', working_dir: ' ' } : { ...file }));

    const changed = await useGitStore.getState().fetchStatus('/repo', createGitApi(async () => createStatus(undefined, nextFiles)), { silent: true });

    const state = useGitStore.getState().getDirectoryState('/repo');
    expect(changed).toBe(true);
    expect(state?.indexRevision).toBe(1);
    expect(state?.diffCache.has('src/file-1.ts')).toBe(false);
    expect(state?.diffCache.has('src/file-2.ts')).toBe(true);
  });

  test('optimistically stages modified files and preserves untouched file references', () => {
    const target = { path: 'src/index.ts', index: ' ', working_dir: 'M' };
    const untouched = { path: 'README.md', index: ' ', working_dir: 'M' };
    const initialStatus = createStatus(undefined, [target, untouched]);
    setDirectoryStatus(initialStatus);

    const previousStatus = useGitStore.getState().moveStatusPathsOptimistically('/repo', ['src/index.ts'], 'stage');
    const status = useGitStore.getState().getDirectoryState('/repo')?.status;
    const state = useGitStore.getState().getDirectoryState('/repo');

    expect(previousStatus).toBe(initialStatus);
    expect(status?.files).toEqual([
      { path: 'src/index.ts', index: 'M', working_dir: ' ' },
      untouched,
    ]);
    expect(status?.files[1]).toBe(untouched);
    expect(state?.indexRevision).toBe(1);
  });

  test('optimistically stages untracked files as added files', () => {
    setDirectoryStatus(createStatus(undefined, [
      { path: 'new-file.ts', index: '?', working_dir: '?' },
    ]));

    useGitStore.getState().moveStatusPathsOptimistically('/repo', ['new-file.ts'], 'stage');
    const status = useGitStore.getState().getDirectoryState('/repo')?.status;

    expect(status?.files).toEqual([
      { path: 'new-file.ts', index: 'A', working_dir: ' ' },
    ]);
  });

  test('optimistically unstages staged files', () => {
    setDirectoryStatus(createStatus(undefined, [
      { path: 'src/index.ts', index: 'M', working_dir: ' ' },
    ]));

    useGitStore.getState().moveStatusPathsOptimistically('/repo', ['src/index.ts'], 'unstage');
    const status = useGitStore.getState().getDirectoryState('/repo')?.status;

    expect(status?.files).toEqual([
      { path: 'src/index.ts', index: ' ', working_dir: 'M' },
    ]);
  });

  test('optimistically unstages staged added files back to untracked files', () => {
    setDirectoryStatus(createStatus(undefined, [
      { path: 'new-file.ts', index: 'A', working_dir: ' ' },
    ]));

    useGitStore.getState().moveStatusPathsOptimistically('/repo', ['new-file.ts'], 'unstage');
    const status = useGitStore.getState().getDirectoryState('/repo')?.status;

    expect(status?.files).toEqual([
      { path: 'new-file.ts', index: ' ', working_dir: '?' },
    ]);
  });

  test('keeps conflicted files unchanged during optimistic moves', () => {
    const conflicted = { path: 'conflict.ts', index: 'U', working_dir: 'U' };
    setDirectoryStatus(createStatus(undefined, [conflicted]));

    useGitStore.getState().moveStatusPathsOptimistically('/repo', ['conflict.ts'], 'stage');
    const status = useGitStore.getState().getDirectoryState('/repo')?.status;

    expect(status?.files).toEqual([conflicted]);
    expect(status?.files[0]).toBe(conflicted);
  });

  test('preserves diff stats during optimistic moves', () => {
    const diffStats = { 'src/index.ts': { insertions: 2, deletions: 1 } };
    setDirectoryStatus(createStatus(diffStats, [
      { path: 'src/index.ts', index: ' ', working_dir: 'M' },
    ]));

    useGitStore.getState().moveStatusPathsOptimistically('/repo', ['src/index.ts'], 'stage');
    const status = useGitStore.getState().getDirectoryState('/repo')?.status;

    expect(status?.diffStats).toBe(diffStats);
  });

  test('does nothing when optimistic move has no matching path', () => {
    const initialStatus = createStatus(undefined, [
      { path: 'src/index.ts', index: ' ', working_dir: 'M' },
    ]);
    setDirectoryStatus(initialStatus);

    const previousStatus = useGitStore.getState().moveStatusPathsOptimistically('/repo', ['missing.ts'], 'stage');

    expect(previousStatus).toBe(initialStatus);
    expect(useGitStore.getState().getDirectoryState('/repo')?.status).toBe(initialStatus);
    expect(useGitStore.getState().getDirectoryState('/repo')?.indexRevision).toBe(0);
  });

  test('does nothing without status for optimistic moves', () => {
    useGitStore.setState({
      directories: new Map([['/repo', { ...createDirectoryState(createStatus()), status: null }]]),
      activeDirectory: '/repo',
    });

    const previousStatus = useGitStore.getState().moveStatusPathsOptimistically('/repo', ['src/index.ts'], 'stage');

    expect(previousStatus).toBeNull();
    expect(useGitStore.getState().getDirectoryState('/repo')?.status).toBeNull();
  });

  test('removes entries that become clean during optimistic moves', () => {
    setDirectoryStatus(createStatus(undefined, [
      { path: 'clean.ts', index: ' ', working_dir: ' ' },
    ]));

    useGitStore.getState().moveStatusPathsOptimistically('/repo', ['clean.ts'], 'stage');
    const status = useGitStore.getState().getDirectoryState('/repo')?.status;

    expect(status?.files).toEqual([]);
    expect(status?.isClean).toBe(true);
  });

  test('restores previous status for optimistic rollback', () => {
    const initialStatus = createStatus(undefined, [
      { path: 'src/index.ts', index: ' ', working_dir: 'M' },
    ]);
    setDirectoryStatus(initialStatus);

    const previousStatus = useGitStore.getState().moveStatusPathsOptimistically('/repo', ['src/index.ts'], 'stage');
    useGitStore.getState().restoreStatus('/repo', previousStatus);

    expect(useGitStore.getState().getDirectoryState('/repo')?.status).toBe(initialStatus);
  });

  test('repeated prefetch over a large status does not rescan every status file', async () => {
    let pathReads = 0;
    const files = Array.from({ length: 20_000 }, (_, index) => new Proxy(
      { path: `src/file-${index}.ts`, index: ' ', working_dir: 'M' },
      {
        get(target, property, receiver) {
          if (property === 'path') pathReads += 1;
          return Reflect.get(target, property, receiver);
        },
      },
    ));
    setDirectoryStatus(createStatus(undefined, files));
    const fetched: string[] = [];
    const git = createGitApi(async () => createStatus());
    git.getGitFileDiff = async (_directory, options) => {
      fetched.push(options.path);
      return { original: 'a\n', modified: 'b\n', path: options.path };
    };
    const candidates = Array.from({ length: 20_000 }, (_, index) => `src/file-${index}.ts`);

    const previousHidden = Object.getOwnPropertyDescriptor(document, 'hidden');
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    try {
      await useGitStore.getState().prefetchDiffs('/repo', git, candidates, { maxFiles: 5 });
      pathReads = 0;
      await useGitStore.getState().prefetchDiffs('/repo', git, candidates.slice(5), { maxFiles: 5 });
    } finally {
      if (previousHidden) {
        Object.defineProperty(document, 'hidden', previousHidden);
      } else {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- test cleanup
        delete (document as { hidden?: boolean }).hidden;
      }
    }

    expect(fetched).toEqual(candidates.slice(0, 10));
    expect(pathReads).toBe(0);
  });

  test('repeating a prefetch larger than the diff cache does not refetch evicted diffs', async () => {
    const files = Array.from({ length: 100 }, (_, index) => ({ path: `src/file-${index}.ts`, index: 'M', working_dir: ' ' }));
    setDirectoryStatus(createStatus(undefined, files));
    const fetched: string[] = [];
    const git = createGitApi(async () => createStatus());
    git.getGitFileDiff = async (_directory, options) => {
      fetched.push(options.path);
      return { original: 'a\n', modified: 'b\n', path: options.path };
    };
    const candidates = files.map((file) => file.path);

    const previousHidden = Object.getOwnPropertyDescriptor(document, 'hidden');
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    try {
      await useGitStore.getState().prefetchDiffs('/repo', git, candidates, { maxFiles: 40 });
      const firstPass = fetched.length;
      fetched.length = 0;
      await useGitStore.getState().prefetchDiffs('/repo', git, candidates, { maxFiles: 40 });

      expect(firstPass).toBeGreaterThan(0);
      expect(fetched).toEqual([]);
    } finally {
      if (previousHidden) {
        Object.defineProperty(document, 'hidden', previousHidden);
      } else {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- test cleanup
        delete (document as { hidden?: boolean }).hidden;
      }
    }
  });

  test('does not cache dual-empty non-binary prefetch results', async () => {
    setDirectoryStatus(createStatus(undefined, [
      { path: 'new-file.ts', index: '?', working_dir: '?' },
      { path: 'tracked.ts', index: ' ', working_dir: 'M' },
    ]));

    const git = createGitApi(async () => createStatus());
    git.getGitFileDiff = async (_directory, options) => {
      if (options.path === 'new-file.ts') {
        return { original: '', modified: '', path: options.path };
      }
      return { original: 'old\n', modified: 'new\n', path: options.path };
    };

    const previousHidden = Object.getOwnPropertyDescriptor(document, 'hidden');
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    try {
      await useGitStore.getState().prefetchDiffs('/repo', git, ['new-file.ts', 'tracked.ts']);
    } finally {
      if (previousHidden) {
        Object.defineProperty(document, 'hidden', previousHidden);
      } else {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- test cleanup
        delete (document as { hidden?: boolean }).hidden;
      }
    }

    const cache = useGitStore.getState().getDirectoryState('/repo')?.diffCache;
    expect(cache?.has('new-file.ts')).toBe(false);
    const tracked = cache?.get('tracked.ts');
    expect(tracked?.original).toBe('old\n');
    expect(tracked?.modified).toBe('new\n');
  });

  test('still caches dual-empty binary prefetch results', async () => {
    setDirectoryStatus(createStatus(undefined, [
      { path: 'image.png', index: '?', working_dir: '?' },
    ]));

    const git = createGitApi(async () => createStatus());
    git.getGitFileDiff = async (_directory, options) => ({
      original: '',
      modified: '',
      path: options.path,
      isBinary: true,
    });

    const previousHidden = Object.getOwnPropertyDescriptor(document, 'hidden');
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    try {
      await useGitStore.getState().prefetchDiffs('/repo', git, ['image.png']);
    } finally {
      if (previousHidden) {
        Object.defineProperty(document, 'hidden', previousHidden);
      } else {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- test cleanup
        delete (document as { hidden?: boolean }).hidden;
      }
    }

    const cached = useGitStore.getState().getDirectoryState('/repo')?.diffCache.get('image.png');
    expect(cached?.original).toBe('');
    expect(cached?.modified).toBe('');
    expect(cached?.isBinary).toBe(true);
  });
});
