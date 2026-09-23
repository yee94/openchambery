import { create } from "zustand";
import type { StoreApi, UseBoundStore } from "zustand";
import { devtools, persist } from "zustand/middleware";
import type { Agent } from '@/lib/opencode/v2-types';
import { opencodeClient } from "@/lib/opencode/client";
import { emitConfigChange, scopeMatches, subscribeToConfigChanges, type ConfigChangeScope } from "@/lib/configSync";
import {
  startConfigUpdate,
  finishConfigUpdate,
  updateConfigUpdateMessage,
} from "@/lib/configUpdate";
import { createDeferredSafeJSONStorage } from "./utils/safeStorage";
import { useConfigStore } from "@/stores/useConfigStore";
import { refreshCommandsQuery } from "@/queries/commandQueries";
import {
  readAgentsSnapshot,
  refreshAgentsQuery,
  resolveConfigQueryDirectory,
  type AgentScope,
  type AgentWithExtras,
} from "@/queries/agentQueries";
import { queryClient } from "@/lib/queryRuntime";
import { useProjectsStore } from "@/stores/useProjectsStore";
import { invalidateSkillsCatalogQueries } from "@/queries/skillsCatalogQueries";
import { refreshInstalledSkillsQuery } from "@/queries/installedSkillsQueries";
import { runtimeFetch } from "@/lib/runtime-fetch";
import { getRuntimeTransportIdentity } from "@/lib/runtime-switch";

// Note: useDirectoryStore cannot be imported at top level to avoid circular dependency
// useDirectoryStore -> useAgentsStore (for refreshAfterOpenCodeRestart)
// useAgentsStore -> useDirectoryStore (for currentDirectory)
const getCurrentDirectory = (): string | null => {
  const opencodeDirectory = opencodeClient.getDirectory();
  if (typeof opencodeDirectory === 'string' && opencodeDirectory.trim().length > 0) {
    return opencodeDirectory;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (window as any).__zustand_directory_store__;
    if (store) {
      return store.getState().currentDirectory;
    }
  } catch {
    // ignore
  }

  return null;
};

const getConfigDirectory = resolveConfigQueryDirectory;

export type { AgentScope } from "@/queries/agentQueries";

export interface AgentConfig {
  name: string;
  description?: string | null;
  model?: string | null;
  system?: string | null;
  mode?: "primary" | "subagent" | "all";
  steps?: number | null;
  hidden?: boolean;
  disabled?: boolean;
  color?: string | null;
  permissions?: Array<{ action: string; resource: string; effect: "allow" | "ask" | "deny" }> | null;
  scope?: AgentScope;
  confirmDrop?: boolean;
}

/**
 * Result of an agent config mutation.
 * `requiresManualRestart` is true when the change was persisted to disk but the
 * connected (external) OpenCode server could not be reloaded by OpenChamber, so
 * the user must restart that server before the change takes effect.
 */
export interface AgentMutationResult {
  ok: boolean;
  requiresManualRestart?: boolean;
}

// Helper to check if agent is built-in (handles both SDK 'builtIn' and API 'native')
export const isAgentBuiltIn = (agent: Agent): boolean => {
  const extended = agent as AgentWithExtras & { builtIn?: boolean };
  return extended.native === true || extended.builtIn === true;
};

// Helper to check if agent is hidden (internal agents like title, compaction, summary)
// Checks both top-level hidden and options.hidden (OpenCode API inconsistency workaround)
export const isAgentHidden = (agent: Agent): boolean => {
  const extended = agent as AgentWithExtras;
  return extended.hidden === true || extended.options?.hidden === true;
};

// Helper to filter only visible (non-hidden) agents
export const filterVisibleAgents = (agents: Agent[]): Agent[] =>
  agents.filter((agent) => !isAgentHidden(agent));

const CONFIG_EVENT_SOURCE = "useAgentsStore";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_HEALTH_WAIT_MS = 20000;
const FAST_HEALTH_POLL_INTERVAL_MS = 300;
const FAST_HEALTH_POLL_ATTEMPTS = 4;
const SLOW_HEALTH_POLL_BASE_MS = 800;
const SLOW_HEALTH_POLL_INCREMENT_MS = 200;
const SLOW_HEALTH_POLL_MAX_MS = 2000;

export interface AgentDraft {
  name: string;
  scope: AgentScope;
  description?: string;
  model?: string | null;
  system?: string;
  mode?: "primary" | "subagent" | "all";
  steps?: number | null;
  hidden?: boolean;
  disabled?: boolean;
  color?: string | null;
  permissions?: AgentConfig["permissions"];
}

interface AgentsStore {

  selectedAgentName: string | null;
  agentDraft: AgentDraft | null;

  setSelectedAgent: (name: string | null) => void;
  setAgentDraft: (draft: AgentDraft | null) => void;
  loadAgents: () => Promise<boolean>;
  createAgent: (config: AgentConfig) => Promise<AgentMutationResult>;
  updateAgent: (name: string, config: Partial<AgentConfig>) => Promise<AgentMutationResult>;
  deleteAgent: (name: string, scope?: AgentScope) => Promise<AgentMutationResult>;
  getAgentByName: (name: string) => Agent | undefined;
  // Returns only visible agents (excludes hidden internal agents)
  getVisibleAgents: () => Agent[];
}

declare global {
  interface Window {
    __zustand_agents_store__?: UseBoundStore<StoreApi<AgentsStore>>;
  }
}

export const useAgentsStore = create<AgentsStore>()(
  devtools(
    persist(
      (set) => ({
        selectedAgentName: null,
        agentDraft: null,
        setSelectedAgent: (selectedAgentName) => set({ selectedAgentName }),
        setAgentDraft: (agentDraft) => set({ agentDraft }),
        loadAgents: async () => {
          const directory = getConfigDirectory();
          const transport = getRuntimeTransportIdentity();
          try {
            await refreshAgentsQuery(queryClient, directory, transport);
            return true;
          } catch {
            return false;
          }
        },
        createAgent: async (config) => mutateAgent('POST', config.name, config, set),
        updateAgent: async (name, config) => mutateAgent('PATCH', name, config, set),
        deleteAgent: async (name, scope) => mutateAgent('DELETE', name, { scope }, set),
        getAgentByName: (name) => readAgentsSnapshot().find((agent) => agent.name === name),
        getVisibleAgents: () => filterVisibleAgents(readAgentsSnapshot()),
      }),
      {
        name: "agents-store",
        storage: createDeferredSafeJSONStorage(),
        partialize: (state) => ({
          selectedAgentName: state.selectedAgentName,
        }),
      },
    ),
    {
      name: "agents-store",
    },
  ),
);

if (typeof window !== "undefined") {
  window.__zustand_agents_store__ = useAgentsStore;
}

async function refreshMutationAgents(directory: string | null, transport: string) {
  await refreshAgentsQuery(queryClient, directory, transport);
  if (getRuntimeTransportIdentity() === transport) {
    emitConfigChange("agents", { source: CONFIG_EVENT_SOURCE });
  }
}

async function mutateAgent(
  method: 'POST' | 'PATCH' | 'DELETE',
  name: string,
  config: Partial<AgentConfig> | undefined,
  set: (partial: Partial<AgentsStore>) => void,
): Promise<AgentMutationResult> {
  const directory = getConfigDirectory();
  const transport = getRuntimeTransportIdentity();
  try {
    const native: Record<string, unknown> = {};
    for (const key of ['description', 'mode', 'model', 'system', 'steps', 'hidden', 'disabled', 'color', 'permissions'] as const) {
      if (config && key in config && config[key] !== undefined) native[key] = config[key];
    }
    const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
    const response = await runtimeFetch(`/api/config/agents/${encodeURIComponent(name)}${query}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(directory ? { 'x-opencode-directory': directory } : {}) },
      body: JSON.stringify(method === 'DELETE'
        ? { scope: config?.scope }
        : { native, ...(config?.scope ? { scope: config.scope } : {}), ...(config?.confirmDrop ? { confirmDrop: true } : {}) }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error || `Failed to ${method.toLowerCase()} agent`);
    if (getRuntimeTransportIdentity() !== transport) {
      return { ok: true, ...(payload?.requiresManualRestart ? { requiresManualRestart: true } : {}) };
    }
    if (method === 'DELETE' && useAgentsStore.getState().selectedAgentName === name) {
      set({ selectedAgentName: null });
    }
    if (payload?.requiresManualRestart) return { ok: true, requiresManualRestart: true };
    await refreshMutationAgents(directory, transport);
    return { ok: true };
  } catch (error) {
    console.error(`[AgentsStore] ${method} agent failed:`, error);
    return { ok: false };
  }
}

async function waitForOpenCodeConnection(delayMs?: number) {
  const initialPause = typeof delayMs === "number" && delayMs > 0
    ? Math.min(delayMs, FAST_HEALTH_POLL_INTERVAL_MS)
    : 0;

  if (initialPause > 0) {
    await sleep(initialPause);
  }

  const start = Date.now();
  let attempt = 0;
  let lastError: unknown = null;

  while (Date.now() - start < MAX_HEALTH_WAIT_MS) {
    attempt += 1;
    updateConfigUpdateMessage(`Waiting for OpenCode… (attempt ${attempt})`);

    try {
      const isHealthy = await opencodeClient.checkHealth();
      if (isHealthy) {
        return;
      }
      lastError = new Error("OpenCode health check reported not ready");
    } catch (error) {
      lastError = error;
    }

    const elapsed = Date.now() - start;

    const waitMs =
      attempt <= FAST_HEALTH_POLL_ATTEMPTS && elapsed < 1200
        ? FAST_HEALTH_POLL_INTERVAL_MS
        : Math.min(
            SLOW_HEALTH_POLL_BASE_MS +
              Math.max(0, attempt - FAST_HEALTH_POLL_ATTEMPTS) * SLOW_HEALTH_POLL_INCREMENT_MS,
            SLOW_HEALTH_POLL_MAX_MS,
          );

    await sleep(waitMs);
  }

  throw lastError || new Error("OpenCode did not become ready in time");
}

type ConfigRefreshMode = "active" | "projects";

interface ConfigRefreshOptions {
  message?: string;
  delayMs?: number;
  scopes?: ConfigChangeScope[];
  mode?: ConfigRefreshMode;
  transportIdentity?: string;
  queryDirectory?: string | null;
  /** Refresh catalogs without driving the blocking config-update overlay. */
  silent?: boolean;
  waitForConnection?: boolean;
}

const normalizeRefreshScopes = (scopes?: ConfigChangeScope[]): ConfigChangeScope[] => {
  if (!scopes || scopes.length === 0) {
    return ["all"];
  }

  const unique = Array.from(new Set(scopes));
  if (unique.includes("all")) {
    return ["all"];
  }

  return unique;
};

async function performConfigRefresh(options: ConfigRefreshOptions = {}) {
  const { message, delayMs } = options;
  const transport = options.transportIdentity ?? getRuntimeTransportIdentity();
  const queryDirectory = options.queryDirectory ?? getConfigDirectory();
  const scopes = normalizeRefreshScopes(options.scopes);
  const mode: ConfigRefreshMode = options.mode ?? (scopes.includes("all") ? "projects" : "active");
  const silent = options.silent === true;

  if (!silent) {
    try {
      updateConfigUpdateMessage(message || "Refreshing configuration…");
    } catch {
      // ignore
    }
  }

  try {
    if (getRuntimeTransportIdentity() !== transport) return;
    if (options.waitForConnection !== false) await waitForOpenCodeConnection(delayMs);
    if (getRuntimeTransportIdentity() !== transport) return;

    const configStore = useConfigStore.getState();

    const refreshProviders = scopes.includes("all") || scopes.includes("providers");
    const refreshSdkAgents = scopes.includes("all") || scopes.includes("agents");
    const refreshAgentConfigs = scopes.includes("all") || scopes.includes("agents");
    const refreshCommands = scopes.includes("all") || scopes.includes("commands");
    const refreshSkills = scopes.includes("all") || scopes.includes("skills");
    const refreshMcp = scopes.includes("all") || scopes.includes("mcp");

    const currentDirectory = getCurrentDirectory();
    const projects = mode === "projects" ? useProjectsStore.getState().projects : [];
    const directoriesToRefresh = Array.from(
      new Set([
         ...(queryDirectory ? [queryDirectory] : currentDirectory ? [currentDirectory] : []),
        ...projects.map((project) => project.path).filter(Boolean),
      ]),
    );

    if (scopes.includes("all") && mode === "projects") {
      useConfigStore.setState({ directoryScoped: {} });
    }

    if (refreshProviders) {
      useConfigStore.getState().invalidateProviderCache(mode === "active" ? currentDirectory : undefined);
    }

    const sdkRefreshTasks: Promise<void>[] = [];
    for (const directory of directoriesToRefresh) {
      if (refreshProviders) {
        sdkRefreshTasks.push(configStore.loadProviders({ directory, source: 'agentsStore:refreshConfig', forceRefresh: true, allowEmpty: true }).then(() => undefined));
      }
      if (refreshSdkAgents) {
        sdkRefreshTasks.push(configStore.loadAgents({ directory, source: 'agentsStore:refreshConfig', forceRefresh: true }).then(() => undefined));
      }
    }

    const uiRefreshTasks: Promise<void>[] = [];
    if (refreshAgentConfigs) {
      uiRefreshTasks.push(refreshAgentsQuery(queryClient, queryDirectory, transport).then(() => undefined));
    }
    if (refreshCommands) {
      uiRefreshTasks.push(refreshCommandsQuery(queryClient, queryDirectory, transport).then(() => undefined));
    }
    if (refreshSkills) {
      uiRefreshTasks.push(refreshInstalledSkillsQuery(queryClient, queryDirectory, transport).then(() => undefined));
      uiRefreshTasks.push(invalidateSkillsCatalogQueries(queryClient, queryDirectory, transport).then(() => undefined));
    }
    if (refreshMcp) {
      const { refreshMcpConfigsQuery, refreshMcpStatusQuery } = await import("@/queries/mcpQueries");
      if (getRuntimeTransportIdentity() !== transport) return;
      uiRefreshTasks.push(refreshMcpConfigsQuery(queryClient, queryDirectory, transport).then(() => undefined));
      uiRefreshTasks.push(refreshMcpStatusQuery(queryClient, queryDirectory, transport).then(() => undefined));
    }

    if (!silent) updateConfigUpdateMessage("Refreshing configuration…");
    await Promise.all([...sdkRefreshTasks, ...uiRefreshTasks]);
  } catch (error) {
    if (!silent) {
      updateConfigUpdateMessage("OpenCode refresh failed. Please retry.");
      await sleep(1500);
    }
    throw error;
  } finally {
    if (!silent) finishConfigUpdate();
  }
}

export async function refreshAfterOpenCodeRestart(options?: ConfigRefreshOptions) {
  await performConfigRefresh(options);
}

/** Refresh UI data after a V2 mutation; never reload locations or the service. */
export async function refreshOpenCodeConfiguration(options?: ConfigRefreshOptions) {
  await performConfigRefresh({ ...options, silent: true, waitForConnection: false });
}

/**
 * Settings "Reload OpenCode" and the VS Code `/reload` command: OpenCode
 * `location.reload` rebuilds every loaded location in place (running sessions
 * continue at the next step boundary), unlike `restartOpenCodeService`, which
 * restarts the managed process. Web, desktop, and mobile keep only the
 * Settings action.
 */
export async function reloadOpenCodeLocations(): Promise<void> {
  const transport = getRuntimeTransportIdentity();
  await opencodeClient.getSdkClient().location.reload();
  if (getRuntimeTransportIdentity() !== transport) return;
  await performConfigRefresh({ transportIdentity: transport, scopes: ["all"], mode: "projects", silent: true });
}

export async function restartOpenCodeService(options?: ConfigRefreshOptions) {
  startConfigUpdate(options?.message || "Reloading OpenCode configuration…");
  const transport = options?.transportIdentity ?? getRuntimeTransportIdentity();
  const queryDirectory = options?.queryDirectory ?? getConfigDirectory();

  try {

    const response = await runtimeFetch('/api/config/reload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      const message = payload?.error || 'Failed to reload configuration';
      throw new Error(message);
    }

    if (getRuntimeTransportIdentity() !== transport) {
      finishConfigUpdate();
      return;
    }

    const refreshOptions = {
      ...options,
      transportIdentity: transport,
      queryDirectory,
      scopes: options?.scopes ?? ["all"],
      mode: options?.mode ?? "projects",
    };

    if (payload?.requiresReload) {
      await refreshAfterOpenCodeRestart({
        ...refreshOptions,
        message: payload.message,
        delayMs: payload.reloadDelayMs,
      });
    } else {
      await refreshAfterOpenCodeRestart(refreshOptions);
    }
  } catch (error) {
    console.error('[restartOpenCodeService] Failed:', error);
    updateConfigUpdateMessage('Failed to reload configuration. Please try again.');
    await sleep(2000);
    finishConfigUpdate();
    throw error;
  }
}

let unsubscribeAgentsConfigChanges: (() => void) | null = null;

if (!unsubscribeAgentsConfigChanges) {
  unsubscribeAgentsConfigChanges = subscribeToConfigChanges((event) => {
    if (event.source === CONFIG_EVENT_SOURCE) {
      return;
    }

    if (scopeMatches(event, "agents")) {
      const { loadAgents } = useAgentsStore.getState();
      void loadAgents();
    }
  });
}
