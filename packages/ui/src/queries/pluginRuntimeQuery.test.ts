import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { PluginRuntimeInfo } from '@/lib/opencode/plugins';

const gateway = vi.hoisted(() => ({
  list: vi.fn(),
  check: vi.fn(),
}));

vi.mock('@/lib/opencode/client', () => ({ opencodeClient: { getDirectory: () => '/fallback' } }));
vi.mock('@/stores/useProjectsStore', () => ({
  useProjectsStore: Object.assign(() => null, { getState: () => ({ getActiveProject: () => ({ path: '/workspace/project' }) }) }),
}));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => 'runtime-a',
  getRuntimeGeneration: () => 0,
  isRuntimeEndpointIdentityChange: () => false,
  subscribeRuntimeEndpointChanged: () => () => undefined,
}));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: vi.fn() }));
vi.mock('@/lib/opencode/plugins', () => ({
  listPluginRuntime: gateway.list,
  checkPluginUpdates: gateway.check,
}));

const loaded: PluginRuntimeInfo = {
  source: { kind: 'package', target: 'foo', version: '1.0.0', outdated: false, updating: false },
  state: { kind: 'active' },
};
const checked: PluginRuntimeInfo = {
  source: { kind: 'package', target: 'foo', version: '1.1.0', outdated: true, updating: false },
  state: { kind: 'active' },
};

describe('plugin runtime query', () => {
  beforeEach(async () => {
    gateway.list.mockReset();
    gateway.check.mockReset();
    const { queryClient } = await import('@/lib/queryRuntime');
    queryClient.clear();
  });

  test('a failed refresh keeps the previous inventory instead of an empty success', async () => {
    const { queryClient } = await import('@/lib/queryRuntime');
    const { pluginRuntimeQueryOptions } = await import('./pluginQueries');
    gateway.list.mockResolvedValueOnce([loaded]);
    const options = pluginRuntimeQueryOptions('/workspace/a', 'runtime-a');
    await queryClient.fetchQuery(options);

    gateway.list.mockRejectedValueOnce(new Error('down'));
    await expect(queryClient.fetchQuery({ ...options, staleTime: 0, retry: false })).rejects.toThrow('down');
    expect(queryClient.getQueryData(options.queryKey)).toEqual([loaded]);
  });

  test('a successful empty inventory is empty, not a synthetic loaded list', async () => {
    const { queryClient } = await import('@/lib/queryRuntime');
    const { pluginRuntimeQueryOptions } = await import('./pluginQueries');
    gateway.list.mockResolvedValueOnce([]);
    const options = pluginRuntimeQueryOptions('/workspace/a', 'runtime-a');
    await expect(queryClient.fetchQuery({ ...options, retry: false })).resolves.toEqual([]);
  });

  test('a slower list does not replace a check that already landed', async () => {
    const { queryClient } = await import('@/lib/queryRuntime');
    const { checkPluginRuntimeUpdates, pluginRuntimeQueryOptions } = await import('./pluginQueries');
    let release: (value: PluginRuntimeInfo[]) => void = () => undefined;
    gateway.list.mockImplementationOnce(() => new Promise<PluginRuntimeInfo[]>((resolve) => {
      release = resolve;
    }));
    gateway.check.mockResolvedValueOnce([checked]);
    const options = pluginRuntimeQueryOptions('/workspace/a', 'runtime-a');
    const pending = queryClient.fetchQuery({ ...options, retry: false });
    await checkPluginRuntimeUpdates('/workspace/a', queryClient);
    release([loaded]);
    await expect(pending).resolves.toEqual([checked]);
    expect(queryClient.getQueryData(options.queryKey)).toEqual([checked]);
  });

  test('a failed check leaves the inventory on screen', async () => {
    const { queryClient } = await import('@/lib/queryRuntime');
    const { checkPluginRuntimeUpdates, pluginRuntimeQueryOptions } = await import('./pluginQueries');
    gateway.list.mockResolvedValueOnce([loaded]);
    const options = pluginRuntimeQueryOptions('/workspace/a', 'runtime-a');
    await queryClient.fetchQuery({ ...options, retry: false });
    gateway.check.mockRejectedValueOnce(new Error('down'));
    await expect(checkPluginRuntimeUpdates('/workspace/a', queryClient)).rejects.toThrow('down');
    expect(queryClient.getQueryData(options.queryKey)).toEqual([loaded]);
  });
});
