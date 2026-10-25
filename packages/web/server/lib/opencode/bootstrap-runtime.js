export const createBootstrapRuntime = (dependencies) => {
  const {
    createUiAuth,
    registerServerStatusRoutes,
    registerCommonRequestMiddleware,
    registerAuthAndAccessRoutes,
    registerTtsRoutes,
    registerNotificationRoutes,
    registerYuriRoutes,
    express,
  } = dependencies;

  const setupBaseRoutes = (app, options) => {
    const {
      process,
      yuriVersion,
      runtimeName,
      serverStartedAt,
      gracefulShutdown,
      getHealthSnapshot,
      verboseRequestLogs,
      uiPassword,
      tunnelAuthController,
      remoteClientAuthRuntime,
      clientPairingRuntime,
      getRelayPairingCandidate,
      reconcileRelay,
      getPairingTransports,
      getDirectCandidateUrls,
      getServerId,
      getServerLabel,
      readSettingsFromDiskMigrated,
      persistSettings,
      normalizeTunnelSessionTtlMs,
      authorizeManagedOpenCodeBridgeRequest,
      getScheduledTaskSkillAuthHeaders,
      sayTTSCapability,
      ensurePushInitialized,
      ensureGlobalWatcherStarted,
      getOrCreateVapidKeys,
      getUiSessionTokenFromRequest,
      writeSettingsToDisk,
      addOrUpdatePushSubscription,
      removePushSubscription,
      addOrUpdateApnsToken,
      removeApnsToken,
      addOrUpdateLiveActivityToken,
      removeLiveActivityToken,
      sendLiveActivityEnd,
      updateUiVisibility,
      clearPendingPushBadge,
      isUiVisible,
      getUiNotificationClients,
      connectNativeNotifications,
      writeSseEvent,
      sessionRuntime,
      setPushInitialized,
      fs,
      os,
      path,
      server,
      __dirname,
      yuriDataDir,
      fetchFreeZenModels,
      getCachedZenModels,
      setAutoAcceptSession,
      sessionIndexService,
      sessionIndexSyncRuntime,
      getCommittedHostMetadata = null,
      transcriptCacheService,
      contentSearch,
    } = options;

    const uiAuthController = createUiAuth({
      password: uiPassword,
      readSettingsFromDiskMigrated,
      clientAuthController: remoteClientAuthRuntime,
    });
    if (uiAuthController.enabled) {
      console.log('UI password protection enabled for browser sessions');
    }

    registerServerStatusRoutes(app, {
      express,
      process,
      yuriVersion,
      runtimeName,
      serverStartedAt,
      gracefulShutdown,
      getHealthSnapshot,
      getServerId,
      tunnelAuthController,
      uiAuthController,
    });

    registerCommonRequestMiddleware(app, { express, verboseRequestLogs });

    registerAuthAndAccessRoutes(app, {
      express,
      tunnelAuthController,
      uiAuthController,
      remoteClientAuthRuntime,
      clientPairingRuntime,
      getRelayPairingCandidate,
      reconcileRelay,
      getPairingTransports,
      getDirectCandidateUrls,
      getServerId,
      getServerLabel,
      readSettingsFromDiskMigrated,
      normalizeTunnelSessionTtlMs,
      authorizeManagedOpenCodeBridgeRequest,
      getScheduledTaskSkillAuthHeaders,
    });

    registerTtsRoutes(app, { sayTTSCapability });

    registerNotificationRoutes(app, {
      uiAuthController,
      ensurePushInitialized,
      ensureGlobalWatcherStarted,
      getOrCreateVapidKeys,
      getUiSessionTokenFromRequest,
      readSettingsFromDiskMigrated,
      writeSettingsToDisk,
      addOrUpdatePushSubscription,
      removePushSubscription,
      addOrUpdateApnsToken,
      removeApnsToken,
      addOrUpdateLiveActivityToken,
      removeLiveActivityToken,
      sendLiveActivityEnd,
      updateUiVisibility,
      clearPendingPushBadge,
      isUiVisible,
      getUiNotificationClients,
      connectNativeNotifications,
      writeSseEvent,
      getSessionActivitySnapshot: sessionRuntime.getSessionActivitySnapshot,
      getSessionStateSnapshot: sessionRuntime.getSessionStateSnapshot,
      getSessionAttentionSnapshot: sessionRuntime.getSessionAttentionSnapshot,
      getSessionState: sessionRuntime.getSessionState,
      getSessionAttentionState: sessionRuntime.getSessionAttentionState,
      markSessionViewed: sessionRuntime.markSessionViewed,
      markSessionUnviewed: sessionRuntime.markSessionUnviewed,
      markUserMessageSent: sessionRuntime.markUserMessageSent,
      setPushInitialized,
      setAutoAcceptSession,
    });

    registerYuriRoutes(app, {
      fs,
      os,
      path,
      process,
      server,
      __dirname,
      yuriDataDir,
      readSettingsFromDiskMigrated,
      persistSettings,
      fetchFreeZenModels,
      getCachedZenModels,
      sessionIndexService,
      sessionIndexSyncRuntime,
      getCommittedHostMetadata,
      transcriptCacheService,
      contentSearch,
      express,
    });

    return {
      uiAuthController,
    };
  };

  return {
    setupBaseRoutes,
  };
};
