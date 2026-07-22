import { useQuery, type QueryClient } from '@tanstack/react-query';
import type { Agent, Provider } from '@opencode-ai/sdk/v2';
import { opencodeClient } from '@/lib/opencode/client';
import { queryClient, queryKeys } from '@/lib/queryRuntime';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { resolveConfigQueryDirectory as resolveDirectory } from './commandQueries';
import { rawAgentsQueryOptions } from './configCatalogQueries';

export { resolveConfigQueryDirectory } from './commandQueries';

export type AgentScope = 'user' | 'project';

export type AgentWithExtras = Agent & {
  native?: boolean;
  hidden?: boolean;
  options?: { hidden?: boolean };
  scope?: AgentScope;
  group?: string;
};

export type ProviderWithModelList = Omit<Provider, 'models'> & { models: Array<Provider['models'][string]> };

const normalizeDirectory = (directory: string | null | undefined): string | null => directory?.trim() || null;

const agentQueryKey = (directory: string | null, transport = getRuntimeTransportIdentity()) =>
  queryKeys.agents.list(directory, transport);

const providerQueryKey = (directory: string | null, transport = getRuntimeTransportIdentity()) =>
  queryKeys.providers.list(directory, transport);

function parseAgentGroup(path: string | null | undefined): string | undefined {
  if (!path) return undefined;
  const normalizedPath = path.replace(/\\/g, '/');
  const idx = normalizedPath.lastIndexOf('/agents/');
  if (idx === -1) return undefined;
  const relative = normalizedPath.substring(idx + '/agents/'.length);
  const parts = relative.split('/');
  return parts.length > 1 ? parts[0] : undefined;
}

export const agentQueryOptions = (
  directory: string | null = resolveDirectory(),
  transport = getRuntimeTransportIdentity(),
) => {
  const normalizedDirectory = normalizeDirectory(directory);
  return {
    queryKey: agentQueryKey(normalizedDirectory, transport),
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<Agent[]> => {
      const agents = await queryClient.fetchQuery(rawAgentsQueryOptions(normalizedDirectory, transport));
      const response = await runtimeFetch('/api/config/agents/metadata', {
        method: 'POST',
        headers: {
          'Cache-Control': 'no-cache',
          'Content-Type': 'application/json',
          ...(normalizedDirectory ? { 'x-opencode-directory': normalizedDirectory } : {}),
        },
        body: JSON.stringify({ names: agents.map((agent) => agent.name) }),
        signal,
      });
      if (!response.ok) throw new Error('Failed to fetch agent metadata');
      const data = await response.json() as {
        agents?: Record<string, { scope?: unknown; sources?: { md?: { exists?: boolean; scope?: unknown; path?: string | null }; json?: { exists?: boolean; scope?: unknown } } }>;
      };
      return agents.map((agent) => {
        const metadata = data.agents?.[agent.name] ?? {};
        const scope = metadata.scope
          ?? (metadata.sources?.md?.exists ? metadata.sources.md.scope : undefined)
          ?? (metadata.sources?.json?.exists ? metadata.sources.json.scope : undefined)
          ?? metadata.sources?.md?.scope
          ?? metadata.sources?.json?.scope;
        const group = parseAgentGroup(metadata.sources?.md?.path);
        return scope === 'project' || scope === 'user' ? { ...agent, scope, group } : { ...agent, group };
      });
    },
    retry: 2,
    staleTime: Infinity,
    gcTime: Infinity,
  };
};

export const providerQueryOptions = (
  directory: string | null,
  transport = getRuntimeTransportIdentity(),
) => {
  const normalizedDirectory = normalizeDirectory(directory);
  return {
    queryKey: providerQueryKey(normalizedDirectory, transport),
    queryFn: async (): Promise<ProviderWithModelList[]> => {
      const result = await opencodeClient.getProvidersForConfig(normalizedDirectory);
      return (Array.isArray(result.providers) ? result.providers : []).map((provider) => ({
        ...provider,
        models: Object.values(provider.models ?? {}),
      }));
    },
    retry: 2,
  };
};

export const useAgentsQuery = (options: { enabled?: boolean } = {}) => {
  const activeProjectPath = useProjectsStore((state) => state.getActiveProject?.()?.path ?? null);
  return useQuery({
    ...agentQueryOptions(normalizeDirectory(activeProjectPath) ?? normalizeDirectory(opencodeClient.getDirectory())),
    enabled: options.enabled,
  });
};

export const useScopedAgentsQuery = (directory: string | null, options: { enabled?: boolean } = {}) => useQuery({
  ...agentQueryOptions(directory),
  enabled: options.enabled,
});

export const useScopedProvidersQuery = (directory: string | null, options: { enabled?: boolean } = {}) => useQuery({
  ...providerQueryOptions(directory),
  enabled: options.enabled,
});

export const readAgentsSnapshot = (
  directory: string | null = resolveDirectory(),
  transport = getRuntimeTransportIdentity(),
): Agent[] => queryClient.getQueryData<Agent[]>(agentQueryKey(normalizeDirectory(directory), transport)) ?? [];

export const readProvidersSnapshot = (
  directory: string | null,
  transport = getRuntimeTransportIdentity(),
): ProviderWithModelList[] => queryClient.getQueryData<ProviderWithModelList[]>(providerQueryKey(normalizeDirectory(directory), transport)) ?? [];

export const refreshAgentsQuery = async (
  client: Pick<QueryClient, 'fetchQuery' | 'getQueryData' | 'invalidateQueries'>,
  directory: string | null,
  transport: string,
): Promise<Agent[]> => {
  const normalizedDirectory = normalizeDirectory(directory);
  if (getRuntimeTransportIdentity() !== transport) {
    return client.getQueryData<Agent[]>(agentQueryKey(normalizedDirectory, transport)) ?? [];
  }
  const options = agentQueryOptions(normalizedDirectory, transport);
  await client.invalidateQueries({ queryKey: options.queryKey, exact: true });
  return client.fetchQuery(options);
};

export const refreshProvidersQuery = async (
  client: Pick<QueryClient, 'fetchQuery' | 'getQueryData'>,
  directory: string | null,
  transport: string,
): Promise<ProviderWithModelList[]> => {
  const normalizedDirectory = normalizeDirectory(directory);
  if (getRuntimeTransportIdentity() !== transport) {
    return client.getQueryData<ProviderWithModelList[]>(providerQueryKey(normalizedDirectory, transport)) ?? [];
  }
  return client.fetchQuery({ ...providerQueryOptions(normalizedDirectory, transport), staleTime: 0 });
};
