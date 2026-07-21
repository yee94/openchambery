import { registerFsRoutes } from '../fs/routes.js';
import { registerQuotaRoutes } from '../quota/routes.js';
import { registerSmallModelRoutes } from '../small-model/routes.js';
import { registerSessionGoalRoutes } from '../session-goal/routes.js';
import { registerGitHubRoutes } from '../github/routes.js';
import { registerGitRoutes } from '../git/routes.js';
import { registerMagicPromptRoutes } from '../magic-prompts/routes.js';
import { registerSessionFoldersRoutes } from '../session-folders/routes.js';
import { registerPermissionAutoAcceptRoutes } from '../permission-auto-accept/runtime.js';
import { registerConfigEntityRoutes } from './config-entity-routes.js';
import { registerSettingsUtilityRoutes } from './core-routes.js';
import { registerProjectIconRoutes } from './project-icon-routes.js';
import { registerScheduledTaskRoutes } from '../scheduled-tasks/routes.js';
import { registerScheduledTaskToolRoute } from '../scheduled-tasks/managed-tool-route.js';
import { registerConversationRoutes } from '../conversations/routes.js';
import { registerAssistantRoutes } from '../assistants/routes.js';
import { registerMessageQueueRoutes } from '../message-queue/routes.js';
import { registerSkillRoutes } from './skill-routes.js';
import { registerPluginRoutes } from './plugin-routes.js';
import { getNpmInfo, clearCache as clearNpmCache } from './npm-registry.js';
import { parseNpmSpec, parsePathSpec, isExactSemver } from './plugin-spec.js';
import { registerOpenCodeRoutes } from './routes.js';
import { getProviderSources, removeProviderConfig } from './providers.js';
import { getAgentSources, getAgentConfig, createAgent, updateAgent, deleteAgent } from './agents.js';
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
  } = dependencies;

  let quotaProviders = null;
  const getQuotaProviders = async () => {
    if (!quotaProviders) {
      quotaProviders = await import('../quota/index.js');
    }
    return quotaProviders;
  };

  let smallModelService = null;
  let assistantRoutesRuntime = null;
  const getSmallModelService = async () => {
    if (!smallModelService) {
      smallModelService = await import('../small-model/index.js');
    }
    return smallModelService;
  };

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
      persistSettings,
      sanitizeProjects,
      sanitizeSkillCatalogs,
      isUnsafeSkillRelativePath,
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      getOpenCodePort,
      buildAugmentedPath,
      projectConfigRuntime,
      scheduledTasksRuntime,
      markUserMessageSent,
      waitForOpenCodeReady,
      getOpenChamberEventClients,
      writeSseEvent,
      permissionAutoAcceptRuntime,
      messageQueueService,
      messageQueueRuntime,
      broadcastGlobalUiEvent,
      getServerId,
    } = routeDependencies;

    registerSettingsUtilityRoutes(app, {
      readCustomThemesFromDisk,
      refreshOpenCodeAfterConfigChange,
      retryOpenCodeStartup,
      clientReloadDelayMs,
    });

    registerPermissionAutoAcceptRoutes(app, permissionAutoAcceptRuntime);

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

    const assistantAllowedRoots = [];
    const refreshAssistantAllowedRoots = async () => {
      const settings = await readSettingsFromDiskMigrated();
      assistantAllowedRoots.splice(0, assistantAllowedRoots.length, ...sanitizeProjects(settings?.projects ?? [])
        .map((project) => project.path)
        .filter((value) => typeof value === 'string'));
    };
    await refreshAssistantAllowedRoots();
    assistantRoutesRuntime = registerAssistantRoutes(app, {
      openchamberDataDir,
      dbPath: path.join(openchamberDataDir, 'assistants.sqlite'),
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      getServerId,
      getAllowedRoots: () => assistantAllowedRoots,
      refreshAllowedRoots: refreshAssistantAllowedRoots,
    });

    registerMessageQueueRoutes(app, { messageQueueService, messageQueueRuntime });

    registerConfigEntityRoutes(app, {
      resolveProjectDirectory,
      resolveOptionalProjectDirectory,
      refreshOpenCodeAfterConfigChange,
      clientReloadDelayMs,
      getAgentSources,
      getAgentConfig,
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
    registerSmallModelRoutes(app, { getSmallModelService });
    registerSessionGoalRoutes(app);
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
    });
  };

  return {
    registerRoutes,
    close: () => assistantRoutesRuntime?.close(),
  };
};
