import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';

let runtimeFetchCalls = 0;
let responseImpl: () => Promise<Response> = async () => new Response(JSON.stringify({ skills: [] }), { headers: { 'Content-Type': 'application/json' } });
const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });

mock.module('@/lib/runtime-switch', () => ({ getRuntimeTransportIdentity: () => 'runtime-a' }));
mock.module('@/lib/runtime-fetch', () => ({ runtimeFetch: async () => {
  runtimeFetchCalls += 1;
  return responseImpl();
} }));
mock.module('@/lib/opencode/client', () => ({ opencodeClient: { getDirectory: () => '/fallback' } }));
mock.module('@/stores/useProjectsStore', () => ({ useProjectsStore: { getState: () => ({ getActiveProject: () => null }) } }));
mock.module('@/lib/queryRuntime', () => ({
  queryClient: client,
  queryKeys: { skills: { list: (directory: string | null, transport: string) => [transport, 'skills', directory] } },
}));

const { readInstalledSkillsSnapshot, refreshInstalledSkillsQuery } = await import('./installedSkillsQueries');

describe('installedSkillsQueries', () => {
  beforeEach(() => {
    client.clear();
    runtimeFetchCalls = 0;
    responseImpl = async () => new Response(JSON.stringify({ skills: [] }), { headers: { 'Content-Type': 'application/json' } });
  });

  test('deduplicates concurrent refreshes for one transport and directory', async () => {
    let release!: () => void;
    responseImpl = () => new Promise((resolve) => {
      release = () => resolve(new Response(JSON.stringify({ skills: [{ name: 'skill', path: '/skills/skill/SKILL.md' }] }), { headers: { 'Content-Type': 'application/json' } }));
    });

    const first = refreshInstalledSkillsQuery(client, ' /workspace ', 'runtime-a');
    const second = refreshInstalledSkillsQuery(client, '/workspace', 'runtime-a');
    await Promise.resolve();

    expect(runtimeFetchCalls).toBe(1);
    release();
    expect(await Promise.all([first, second])).toEqual([
      [{ name: 'skill', path: '/skills/skill/SKILL.md', scope: 'user', source: 'opencode', description: '', group: undefined }],
      [{ name: 'skill', path: '/skills/skill/SKILL.md', scope: 'user', source: 'opencode', description: '', group: undefined }],
    ]);
  });

  test('retains the previous snapshot after a failed refresh', async () => {
    const previous = [{ name: 'existing', path: '/skills/existing/SKILL.md', scope: 'user' as const, source: 'opencode' as const, description: '' }];
    client.setQueryData(['runtime-a', 'skills', '/workspace'], previous);
    responseImpl = async () => new Response('failure', { status: 500 });

    await expect(refreshInstalledSkillsQuery(client, '/workspace', 'runtime-a')).rejects.toThrow('Failed to list skills: 500');
    expect(readInstalledSkillsSnapshot(client, '/workspace', 'runtime-a')).toEqual(previous);
  });
});
