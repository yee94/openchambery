import { afterEach, expect, it, vi } from 'vitest';
import { opencodeClient } from '@/lib/opencode/client';
import { queryClient, queryKeys } from '@/lib/queryRuntime';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { useConfigStore } from '@/stores/useConfigStore';
import { ChildStoreManager } from './child-store';
import { handleEvent } from './sync-context';
import type { Event } from './types';

afterEach(() => { queryClient.clear(); vi.restoreAllMocks(); vi.useRealTimers(); });

it('reconnect refreshes the current projection without waking 61 persisted directories', async () => {
  vi.useFakeTimers();
  const state = useConfigStore.getState();
  const loadProviders = vi.fn(async () => undefined);
  const loadAgents = vi.fn(async () => true);
  const snapshot = { providers: [], agents: [], currentProviderId: '', currentModelId: '', currentAgentName: undefined, selectedProviderId: '', agentModelSelections: {}, defaultProviders: {} };
  const directoryScoped = Object.fromEntries(Array.from({ length: 61 }, (_, i) => [`/history/${i}`, snapshot]));
  vi.spyOn(useConfigStore, 'getState').mockReturnValue({ ...state, directoryScoped, loadProviders, loadAgents });
  vi.spyOn(opencodeClient, 'getDirectory').mockReturnValue('/current');
  const key = queryKeys.agents.raw('/history/0', getRuntimeTransportIdentity());
  queryClient.setQueryData(key, ['previous']);
  const stores = new ChildStoreManager();
  const routing = { sessionDirectoryById: new Map<string, string>(), messageSessionById: new Map<string, string>(), sessionMessageIdsById: new Map<string, Set<string>>() };
  for (let i = 0; i < 50; i++) handleEvent('global', { type: 'server.connected', properties: {} } as Event, stores, routing);
  await vi.advanceTimersByTimeAsync(100);
  expect(loadProviders.mock.calls).toEqual([[{ directory: '/current', source: 'config-event', forceRefresh: true, allowEmpty: true }]]);
  expect(loadAgents.mock.calls).toEqual([[{ directory: '/current', source: 'config-event', forceRefresh: true }]]);
  expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
  expect(queryClient.getQueryData(key)).toEqual(['previous']);
  loadProviders.mockClear(); loadAgents.mockClear();
  handleEvent('/history/0', { type: 'config.updated', properties: {} } as Event, stores, routing);
  await vi.advanceTimersByTimeAsync(100);
  expect(loadProviders).not.toHaveBeenCalled();
  expect(loadAgents).not.toHaveBeenCalled();
  stores.disposeAll();
});
