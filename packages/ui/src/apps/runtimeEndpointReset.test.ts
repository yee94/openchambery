import { expect, mock, test } from 'bun:test';

const configCalls: unknown[] = [];
const configSetState = (value: unknown) => { configCalls.push(value); };
const updateBrowserURLCalls: unknown[] = [];
let pathSessionId: string | null = 'ses_previous_runtime';
let restoredSessionId: string | null = null;
let newSessionDraftOpen = false;

const sessionUiState = {
  prepareForRuntimeSwitch: mock(() => undefined),
  restoreForRuntimeSwitch: mock(() => {
    // Mirror production: restore may leave no session for a cold runtime.
  }),
  get currentSessionId() {
    return restoredSessionId;
  },
  get newSessionDraft() {
    return { open: newSessionDraftOpen };
  },
};

const uiState = {
  prepareForRuntimeSwitch: mock(() => undefined),
  restoreForRuntimeSwitch: mock(() => undefined),
  activeMainTab: 'chat' as const,
  isSettingsDialogOpen: false,
  settingsPage: 'home',
};

const state = {
  getState: () => ({
    prepareForRuntimeSwitch: mock(() => undefined),
    restoreForRuntimeSwitch: mock(() => undefined),
    resetForRuntimeSwitch: mock(() => undefined),
    stopRunningRunsForRuntime: mock(() => undefined),
    reset: mock(() => undefined),
  }),
};

mock.module('@/lib/opencode/client', () => ({ opencodeClient: { reconnectToRuntimeBaseUrl: mock(() => undefined) } }));
mock.module('@/lib/terminalApi', () => ({ disposeTerminalInputTransport: mock(() => undefined) }));
mock.module('@/stores/useConfigStore', () => ({ useConfigStore: { setState: configSetState } }));
mock.module('@/stores/useProjectsStore', () => ({ useProjectsStore: state }));
mock.module('@/stores/useGlobalSessionsStore', () => ({ useGlobalSessionsStore: state }));
mock.module('@/stores/useAutoReviewStore', () => ({ useAutoReviewStore: state }));
mock.module('@/stores/useUIStore', () => ({
  useUIStore: {
    getState: () => uiState,
  },
}));
mock.module('@/stores/permissionStore', () => ({ usePermissionStore: state }));
mock.module('@/stores/useQuotaStore', () => ({ resetQuotaStoreForRuntimeSwitch: mock(() => undefined) }));
mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: {
    getState: () => sessionUiState,
  },
}));
mock.module('@/sync/streaming', () => ({ resetStreamingState: mock(() => undefined) }));
mock.module('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => 'relay:test-transport',
}));
mock.module('@/lib/router', () => ({
  parseRoute: () => ({ sessionId: pathSessionId }),
  updateBrowserURL: (state: unknown, options: unknown) => {
    updateBrowserURLCalls.push({ state, options });
  },
}));

const { reconnectAppForTransportSwitch, resetAppForRuntimeEndpointChange } = await import('./runtimeEndpointReset');

test('runtime endpoint switch clears catalog snapshots and selection state', () => {
  configCalls.length = 0;
  updateBrowserURLCalls.length = 0;
  pathSessionId = null;
  restoredSessionId = null;
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

test('runtime endpoint switch clears a previous-runtime session path when restore has no session', () => {
  configCalls.length = 0;
  updateBrowserURLCalls.length = 0;
  pathSessionId = 'ses_previous_runtime';
  restoredSessionId = null;
  newSessionDraftOpen = false;
  resetAppForRuntimeEndpointChange({ previousRuntimeKey: 'runtime-a', runtimeKey: 'runtime-b' } as never);
  expect(updateBrowserURLCalls).toHaveLength(1);
  const call = updateBrowserURLCalls[0] as {
    state: { sessionId: string | null; isNewSession: boolean };
    options: { replace: boolean; force: boolean };
  };
  expect(call.state.sessionId).toBeNull();
  expect(call.state.isNewSession).toBe(false);
  expect(call.options).toEqual({ replace: true, force: true });
});

test('runtime endpoint switch keeps path when restore recovers the same session id', () => {
  updateBrowserURLCalls.length = 0;
  pathSessionId = 'ses_restored';
  restoredSessionId = 'ses_restored';
  resetAppForRuntimeEndpointChange({ previousRuntimeKey: 'runtime-b', runtimeKey: 'runtime-a' } as never);
  expect(updateBrowserURLCalls).toEqual([]);
});
