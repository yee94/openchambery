import { useQuery, type QueryClient } from '@tanstack/react-query';
import type { McpStatus } from '@/lib/opencode/v2-types';
import { queryClient, queryKeys } from '@/lib/queryRuntime';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { opencodeClient } from '@/lib/opencode/client';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import type { McpServerConfig, McpScope } from '@/stores/useMcpConfigStore';

export type McpStatusMap = Record<string, McpStatus>;
export type McpServerWithScope = McpServerConfig & { scope?: McpScope | null };

export const normalizeMcpDirectory = (directory: string | null | undefined): string | null => {
  if (typeof directory !== 'string') return null;
  const trimmed = directory.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\\/g, '/');
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
};

export const resolveMcpConfigQueryDirectory = (): string | null => {
  const activeProject = useProjectsStore.getState().getActiveProject?.();
  return normalizeMcpDirectory(activeProject?.path) ?? normalizeMcpDirectory(opencodeClient.getDirectory());
};

const mcpConfigsQueryKey = (directory: string | null, transport = getRuntimeTransportIdentity()) =>
  queryKeys.mcp.configs(directory, transport);

const mcpStatusQueryKey = (directory: string | null, transport = getRuntimeTransportIdentity()) =>
  queryKeys.mcp.status(directory, transport);

const getMcpApiClient = (directory: string | null) => directory
  ? opencodeClient.getScopedApiClient(directory)
  : opencodeClient.getApiClient();

const locationOf = (directory: string | null) => (
  directory ? { location: { directory } } : undefined
);

export const mcpConfigsQueryOptions = (
  directory: string | null = resolveMcpConfigQueryDirectory(),
  transport = getRuntimeTransportIdentity(),
) => {
  const normalizedDirectory = normalizeMcpDirectory(directory);
  return {
    queryKey: mcpConfigsQueryKey(normalizedDirectory, transport),
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<McpServerWithScope[]> => {
      const queryParams = normalizedDirectory ? `?directory=${encodeURIComponent(normalizedDirectory)}` : '';
      const response = await runtimeFetch(`/api/config/mcp${queryParams}`, {
        headers: normalizedDirectory ? { 'x-opencode-directory': normalizedDirectory } : undefined,
        signal,
      });
      if (!response.ok) throw new Error('Failed to load MCP configs');
      const payload = await response.json();
      if (!Array.isArray(payload)) throw new Error('Invalid MCP configs response');
      return payload as McpServerWithScope[];
    },
    staleTime: 5_000,
    retry: 2,
  };
};

export const mcpStatusQueryOptions = (
  directory: string | null,
  transport = getRuntimeTransportIdentity(),
) => {
  const normalizedDirectory = normalizeMcpDirectory(directory);
  return {
    queryKey: mcpStatusQueryKey(normalizedDirectory, transport),
    queryFn: async (): Promise<McpStatusMap> => {
      // v2 has mcp.list (with per-server status), not 1.x mcp.status / {data,error}.
      const listed = await getMcpApiClient(normalizedDirectory).mcp.list(locationOf(normalizedDirectory));
      if (!Array.isArray(listed.data)) {
        throw new Error('v2 mcp.list returned no data');
      }
      const status: McpStatusMap = {};
      for (const server of listed.data) {
        if (!server?.name) continue;
        status[server.name] = server.status;
      }
      return status;
    },
    staleTime: 2_000,
    retry: 1,
  };
};

export const useMcpConfigsQuery = (
  directory?: string | null,
  options: { enabled?: boolean } = {},
) => {
  const activeProjectPath = useProjectsStore((state) => state.getActiveProject?.()?.path ?? null);
  const resolvedDirectory = directory === undefined
    ? normalizeMcpDirectory(activeProjectPath) ?? normalizeMcpDirectory(opencodeClient.getDirectory())
    : normalizeMcpDirectory(directory);
  return useQuery({ ...mcpConfigsQueryOptions(resolvedDirectory), enabled: options.enabled });
};

export const useMcpStatusQuery = (
  directory?: string | null,
  options: { enabled?: boolean } = {},
) => {
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const resolvedDirectory = directory === undefined ? currentDirectory : directory;
  return useQuery({ ...mcpStatusQueryOptions(normalizeMcpDirectory(resolvedDirectory)), enabled: options.enabled });
};

export const readMcpConfigsSnapshot = (
  client: Pick<QueryClient, 'getQueryData'> = queryClient,
  directory: string | null = resolveMcpConfigQueryDirectory(),
  transport = getRuntimeTransportIdentity(),
): McpServerWithScope[] => client.getQueryData<McpServerWithScope[]>(mcpConfigsQueryKey(normalizeMcpDirectory(directory), transport)) ?? [];

export const readMcpStatusSnapshot = (
  client: Pick<QueryClient, 'getQueryData'> = queryClient,
  directory: string | null,
  transport = getRuntimeTransportIdentity(),
): McpStatusMap => client.getQueryData<McpStatusMap>(mcpStatusQueryKey(normalizeMcpDirectory(directory), transport)) ?? {};

export const refreshMcpConfigsQuery = async (
  client: Pick<QueryClient, 'fetchQuery' | 'getQueryData'>,
  directory: string | null,
  transport: string,
): Promise<McpServerWithScope[]> => {
  const normalizedDirectory = normalizeMcpDirectory(directory);
  if (getRuntimeTransportIdentity() !== transport) return readMcpConfigsSnapshot(client, normalizedDirectory, transport);
  return client.fetchQuery({ ...mcpConfigsQueryOptions(normalizedDirectory, transport), staleTime: 0 });
};

export const refreshMcpStatusQuery = async (
  client: Pick<QueryClient, 'fetchQuery' | 'getQueryData'>,
  directory: string | null,
  transport: string,
): Promise<McpStatusMap> => {
  const normalizedDirectory = normalizeMcpDirectory(directory);
  if (getRuntimeTransportIdentity() !== transport) return readMcpStatusSnapshot(client, normalizedDirectory, transport);
  return client.fetchQuery({ ...mcpStatusQueryOptions(normalizedDirectory, transport), staleTime: 0 });
};
