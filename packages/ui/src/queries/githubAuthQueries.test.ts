import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { RuntimeAPIs } from '@/lib/api/types';

let runtimeKey = 'runtime-a';
let runtimeGitHub: RuntimeAPIs['github'] | undefined;
const fetchCalls: Array<{ input: string; init?: RequestInit }> = [];
let fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = async () => new Response('{}');

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: (input: string, init?: RequestInit) => {
    fetchCalls.push({ input, init });
    return fetchImpl(input, init);
  },
}));
mock.module('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => runtimeKey,
  getRuntimeGeneration: () => 0,
  isRuntimeEndpointIdentityChange: () => false,
  subscribeRuntimeEndpointChanged: () => () => undefined,
}));
mock.module('@/contexts/runtimeAPIRegistry', () => ({
  getRegisteredRuntimeAPIs: () => runtimeGitHub ? { github: runtimeGitHub } : null,
}));

const {
  githubAuthQueryOptions,
  readGitHubAuthSnapshot,
  refreshGitHubAuthQuery,
  setGitHubAuthSnapshot,
} = await import('./githubAuthQueries');
const { queryClient, queryKeys } = await import('@/lib/queryRuntime');

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

describe('githubAuthQueries', () => {
  beforeEach(() => {
    queryClient.clear();
    runtimeKey = 'runtime-a';
    runtimeGitHub = undefined;
    fetchCalls.length = 0;
    fetchImpl = async () => jsonResponse({ connected: false });
  });

  test('fallback request uses the runtime key and query signal', async () => {
    const controller = new AbortController();
    const options = githubAuthQueryOptions(undefined, 'runtime-b');
    const status = await options.queryFn({ signal: controller.signal });

    expect(options.queryKey).toEqual(['runtime-b', 'github', 'auth']);
    expect(status).toEqual({ connected: false });
    expect(fetchCalls[0]?.input).toBe('/api/github/auth/status');
    expect(fetchCalls[0]?.init?.signal).toBe(controller.signal);
  });

  test('runtime API status is used without an HTTP fallback', async () => {
    runtimeGitHub = {
      authStatus: async () => ({ connected: true, user: { login: 'octocat' } }),
    } as unknown as RuntimeAPIs['github'];

    const status = await githubAuthQueryOptions().queryFn({ signal: new AbortController().signal });

    expect(status.connected).toBe(true);
    expect(fetchCalls).toHaveLength(0);
  });

  test('matching refreshes share one flight and inactive transports do not request', async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    fetchImpl = async () => new Promise<Response>((resolve) => { resolveResponse = resolve; });
    const first = refreshGitHubAuthQuery(queryClient, undefined, runtimeKey);
    const second = refreshGitHubAuthQuery(queryClient, undefined, runtimeKey);
    resolveResponse?.(jsonResponse({ connected: true, user: { login: 'octocat' } }));
    await Promise.all([first, second]);

    runtimeKey = 'runtime-b';
    await refreshGitHubAuthQuery(queryClient, undefined, 'runtime-a');

    expect(fetchCalls).toHaveLength(1);
  });

  test('failed refresh retains the prior complete snapshot', async () => {
    setGitHubAuthSnapshot(queryClient, { connected: true, user: { login: 'octocat' } }, runtimeKey);
    fetchImpl = async () => jsonResponse({ error: 'offline' }, 503);

    await expect(refreshGitHubAuthQuery(queryClient, undefined, runtimeKey)).rejects.toThrow('offline');

    expect(readGitHubAuthSnapshot(queryClient, runtimeKey)?.connected).toBe(true);
  });

  test('set helper writes and clears the standard observer key', () => {
    setGitHubAuthSnapshot(queryClient, { connected: false }, runtimeKey);
    expect(queryClient.getQueryData(queryKeys.github.auth(runtimeKey))).toEqual({ connected: false });
    setGitHubAuthSnapshot(queryClient, null, runtimeKey);
    expect(readGitHubAuthSnapshot(queryClient, runtimeKey)).toBeNull();
  });
});