import { afterEach, expect, test, vi } from 'vitest';
import { fetchDesktopInstalledApps, openDesktopProjectInApp } from './desktop';

const io = vi.hoisted(() => ({ key: 'host:ssh-a', invoke: vi.fn() }));
vi.mock('@/lib/runtime-switch', () => ({ getRuntimeKey: () => io.key, getRuntimeApiBaseUrl: () => '' }));
vi.mock('@/lib/relay/runtime-tunnel', () => ({ isRelayModeActive: () => false }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  io.key = 'host:ssh-a';
});

test('SSH handoff never uses the local-path IPC and rejects a stale host after switching', async () => {
  vi.stubGlobal('__OPENCHAMBER_DESKTOP__', { invoke: io.invoke });
  io.invoke.mockResolvedValue(null);
  expect(await openDesktopProjectInApp('/srv/a ', 'cursor', 'Cursor', 'ssh-a')).toBe(true);
  expect(io.invoke).toHaveBeenCalledWith('desktop_open_ssh_in_app', { projectPath: '/srv/a ', appId: 'cursor', hostId: 'ssh-a' });
  io.key = 'host:other';
  expect(await openDesktopProjectInApp('/srv/a', 'cursor', 'Cursor', 'ssh-a')).toBe(false);
  expect(await openDesktopProjectInApp('/srv/a', 'cursor', 'Cursor')).toBe(false);
  expect(io.invoke).toHaveBeenCalledTimes(1);
});

test('local app catalog can be read from a trusted desktop UI connected to SSH', async () => {
  vi.stubGlobal('__OPENCHAMBER_DESKTOP__', { invoke: io.invoke });
  io.invoke.mockResolvedValue({ apps: [{ name: 'Cursor' }], hasCache: true, isCacheStale: false });
  const result = await fetchDesktopInstalledApps(['Cursor']);
  expect(result.success).toBe(true);
  expect(result.apps[0].name).toBe('Cursor');
  expect(io.invoke).toHaveBeenCalledWith('desktop_get_installed_apps', { apps: ['Cursor'], force: undefined });
});
