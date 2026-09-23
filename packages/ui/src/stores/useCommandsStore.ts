import { create } from 'zustand';
import type { StoreApi, UseBoundStore } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import { emitConfigChange, scopeMatches, subscribeToConfigChanges } from '@/lib/configSync';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { queryClient } from '@/lib/queryRuntime';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';
import {
  readCommandsSnapshot,
  refreshCommandsQuery,
  resolveConfigQueryDirectory,
  type Command,
  type CommandConfig,
  type CommandScope,
} from '@/queries/commandQueries';

export type { Command, CommandConfig, CommandScope } from '@/queries/commandQueries';

const CONFIG_EVENT_SOURCE = 'useCommandsStore';
const BUILTIN_COMMAND_NAMES = new Set(['init', 'review']);

export const isCommandBuiltIn = (command: Command): boolean => BUILTIN_COMMAND_NAMES.has(command.name);

export interface CommandDraft {
  name: string;
  scope: CommandScope;
  description?: string;
  agent?: string | null;
  model?: string | null;
  template?: string;
}

interface CommandsStore {
  selectedCommandName: string | null;
  commandDraft: CommandDraft | null;
  setSelectedCommand: (name: string | null) => void;
  setCommandDraft: (draft: CommandDraft | null) => void;
  loadCommands: () => Promise<boolean>;
  createCommand: (config: CommandConfig) => Promise<boolean>;
  updateCommand: (name: string, config: Partial<CommandConfig>) => Promise<boolean>;
  deleteCommand: (name: string) => Promise<boolean>;
  getCommandByName: (name: string) => Command | undefined;
}

declare global {
  interface Window {
    __zustand_commands_store__?: UseBoundStore<StoreApi<CommandsStore>>;
  }
}

const refreshMutationCommands = async (directory: string | null, transport: string) => {
  await refreshCommandsQuery(queryClient, directory, transport);
  if (getRuntimeTransportIdentity() === transport) {
    emitConfigChange('commands', { source: CONFIG_EVENT_SOURCE });
  }
};

export const useCommandsStore = create<CommandsStore>()(devtools(persist((set) => ({
  selectedCommandName: null,
  commandDraft: null,
  setSelectedCommand: (selectedCommandName) => set({ selectedCommandName }),
  setCommandDraft: (commandDraft) => set({ commandDraft }),
  loadCommands: async () => {
    const directory = resolveConfigQueryDirectory();
    const transport = getRuntimeTransportIdentity();
    try {
      await refreshCommandsQuery(queryClient, directory, transport);
      return true;
    } catch {
      return false;
    }
  },
  createCommand: async (config) => mutateCommand('POST', config.name, config, set),
  updateCommand: async (name, config) => mutateCommand('PATCH', name, config, set),
  deleteCommand: async (name) => mutateCommand('DELETE', name, undefined, set),
  getCommandByName: (name) => readCommandsSnapshot().find((command) => command.name === name),
}), {
  name: 'commands-store',
  storage: createDeferredSafeJSONStorage(),
  partialize: (state) => ({ selectedCommandName: state.selectedCommandName }),
}), { name: 'commands-store' }));

async function mutateCommand(
  method: 'POST' | 'PATCH' | 'DELETE',
  name: string,
  config: CommandConfig | Partial<CommandConfig> | undefined,
  set: (partial: Partial<CommandsStore>) => void,
): Promise<boolean> {
  const directory = resolveConfigQueryDirectory();
  const transport = getRuntimeTransportIdentity();
  try {
    const commandConfig: Record<string, unknown> = {};
    if (method === 'POST') {
      commandConfig.template = config?.template || '';
      if (config?.description) commandConfig.description = config.description;
      if (config?.agent) commandConfig.agent = config.agent;
      if (config?.model) commandConfig.model = config.model;
      if (config?.scope) commandConfig.scope = config.scope;
    }
    if (method === 'PATCH') {
      for (const key of ['description', 'agent', 'model', 'template'] as const) {
        if (config?.[key] !== undefined) commandConfig[key] = config[key];
      }
    }
    const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
    const response = await runtimeFetch(`/api/config/commands/${encodeURIComponent(name)}${query}`, {
      method,
      headers: method === 'DELETE'
        ? (directory ? { 'x-opencode-directory': directory } : undefined)
        : { 'Content-Type': 'application/json', ...(directory ? { 'x-opencode-directory': directory } : {}) },
      ...(method === 'DELETE' ? {} : { body: JSON.stringify(commandConfig) }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error || `Failed to ${method.toLowerCase()} command`);
    if (getRuntimeTransportIdentity() !== transport) return true;
    await refreshMutationCommands(directory, transport);
    if (getRuntimeTransportIdentity() !== transport) return true;
    if (method === 'DELETE') set({ selectedCommandName: null });
    return true;
  } catch (error) {
    console.error('[CommandsStore] Command mutation failed:', error);
    return false;
  }
}

if (typeof window !== 'undefined') window.__zustand_commands_store__ = useCommandsStore;

subscribeToConfigChanges((event) => {
  if (event.source !== CONFIG_EVENT_SOURCE && scopeMatches(event, 'commands')) {
    void useCommandsStore.getState().loadCommands();
  }
});
