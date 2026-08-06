import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { FilesAPI } from '@/lib/api/types';

let runtimeKey = 'runtime-a';
let registeredFiles: FilesAPI | undefined;
const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => runtimeKey,
  getRuntimeGeneration: () => 0,
  isRuntimeEndpointIdentityChange: () => false,
  subscribeRuntimeEndpointChanged: () => () => undefined,
}));
mock.module('@/contexts/runtimeAPIRegistry', () => ({ getRegisteredRuntimeAPIs: () => registeredFiles ? { files: registeredFiles } : null }));
mock.module('@/lib/runtime-fetch', () => ({ runtimeFetch: async (url: string, init?: RequestInit) => {
  fetchCalls.push({ url, init });
  return new Response('http plan', { headers: { 'x-openchamber-file-exists': 'true' } });
} }));

const { planResolvedQueryOptions, resolvePlanSource } = await import('./planQueries');
const { queryClient, queryKeys } = await import('@/lib/queryRuntime');

const input = { mode: 'session' as const, sessionId: 's1', scopeDirectory: '/repo', targetPath: null, repoPath: '/repo/.opencode/plans/p.md', homePath: '/home/me/.opencode/plans/p.md' };
const files = (readFile: NonNullable<FilesAPI['readFile']>): FilesAPI => ({ listDirectory: async () => ({ directory: '', entries: [] }), search: async () => [], createDirectory: async (path) => ({ success: true, path }), readFile });

describe('planQueries', () => {
  beforeEach(() => { queryClient.clear(); registeredFiles = undefined; runtimeKey = 'runtime-a'; fetchCalls.length = 0; });

  test('resolves target, target missing, and isolates every document key dimension', async () => {
    const api = files(async () => ({ path: '/target.md', content: 'target', exists: true }));
    expect(await planResolvedQueryOptions(api, { ...input, mode: 'target', targetPath: '/target.md', repoPath: null, homePath: null }).queryFn())
      .toEqual({ kind: 'resolved', source: 'target', path: '/target.md', content: 'target' });
    const missing = files(async (path) => ({ path, content: '', exists: false }));
    expect(await planResolvedQueryOptions(missing, { ...input, mode: 'target', targetPath: '/target.md', repoPath: null, homePath: null }).queryFn())
      .toEqual({ kind: 'missing', candidates: ['/target.md'] });
    expect(queryKeys.plans.resolved('session', 's1', '/repo', null, '/repo/a', '/home/a', 'a'))
      .not.toEqual(queryKeys.plans.resolved('session', 's2', '/repo', null, '/repo/a', '/home/a', 'a'));
  });

  test('uses repo before home and resolves an existing empty repo file', async () => {
    const calls: string[] = [];
    const api = files(async (path) => { calls.push(path); return { path, content: '', exists: true }; });
    expect(await planResolvedQueryOptions(api, input).queryFn()).toEqual({ kind: 'resolved', source: 'repo', path: input.repoPath, content: '' });
    expect(calls).toEqual([input.repoPath]);
    expect(resolvePlanSource(input, input.repoPath)).toBe('repo');
    expect(resolvePlanSource(input, input.homePath)).toBe('home');
    expect(resolvePlanSource({ ...input, mode: 'target', targetPath: '/target.md' }, '/target.md')).toBe('target');
  });

  test('uses home after a missing repo and reports dual missing', async () => {
    const api = files(async (path) => ({ path, content: path === input.homePath ? 'home' : '', exists: path === input.homePath }));
    expect(await planResolvedQueryOptions(api, input).queryFn()).toEqual({ kind: 'resolved', source: 'home', path: input.homePath, content: 'home' });
    const missing = files(async (path) => ({ path, content: '', exists: false }));
    expect(await planResolvedQueryOptions(missing, input).queryFn()).toEqual({ kind: 'missing', candidates: [input.repoPath, input.homePath] });
  });

  test('propagates authoritative errors and retains prior query data after a failed refresh', async () => {
    const key = queryKeys.plans.resolved(input.mode, input.sessionId, input.scopeDirectory, input.targetPath, input.repoPath, input.homePath, runtimeKey);
    queryClient.setQueryData(key, { kind: 'resolved', source: 'repo', path: input.repoPath, content: 'prior' });
    const failing = files(async () => { throw new Error('permission denied'); });
    await expect(queryClient.fetchQuery({ ...planResolvedQueryOptions(failing, input), staleTime: 0 })).rejects.toThrow('permission denied');
    expect(queryClient.getQueryData(key)).toEqual({ kind: 'resolved', source: 'repo', path: input.repoPath, content: 'prior' });
  });

  test('captures the supplied API and uses the HTTP optional-read contract with scope headers', async () => {
    registeredFiles = files(async () => ({ path: input.repoPath, content: 'registered', exists: true }));
    expect(await planResolvedQueryOptions(undefined, input).queryFn()).toEqual({ kind: 'resolved', source: 'repo', path: input.repoPath, content: 'registered' });
    registeredFiles = undefined;
    expect(await planResolvedQueryOptions(undefined, { ...input, mode: 'target', targetPath: '/target.md', repoPath: null, homePath: null }).queryFn()).toEqual({ kind: 'resolved', source: 'target', path: '/target.md', content: 'http plan' });
    expect(fetchCalls[0]).toEqual({ url: '/api/fs/read', init: { query: { path: '/target.md', optional: true }, cache: 'no-store', headers: { 'x-opencode-directory': '/repo' } } });
  });
});