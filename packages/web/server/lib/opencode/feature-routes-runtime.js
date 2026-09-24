import { registerFsRoutes } from '../fs/routes.js';
import { registerQuotaRoutes } from '../quota/routes.js';
import { registerSmallModelRoutes } from '../small-model/routes.js';
import { registerSessionGoalRoutes } from '../session-goal/routes.js';
import { registerSessionMetadataRoutes } from '../session-metadata/routes.js';
import { registerGitHubRoutes } from '../github/routes.js';
import { registerGitRoutes } from '../git/routes.js';
import { registerMagicPromptRoutes } from '../magic-prompts/routes.js';
import { registerSessionFoldersRoutes } from '../session-folders/routes.js';
import { registerPermissionAutoAcceptRoutes } from '../permission-auto-accept/runtime.js';
import { registerQuestionAutoDelegateRoutes } from '../question-auto-delegate/routes.js';
import { registerConfigEntityRoutes } from './config-entity-routes.js';
import { registerSettingsUtilityRoutes } from './core-routes.js';
import { registerProjectIconRoutes } from './project-icon-routes.js';
import { registerScheduledTaskRoutes } from '../scheduled-tasks/routes.js';
import { registerScheduledTaskToolRoute } from '../scheduled-tasks/managed-tool-route.js';
import { registerConversationRoutes } from '../conversations/routes.js';
import { registerSessionTurnPageRoutes } from '../session-turn-pages/routes.js';
import { registerAssistantRoutes } from '../assistants/routes.js';
import { registerLlmRoutes } from '../llm/routes.js';
import { registerMessageQueueRoutes } from '../message-queue/routes.js';
import { getBrowserProviderHost } from '../browser-provider/host.js';
import { registerBrowserProviderRoutes } from '../browser-provider/routes.js';
import { createBrowserProviderSelectionStore } from '../browser-provider/selection-store.js';
import { registerSkillRoutes } from './skill-routes.js';
import { registerPluginRoutes } from './plugin-routes.js';
import { getNpmInfo, clearCache as clearNpmCache } from './npm-registry.js';
import { parseNpmSpec, parsePathSpec, isExactSemver } from './plugin-spec.js';
import { registerOpenCodeRoutes } from './routes.js';
import { getProviderSources, removeProviderConfig } from './providers.js';
import { getAgentSources, getAgentConfig, listDisabledAgentOverrides, createAgent, updateAgent, deleteAgent } from './agents.js';
import { getCommandSources, createCommand, updateCommand, deleteCommand } from './commands.js';
import { listMcpConfigs, getMcpConfig, createMcpConfig, updateMcpConfig, deleteMcpConfig } from './mcp.js';
import { listSnippets, getSnippet, createSnippet, updateSnippet, deleteSnippet, expandSnippets } from './snippets.js';
import {
  listPluginEntries,
  getPluginEntry,
  createPluginEntry,
  updatePluginEntry,
  deletePluginEntry,
  listPluginDirFiles,
  readPluginDirFile,
  writePluginDirFile,
  deletePluginDirFile,
  encodePluginId,
  decodePluginId,
} from './plugins.js';
import { SKILL_DIR, SKILL_SCOPE, readSkillSupportingFile, writeSkillSupportingFile, deleteSkillSupportingFile } from './shared.js';
import { getSkillSources, discoverSkills, mergeDiscoveredSkills, createSkill, updateSkill, deleteSkill } from './skills.js';
import { getCuratedSkillsSources } from '../skills-catalog/curated-sources.js';
import { getCacheKey, getCachedScan, setCachedScan } from '../skills-catalog/cache.js';
import { isClawdHubSource, parseSkillRepoSource } from '../skills-catalog/source.js';
import { scanSkillsRepository } from '../skills-catalog/scan.js';
import { installSkillsFromRepository } from '../skills-catalog/install.js';
import { scanClawdHubPage } from '../skills-catalog/clawdhub/scan.js';
import { installSkillsFromClawdHub } from '../skills-catalog/clawdhub/install.js';

/** Fan-out an OpenChamber product SSE tip to every /api/openchamber/events client. */
export const createOpenChamberEventBroadcaster = ({ getOpenChamberEventClients, writeSseEvent }) => (event) => {
  const clients = getOpenChamberEventClients();
  for (const client of clients) {
    try {
      writeSseEvent(client, event);
    } catch {
      clients.delete(client);
    }
  }
};

// Topology routes historically imported this name; same broadcaster.
export const createWorktreeTopologyBroadcaster = createOpenChamberEventBroadcaster;

export const createFeatureRoutesRuntime = (dependencies) => {
  const {
    clientReloadDelayMs,
    getSmallModelService: injectedGetSmallModelService,
  } = dependencies;

  let quotaProviders = null;
  const getQuotaProviders = async () => {
    if (!quotaProviders) {
      quotaProviders = await import('../quota/index.js');
    }
    return quotaProviders;
  };

  let assistantRoutesRuntime = null;

  const registerRoutes = async (app, routeDependencies) => {
    const {
      express,
      crypto,
      fs,
      os,
      path,
      fsPromises,
      spawn,
      resolveGitBinaryForSpawn,
      createFsSearchRuntime,
      openchamberDataDir,
      openchamberUserConfigRoot,
      normalizeDirectoryPath,
      resolveProjectDirectory,
      resolveOptionalProjectDirectory,
      validateDirectoryPath,
      readCustomThemesFromDisk,
      refreshOpenCodeAfterConfigChange,
      retryOpenCodeStartup,
      getOpenCodeResolutionSnapshot,
      formatSettingsResponse,
      readSettingsFromDisk,
      readSettingsFromDiskMigrated,
      readSettingsFromDiskStrict,
      persistSettings,
      sanitizeProjects,
      sanitizeSkillCatalogs,
      isUnsafeSkillRelativePath,
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      getIsExternalOpenCode = () => false,
      getIsSharedOpenCodeService = () => false,
      forceResolvedOpenCodeBinary = null,
      restartOpenCode = null,
      getRuntimeContract = () => null,
      getOpenCodeServeVersion = () => null,
      getOpenCodeCliVersion = () => null,
      getResolvedOpenCodeBinary = () => null,
      getResolvedOpenCodeBinarySource = () => null,
      getActiveSessionCount = () => 0,
      getSmallModelService: routeGetSmallModelService,
      getOpenCodePort,
      buildAugmentedPath,
      projectConfigRuntime,
      scheduledTasksRuntime,
      runHistoryStore,
      markUserMessageSent,
      waitForOpenCodeReady,
      getOpenChamberEventClients,
      writeSseEvent,
      permissionAutoAcceptRuntime,
      questionAutoDelegateRuntime,
      messageQueueService,
      messageQueueRuntime,
      broadcastGlobalUiEvent,
      globalMessageStreamHub,
      getServerId,
      sessionIndexService,
      notifyContactTurnComplete,
      sessionMetadataStore = null,
      sessionArchiveService = null,
      onSessionMetadataWritten = null,
      persistSessionGoal = null,
      persistSessionMetadata = null,
      onSystemSessionPersisted = null,
      readSessionMetadata = null,
    } = routeDependencies;

    registerSettingsUtilityRoutes(app, {
      readCustomThemesFromDisk,
      refreshOpenCodeAfterConfigChange,
      retryOpenCodeStartup,
      clientReloadDelayMs,
    });

    registerPermissionAutoAcceptRoutes(app, permissionAutoAcceptRuntime);
    // Question auto-delegate + precise /api/question/:id/reply|reject intercepts
    // must win before the generic OpenCode proxy.
    if (questionAutoDelegateRuntime) {
      registerQuestionAutoDelegateRoutes(app, questionAutoDelegateRuntime);
    }

    registerOpenCodeRoutes(app, {
      crypto,
      clientReloadDelayMs,
      getOpenCodeResolutionSnapshot,
      formatSettingsResponse,
      readSettingsFromDisk,
      readSettingsFromDiskMigrated,
      persistSettings,
      sanitizeProjects,
      validateDirectoryPath,
      resolveProjectDirectory,
      getProviderSources,
      removeProviderConfig,
      refreshOpenCodeAfterConfigChange,
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      getIsExternalOpenCode,
      getIsSharedOpenCodeService,
      forceResolvedOpenCodeBinary,
      restartOpenCode,
      waitForOpenCodeReady,
      getRuntimeContract,
      getOpenCodeServeVersion,
      getOpenCodeCliVersion,
      getResolvedOpenCodeBinary,
      getResolvedOpenCodeBinarySource,
      getActiveSessionCount,
      openchamberDataDir,
      onSettingsPersisted: (updated, changes) => {
        if (!questionAutoDelegateRuntime) return;
        if (!Object.prototype.hasOwnProperty.call(changes ?? {}, 'questionAutoDelegateEnabled')) return;
        // Only a real boolean may change runtime state — invalid/coerced junk is ignored.
        const fromChanges = changes.questionAutoDelegateEnabled;
        const fromUpdated = updated?.questionAutoDelegateEnabled;
        const next = typeof fromUpdated === 'boolean'
          ? fromUpdated
          : (typeof fromChanges === 'boolean' ? fromChanges : null);
        if (typeof next !== 'boolean') return;
        // Persisted successfully — apply immediately. Failed saves never reach here.
        questionAutoDelegateRuntime.applyEnabled(next);
      },
    });

    registerProjectIconRoutes(app, {
      fsPromises,
      path,
      crypto,
      openchamberDataDir,
      sanitizeProjects,
      readSettingsFromDiskMigrated,
      persistSettings,
      createFsSearchRuntime,
      spawn,
      resolveGitBinaryForSpawn,
    });

    registerScheduledTaskRoutes(app, {
      readSettingsFromDiskMigrated,
      sanitizeProjects,
      projectConfigRuntime,
      scheduledTasksRuntime,
      runHistoryStore,
      getOpenChamberEventClients,
      writeSseEvent,
    });

    registerScheduledTaskToolRoute(app, {
      express,
      path,
      validateDirectoryPath,
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      readSettingsFromDiskMigrated,
      sanitizeProjects,
      projectConfigRuntime,
      scheduledTasksRuntime,
    });

    registerConversationRoutes(app, {
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      markUserMessageSent,
      waitForOpenCodeReady,
    });

    // OpenChamber-owned turn-window messages API — must register before generic proxy.
    registerSessionTurnPageRoutes(app, {
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
    });

    const assistantAllowedRoots = [];
    const refreshAssistantAllowedRoots = async () => {
      const settings = await readSettingsFromDiskMigrated();
      assistantAllowedRoots.splice(0, assistantAllowedRoots.length, ...sanitizeProjects(settings?.projects ?? [])
        .map((project) => project.path)
        .filter((value) => typeof value === 'string'));
    };
    await refreshAssistantAllowedRoots();
    const broadcastAssistantRevisionTip = createOpenChamberEventBroadcaster({
      getOpenChamberEventClients,
      writeSseEvent,
    });
    // Contact turn lifecycle / bubble deltas — same SSE bus, not revision watermark.
    const broadcastContactTurnEvent = createOpenChamberEventBroadcaster({
      getOpenChamberEventClients,
      writeSseEvent,
    });
    registerLlmRoutes(app, {
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      persistSessionMetadata,
      onSystemSessionPersisted,
    });
    assistantRoutesRuntime = registerAssistantRoutes(app, {
      openchamberDataDir,
      dbPath: path.join(openchamberDataDir, 'assistants.sqlite'),
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      getServerId,
      getAllowedRoots: () => assistantAllowedRoots,
      listProjects: async () => {
        const settings = await readSettingsFromDiskMigrated();
        return sanitizeProjects(settings?.projects ?? [])
          .filter((project) => project && typeof project.id === 'string' && typeof project.path === 'string')
          .map((project) => ({
            id: project.id,
            path: project.path,
            ...(typeof project.label === 'string' && project.label.trim()
              ? { label: project.label.trim() }
              : {}),
          }));
      },
      readModelPreferences: async () => {
        const settings = await readSettingsFromDiskStrict();
        return { favoriteModels: settings.favoriteModels, recentModels: settings.recentModels };
      },
      listScheduledTasks: (projectID) => projectConfigRuntime.listScheduledTasks(projectID),
      sessionIndexService,
      archiveSessionHost: sessionArchiveService
        ? async ({ sessionID, directory, archivedAt }) => sessionArchiveService.archiveSession(
          sessionID,
          directory,
          archivedAt,
        )
        : null,
      forgetSessionHost: sessionArchiveService
        ? (sessionID) => sessionArchiveService.forgetSession(sessionID)
        : null,
      persistSessionMetadata,
      onSystemSessionPersisted,
      upsertScheduledTask: (projectID, task) => projectConfigRuntime.upsertScheduledTask(projectID, task),
      syncScheduledTaskProject: (projectID) => scheduledTasksRuntime.syncProject(projectID),
      refreshAllowedRoots: refreshAssistantAllowedRoots,
      globalEventHub: globalMessageStreamHub,
      onRevisionTip: (tip) => broadcastAssistantRevisionTip({
        type: 'openchamber:assistants-changed',
        properties: tip,
      }),
      onContactTurnEvent: (event) => broadcastContactTurnEvent(event),
      onContactTurnComplete: (event) => notifyContactTurnComplete?.(event),
    });
    messageQueueRuntime?.setAssistantDeliveryService?.(assistantRoutesRuntime.service);

    registerMessageQueueRoutes(app, { messageQueueService, messageQueueRuntime });

    registerConfigEntityRoutes(app, {
      resolveProjectDirectory,
      resolveOptionalProjectDirectory,
      refreshOpenCodeAfterConfigChange,
      clientReloadDelayMs,
      waitForOpenCodeReady,
    getAgentSources,
    getAgentConfig,
    listDisabledAgentOverrides,
    createAgent,
      updateAgent,
      deleteAgent,
      getCommandSources,
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      getOpenCodePort,
      createCommand,
      updateCommand,
      deleteCommand,
      listMcpConfigs,
      getMcpConfig,
      createMcpConfig,
      updateMcpConfig,
      deleteMcpConfig,
      listSnippets,
      getSnippet,
      createSnippet,
      updateSnippet,
      deleteSnippet,
      expandSnippets,
    });

    registerPluginRoutes(app, {
      resolveOptionalProjectDirectory,
      refreshOpenCodeAfterConfigChange,
      clientReloadDelayMs,
      listPluginEntries,
      getPluginEntry,
      createPluginEntry,
      updatePluginEntry,
      deletePluginEntry,
      listPluginDirFiles,
      readPluginDirFile,
      writePluginDirFile,
      deletePluginDirFile,
      encodePluginId,
      decodePluginId,
      getNpmInfo,
      parseNpmSpec,
      parsePathSpec,
      isExactSemver,
    });

    const { getProfiles, getProfile } = await import('../git/index.js');

    registerSkillRoutes(app, {
      fs,
      path,
      os,
      resolveProjectDirectory,
      resolveOptionalProjectDirectory,
      readSettingsFromDisk,
      sanitizeSkillCatalogs,
      isUnsafeSkillRelativePath,
      refreshOpenCodeAfterConfigChange,
      clientReloadDelayMs,
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      getOpenCodePort,
      getSkillSources,
      discoverSkills,
      mergeDiscoveredSkills,
      createSkill,
      updateSkill,
      deleteSkill,
      readSkillSupportingFile,
      writeSkillSupportingFile,
      deleteSkillSupportingFile,
      SKILL_SCOPE,
      SKILL_DIR,
      getCuratedSkillsSources,
      getCacheKey,
      getCachedScan,
      setCachedScan,
      parseSkillRepoSource,
      scanSkillsRepository,
      installSkillsFromRepository,
      scanClawdHubPage,
      installSkillsFromClawdHub,
      isClawdHubSource,
      getProfiles,
      getProfile,
    });

    registerQuotaRoutes(app, { getQuotaProviders });
    const getSmallModelService = routeGetSmallModelService
      || injectedGetSmallModelService
      || (async () => {
        throw new Error('Small model service is not configured');
      });
    registerSmallModelRoutes(app, { getSmallModelService });
    registerSessionGoalRoutes(app, {
      // Reuse the index-provided store seam — do not invent a second store.
      persistSessionGoal: typeof persistSessionGoal === 'function'
        ? persistSessionGoal
        : (sessionMetadataStore
          ? async (sessionId, _directory, goal) => {
            const metadata = await sessionMetadataStore.setSessionMetadata(sessionId, {
              openchamber: { goal },
            });
            return metadata;
          }
          : null),
      readSessionMetadata: typeof readSessionMetadata === 'function'
        ? readSessionMetadata
        : (sessionMetadataStore
          ? (sessionId) => sessionMetadataStore.get(sessionId)
          : null),
      // Same arm path as PUT /api/openchamber/sessions/:id/metadata.
      onGoalPersisted: typeof onSessionMetadataWritten === 'function'
        ? onSessionMetadataWritten
        : null,
    });
    if (sessionMetadataStore) {
      registerSessionMetadataRoutes(app, {
        sessionMetadataStore,
        sessionArchiveService,
        broadcastGlobalUiEvent,
        onMetadataWritten: onSessionMetadataWritten,
      });
    }
    registerGitHubRoutes(app);
    const broadcastOpenChamberEvent = createOpenChamberEventBroadcaster({
      getOpenChamberEventClients,
      writeSseEvent,
    });
    const broadcastWorktreeTopologyChanged = createWorktreeTopologyBroadcaster({
      getOpenChamberEventClients,
      writeSseEvent,
    });
    const broadcastWorktreeBootstrapStatus = (event) => {
      broadcastOpenChamberEvent(event);
      if (typeof broadcastGlobalUiEvent === 'function') {
        const directory = typeof event?.properties?.directory === 'string' ? event.properties.directory : '';
        broadcastGlobalUiEvent(event, directory ? { directory } : undefined);
      }
    };
    void import('../git/service.js').then((gitService) => {
      if (typeof gitService.setWorktreeBootstrapStatusBroadcaster === 'function') {
        gitService.setWorktreeBootstrapStatusBroadcaster(broadcastWorktreeBootstrapStatus);
      }
    }).catch(() => {
      // Git service unavailable in this runtime — bootstrap status stays request-scoped.
    });
    registerGitRoutes(app, {
      messageQueueService,
      broadcastWorktreeTopologyChanged,
    });
    registerMagicPromptRoutes(app, {
      fsPromises,
      path,
      openchamberDataDir,
    });
    registerSessionFoldersRoutes(app, {
      fsPromises,
      path,
      openchamberDataDir,
    });
    registerFsRoutes(app, {
      os,
      path,
      fsPromises,
      spawn,
      crypto,
      normalizeDirectoryPath,
      resolveProjectDirectory,
      buildAugmentedPath,
      resolveGitBinaryForSpawn,
      openchamberUserConfigRoot,
      openchamberDataDir,
    });
    const browserProviderHost = getBrowserProviderHost();
    if (typeof openchamberDataDir === 'string' && openchamberDataDir) {
      browserProviderHost.attachSelectionStore(createBrowserProviderSelectionStore(
        path.join(openchamberDataDir, 'browser-provider-selection.json'),
      ));
    }
    registerBrowserProviderRoutes(app, { host: browserProviderHost });
  };

  return {
    registerRoutes,
    close: () => assistantRoutesRuntime?.close(),
  };
};
