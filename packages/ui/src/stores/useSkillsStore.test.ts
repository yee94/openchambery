import { beforeEach, describe, expect, mock, test } from 'bun:test';

const fetchCalls: string[] = [];
const installedRefreshes: Array<[string | null, string]> = [];
const catalogInvalidations: Array<[string | null, string]> = [];

mock.module('@/lib/opencode/client', () => ({ opencodeClient: { getDirectory: () => '/opencode-directory', checkHealth: async () => true } }));
mock.module('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => 'runtime-a',
  isRuntimeEndpointIdentityChange: () => false,
  subscribeRuntimeEndpointChanged: () => () => undefined,
}));
mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: async (input: string) => {
    fetchCalls.push(input);
    return new Response(JSON.stringify({ skills: [] }), { headers: { 'Content-Type': 'application/json' } });
  },
}));
mock.module('@/lib/configSync', () => ({ emitConfigChange: () => undefined, scopeMatches: () => false, subscribeToConfigChanges: () => () => undefined }));
mock.module('@/lib/configUpdate', () => ({ startConfigUpdate: () => undefined, finishConfigUpdate: () => undefined, updateConfigUpdateMessage: () => undefined }));
mock.module('@/queries/installedSkillsQueries', () => ({
  readInstalledSkillsSnapshot: () => [],
  refreshInstalledSkillsQuery: async (_client: unknown, directory: string | null, transport: string) => { installedRefreshes.push([directory, transport]); return []; },
}));
mock.module('@/queries/skillsCatalogQueries', () => ({
  FALLBACK_SKILLS_CATALOG_SOURCES: [{ id: 'fallback', label: 'Fallback', source: 'owner/repo' }],
  invalidateSkillsCatalogQueries: async (_client: unknown, directory: string | null, transport: string) => { catalogInvalidations.push([directory, transport]); },
}));

const { useSkillsStore } = await import('./useSkillsStore');

describe('useSkillsStore', () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    installedRefreshes.length = 0;
    catalogInvalidations.length = 0;
  });

  test('createSkill uses an explicit query directory for its mutation and Query refreshes', async () => {
    await useSkillsStore.getState().createSkill({ name: 'scoped-skill', description: 'Scoped skill' }, { directory: ' /active-project ' });

    expect(fetchCalls).toEqual(['/api/config/skills/scoped-skill?directory=%2Factive-project']);
    expect(installedRefreshes).toEqual([['/active-project', 'runtime-a']]);
    expect(catalogInvalidations).toEqual([['/active-project', 'runtime-a']]);
  });

  test('keeps installed Skills server state out of Zustand', () => {
    const state = useSkillsStore.getState();

    expect('skills' in state).toBe(false);
    expect('isLoading' in state).toBe(false);
  });
});
