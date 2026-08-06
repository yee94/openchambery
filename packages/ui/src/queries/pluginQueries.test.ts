import { beforeEach, describe, expect, mock, test } from 'bun:test';

let activeProjectPath = '/workspace/project';
let runtimeKey = 'runtime-a';
type FetchCall = { input: string; init?: RequestInit };
const fetchCalls: FetchCall[] = [];
let fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = async () => new Response('{}');

mock.module('@/lib/opencode/client', () => ({ opencodeClient: { getDirectory: () => '/fallback/project' } }));
mock.module('@/stores/useProjectsStore', () => ({
  useProjectsStore: Object.assign(() => null, { getState: () => ({ getActiveProject: () => ({ path: activeProjectPath }) }) }),
}));
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

const {
  pluginFileQueryOptions,
  pluginRegistryQueryOptions,
  pluginsListQueryOptions,
  readPluginRegistrySnapshot,
  refreshPluginRegistryQuery,
  refreshPluginsQuery,
} = await import('./pluginQueries');
const { queryClient, queryKeys } = await import('@/lib/queryRuntime');

const jsonResponse = (body: unknown, init?: ResponseInit): Response => new Response(JSON.stringify(body), {
  status: init?.status ?? 200,
  headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
});

describe('pluginQueries', () => {
  beforeEach(() => {
    queryClient.clear();
    activeProjectPath = '/workspace/project';
    runtimeKey = 'runtime-a';
    fetchCalls.length = 0;
    fetchImpl = async () => jsonResponse({});
  });

  test('list request scopes directory, runtime, and abort signal', async () => {
    const controller = new AbortController();
    fetchImpl = async () => jsonResponse({ entries: [], files: [] });

    await pluginsListQueryOptions(' /workspace/a ', 'runtime-b').queryFn({ signal: controller.signal });

    expect(pluginsListQueryOptions(' /workspace/a ', 'runtime-b').queryKey).toEqual(['runtime-b', 'plugins', 'list', '/workspace/a']);
    expect(fetchCalls[0]?.input).toBe('/api/config/plugins?directory=%2Fworkspace%2Fa');
    expect(fetchCalls[0]?.init?.headers).toEqual({ 'x-opencode-directory': '/workspace/a' });
    expect(fetchCalls[0]?.init?.signal).toBe(controller.signal);
  });

  test('registry keys canonicalize specs and isolate distinct spec sets', () => {
    expect(queryKeys.plugins.registry('/workspace/a', [' b ', 'a', 'a'], false, 'runtime-a')).toEqual([
      'runtime-a', 'plugins', 'registry', '/workspace/a', ['a', 'b'], false,
    ]);
    expect(pluginRegistryQueryOptions('/workspace/a', ['a'], false, 'runtime-a').queryKey)
      .not.toEqual(pluginRegistryQueryOptions('/workspace/a', ['b'], false, 'runtime-a').queryKey);
  });

  test('registry preserves URL semantics, chunks long spec lists, and aggregates results', async () => {
    const specs = Array.from({ length: 50 }, (_, index) => `plugin-${index}-${'x'.repeat(20)}@1.0.0`);
    fetchImpl = async (input) => jsonResponse({
      results: [{ kind: 'npm-ok', spec: new URL(`http://localhost${input}`).searchParams.get('specs')?.split(',')[0] ?? '', name: 'plugin', currentVersion: null, latestVersion: null, versions: [], hasUpdate: false }],
    });

    const registry = await pluginRegistryQueryOptions('/workspace/a', specs, true).queryFn({ signal: new AbortController().signal });

    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[0]?.input).toContain('refresh=true');
    expect(fetchCalls[0]?.input).toContain('directory=%2Fworkspace%2Fa');
    expect(Object.keys(registry)).toHaveLength(2);
  });

  test('registry partial failure keeps the prior complete snapshot', async () => {
    const specs = Array.from({ length: 50 }, (_, index) => `plugin-${index}-${'x'.repeat(20)}@1.0.0`);
    fetchImpl = async (input) => {
      const spec = new URL(`http://localhost${input}`).searchParams.get('specs')?.split(',')[0] ?? '';
      return jsonResponse({ results: [{ kind: 'npm-ok', spec, name: spec, currentVersion: null, latestVersion: null, versions: [], hasUpdate: false }] });
    };
    await refreshPluginRegistryQuery(queryClient, activeProjectPath, specs);

    let calls = 0;
    fetchImpl = async (input) => {
      calls += 1;
      if (calls === 2) return jsonResponse({}, { status: 500 });
      const spec = new URL(`http://localhost${input}`).searchParams.get('specs')?.split(',')[0] ?? '';
      return jsonResponse({ results: [{ kind: 'npm-ok', spec, name: spec, currentVersion: null, latestVersion: null, versions: [], hasUpdate: false }] });
    };

    await expect(queryClient.fetchQuery({ ...pluginRegistryQueryOptions(activeProjectPath, specs, false, runtimeKey), staleTime: 0, retry: false })).rejects.toThrow('Failed to load plugin registry info');

    expect(readPluginRegistrySnapshot(activeProjectPath, specs, false, runtimeKey)[specs[0]]?.kind).toBe('npm-ok');
  });

  test('forced registry refresh writes its result to the standard observer key', async () => {
    const specs = ['plugin@1.0.0'];
    fetchImpl = async () => jsonResponse({
      results: [{ kind: 'npm-ok', spec: specs[0], name: 'plugin', currentVersion: '1.0.0', latestVersion: '2.0.0', versions: ['1.0.0', '2.0.0'], hasUpdate: true }],
    });

    await refreshPluginRegistryQuery(queryClient, activeProjectPath, specs);

    expect(fetchCalls[0]?.input).toContain('refresh=true');
    const refreshed = readPluginRegistrySnapshot(activeProjectPath, specs, false, runtimeKey)[specs[0]];
    expect(refreshed?.kind).toBe('npm-ok');
    if (refreshed?.kind === 'npm-ok') {
      expect(refreshed.latestVersion).toBe('2.0.0');
    }
    expect(readPluginRegistrySnapshot(activeProjectPath, specs, true, runtimeKey)).toEqual({});
  });

  test('file request reads directory-scoped content and forwards its signal', async () => {
    const controller = new AbortController();
    fetchImpl = async () => jsonResponse({ fileName: 'plugin.ts', scope: 'project', content: 'export {}' });

    const file = await pluginFileQueryOptions('/workspace/a', 'file:user:plugin.ts').queryFn({ signal: controller.signal });

    expect(file).toEqual({ fileName: 'plugin.ts', scope: 'project', content: 'export {}' });

    expect(fetchCalls[0]?.input).toBe('/api/config/plugins/file/file%3Auser%3Aplugin.ts?directory=%2Fworkspace%2Fa');
    expect(fetchCalls[0]?.init?.signal).toBe(controller.signal);
  });

  test('matching list refreshes share one flight and inactive runtimes retain their snapshot', async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    fetchImpl = async () => new Promise<Response>((resolve) => { resolveResponse = resolve; });
    const first = refreshPluginsQuery(queryClient, activeProjectPath, runtimeKey);
    const second = refreshPluginsQuery(queryClient, activeProjectPath, runtimeKey);
    resolveResponse?.(jsonResponse({ entries: [], files: [] }));
    await Promise.all([first, second]);

    runtimeKey = 'runtime-b';
    await refreshPluginsQuery(queryClient, activeProjectPath, 'runtime-a');

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });
});