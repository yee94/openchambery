import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { IntegrationAttempt, IntegrationAttemptStatus } from '@opencode/client';
import type { McpStatus } from '@/lib/opencode/v2-types';
import { opencodeClient } from '@/lib/opencode/client';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { queryClient } from '@/lib/queryRuntime';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import {
  normalizeMcpDirectory,
  readMcpStatusSnapshot,
  refreshMcpStatusQuery,
  type McpStatusMap,
} from '@/queries/mcpQueries';
type McpRuntimeDiagnostic = {
  status: 'failed';
  error: string;
};
type McpRuntimeDiagnosticMap = Record<string, McpRuntimeDiagnostic>;

const EMPTY_DIAGNOSTICS: McpRuntimeDiagnosticMap = {};

type McpHealth = {
  connected: number;
  total: number;
  hasFailed: boolean;
  hasAuthRequired: boolean;
};

const toKey = (directory: string | null | undefined, transport = getRuntimeTransportIdentity()): string =>
  JSON.stringify([transport, normalizeMcpDirectory(directory)]);

const withoutDiagnostic = (
  diagnostics: Record<string, McpRuntimeDiagnosticMap>,
  key: string,
  name: string,
): Record<string, McpRuntimeDiagnosticMap> => {
  if (!diagnostics[key]?.[name]) return diagnostics;
  const scoped = { ...diagnostics[key] };
  delete scoped[name];
  return { ...diagnostics, [key]: scoped };
};

const getMcpApiClient = (directory: string | null | undefined) => {
  const normalized = normalizeMcpDirectory(directory);
  if (!normalized) {
    return opencodeClient.getApiClient();
  }
  return opencodeClient.getScopedApiClient(normalized);
};

const locationOf = (directory: string | null) => (
  directory ? { location: { directory } } : undefined
);

// Attempts are transient and belong to the exact runtime lifetime and Location.
const authAttempts = new Map<string, { integrationID: string; attempt: IntegrationAttempt }>();
const authKey = (name: string, directory: string | null) =>
  JSON.stringify([getRuntimeGeneration(), toKey(directory), name]);

const getMcpIntegration = async (api: ReturnType<typeof getMcpApiClient>, name: string, directory: string | null) => {
  const servers = await api.mcp.list(locationOf(directory));
  const integrationID = servers.data.find((server) => server.name === name)?.integrationID;
  if (!integrationID) throw new Error(`MCP server "${name}" has no authentication integration`);
  return (await api.integration.get({ integrationID, ...locationOf(directory) })).data;
};

const resolveMcpDirectoryArg = (directory: string | null | undefined): string | null =>
  normalizeMcpDirectory(directory === undefined ? useDirectoryStore.getState().currentDirectory : directory);

export const computeMcpHealth = (status: McpStatusMap | null | undefined): McpHealth => {
  const entries = Object.entries(status ?? {});
  const connected = entries.filter(([, s]) => s?.status === 'connected').length;
  const total = entries.length;
  const hasFailed = entries.some(([, s]) => s?.status === 'failed');
  const hasAuthRequired = entries.some(([, s]) => s?.status === 'needs_auth' || s?.status === 'needs_client_registration');
  return { connected, total, hasFailed, hasAuthRequired };
};

type TestConnectionResult = {
  status?: McpStatus;
  error?: string;
  warning?: string;
};

interface McpStore {
  diagnosticsByDirectory: Record<string, McpRuntimeDiagnosticMap>;
  getDiagnosticForDirectory: (directory?: string | null) => McpRuntimeDiagnosticMap;
  clearDiagnostic: (name: string, directory?: string | null, transport?: string) => void;
  connect: (name: string, directory?: string | null) => Promise<void>;
  disconnect: (name: string, directory?: string | null) => Promise<void>;
  startAuth: (name: string, directory?: string | null) => Promise<IntegrationAttempt>;
  authStatus: (name: string, directory?: string | null) => Promise<IntegrationAttemptStatus>;
  completeAuth: (name: string, code: string, directory?: string | null) => Promise<void>;
  clearAuth: (name: string, directory?: string | null) => Promise<void>;
  testConnection: (name: string, directory?: string | null) => Promise<TestConnectionResult>;
}

export const useMcpStore = create<McpStore>()(
  devtools((set, get) => ({
    diagnosticsByDirectory: {},

    getDiagnosticForDirectory: (directory) => {
      const key = toKey(resolveMcpDirectoryArg(directory));
      return get().diagnosticsByDirectory[key] ?? EMPTY_DIAGNOSTICS;
    },

    clearDiagnostic: (name, directory, transport) => {
      const key = toKey(resolveMcpDirectoryArg(directory), transport);
      set((state) => ({ diagnosticsByDirectory: withoutDiagnostic(state.diagnosticsByDirectory, key, name) }));
    },

    connect: async (name, directory) => {
      const normalized = resolveMcpDirectoryArg(directory);
      const transport = getRuntimeTransportIdentity();
      const key = toKey(normalized, transport);
      const api = getMcpApiClient(normalized);
      try {
        await api.mcp.connect({ server: name, ...locationOf(normalized) });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Connection failed';
        set((state) => ({
          diagnosticsByDirectory: {
            ...state.diagnosticsByDirectory,
            [key]: {
              ...(state.diagnosticsByDirectory[key] ?? {}),
              [name]: { status: 'failed', error: message },
            },
          },
        }));
        throw error;
      }
      await refreshMcpStatusQuery(queryClient, normalized, transport);
      set((state) => ({ diagnosticsByDirectory: withoutDiagnostic(state.diagnosticsByDirectory, key, name) }));
    },

    disconnect: async (name, directory) => {
      const normalized = resolveMcpDirectoryArg(directory);
      const transport = getRuntimeTransportIdentity();
      const key = toKey(normalized, transport);
      const api = getMcpApiClient(normalized);
      await api.mcp.disconnect({ server: name, ...locationOf(normalized) });
      await refreshMcpStatusQuery(queryClient, normalized, transport);
      set((state) => ({ diagnosticsByDirectory: withoutDiagnostic(state.diagnosticsByDirectory, key, name) }));
    },

    startAuth: async (name, directory) => {
      const normalized = resolveMcpDirectoryArg(directory);
      const key = authKey(name, normalized);
      const api = getMcpApiClient(normalized);
      const integration = await getMcpIntegration(api, name, normalized);
      const method = integration.methods.find((entry) => entry.type === 'oauth');
      if (!method) throw new Error(`MCP server "${name}" has no OAuth method`);
      if (key !== authKey(name, normalized)) throw new Error('MCP authorization runtime changed');
      const previous = authAttempts.get(key);
      if (previous) {
        await api.integration.oauth.cancel({ integrationID: previous.integrationID, attemptID: previous.attempt.attemptID, ...locationOf(normalized) });
        authAttempts.delete(key);
      }
      if (key !== authKey(name, normalized)) throw new Error('MCP authorization runtime changed');
      const { data: attempt } = await api.integration.oauth.connect({ integrationID: integration.id, methodID: method.id, ...locationOf(normalized) });
      if (key !== authKey(name, normalized)) throw new Error('MCP authorization runtime changed');
      // Drop expired attempts without persisting authorization URLs or codes.
      for (const [entryKey, entry] of authAttempts) {
        if (entry.attempt.time.expires <= Date.now()) authAttempts.delete(entryKey);
      }
      authAttempts.set(key, { integrationID: integration.id, attempt });
      return attempt;
    },

    authStatus: async (name, directory) => {
      const normalized = resolveMcpDirectoryArg(directory);
      const key = authKey(name, normalized);
      const pending = authAttempts.get(key);
      if (!pending) throw new Error('MCP authorization attempt not found');
      const { data } = await getMcpApiClient(normalized).integration.oauth.status({
        integrationID: pending.integrationID, attemptID: pending.attempt.attemptID, ...locationOf(normalized),
      });
      if (key !== authKey(name, normalized)) throw new Error('MCP authorization runtime changed');
      if (data.status !== 'pending' && authAttempts.get(key) === pending) authAttempts.delete(key);
      return data;
    },

    completeAuth: async (name, code, directory) => {
      const normalized = resolveMcpDirectoryArg(directory);
      const transport = getRuntimeTransportIdentity();
      const key = authKey(name, normalized);
      const pending = authAttempts.get(key);
      if (!pending || pending.attempt.mode !== 'code') throw new Error('MCP authorization requires the browser callback');
      if (!code.trim()) throw new Error('MCP authorization code is empty');
      await getMcpApiClient(normalized).integration.oauth.complete({
        integrationID: pending.integrationID, attemptID: pending.attempt.attemptID, code: code.trim(), ...locationOf(normalized),
      });
      if (authAttempts.get(key) === pending) authAttempts.delete(key);
      if (key !== authKey(name, normalized)) throw new Error('MCP authorization runtime changed');
      await refreshMcpStatusQuery(queryClient, normalized, transport);
    },

    clearAuth: async (name, directory) => {
      const normalized = resolveMcpDirectoryArg(directory);
      const transport = getRuntimeTransportIdentity();
      const key = authKey(name, normalized);
      const api = getMcpApiClient(normalized);
      const integration = await getMcpIntegration(api, name, normalized);
      if (key !== authKey(name, normalized)) throw new Error('MCP authorization runtime changed');
      const pending = authAttempts.get(key);
      if (pending) {
        await api.integration.oauth.cancel({ integrationID: pending.integrationID, attemptID: pending.attempt.attemptID, ...locationOf(normalized) });
        authAttempts.delete(key);
      }
      const credentialIDs = new Set(integration.connections.flatMap((connection) => connection.type === 'credential' ? [connection.id] : []));
      for (const credentialID of credentialIDs) {
        if (key !== authKey(name, normalized)) throw new Error('MCP authorization runtime changed');
        await api.credential.remove({ credentialID });
      }
      if (key !== authKey(name, normalized)) throw new Error('MCP authorization runtime changed');
      await refreshMcpStatusQuery(queryClient, normalized, transport);
    },

    testConnection: async (name, directory) => {
      const normalized = resolveMcpDirectoryArg(directory);
      const transport = getRuntimeTransportIdentity();
      const key = toKey(normalized, transport);
      const api = getMcpApiClient(normalized);
      const previousStatus = readMcpStatusSnapshot(queryClient, normalized, transport)[name];
      const wasConnected = previousStatus?.status === 'connected';
      let errorMessage: string | undefined;
      let warningMessage: string | undefined;

      try {
        await api.mcp.connect({ server: name, ...locationOf(normalized) });
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : 'Connection failed';
        set((state) => ({
          diagnosticsByDirectory: {
            ...state.diagnosticsByDirectory,
            [key]: {
              ...(state.diagnosticsByDirectory[key] ?? {}),
              [name]: { status: 'failed', error: errorMessage ?? 'Connection failed' },
            },
          },
        }));
      }

      const current = await refreshMcpStatusQuery(queryClient, normalized, transport);
      const currentStatus = current[name];
      const observedStatus = currentStatus;

      if (!wasConnected && currentStatus?.status === 'connected') {
        try {
          await api.mcp.disconnect({ server: name, ...locationOf(normalized) });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Disconnect failed';
          warningMessage = `Connection test succeeded, but cleanup disconnect failed: ${message}`;
        }
        await refreshMcpStatusQuery(queryClient, normalized, transport);
      }

      if (!errorMessage) {
        set((state) => ({ diagnosticsByDirectory: withoutDiagnostic(state.diagnosticsByDirectory, key, name) }));
      }

      return {
        status: observedStatus ?? readMcpStatusSnapshot(queryClient, normalized, transport)[name],
        error: errorMessage,
        warning: warningMessage,
      };
    },

  }))
);
