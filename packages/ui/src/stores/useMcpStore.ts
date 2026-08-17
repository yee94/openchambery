import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { McpStatus } from '@/lib/opencode/v2-types';
import { opencodeClient } from '@/lib/opencode/client';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { queryClient } from '@/lib/queryRuntime';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { v2CapabilityUnavailable } from '@/sync/v2-runtime';
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
  startAuth: (name: string, directory?: string | null) => Promise<string>;
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

    startAuth: async (_name, _directory) => {
      // v2 has no MCP OAuth/auth pair; fail closed instead of faking a URL.
      void _name;
      void _directory;
      throw v2CapabilityUnavailable('mcp.auth');
    },

    completeAuth: async (_name, _code, _directory) => {
      void _name;
      void _code;
      void _directory;
      throw v2CapabilityUnavailable('mcp.auth');
    },

    clearAuth: async (_name, _directory) => {
      void _name;
      void _directory;
      throw v2CapabilityUnavailable('mcp.auth');
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
