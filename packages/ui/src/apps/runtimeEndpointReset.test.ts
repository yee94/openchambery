import { expect, mock, test } from 'bun:test';

const configCalls: unknown[] = [];
const configSetState = (value: unknown) => { configCalls.push(value); };
const state = { getState: () => ({ prepareForRuntimeSwitch: mock(() => undefined), restoreForRuntimeSwitch: mock(() => undefined), resetForRuntimeSwitch: mock(() => undefined), stopRunningRunsForRuntime: mock(() => undefined), reset: mock(() => undefined) }) };

mock.module('@/lib/opencode/client', () => ({ opencodeClient: { reconnectToRuntimeBaseUrl: mock(() => undefined) } }));
mock.module('@/lib/terminalApi', () => ({ disposeTerminalInputTransport: mock(() => undefined) }));
mock.module('@/stores/useConfigStore', () => ({ useConfigStore: { setState: configSetState } }));
mock.module('@/stores/useProjectsStore', () => ({ useProjectsStore: state }));
mock.module('@/stores/useGlobalSessionsStore', () => ({ useGlobalSessionsStore: state }));
mock.module('@/stores/useAutoReviewStore', () => ({ useAutoReviewStore: state }));
mock.module('@/stores/useUIStore', () => ({ useUIStore: state }));
mock.module('@/stores/permissionStore', () => ({ usePermissionStore: state }));
mock.module('@/stores/useQuotaStore', () => ({ resetQuotaStoreForRuntimeSwitch: mock(() => undefined) }));
mock.module('@/sync/session-ui-store', () => ({ useSessionUIStore: state }));
mock.module('@/sync/streaming', () => ({ resetStreamingState: mock(() => undefined) }));
mock.module('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => 'relay:test-transport',
}));

const { reconnectAppForTransportSwitch, resetAppForRuntimeEndpointChange } = await import('./runtimeEndpointReset');

test('runtime endpoint switch clears catalog snapshots and selection state', () => {
  configCalls.length = 0;
  resetAppForRuntimeEndpointChange({ previousRuntimeKey: 'runtime-a', runtimeKey: 'runtime-b' } as never);
  const catalogState = configCalls[0] as Record<string, unknown>;
  expect(catalogState.catalogTransportIdentity).toBe('relay:test-transport');
  expect(catalogState.directoryScoped).toEqual({});
  expect(catalogState.providers).toEqual([]);
  expect(catalogState.agents).toEqual([]);
  expect(catalogState.defaultProviders).toEqual({});
  expect(catalogState.currentProviderId).toBe('');
  expect(catalogState.currentModelId).toBe('');
  expect(catalogState.selectedProviderId).toBe('');
});

test('same-device transport switch rebinds catalogTransportIdentity to the active transport', () => {
  configCalls.length = 0;
  reconnectAppForTransportSwitch();
  expect(configCalls).toEqual([{ catalogTransportIdentity: 'relay:test-transport' }]);
});
