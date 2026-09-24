import { beforeEach, describe, expect, test, vi } from 'vitest';

const gateway = vi.hoisted(() => ({
  update: vi.fn(),
  list: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('@/lib/opencode/plugins', () => ({
  updatePluginPackage: gateway.update,
  listPluginRuntime: gateway.list,
  pluginOperationErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
}));
vi.mock('@/lib/runtime-fetch', () => ({
  runtimeFetch: gateway.fetch,
}));

describe('plugin package update', () => {
  beforeEach(() => {
    gateway.update.mockReset();
    gateway.list.mockReset();
    gateway.fetch.mockReset();
    gateway.update.mockResolvedValue(undefined);
    gateway.list.mockResolvedValue([]);
  });

  test('updates one unpinned target without rewriting a pinned spec', async () => {
    const { useProjectsStore } = await import('@/stores/useProjectsStore');
    const { usePluginsStore } = await import('./usePluginsStore');
    useProjectsStore.setState({
      projects: [{ id: 'a', path: '/workspace/a', name: 'a' }],
      activeProjectId: 'a',
    } as never);
    usePluginsStore.setState({ packageUpdates: {} });

    await expect(usePluginsStore.getState().updatePackage('foo')).resolves.toBe(true);
    await expect(usePluginsStore.getState().updatePackage('foo@1.2.3')).resolves.toBe(true);

    expect(gateway.update.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ['/workspace/a', 'foo'],
      ['/workspace/a', 'foo@1.2.3'],
    ]);
    const pluginConfigWrites = gateway.fetch.mock.calls.filter((call) => String(call[0]).includes('/api/config/plugins'));
    expect(pluginConfigWrites).toEqual([]);
  });

  test('a failed update records the OpenCode error and does not rewrite config', async () => {
    const { useProjectsStore } = await import('@/stores/useProjectsStore');
    const { usePluginsStore } = await import('./usePluginsStore');
    const { pluginPackageUpdateKey } = await import('@/queries/pluginQueries');
    useProjectsStore.setState({
      projects: [{ id: 'a', path: '/workspace/a', name: 'a' }],
      activeProjectId: 'a',
    } as never);
    usePluginsStore.setState({ packageUpdates: {} });
    gateway.update.mockRejectedValueOnce(new Error('Failed to update plugin packages: foo: registry timeout'));

    await expect(usePluginsStore.getState().updatePackage('foo')).resolves.toBe(false);

    const failure = usePluginsStore.getState().packageUpdates[pluginPackageUpdateKey('/workspace/a', 'foo')];
    expect(failure).toEqual({ kind: 'failed', error: 'Failed to update plugin packages: foo: registry timeout' });
    expect(gateway.fetch).not.toHaveBeenCalled();
  });
});
