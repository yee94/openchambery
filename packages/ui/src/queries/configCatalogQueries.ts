import type { Agent } from '@opencode-ai/sdk/v2';
import { queryClient, queryKeys } from '@/lib/queryRuntime';
import { opencodeClient } from '@/lib/opencode/client';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { parseProviderCatalog } from '@/lib/configCatalogParser';
import type { ProviderCatalog } from '@/types/configCatalog';

export const normalizeConfigCatalogDirectory = (directory: string | null | undefined): string | null => {
  if (typeof directory !== 'string') return null;
  const normalized = directory.trim().replace(/\\/g, '/');
  if (!normalized) return null;
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
};

export const providerCatalogQueryOptions = (
  directory: string | null,
  transport = getRuntimeTransportIdentity(),
) => {
  const normalizedDirectory = normalizeConfigCatalogDirectory(directory);
  return {
    queryKey: queryKeys.configCatalog.providers(normalizedDirectory, transport),
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const response = await runtimeFetch('/api/config/catalog/providers', {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...(normalizedDirectory ? { 'x-opencode-directory': normalizedDirectory } : {}),
        },
        signal,
      });
      let catalog: ProviderCatalog;
      if (response.ok) {
        catalog = parseProviderCatalog(await response.json());
      } else {
        if (response.status !== 404 && response.status !== 501) {
          throw new Error(`Provider catalog request failed (${response.status})`);
        }
        const legacyResponse = await opencodeClient.getSdkClient().config.providers(
          normalizedDirectory ? { directory: normalizedDirectory } : undefined,
          { signal },
        );
        if (legacyResponse.error !== undefined) {
          throw new Error('Legacy provider catalog request failed');
        }
        if (legacyResponse.data === undefined || legacyResponse.data === null) {
          throw new Error('Legacy provider catalog request failed');
        }
        catalog = parseProviderCatalog({
          schemaVersion: 1,
          providers: legacyResponse.data.providers,
          default: legacyResponse.data.default,
          partial: false,
        });
      }
      const previous = queryClient.getQueryData<ProviderCatalog>(queryKeys.configCatalog.providers(normalizedDirectory, transport));
      if (catalog.partial && previous && !previous.partial) {
        throw new Error('Partial provider catalog refresh retained the complete snapshot');
      }
      return catalog;
    },
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 2,
    retryDelay: 100,
  };
};

export const rawAgentsQueryOptions = (
  directory: string | null,
  transport = getRuntimeTransportIdentity(),
) => {
  const normalizedDirectory = normalizeConfigCatalogDirectory(directory);
  return {
    queryKey: queryKeys.agents.raw(normalizedDirectory, transport),
    queryFn: ({ signal }: { signal: AbortSignal }) => opencodeClient.listAgents(normalizedDirectory, signal),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 2,
    retryDelay: 100,
  };
};

export const readProviderCatalogSnapshot = (directory: string | null, transport = getRuntimeTransportIdentity()): ProviderCatalog | undefined =>
  queryClient.getQueryData<ProviderCatalog>(providerCatalogQueryOptions(directory, transport).queryKey);

export const readRawAgentsSnapshot = (directory: string | null, transport = getRuntimeTransportIdentity()): Agent[] | undefined =>
  queryClient.getQueryData<Agent[]>(rawAgentsQueryOptions(directory, transport).queryKey);

export const seedProviderCatalogQuery = (
  directory: string | null,
  snapshot: { providers: unknown; defaultProviders: unknown; providerCatalogPartial?: boolean },
  transport = getRuntimeTransportIdentity(),
): void => {
  if (snapshot.providerCatalogPartial === true) return;
  const options = providerCatalogQueryOptions(directory, transport);
  if (queryClient.getQueryData(options.queryKey) !== undefined) return;
  try {
    const providers = Array.isArray(snapshot.providers)
      ? snapshot.providers.map((provider) => {
        if (typeof provider !== 'object' || provider === null || Array.isArray(provider)) return provider;
        const entry = provider as Record<string, unknown>;
        return {
          ...entry,
          models: Array.isArray(entry.models)
            ? Object.fromEntries(entry.models.map((model, index) => [String(index), model]))
            : entry.models,
        };
      })
      : snapshot.providers;
    const catalog = parseProviderCatalog({ schemaVersion: 1, providers, default: snapshot.defaultProviders, partial: false });
    if (catalog.partial) return;
    queryClient.setQueryData(options.queryKey, catalog);
  } catch {
    // Persisted startup snapshots are optional and isolated from network loading.
  }
};

export const ensureProviderCatalogQuery = (directory: string | null, transport = getRuntimeTransportIdentity()): Promise<ProviderCatalog> =>
  queryClient.fetchQuery(providerCatalogQueryOptions(directory, transport));

export const ensureRawAgentsQuery = (directory: string | null, transport = getRuntimeTransportIdentity()): Promise<Agent[]> =>
  queryClient.fetchQuery(rawAgentsQueryOptions(directory, transport));

export const refreshProviderCatalogQuery = async (directory: string | null, transport = getRuntimeTransportIdentity()): Promise<ProviderCatalog> => {
  const options = providerCatalogQueryOptions(directory, transport);
  await queryClient.invalidateQueries({ queryKey: options.queryKey, exact: true });
  return queryClient.fetchQuery(options);
};

export const refreshRawAgentsQuery = async (directory: string | null, transport = getRuntimeTransportIdentity()): Promise<Agent[]> => {
  const options = rawAgentsQueryOptions(directory, transport);
  await queryClient.invalidateQueries({ queryKey: options.queryKey, exact: true });
  return queryClient.fetchQuery(options);
};

export const invalidateProviderCatalogQuery = (directory: string | null, transport = getRuntimeTransportIdentity()) =>
  queryClient.invalidateQueries({ queryKey: providerCatalogQueryOptions(directory, transport).queryKey, exact: true });

export const invalidateRawAgentsQuery = (directory: string | null, transport = getRuntimeTransportIdentity()) =>
  queryClient.invalidateQueries({ queryKey: rawAgentsQueryOptions(directory, transport).queryKey, exact: true });
