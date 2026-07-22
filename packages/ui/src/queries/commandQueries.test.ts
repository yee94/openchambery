import { beforeEach, describe, expect, mock, test } from 'bun:test';

let activeProjectPath = '/workspace/project';
let runtimeKey = 'runtime-a';
let metadataImpl: () => Promise<Response> = async () => new Response(JSON.stringify({ commands: {} }));
let metadataRequest: RequestInit | undefined;

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    getDirectory: () => '/fallback/project',
  },
}));
mock.module('@/stores/useProjectsStore', () => ({
  useProjectsStore: Object.assign(() => null, { getState: () => ({ getActiveProject: () => ({ path: activeProjectPath }) }) }),
}));
mock.module('@/lib/runtime-fetch', () => ({ runtimeFetch: async (_path: string, options?: RequestInit) => {
  metadataRequest = options;
  return metadataImpl();
} }));
mock.module('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => runtimeKey,
  isRuntimeEndpointIdentityChange: () => false,
  subscribeRuntimeEndpointChanged: () => () => undefined,
}));

const { commandQueryOptions, readCommandsSnapshot, refreshCommandsQuery } = await import('./commandQueries');
const { queryClient } = await import('@/lib/queryRuntime');

describe('commandQueries', () => {
  beforeEach(() => {
    queryClient.clear();
    activeProjectPath = '/workspace/project';
    runtimeKey = 'runtime-a';
    metadataRequest = undefined;
    metadataImpl = async () => new Response(JSON.stringify({ commands: {} }));
  });

  test('loads the compact command catalog in one request', async () => {
    metadataImpl = async () => new Response(JSON.stringify({ commands: [{ name: 'command-0', scope: 'project', isBuiltIn: false, reference: 'command-0' }] }));

    const commands = await refreshCommandsQuery(queryClient, activeProjectPath, runtimeKey);

    expect(commands).toHaveLength(1);
    expect(commands[0]?.scope).toBe('project');
    expect(metadataRequest?.body).toBe(JSON.stringify({ catalog: true }));
  });

  test('preserves a complete snapshot when metadata refresh fails', async () => {
    metadataImpl = async () => new Response(JSON.stringify({ commands: [{ name: 'deploy', scope: 'project', isBuiltIn: false, reference: 'deploy' }] }));
    await refreshCommandsQuery(queryClient, activeProjectPath, runtimeKey);
    metadataImpl = async () => { throw new Error('metadata unavailable'); };

    await expect(refreshCommandsQuery(queryClient, activeProjectPath, runtimeKey)).rejects.toThrow('metadata unavailable');
    expect(readCommandsSnapshot()[0]?.scope).toBe('project');
  });

  test('isolates directory and runtime snapshots and shares matching flights', async () => {
    metadataImpl = async () => new Response(JSON.stringify({ commands: [{ name: `${runtimeKey}:${activeProjectPath}`, isBuiltIn: true, reference: 'command' }] }));
    await Promise.all([
      refreshCommandsQuery(queryClient, activeProjectPath, runtimeKey),
      refreshCommandsQuery(queryClient, activeProjectPath, runtimeKey),
    ]);
    activeProjectPath = '/workspace/second';
    await refreshCommandsQuery(queryClient, activeProjectPath, runtimeKey);
    runtimeKey = 'runtime-b';
    await refreshCommandsQuery(queryClient, activeProjectPath, runtimeKey);

    expect(commandQueryOptions(activeProjectPath).queryKey).toEqual(['runtime-b', 'commands', '/workspace/second']);
  });

  test('leaves the captured snapshot untouched when its runtime is inactive', async () => {
    metadataImpl = async () => new Response(JSON.stringify({ commands: [{ name: 'deploy', isBuiltIn: true, reference: 'deploy' }] }));
    await refreshCommandsQuery(queryClient, activeProjectPath, runtimeKey);
    runtimeKey = 'runtime-b';

    await refreshCommandsQuery(queryClient, activeProjectPath, 'runtime-a');

    expect(readCommandsSnapshot(activeProjectPath, 'runtime-a')[0]?.name).toBe('deploy');
  });
});
