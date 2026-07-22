import { beforeEach, describe, expect, mock, test } from 'bun:test';

let activeProjectPath = '/workspace/project';
let runtimeKey = 'runtime-a';
let listCalls = 0;
let listedDirectories: Array<string | null | undefined> = [];
let listImpl: () => Promise<Array<{ name: string }>> = async () => [];
let providerDirectories: Array<string | null | undefined> = [];
let metadataCalls = 0;
let metadataRequest: { path: string; init?: RequestInit } | null = null;
let metadataImpl: () => Promise<Response> = async () => new Response(JSON.stringify({ agents: {} }));

mock.module('@/lib/opencode/client', () => ({ opencodeClient: {
  getDirectory: () => '/fallback/project',
  listAgents: async (directory?: string | null) => { listCalls += 1; listedDirectories.push(directory); return listImpl(); },
  getProvidersForConfig: async (directory?: string | null) => { providerDirectories.push(directory); return { providers: [{ id: 'provider', models: { model: { id: 'model' } } }], default: {} }; },
} }));
mock.module('@/stores/useProjectsStore', () => ({ useProjectsStore: Object.assign(() => null, { getState: () => ({ getActiveProject: () => ({ path: activeProjectPath }) }) }) }));
mock.module('@/lib/runtime-fetch', () => ({ runtimeFetch: async (path: string, init?: RequestInit) => {
  metadataCalls += 1;
  metadataRequest = { path, init };
  return metadataImpl();
} }));
mock.module('@/lib/runtime-switch', () => ({ getRuntimeTransportIdentity: () => runtimeKey, isRuntimeEndpointIdentityChange: () => false, subscribeRuntimeEndpointChanged: () => () => undefined }));

const { agentQueryOptions, providerQueryOptions, readAgentsSnapshot, readProvidersSnapshot, refreshAgentsQuery, refreshProvidersQuery } = await import('./agentQueries');
const { ensureRawAgentsQuery } = await import('./configCatalogQueries');
const { queryClient } = await import('@/lib/queryRuntime');

describe('agentQueries', () => {
  beforeEach(() => {
    queryClient.clear();
    activeProjectPath = '/workspace/project';
    runtimeKey = 'runtime-a';
    listCalls = 0;
    listedDirectories = [];
    providerDirectories = [];
    metadataCalls = 0;
    metadataRequest = null;
    listImpl = async () => [];
    metadataImpl = async () => new Response(JSON.stringify({ agents: {} }));
  });

  test('uses one metadata batch and retains the complete snapshot when it fails', async () => {
    listImpl = async () => [{ name: 'deploy' }, { name: 'review' }];
    metadataImpl = async () => new Response(JSON.stringify({ agents: { deploy: { scope: 'project' } } }));
    await refreshAgentsQuery(queryClient, activeProjectPath, runtimeKey);
    expect(metadataCalls).toBe(1);
    expect(metadataRequest?.path).toBe('/api/config/agents/metadata');
    expect(metadataRequest?.init?.method).toBe('POST');
    expect(metadataRequest?.init?.body).toBe(JSON.stringify({ names: ['deploy', 'review'] }));
    metadataImpl = async () => { throw new Error('metadata unavailable'); };
    await expect(refreshAgentsQuery(queryClient, activeProjectPath, runtimeKey)).rejects.toThrow('metadata unavailable');
    expect(readAgentsSnapshot()[0]?.name).toBe('deploy');
    expect((readAgentsSnapshot()[0] as { scope?: string } | undefined)?.scope).toBe('project');
  });

  test('isolates query keys and skips inactive runtime refreshes', async () => {
    listImpl = async () => [{ name: `${runtimeKey}:${activeProjectPath}` }];
    await Promise.all([refreshAgentsQuery(queryClient, activeProjectPath, runtimeKey), refreshAgentsQuery(queryClient, activeProjectPath, runtimeKey)]);
    activeProjectPath = '/workspace/second';
    await refreshAgentsQuery(queryClient, activeProjectPath, runtimeKey);
    runtimeKey = 'runtime-b';
    await refreshAgentsQuery(queryClient, activeProjectPath, 'runtime-a');
    expect(listCalls).toBe(2);
    expect(agentQueryOptions(activeProjectPath).queryKey).toEqual(['runtime-b', 'agents', '/workspace/second']);
  });

  test('enriched query reuses raw agents and keeps metadata work with enriched consumers', async () => {
    listImpl = async () => [{ name: 'build' }];
    await ensureRawAgentsQuery(activeProjectPath, runtimeKey);
    expect(listCalls).toBe(1);
    expect(metadataCalls).toBe(0);

    await refreshAgentsQuery(queryClient, activeProjectPath, runtimeKey);
    expect(listCalls).toBe(1);
    expect(metadataCalls).toBe(1);
  });

  test('uses an explicit managed directory for unregistered workspace catalogs', async () => {
    await Promise.all([
      refreshAgentsQuery(queryClient, '/managed/unregistered', runtimeKey),
      refreshProvidersQuery(queryClient, '/managed/unregistered', runtimeKey),
    ]);
    expect(listedDirectories).toEqual(['/managed/unregistered']);
    expect(providerDirectories).toEqual(['/managed/unregistered']);
    expect(agentQueryOptions(' /managed/unregistered ', runtimeKey).queryKey).toEqual(['runtime-a', 'agents', '/managed/unregistered']);
    expect(providerQueryOptions(' /managed/unregistered ', runtimeKey).queryKey).toEqual(['runtime-a', 'providers', '/managed/unregistered']);
    expect(readAgentsSnapshot('/managed/unregistered', runtimeKey)).toEqual([]);
    expect(readProvidersSnapshot('/managed/unregistered', runtimeKey)[0]?.models[0]?.id).toBe('model');
  });

  test('queries the global catalog with an explicit null directory', async () => {
    await Promise.all([
      refreshAgentsQuery(queryClient, null, runtimeKey),
      refreshProvidersQuery(queryClient, null, runtimeKey),
    ]);
    expect(listedDirectories).toEqual([null]);
    expect(providerDirectories).toEqual([null]);
  });
});
