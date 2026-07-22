import { beforeEach, describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import type { GitBranch } from '@/lib/api/types';
import {
  ensureGitBranchesQuery,
  gitBranchesQueryOptions,
  gitRemotesQueryOptions,
  readGitBranchesSnapshot,
  refreshGitBranchesQuery,
} from './gitBranchQueries';
import { readGitBranchStartupSnapshot, writeGitBranchStartupSnapshot, type GitBranchStartupStorage } from './gitBranchStartupCache';

const branches = (current = 'main'): GitBranch => ({ all: [current], current, branches: {} });

const memoryStorage = (value: string | null = null): GitBranchStartupStorage & { value: () => string | null } => {
  let current = value;
  return { getItem: () => current, setItem: (_key, next) => { current = next; }, value: () => current };
};

describe('gitBranchQueries', () => {
  let client: QueryClient;

  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  test('normalizes directory keys and isolates transports and resources', () => {
    expect(gitBranchesQueryOptions(' /repo/ ', undefined, 'runtime-a').queryKey)
      .toEqual(['runtime-a', 'git', 'branches', '/repo']);
    expect(gitBranchesQueryOptions('/repo', undefined, 'runtime-b').queryKey)
      .toEqual(['runtime-b', 'git', 'branches', '/repo']);
    expect(gitBranchesQueryOptions('/other', undefined, 'runtime-a').queryKey)
      .toEqual(['runtime-a', 'git', 'branches', '/other']);
    expect(gitRemotesQueryOptions('/repo', undefined, 'runtime-a').queryKey)
      .toEqual(['runtime-a', 'git', 'remotes', '/repo']);
  });

  test('shares concurrent ensure calls and keeps the fresh cache for 30 seconds', async () => {
    let calls = 0;
    let resolveRequest: ((value: GitBranch) => void) | undefined;
    const git = {
      getGitBranches: async () => {
        calls += 1;
        return new Promise<GitBranch>((resolve) => { resolveRequest = resolve; });
      },
    };

    const first = ensureGitBranchesQuery('/repo', git, client, 'runtime-a');
    const second = ensureGitBranchesQuery('/repo', git, client, 'runtime-a');
    resolveRequest?.(branches());
    await Promise.all([first, second]);
    await ensureGitBranchesQuery('/repo', git, client, 'runtime-a');

    expect(calls).toBe(1);
  });

  test('refreshes the exact key and retains a prior snapshot after failure', async () => {
    let shouldFail = false;
    let calls = 0;
    const git = {
      getGitBranches: async () => {
        calls += 1;
        if (shouldFail) throw new Error('offline');
        return branches(calls === 1 ? 'main' : 'next');
      },
    };

    await ensureGitBranchesQuery('/repo', git, client, 'runtime-a');
    shouldFail = true;
    await expect(refreshGitBranchesQuery('/repo', git, client, 'runtime-a')).rejects.toThrow('offline');

    expect(readGitBranchesSnapshot('/repo', client, 'runtime-a')).toEqual(branches('main'));
    shouldFail = false;
    await refreshGitBranchesQuery('/repo', git, client, 'runtime-b');
    expect(readGitBranchesSnapshot('/repo', client, 'runtime-a')).toEqual(branches('main'));
    expect(readGitBranchesSnapshot('/repo', client, 'runtime-b')).toEqual(branches('next'));
  });

  test('passes the query AbortSignal to the runtime Git facade', async () => {
    let receivedSignal: AbortSignal | undefined;
    const options = gitBranchesQueryOptions('/repo', {
      getGitBranches: async (_directory, requestOptions) => {
        receivedSignal = requestOptions?.signal;
        return branches();
      },
    }, 'runtime-a');
    const controller = new AbortController();

    await options.queryFn({ signal: controller.signal });

    expect(receivedSignal).toBe(controller.signal);
  });

  test('migrates a legacy directory cache once into the first transport that reads it', () => {
    const storage = memoryStorage(JSON.stringify({ ' /repo/ ': branches('legacy') }));

    expect(readGitBranchStartupSnapshot('/repo', 'runtime-a', storage)).toEqual(branches('legacy'));
    expect(readGitBranchStartupSnapshot('/repo', 'runtime-b', storage)).toBeNull();
    expect(storage.value()).toEqual(JSON.stringify({ version: 2, entries: { '["runtime-a","/repo"]': branches('legacy') } }));
  });

  test('isolates startup snapshots by normalized directory and transport and ignores malformed values', () => {
    const storage = memoryStorage();
    writeGitBranchStartupSnapshot(' /repo/ ', 'runtime-a', branches('a'), storage);
    writeGitBranchStartupSnapshot('/repo', 'runtime-b', branches('b'), storage);

    expect(readGitBranchStartupSnapshot('/repo', 'runtime-a', storage)).toEqual(branches('a'));
    expect(readGitBranchStartupSnapshot('/repo', 'runtime-b', storage)).toEqual(branches('b'));
    expect(readGitBranchStartupSnapshot('/other', 'runtime-a', storage)).toBeNull();
    expect(readGitBranchStartupSnapshot('/repo', 'runtime-c', memoryStorage('{bad json'))).toBeNull();
    expect(readGitBranchStartupSnapshot('/repo', 'runtime-c', memoryStorage(JSON.stringify({ version: 2, entries: { '["runtime-c","/repo"]': { all: [1] } } })))).toBeNull();
  });

  test('exposes a cold startup snapshot immediately, marks it stale, and retains it after revalidation failure', async () => {
    const storage = memoryStorage();
    writeGitBranchStartupSnapshot('/repo', 'runtime-a', branches('cached'), storage);
    const options = gitBranchesQueryOptions('/repo', { getGitBranches: async () => { throw new Error('offline'); } }, 'runtime-a', storage);
    const query = client.getQueryCache().build(client, options);

    expect(query.state.data).toEqual(branches('cached'));
    expect(query.state.dataUpdatedAt).toBe(0);
    await expect(client.fetchQuery(options)).rejects.toThrow('offline');
    expect(readGitBranchesSnapshot('/repo', client, 'runtime-a')).toEqual(branches('cached'));
  });

  test('persists successful Query results in the matching startup scope', async () => {
    const storage = memoryStorage();
    await client.fetchQuery(gitBranchesQueryOptions('/repo', { getGitBranches: async () => branches('fresh') }, 'runtime-a', storage));

    expect(readGitBranchStartupSnapshot('/repo', 'runtime-a', storage)).toEqual(branches('fresh'));
    expect(readGitBranchStartupSnapshot('/repo', 'runtime-b', storage)).toBeNull();
  });
});
