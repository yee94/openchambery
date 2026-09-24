import { beforeEach, expect, test, vi } from 'vitest';

const probe = vi.hoisted(() => ({
  reload: vi.fn(async () => undefined),
  health: vi.fn(async () => false),
  projects: vi.fn(() => { throw new Error('Reload must not enumerate projects'); }),
  fetch: vi.fn(() => { throw new Error('Reload must not use host restart or catalog routes'); }),
}));
vi.mock('@/lib/opencode/client', () => ({ opencodeClient: {
  getSdkClient: () => ({ location: { reload: probe.reload } }),
  checkHealth: probe.health,
  getDirectory: () => '/workspace',
} }));
vi.mock('@/stores/useProjectsStore', () => ({ useProjectsStore: { getState: probe.projects } }));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: probe.fetch }));
vi.mock('@/lib/configSync', () => ({ subscribeToConfigChanges: () => () => undefined, emitConfigChange: vi.fn(), scopeMatches: vi.fn() }));
vi.mock('@/stores/useConfigStore', () => ({ useConfigStore: { getState: vi.fn(), setState: vi.fn() } }));

import { reloadOpenCodeLocations } from './useAgentsStore';

beforeEach(() => { vi.clearAllMocks(); });

test('successful official reload completes without health polling, project enumeration or host catalog requests', async () => {
  await expect(reloadOpenCodeLocations()).resolves.toBeUndefined();
  expect(probe.reload).toHaveBeenCalledTimes(1);
  expect(probe.health).not.toHaveBeenCalled();
  expect(probe.projects).not.toHaveBeenCalled();
  expect(probe.fetch).not.toHaveBeenCalled();
});

test('official reload failure is preserved without a restart fallback', async () => {
  const failure = new Error('reload unavailable');
  probe.reload.mockRejectedValueOnce(failure);
  await expect(reloadOpenCodeLocations()).rejects.toBe(failure);
  expect(probe.reload).toHaveBeenCalledTimes(1);
  expect(probe.fetch).not.toHaveBeenCalled();
});
