import { opencodeClient } from '@/lib/opencode/client';
import { updateBrowserURL } from '@/lib/router';
import { getRuntimeTransportIdentity, type RuntimeEndpointChangedDetail } from '@/lib/runtime-switch';
import { disposeTerminalInputTransport } from '@/lib/terminalApi';
import { useConfigStore } from '@/stores/useConfigStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useAutoReviewStore } from '@/stores/useAutoReviewStore';
import { useUIStore } from '@/stores/useUIStore';
import { usePermissionStore } from '@/stores/permissionStore';
import { resetQuotaStoreForRuntimeSwitch } from '@/stores/useQuotaStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { resetStreamingState } from '@/sync/streaming';

/**
 * After identity switch, never leave the previous runtime's session id on the
 * path. useRouter falls back to path sessionId when the store is empty, so a
 * leftover `/session/ses_old` re-triggers deep-link resolve + missing-directory
 * toasts on first switch into a cold runtime.
 *
 * Always rewrite: restored session (if any) is the only id allowed; otherwise
 * clear. updateBrowserURL no-ops without a browser window / VS Code / embedded chat.
 */
const clearStaleSessionPathAfterRuntimeSwitch = (): void => {
  const sessionState = useSessionUIStore.getState();
  const restoredSessionId = sessionState.currentSessionId;
  const uiState = useUIStore.getState();
  const isNewSession = Boolean(sessionState.newSessionDraft?.open) && !restoredSessionId;
  updateBrowserURL({
    sessionId: restoredSessionId,
    isNewSession,
    tab: uiState.activeMainTab || 'chat',
    isSettingsOpen: uiState.isSettingsDialogOpen,
    settingsPath: uiState.settingsPage,
    diffFile: null,
    diffScope: null,
  }, { replace: true, force: true });
};

// Same-device transport switch (LAN⇄relay for one paired device): rebind the SDK
// to the new transport WITHOUT tearing down connection/session state or remounting
// the sync layer. `reconnectToRuntimeBaseUrl` swaps in a fresh SDK client; the
// caller then forces a re-render so SyncProvider receives it as a new `sdk` prop,
// which re-runs its event-pipeline + bootstrap effects (keyed on `sdk`) to
// reconnect over the new transport IN PLACE. Message-pagination refs, the open
// session, and the whole view are preserved — no reconnecting screen, no flash,
// no bounce back to the draft.
export const reconnectAppForTransportSwitch = (): void => {
  disposeTerminalInputTransport();
  opencodeClient.reconnectToRuntimeBaseUrl();
  // Provider/agent loaders gate writes on catalogTransportIdentity matching the
  // active transport fingerprint. Keep that fingerprint in sync on LAN⇄relay
  // swaps so catalog refreshes are not silently discarded.
  useConfigStore.setState({
    catalogTransportIdentity: getRuntimeTransportIdentity(),
  });
  resetStreamingState();
};

export const resetAppForRuntimeEndpointChange = (detail: RuntimeEndpointChangedDetail): void => {
  useSessionUIStore.getState().prepareForRuntimeSwitch(detail.previousRuntimeKey);
  useUIStore.getState().prepareForRuntimeSwitch(detail.previousRuntimeKey);
  if (detail.previousRuntimeKey) {
    useAutoReviewStore.getState().stopRunningRunsForRuntime(detail.previousRuntimeKey);
  }
  disposeTerminalInputTransport();
  opencodeClient.reconnectToRuntimeBaseUrl();
  useConfigStore.setState({
    // Must match getRuntimeTransportIdentity(), not runtimeKey. runtimeKey is the
    // stable device/instance id (shared across LAN and relay); loadProviders /
    // loadAgents compare against the transport fingerprint (direct:/relay:...).
    catalogTransportIdentity: getRuntimeTransportIdentity(),
    activeDirectoryKey: '__global__',
    directoryScoped: {},
    providerConfigLoadingByDirectory: {},
    agentConfigLoadingByDirectory: {},
    providers: [],
    agents: [],
    defaultProviders: {},
    currentProviderId: '',
    currentModelId: '',
    currentVariant: undefined,
    currentAgentName: undefined,
    selectedProviderId: '',
    agentModelSelections: {},
    lastSelectedAgentName: undefined,
    lastUserSelection: undefined,
    globalLastUserSelection: undefined,
    opencodeDefaultAgent: undefined,
    opencodeDefaultModel: undefined,
    selectionSource: 'auto',
    isConnected: false,
    isInitialized: false,
    connectionPhase: 'connecting',
    lastDisconnectReason: null,
  });
  useProjectsStore.getState().resetForRuntimeSwitch();
  // Cross-project session list (mobile sessions sheet & co) belongs to the
  // previous instance — drop it so stale sessions can't linger after a switch.
  useGlobalSessionsStore.getState().resetForRuntimeSwitch();
  usePermissionStore.getState().reset();
  resetQuotaStoreForRuntimeSwitch();
  useSessionUIStore.getState().restoreForRuntimeSwitch(detail.runtimeKey);
  useUIStore.getState().restoreForRuntimeSwitch(detail.runtimeKey);
  clearStaleSessionPathAfterRuntimeSwitch();
  resetStreamingState();
};
