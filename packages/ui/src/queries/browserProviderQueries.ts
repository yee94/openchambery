import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { queryClient, queryKeys } from '@/lib/queryRuntime';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import {
  BROWSER_PROVIDER_CATALOG_PATH,
  BROWSER_PROVIDER_SELECTION_PATH,
  parseBrowserProviderCatalog,
  parseBrowserProviderSelection,
  type BrowserProviderCatalog,
} from '@/lib/browser-provider/contract';

export class BrowserProviderRequestError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`browser_provider_request_failed:${status}`);
    this.name = 'BrowserProviderRequestError';
    this.status = status;
  }
}

const catalogQueryKey = (transport = getRuntimeTransportIdentity()) =>
  queryKeys.browserProviders.catalog(transport);

const readJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

/**
 * Host catalog. Non-OK responses throw so a missing route is not an empty
 * connected browser. A 200 with no providers is the only empty success.
 */
export const fetchBrowserProviderCatalog = async (signal?: AbortSignal): Promise<BrowserProviderCatalog> => {
  const response = await runtimeFetch(BROWSER_PROVIDER_CATALOG_PATH, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw new BrowserProviderRequestError(response.status);
  }
  const catalog = parseBrowserProviderCatalog(payload);
  if (!catalog) {
    throw new BrowserProviderRequestError(response.status || 502);
  }
  return catalog;
};

export const browserProviderCatalogQueryOptions = (transport = getRuntimeTransportIdentity()) => ({
  queryKey: catalogQueryKey(transport),
  queryFn: ({ signal }: { signal: AbortSignal }) => fetchBrowserProviderCatalog(signal),
  staleTime: 5_000,
  refetchOnWindowFocus: true,
  refetchInterval: (query: { state: { error: unknown } }) => {
    const error = query.state.error;
    if (error instanceof BrowserProviderRequestError && (error.status === 404 || error.status === 501)) return false;
    return 15_000;
  },
});

export const useBrowserProviderCatalogQuery = () => useQuery(browserProviderCatalogQueryOptions());

export const readBrowserProviderCatalogSnapshot = (
  client: Pick<QueryClient, 'getQueryData'> = queryClient,
  transport = getRuntimeTransportIdentity(),
): BrowserProviderCatalog | null =>
  client.getQueryData<BrowserProviderCatalog>(catalogQueryKey(transport)) ?? null;

const mergeSelection = (
  current: BrowserProviderCatalog | undefined,
  selectedId: string,
): BrowserProviderCatalog | null => {
  if (!current?.providers.some((provider) => provider.id === selectedId)) return null;
  return { providers: current.providers, selectedId };
};

export const selectBrowserProvider = async (
  id: string,
  client: Pick<QueryClient, 'getQueryData'> = queryClient,
  signal?: AbortSignal,
): Promise<BrowserProviderCatalog> => {
  const transport = getRuntimeTransportIdentity();
  const response = await runtimeFetch(BROWSER_PROVIDER_SELECTION_PATH, {
    method: 'PUT',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
    signal,
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw new BrowserProviderRequestError(response.status);
  }
  const selection = parseBrowserProviderSelection(payload);
  if (!selection || selection.selectedId !== id || getRuntimeTransportIdentity() !== transport) {
    throw new BrowserProviderRequestError(response.status || 502);
  }
  const merged = mergeSelection(client.getQueryData<BrowserProviderCatalog>(catalogQueryKey(transport)), selection.selectedId);
  if (!merged) {
    throw new BrowserProviderRequestError(409);
  }
  return merged;
};

export const useSelectBrowserProvider = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => selectBrowserProvider(id, client),
    onMutate: async (id) => {
      const transport = getRuntimeTransportIdentity();
      const key = catalogQueryKey(transport);
      await client.cancelQueries({ queryKey: key });
      const previous = client.getQueryData<BrowserProviderCatalog>(key);
      const optimistic = mergeSelection(previous, id);
      if (optimistic) client.setQueryData(key, optimistic);
      return { previous, key, transport };
    },
    onError: (_error, _id, context) => {
      if (!context || getRuntimeTransportIdentity() !== context.transport) return;
      client.setQueryData(context.key, context.previous);
    },
    onSuccess: (catalog, _id, context) => {
      if (!context || getRuntimeTransportIdentity() !== context.transport) return;
      client.setQueryData(context.key, catalog);
    },
  });
};
