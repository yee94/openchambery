import { create } from "zustand";
import type { StoreApi, UseBoundStore } from "zustand";
import { devtools, persist } from "zustand/middleware";
import { emitConfigChange, scopeMatches, subscribeToConfigChanges } from "@/lib/configSync";
import {
  startConfigUpdate,
  finishConfigUpdate,
  updateConfigUpdateMessage,
} from "@/lib/configUpdate";
import { createDeferredSafeJSONStorage } from "./utils/safeStorage";
import { runtimeFetch } from "@/lib/runtime-fetch";
import { queryClient } from '@/lib/queryRuntime';
import { readInstalledSkillsSnapshot, refreshInstalledSkillsQuery } from '@/queries/installedSkillsQueries';
import { invalidateSkillsCatalogQueries } from '@/queries/skillsCatalogQueries';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';

import { opencodeClient } from '@/lib/opencode/client';

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

export type SkillScope = 'user' | 'project';
export type SkillSource = 'opencode' | 'claude' | 'agents';

export interface SupportingFile {
  name: string;
  path: string;
  fullPath: string;
}

interface SkillSources {
  md: {
    exists: boolean;
    path: string | null;
    dir: string | null;
    fields: string[];
    scope?: SkillScope | null;
    source?: SkillSource | null;
    supportingFiles: SupportingFile[];
    // Actual content values
    name?: string;
    description?: string;
    instructions?: string;
  };
  projectMd?: { exists: boolean; path: string | null };
  claudeMd?: { exists: boolean; path: string | null };
  userMd?: { exists: boolean; path: string | null };
  userClaudeMd?: { exists: boolean; path: string | null };
  userAgentsMd?: { exists: boolean; path: string | null };
}

export interface DiscoveredSkill {
  name: string;
  path: string;
  scope: SkillScope;
  source: SkillSource;
  description?: string;
  /** Domain folder parsed from file path, e.g. "automation-ai", "lark-ecosystem" */
  group?: string;
}

export interface SkillConfig {
  name: string;
  description: string;
  instructions?: string;
  scope?: SkillScope;
  source?: SkillSource;
  targetPath?: string;
  supportingFiles?: Array<{ path: string; content: string }>;
}

interface SkillsMutationOptions {
  directory?: string | null;
}

export interface PendingFile {
  path: string;
  content: string;
}

export interface SkillDraft {
  name: string;
  scope: SkillScope;
  source?: SkillSource;
  description: string;
  instructions?: string;
  pendingFiles?: PendingFile[];
}

interface SkillDetail {
  name: string;
  sources: SkillSources;
  scope?: SkillScope | null;
  source?: SkillSource | null;
}

interface SkillsStore {
  selectedSkillName: string | null;
  skillDraft: SkillDraft | null;

  setSelectedSkill: (name: string | null) => void;
  setSkillDraft: (draft: SkillDraft | null) => void;
  loadSkills: () => Promise<boolean>;
  getSkillDetail: (name: string) => Promise<SkillDetail | null>;
  createSkill: (config: SkillConfig, options?: SkillsMutationOptions) => Promise<boolean>;
  updateSkill: (name: string, config: Partial<SkillConfig>, options?: SkillsMutationOptions) => Promise<boolean>;
  deleteSkill: (name: string, options?: SkillsMutationOptions) => Promise<boolean>;
  getSkillByName: (name: string) => DiscoveredSkill | undefined;
  
  // Supporting files
  readSupportingFile: (skillName: string, filePath: string) => Promise<string | null>;
  writeSupportingFile: (skillName: string, filePath: string, content: string) => Promise<boolean>;
  deleteSupportingFile: (skillName: string, filePath: string) => Promise<boolean>;
}

declare global {
  interface Window {
    __zustand_skills_store__?: UseBoundStore<StoreApi<SkillsStore>>;
  }
}

const CONFIG_EVENT_SOURCE = "useSkillsStore";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const resolveMutationDirectory = (options?: SkillsMutationOptions): string | null => {
  if (options && Object.prototype.hasOwnProperty.call(options, 'directory')) {
    return typeof options.directory === 'string' ? options.directory.trim() || null : null;
  }
  const directory = getCurrentDirectory();
  return typeof directory === 'string' ? directory.trim() || null : null;
};

const MAX_HEALTH_WAIT_MS = 20000;
const FAST_HEALTH_POLL_INTERVAL_MS = 300;
const FAST_HEALTH_POLL_ATTEMPTS = 4;
const SLOW_HEALTH_POLL_BASE_MS = 800;
const SLOW_HEALTH_POLL_INCREMENT_MS = 200;
const SLOW_HEALTH_POLL_MAX_MS = 2000;

export const useSkillsStore = create<SkillsStore>()(
  devtools(
    persist(
      (set, get) => ({
        selectedSkillName: null,
        skillDraft: null,

        setSelectedSkill: (name: string | null) => {
          set({ selectedSkillName: name });
        },

        setSkillDraft: (draft: SkillDraft | null) => {
          set({ skillDraft: draft });
        },

        loadSkills: async () => {
          try {
            await refreshInstalledSkillsQuery(queryClient, getCurrentDirectory(), getRuntimeTransportIdentity());
            return true;
          } catch {
            return false;
          }
        },

        getSkillDetail: async (name: string) => {
          try {
            const currentDirectory = getCurrentDirectory();
            const queryParams = currentDirectory ? `?directory=${encodeURIComponent(currentDirectory)}` : '';
            
            const response = await runtimeFetch(`/api/config/skills/${encodeURIComponent(name)}${queryParams}`);
            if (!response.ok) {
              return null;
            }
            
            return await response.json() as SkillDetail;
          } catch {
            return null;
          }
        },

        createSkill: async (config: SkillConfig, options) => {
          startConfigUpdate("Creating skill...");
          let requiresReload = false;
          try {
            const skillConfig: Record<string, unknown> = {
              name: config.name,
              description: config.description,
            };

            if (config.instructions) skillConfig.instructions = config.instructions;
            if (config.scope) skillConfig.scope = config.scope;
            if (config.source) skillConfig.source = config.source;
            if (config.supportingFiles) skillConfig.supportingFiles = config.supportingFiles;

            const currentDirectory = resolveMutationDirectory(options);
            const transport = getRuntimeTransportIdentity();
            const queryParams = currentDirectory ? `?directory=${encodeURIComponent(currentDirectory)}` : '';

            const response = await runtimeFetch(`/api/config/skills/${encodeURIComponent(config.name)}${queryParams}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(skillConfig)
            });

            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              const message = payload?.error || 'Failed to create skill';
              throw new Error(message);
            }

            const needsReload = payload?.requiresReload ?? false;
            if (needsReload) {
              requiresReload = true;
              await refreshSkillsAfterOpenCodeRestart({
                message: payload?.message,
                delayMs: payload?.reloadDelayMs,
                directory: currentDirectory,
                transportIdentity: transport,
              });
              return true;
            }

            await refreshInstalledSkillsQuery(queryClient, currentDirectory, transport);
            await invalidateSkillsCatalogQueries(queryClient, currentDirectory, transport);
            emitConfigChange("skills", { source: CONFIG_EVENT_SOURCE });
            return true;
          } catch {
            return false;
          } finally {
            if (!requiresReload) {
              finishConfigUpdate();
            }
          }
        },

        updateSkill: async (name: string, config: Partial<SkillConfig>, options) => {
          startConfigUpdate("Updating skill...");
          let requiresReload = false;
          try {
            const skillConfig: Record<string, unknown> = {};

            if (config.description !== undefined) skillConfig.description = config.description;
            if (config.instructions !== undefined) skillConfig.instructions = config.instructions;
            if (config.supportingFiles !== undefined) skillConfig.supportingFiles = config.supportingFiles;
            if (config.targetPath !== undefined) skillConfig.targetPath = config.targetPath;

            const currentDirectory = resolveMutationDirectory(options);
            const transport = getRuntimeTransportIdentity();
            const queryParams = currentDirectory ? `?directory=${encodeURIComponent(currentDirectory)}` : '';

            const response = await runtimeFetch(`/api/config/skills/${encodeURIComponent(name)}${queryParams}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(skillConfig)
            });

            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              const message = payload?.error || 'Failed to update skill';
              throw new Error(message);
            }

            const needsReload = payload?.requiresReload ?? false;
            if (needsReload) {
              requiresReload = true;
              await refreshSkillsAfterOpenCodeRestart({
                message: payload?.message,
                delayMs: payload?.reloadDelayMs,
                directory: currentDirectory,
                transportIdentity: transport,
              });
              return true;
            }

            await refreshInstalledSkillsQuery(queryClient, currentDirectory, transport);
            await invalidateSkillsCatalogQueries(queryClient, currentDirectory, transport);
            emitConfigChange("skills", { source: CONFIG_EVENT_SOURCE });
            return true;
          } catch {
            return false;
          } finally {
            if (!requiresReload) {
              finishConfigUpdate();
            }
          }
        },

        deleteSkill: async (name: string, options) => {
          startConfigUpdate("Deleting skill...");
          let requiresReload = false;
          try {
            const currentDirectory = resolveMutationDirectory(options);
            const transport = getRuntimeTransportIdentity();
            const queryParams = currentDirectory ? `?directory=${encodeURIComponent(currentDirectory)}` : '';

            const response = await runtimeFetch(`/api/config/skills/${encodeURIComponent(name)}${queryParams}`, {
              method: 'DELETE'
            });

            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              const message = payload?.error || 'Failed to delete skill';
              throw new Error(message);
            }

            const needsReload = payload?.requiresReload ?? false;
            if (needsReload) {
              requiresReload = true;
              await refreshSkillsAfterOpenCodeRestart({
                message: payload?.message,
                delayMs: payload?.reloadDelayMs,
                directory: currentDirectory,
                transportIdentity: transport,
              });
              return true;
            }

            await refreshInstalledSkillsQuery(queryClient, currentDirectory, transport);
            await invalidateSkillsCatalogQueries(queryClient, currentDirectory, transport);
            emitConfigChange("skills", { source: CONFIG_EVENT_SOURCE });

            if (get().selectedSkillName === name) {
              set({ selectedSkillName: null });
            }

            return true;
          } catch {
            return false;
          } finally {
            if (!requiresReload) {
              finishConfigUpdate();
            }
          }
        },

        getSkillByName: (name: string) => {
          return readInstalledSkillsSnapshot(queryClient, getCurrentDirectory()).find((skill) => skill.name === name);
        },

        readSupportingFile: async (skillName: string, filePath: string) => {
          try {
            const currentDirectory = getCurrentDirectory();
            const queryParams = currentDirectory ? `&directory=${encodeURIComponent(currentDirectory)}` : '';
            
            const response = await runtimeFetch(
              `/api/config/skills/${encodeURIComponent(skillName)}/files/${encodeURIComponent(filePath)}?${queryParams.slice(1)}`
            );
            if (!response.ok) {
              return null;
            }
            
            const data = await response.json();
            return data.content ?? null;
          } catch {
            return null;
          }
        },

        writeSupportingFile: async (skillName: string, filePath: string, content: string) => {
          try {
            const currentDirectory = getCurrentDirectory();
            const queryParams = currentDirectory ? `?directory=${encodeURIComponent(currentDirectory)}` : '';
            
            const response = await runtimeFetch(
              `/api/config/skills/${encodeURIComponent(skillName)}/files/${encodeURIComponent(filePath)}${queryParams}`,
              {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content })
              }
            );
            
            return response.ok;
          } catch {
            return false;
          }
        },

        deleteSupportingFile: async (skillName: string, filePath: string) => {
          try {
            const currentDirectory = getCurrentDirectory();
            const queryParams = currentDirectory ? `?directory=${encodeURIComponent(currentDirectory)}` : '';
            
            const response = await runtimeFetch(
              `/api/config/skills/${encodeURIComponent(skillName)}/files/${encodeURIComponent(filePath)}${queryParams}`,
              { method: 'DELETE' }
            );
            
            return response.ok;
          } catch {
            return false;
          }
        },
      }),
      {
        name: "skills-store",
        storage: createDeferredSafeJSONStorage(),
        partialize: (state) => ({
          selectedSkillName: state.selectedSkillName,
        }),
      },
    ),
    {
      name: "skills-store",
    },
  ),
);

if (typeof window !== "undefined") {
  window.__zustand_skills_store__ = useSkillsStore;
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

export async function refreshSkillsAfterOpenCodeRestart(options?: { message?: string; delayMs?: number; directory?: string | null; transportIdentity?: string }) {
  const directory = options && 'directory' in options
    ? options.directory?.trim() || null
    : getCurrentDirectory();
  const transport = options?.transportIdentity ?? getRuntimeTransportIdentity();
  try {
    updateConfigUpdateMessage(options?.message || "Refreshing skills…");
  } catch {
    // ignore
  }

  try {
    await waitForOpenCodeConnection(options?.delayMs);
    if (getRuntimeTransportIdentity() !== transport) return;
    updateConfigUpdateMessage("Refreshing skills…");
    await refreshInstalledSkillsQuery(queryClient, directory, transport);
    if (getRuntimeTransportIdentity() !== transport) return;
    await invalidateSkillsCatalogQueries(queryClient, directory, transport);
    emitConfigChange("skills", { source: CONFIG_EVENT_SOURCE });
  } catch (error) {
    updateConfigUpdateMessage("OpenCode refresh failed. Please retry.");
    await sleep(1500);
    throw error;
  } finally {
    finishConfigUpdate();
  }
}

// Subscribe to config changes from other stores
let unsubscribeSkillsConfigChanges: (() => void) | null = null;

if (!unsubscribeSkillsConfigChanges) {
  unsubscribeSkillsConfigChanges = subscribeToConfigChanges((event) => {
    if (event.source === CONFIG_EVENT_SOURCE) {
      return;
    }

    if (scopeMatches(event, "skills")) {
      const directory = getCurrentDirectory();
      const transport = getRuntimeTransportIdentity();
      void refreshInstalledSkillsQuery(queryClient, directory, transport)
        .then(() => invalidateSkillsCatalogQueries(queryClient, directory, transport))
        .catch(() => undefined);
    }
  });
}
