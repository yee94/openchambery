import { beforeEach, describe, expect, mock, test } from 'bun:test';

let activeProjectPath = '/workspace/project';
let runtimeKey = 'runtime-a';
let refreshCalls: Array<[string | null, string]> = [];
let configChangeCalls = 0;
let agentsSnapshot: Array<{ name: string; hidden?: boolean }> = [];
let refreshedAgents: Array<{ name: string; hidden?: boolean }> = [];
let responseImpl: () => Promise<Response> = async () => new Response(JSON.stringify({ requiresReload: false }));
const installedRefreshes: Array<[string | null, string]> = [];
const catalogInvalidations: Array<[string | null, string]> = [];

mock.module('@/lib/opencode/client', () => ({ opencodeClient: { getDirectory: () => '/fallback/project', checkHealth: async () => true } }));
mock.module('@/stores/useProjectsStore', () => ({ useProjectsStore: { getState: () => ({ getActiveProject: () => ({ path: activeProjectPath }), projects: [] }) } }));
mock.module('@/lib/runtime-switch', () => ({ getRuntimeTransportIdentity: () => runtimeKey, isRuntimeEndpointIdentityChange: () => false, subscribeRuntimeEndpointChanged: () => () => undefined }));
mock.module('@/lib/runtime-fetch', () => ({ runtimeFetch: async () => responseImpl() }));
mock.module('@/queries/agentQueries', () => ({
  resolveConfigQueryDirectory: () => activeProjectPath,
  readAgentsSnapshot: () => agentsSnapshot,
  refreshAgentsQuery: async (_client: unknown, directory: string | null, transport: string) => {
    refreshCalls.push([directory, transport]);
    agentsSnapshot = refreshedAgents;
    return refreshedAgents;
  },
}));
mock.module('@/lib/configUpdate', () => ({ startConfigUpdate: mock(() => undefined), finishConfigUpdate: mock(() => undefined), updateConfigUpdateMessage: mock(() => undefined) }));
mock.module('@/lib/configSync', () => ({ emitConfigChange: () => { configChangeCalls += 1; }, scopeMatches: mock(() => false), subscribeToConfigChanges: mock(() => () => undefined) }));
mock.module('@/stores/useConfigStore', () => ({ useConfigStore: { getState: () => ({ loadAgents: async () => undefined, loadProviders: async () => undefined, invalidateModelMetadataCache: () => undefined, invalidateProviderCache: () => undefined }) } }));
mock.module('@/queries/installedSkillsQueries', () => ({
  refreshInstalledSkillsQuery: async (_client: unknown, directory: string | null, transport: string) => { installedRefreshes.push([directory, transport]); return []; },
}));
mock.module('@/queries/skillsCatalogQueries', () => ({
  FALLBACK_SKILLS_CATALOG_SOURCES: [{ id: 'fallback', label: 'Fallback', source: 'owner/repo' }],
  invalidateSkillsCatalogQueries: async (_client: unknown, directory: string | null, transport: string) => { catalogInvalidations.push([directory, transport]); },
}));

const { refreshAfterOpenCodeRestart, useAgentsStore } = await import('./useAgentsStore');

describe('useAgentsStore', () => {
  beforeEach(() => {
    activeProjectPath = '/workspace/project';
    runtimeKey = 'runtime-a';
    refreshCalls = [];
    configChangeCalls = 0;
    installedRefreshes.length = 0;
    catalogInvalidations.length = 0;
    agentsSnapshot = [{ name: 'visible' }, { name: 'hidden', hidden: true }];
    refreshedAgents = agentsSnapshot;
    responseImpl = async () => new Response(JSON.stringify({ requiresReload: false }));
    useAgentsStore.setState({ selectedAgentName: null, agentDraft: null });
  });

  test('keeps only UI state in Zustand', () => {
    const state = useAgentsStore.getState();
    expect(state.selectedAgentName).toBe(null);
    expect(state.agentDraft).toBe(null);
    expect('agents' in state).toBe(false);
    expect('isLoading' in state).toBe(false);
  });

  test('loads the captured directory and transport through the query', async () => {
    expect(await useAgentsStore.getState().loadAgents()).toBe(true);
    expect(refreshCalls).toEqual([['/workspace/project', 'runtime-a']]);
    expect(useAgentsStore.getState().getAgentByName('visible')?.name).toBe('visible');
    expect(useAgentsStore.getState().getVisibleAgents().map((agent) => agent.name)).toEqual(['visible']);
  });

  test('creates on the active runtime, refreshes its captured project directory, and retains the query result', async () => {
    activeProjectPath = '/workspace/create-project';
    refreshedAgents = [{ name: 'created-agent' }];
    const result = await useAgentsStore.getState().createAgent({ name: 'new-agent' });
    expect(result).toEqual({ ok: true });
    expect(refreshCalls).toEqual([['/workspace/create-project', 'runtime-a']]);
    expect(useAgentsStore.getState().getAgentByName('created-agent')?.name).toBe('created-agent');
  });

  test('carries the captured query target through a reload refresh', async () => {
    responseImpl = async () => new Response(JSON.stringify({ requiresReload: true }));
    const result = await useAgentsStore.getState().updateAgent('visible', { description: 'updated' });
    expect(result).toEqual({ ok: true });
    expect(refreshCalls).toEqual([['/workspace/project', 'runtime-a']]);
  });

  test('keeps the new runtime selection and query untouched when an earlier delete resolves', async () => {
    useAgentsStore.setState({ selectedAgentName: 'visible' });
    let resolveResponse!: (response: Response) => void;
    responseImpl = () => new Promise((resolve) => { resolveResponse = resolve; });

    const deleteRequest = useAgentsStore.getState().deleteAgent('visible');
    await Promise.resolve();
    runtimeKey = 'runtime-b';
    useAgentsStore.setState({ selectedAgentName: 'visible' });
    resolveResponse(new Response(JSON.stringify({ requiresReload: false })));

    const result = await deleteRequest;
    expect(result).toEqual({ ok: true });
    expect(useAgentsStore.getState().selectedAgentName).toBe('visible');
    expect(refreshCalls).toEqual([]);
    expect(configChangeCalls).toBe(0);
  });

  test('updates on the active runtime and refreshes the exact captured directory', async () => {
    activeProjectPath = '/workspace/update-project';
    refreshedAgents = [{ name: 'visible', hidden: true }];

    const result = await useAgentsStore.getState().updateAgent('visible', { description: 'updated' });

    expect(result).toEqual({ ok: true });
    expect(refreshCalls).toEqual([['/workspace/update-project', 'runtime-a']]);
    expect(useAgentsStore.getState().getAgentByName('visible')).toEqual({ name: 'visible', hidden: true });
  });

  test('refreshes skills through the installed query and Catalog invalidation', async () => {
    await refreshAfterOpenCodeRestart({ scopes: ['skills'], mode: 'active', queryDirectory: '/workspace/skills' });

    expect(installedRefreshes).toEqual([['/workspace/skills', 'runtime-a']]);
    expect(catalogInvalidations).toEqual([['/workspace/skills', 'runtime-a']]);
  });
});
