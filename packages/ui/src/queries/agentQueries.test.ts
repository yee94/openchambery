import { beforeEach, describe, expect, mock, test } from 'bun:test';

let activeProjectPath = '/workspace/project';
let runtimeKey = 'runtime-a';
let listCalls = 0;
let listImpl: () => Promise<Array<{ name: string }>> = async () => [];
let metadataCalls = 0;
let metadataRequest: { path: string; init?: RequestInit } | null = null;
let metadataImpl: () => Promise<Response> = async () => new Response(JSON.stringify({ agents: {} }));

mock.module('@/lib/opencode/client', () => ({ opencodeClient: { getDirectory: () => '/fallback/project', listAgents: async () => { listCalls += 1; return listImpl(); } } }));
mock.module('@/stores/useProjectsStore', () => ({ useProjectsStore: Object.assign(() => null, { getState: () => ({ getActiveProject: () => ({ path: activeProjectPath }) }) }) }));
mock.module('@/lib/runtime-fetch', () => ({ runtimeFetch: async (path: string, init?: RequestInit) => {
  metadataCalls += 1;
  metadataRequest = { path, init };
  return metadataImpl();
} }));
mock.module('@/lib/runtime-switch', () => ({ getRuntimeTransportIdentity: () => runtimeKey, isRuntimeEndpointIdentityChange: () => false, subscribeRuntimeEndpointChanged: () => () => undefined }));

const { agentQueryOptions, readAgentsSnapshot, refreshAgentsQuery } = await import('./agentQueries');
const { ensureRawAgentsQuery } = await import('./configCatalogQueries');
const { queryClient } = await import('@/lib/queryRuntime');

describe('agentQueries', () => {
  beforeEach(() => {
    queryClient.clear();
    activeProjectPath = '/workspace/project';
    runtimeKey = 'runtime-a';
    listCalls = 0;
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
});
