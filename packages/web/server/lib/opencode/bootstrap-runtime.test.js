import { describe, expect, it, vi } from 'vitest';
import { createBootstrapRuntime } from './bootstrap-runtime.js';

describe('bootstrap runtime', () => {
  it('passes managed OpenCode bridge authorization to the API auth registration', () => {
    const registerAuthAndAccessRoutes = vi.fn();
    const runtime = createBootstrapRuntime({
      createUiAuth: () => ({ enabled: false }), registerServerStatusRoutes: vi.fn(), registerCommonRequestMiddleware: vi.fn(), registerAuthAndAccessRoutes,
      registerTtsRoutes: vi.fn(), registerNotificationRoutes: vi.fn(), registerOpenChamberRoutes: vi.fn(), express: {},
    });
    const authorizeManagedOpenCodeBridgeRequest = vi.fn();
    runtime.setupBaseRoutes({}, {
      process: {}, openchamberVersion: 'test', runtimeName: 'test', serverStartedAt: 0, gracefulShutdown: vi.fn(), getHealthSnapshot: vi.fn(), verboseRequestLogs: false, uiPassword: null,
      tunnelAuthController: {}, remoteClientAuthRuntime: {}, clientPairingRuntime: {}, getRelayPairingCandidate: vi.fn(), reconcileRelay: vi.fn(), getPairingTransports: vi.fn(), getDirectCandidateUrls: vi.fn(), getServerId: vi.fn(), getServerLabel: vi.fn(), readSettingsFromDiskMigrated: vi.fn(), normalizeTunnelSessionTtlMs: vi.fn(), authorizeManagedOpenCodeBridgeRequest,
      sayTTSCapability: vi.fn(), ensurePushInitialized: vi.fn(), ensureGlobalWatcherStarted: vi.fn(), getOrCreateVapidKeys: vi.fn(), getUiSessionTokenFromRequest: vi.fn(), writeSettingsToDisk: vi.fn(), addOrUpdatePushSubscription: vi.fn(), removePushSubscription: vi.fn(), addOrUpdateApnsToken: vi.fn(), removeApnsToken: vi.fn(), updateUiVisibility: vi.fn(), clearPendingPushBadge: vi.fn(), isUiVisible: vi.fn(), getUiNotificationClients: vi.fn(), writeSseEvent: vi.fn(), sessionRuntime: { getSessionActivitySnapshot: vi.fn(), getSessionStateSnapshot: vi.fn(), getSessionAttentionSnapshot: vi.fn(), getSessionState: vi.fn(), getSessionAttentionState: vi.fn(), markSessionViewed: vi.fn(), markSessionUnviewed: vi.fn(), markUserMessageSent: vi.fn() }, setPushInitialized: vi.fn(), fs: {}, os: {}, path: {}, server: {}, __dirname: '', openchamberDataDir: '', fetchFreeZenModels: vi.fn(), getCachedZenModels: vi.fn(), setAutoAcceptSession: vi.fn(), sessionIndexService: {}, sessionIndexSyncRuntime: {},
    });
    expect(registerAuthAndAccessRoutes).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ authorizeManagedOpenCodeBridgeRequest }));
  });

  it('passes live activity register, unregister, and end into notification route registration', () => {
    const registerNotificationRoutes = vi.fn();
    const runtime = createBootstrapRuntime({
      createUiAuth: () => ({ enabled: false }), registerServerStatusRoutes: vi.fn(), registerCommonRequestMiddleware: vi.fn(), registerAuthAndAccessRoutes: vi.fn(),
      registerTtsRoutes: vi.fn(), registerNotificationRoutes, registerOpenChamberRoutes: vi.fn(), express: {},
    });
    const addOrUpdateLiveActivityToken = vi.fn();
    const removeLiveActivityToken = vi.fn();
    const sendLiveActivityEnd = vi.fn();
    runtime.setupBaseRoutes({}, {
      process: {}, openchamberVersion: 'test', runtimeName: 'test', serverStartedAt: 0, gracefulShutdown: vi.fn(), getHealthSnapshot: vi.fn(), verboseRequestLogs: false, uiPassword: null,
      tunnelAuthController: {}, remoteClientAuthRuntime: {}, clientPairingRuntime: {}, getRelayPairingCandidate: vi.fn(), reconcileRelay: vi.fn(), getPairingTransports: vi.fn(), getDirectCandidateUrls: vi.fn(), getServerId: vi.fn(), getServerLabel: vi.fn(), readSettingsFromDiskMigrated: vi.fn(), normalizeTunnelSessionTtlMs: vi.fn(), authorizeManagedOpenCodeBridgeRequest: vi.fn(),
      sayTTSCapability: vi.fn(), ensurePushInitialized: vi.fn(), ensureGlobalWatcherStarted: vi.fn(), getOrCreateVapidKeys: vi.fn(), getUiSessionTokenFromRequest: vi.fn(), writeSettingsToDisk: vi.fn(), addOrUpdatePushSubscription: vi.fn(), removePushSubscription: vi.fn(), addOrUpdateApnsToken: vi.fn(), removeApnsToken: vi.fn(), addOrUpdateLiveActivityToken, removeLiveActivityToken, sendLiveActivityEnd, updateUiVisibility: vi.fn(), clearPendingPushBadge: vi.fn(), isUiVisible: vi.fn(), getUiNotificationClients: vi.fn(), writeSseEvent: vi.fn(), sessionRuntime: { getSessionActivitySnapshot: vi.fn(), getSessionStateSnapshot: vi.fn(), getSessionAttentionSnapshot: vi.fn(), getSessionState: vi.fn(), getSessionAttentionState: vi.fn(), markSessionViewed: vi.fn(), markSessionUnviewed: vi.fn(), markUserMessageSent: vi.fn() }, setPushInitialized: vi.fn(), fs: {}, os: {}, path: {}, server: {}, __dirname: '', openchamberDataDir: '', fetchFreeZenModels: vi.fn(), getCachedZenModels: vi.fn(), setAutoAcceptSession: vi.fn(), sessionIndexService: {}, sessionIndexSyncRuntime: {},
    });
    expect(registerNotificationRoutes).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      addOrUpdateLiveActivityToken,
      removeLiveActivityToken,
      sendLiveActivityEnd,
    }));
  });
});
