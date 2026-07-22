const VISIBLE_SETTING_KEYS = [
  'themeId', 'useSystemTheme', 'lightThemeId', 'darkThemeId', 'splashBgLight', 'splashFgLight', 'splashBgDark', 'splashFgDark', 'homeDirectory', 'opencodeBinary', 'desktopLanAccessEnabled', 'desktopKeepAwakeEnabled', 'desktopMinimizeToTrayEnabled', 'projects', 'activeProjectId', 'securityScopedBookmarks', 'pinnedDirectories', 'showReasoningTraces', 'collapsibleThinkingBlocks', 'showDeletionDialog', 'nativeNotificationsEnabled', 'notificationMode', 'notifyOnSubtasks', 'notifyOnCompletion', 'notifyOnError', 'notifyOnQuestion', 'notificationTemplates', 'summarizeLastMessage', 'summaryThreshold', 'summaryLength', 'maxLastMessageLength', 'usageAutoRefresh', 'usageRefreshIntervalMs', 'usageDisplayMode', 'usageShowPredValues', 'usageDropdownProviders', 'usageSelectedModels', 'usageCollapsedFamilies', 'usageExpandedFamilies', 'usageModelGroups', 'autoDeleteEnabled', 'autoDeleteAfterDays', 'sessionRetentionAction', 'tunnelProvider', 'tunnelMode', 'tunnelBootstrapTtlMs', 'tunnelSessionTtlMs', 'managedLocalTunnelConfigPath', 'managedRemoteTunnelHostname', 'managedRemoteTunnelPresets', 'managedRemoteTunnelSelectedPresetId', 'defaultModel', 'defaultVariant', 'defaultAgent', 'smallModelUseDefault', 'sessionRecapEnabled', 'sessionSuggestionEnabled', 'sessionTitleRefreshEnabled', 'sessionGoalEnabled', 'sessionGoalDefaultBudgetEnabled', 'sessionGoalDefaultBudget', 'smallModelOverride', 'summaryModelMode', 'summaryProviderID', 'summaryModelID', 'summaryCustomBaseURL', 'summaryCommitPrompt', 'summarySessionTitlePrompt', 'defaultGitIdentityId', 'openInAppId', 'autoCreateWorktree', 'followUpBehavior', 'queueModeEnabled', 'gitmojiEnabled', 'defaultFileViewerPreview', 'zenModel', 'gitProviderId', 'gitModelId', 'pwaAppName', 'pwaOrientation', 'mobileKeyboardMode', 'desktopWindowControlsPosition', 'inputSpellcheckEnabled', 'showOpenCodeUpdateNotifications', 'openCodeUpdateToastDismissedVersion', 'showToolFileIcons', 'codeBlockLineWrap', 'showTurnChangedFiles', 'showExpandedBashTools', 'showSubagentTaskDetails', 'timeFormatPreference', 'weekStartPreference', 'chatRenderMode', 'messageStreamTransport', 'activityRenderMode', 'mermaidRenderingMode', 'userMessageRenderingMode', 'collapsibleUserMessages', 'stickyUserHeader', 'promptNavigatorEnabled', 'expandedEditorToolbar', 'wideChatLayoutEnabled', 'showSplitAssistantMessageActions', 'fontSize', 'terminalFontSize', 'editorFontSize', 'uiFont', 'monoFont', 'padding', 'cornerRadius', 'inputBarOffset', 'shortcutOverrides', 'favoriteModels', 'hiddenModels', 'collapsedModelProviders', 'recentModels', 'recentAgents', 'recentEfforts', 'diffLayoutPreference', 'gitChangesViewMode', 'directoryShowHidden', 'filesViewShowGitignored', 'messageLimit', 'skillCatalogs', 'reportUsage', 'globalBehaviorPrompt', 'responseStyleEnabled', 'responseStylePreset', 'responseStyleCustomInstructions', 'dictationEnabled', 'sttProvider', 'sttServerUrl', 'sttModel', 'sttLocalModel', 'sttLanguage', 'draftStarters', 'draftStartersCraftGoalAdded',
] as const;

export const formatSettingsResponse = (
  persisted: Record<string, unknown>,
  derived: { themeVariant: 'light' | 'dark'; lastDirectory: string },
): Record<string, unknown> => {
  const visible: Record<string, unknown> = {};
  for (const key of VISIBLE_SETTING_KEYS) {
    if (persisted[key] !== undefined) visible[key] = persisted[key];
  }
  const opencodeBinary = typeof persisted.opencodeBinary === 'string' ? persisted.opencodeBinary.trim() : '';
  return {
    ...visible,
    hasManagedRemoteTunnelToken: typeof persisted.managedRemoteTunnelToken === 'string' && persisted.managedRemoteTunnelToken.trim().length > 0,
    hasSummaryCustomAPIToken: typeof persisted.summaryCustomAPIToken === 'string' && persisted.summaryCustomAPIToken.trim().length > 0,
    ...derived,
    opencodeBinary: opencodeBinary || undefined,
  };
};
