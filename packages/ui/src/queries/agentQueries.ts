import { useQuery, type QueryClient } from '@tanstack/react-query';
import type { Agent, Provider } from '@/lib/opencode/v2-types';
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
  document?: {
    legacy?: boolean;
    dropped?: Array<{ key: string; reason: string }>;
  };
  disabledOverride?: boolean;
};

export type ProviderWithModelList = Omit<Provider, 'models'> & { models: Array<NonNullable<Provider['models']>[string]> };

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
        agents?: Record<string, {
          scope?: unknown;
          sources?: {
            document?: AgentWithExtras['document'];
            md?: { exists?: boolean; scope?: unknown; path?: string | null };
            json?: { exists?: boolean; scope?: unknown };
          };
        }>;
        disabled?: Array<{ name?: unknown; scope?: unknown; description?: unknown; mode?: unknown }>;
      };
      const listed = agents.map((agent) => {
        const metadata = data.agents?.[agent.name] ?? {};
        const scope = metadata.scope
          ?? (metadata.sources?.md?.exists ? metadata.sources.md.scope : undefined)
          ?? (metadata.sources?.json?.exists ? metadata.sources.json.scope : undefined)
          ?? metadata.sources?.md?.scope
          ?? metadata.sources?.json?.scope;
        const group = parseAgentGroup(metadata.sources?.md?.path);
        const withScope = scope === 'project' || scope === 'user' ? { ...agent, scope, group } : { ...agent, group };
        return metadata.sources?.document ? { ...withScope, document: metadata.sources.document } : withScope;
      });
      const known = new Set(listed.map((agent) => agent.name));
      const disabled = (data.disabled ?? []).flatMap((entry) => {
        if (typeof entry.name !== 'string' || !entry.name.trim() || known.has(entry.name)) return [];
        const mode = entry.mode === 'primary' || entry.mode === 'subagent' || entry.mode === 'all' ? entry.mode : 'primary';
        const scope = entry.scope === 'project' || entry.scope === 'user' ? entry.scope : undefined;
        return [{
          id: entry.name,
          name: entry.name,
          displayName: entry.name,
          mode,
          hidden: false,
          permissions: [],
          request: { settings: {}, headers: {}, body: {} },
          description: typeof entry.description === 'string' ? entry.description : undefined,
          disabledOverride: true,
          ...(scope ? { scope } : {}),
        } satisfies AgentWithExtras];
      });
      return [...listed, ...disabled];
    },
    retry: 2,
    staleTime: ((query: { state: { data: unknown } }) => {
      const data = query.state.data as Agent[] | undefined;
      return data && data.length > 0 ? Infinity : 0;
    }) as () => number,
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
