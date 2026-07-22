import { beforeEach, describe, expect, mock, test } from 'bun:test';

let runtimeKey = 'runtime-a';
const fetchCalls: string[] = [];
const installedRefreshes: Array<[string | null, string]> = [];
const catalogInvalidations: Array<[string | null, string]> = [];
const restartRefreshes: Array<{ directory?: string | null; transportIdentity?: string }> = [];
let installPayload: Record<string, unknown> = { ok: true };

mock.module('@/lib/opencode/client', () => ({ opencodeClient: { getDirectory: () => '/opencode-directory' } }));
mock.module('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => runtimeKey,
  isRuntimeEndpointIdentityChange: () => false,
  subscribeRuntimeEndpointChanged: () => () => undefined,
}));
mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: async (input: string) => {
    fetchCalls.push(input);
    return new Response(JSON.stringify(installPayload), { headers: { 'Content-Type': 'application/json' } });
  },
}));
mock.module('@/lib/configUpdate', () => ({ startConfigUpdate: () => undefined, finishConfigUpdate: () => undefined, updateConfigUpdateMessage: () => undefined }));
mock.module('@/stores/useSkillsStore', () => ({
  refreshSkillsAfterOpenCodeRestart: async (options: { directory?: string | null; transportIdentity?: string }) => { restartRefreshes.push(options); },
}));
mock.module('@/queries/installedSkillsQueries', () => ({
  refreshInstalledSkillsQuery: async (_client: unknown, directory: string | null, transport: string) => { installedRefreshes.push([directory, transport]); return []; },
}));
mock.module('@/queries/skillsCatalogQueries', () => ({
  FALLBACK_SKILLS_CATALOG_SOURCES: [{ id: 'fallback', label: 'Fallback', source: 'owner/repo' }],
  invalidateSkillsCatalogQueries: async (_client: unknown, directory: string | null, transport: string) => { catalogInvalidations.push([directory, transport]); },
}));

const { useSkillsCatalogStore } = await import('./useSkillsCatalogStore');

describe('useSkillsCatalogStore', () => {
  beforeEach(() => {
    runtimeKey = 'runtime-a';
    fetchCalls.length = 0;
    installedRefreshes.length = 0;
    catalogInvalidations.length = 0;
    restartRefreshes.length = 0;
    installPayload = { ok: true };
  });

  test('uses the explicit Catalog directory for install and captured query refreshes', async () => {
    await useSkillsCatalogStore.getState().installSkills({ source: 'owner/repo', scope: 'user', targetSource: 'opencode', selections: [] }, { directory: ' /active-project ' });

    expect(fetchCalls).toEqual(['/api/config/skills/install?directory=%2Factive-project']);
    expect(installedRefreshes).toEqual([['/active-project', 'runtime-a']]);
    expect(catalogInvalidations).toEqual([['/active-project', 'runtime-a']]);
  });

  test('passes captured scope to restart refresh without an early installed query fetch', async () => {
    installPayload = { ok: true, requiresReload: true };

    await useSkillsCatalogStore.getState().installSkills({ source: 'owner/repo', scope: 'user', targetSource: 'opencode', selections: [] }, { directory: '/active-project' });

    expect(restartRefreshes).toEqual([{ directory: '/active-project', transportIdentity: 'runtime-a' }]);
    expect(installedRefreshes).toEqual([]);
  });

  test('does not dispatch an install captured for an inactive transport', async () => {
    runtimeKey = 'runtime-b';

    const result = await useSkillsCatalogStore.getState().installSkills(
      { source: 'owner/repo', scope: 'user', targetSource: 'opencode', selections: [] },
      { directory: '/active-project', transportIdentity: 'runtime-a' },
    );

    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('unknown');
    expect(fetchCalls).toEqual([]);
  });
});
