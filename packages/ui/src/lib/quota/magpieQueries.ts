import { queryOptions } from '@tanstack/react-query';
import type { ProviderResult } from '@/types';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { isProviderResult, queryKeys } from '@/lib/queryRuntime';

export interface MagpieSource {
  id: string;
  name: string;
  results: ProviderResult[];
  error?: string;
  identified?: boolean;
  ignored?: boolean;
  clearPrevious?: boolean;
}

export const magpieQuotaOptions = (directory: string | null, manualURL = '', refresh = false) => queryOptions({
  queryKey: queryKeys.scoped('magpie-quotas', directory, manualURL, refresh),
  staleTime: 0,
  retry: false,
  queryFn: async ({ signal }): Promise<{ sources: MagpieSource[]; incomplete?: boolean }> => {
    const response = await runtimeFetch('/api/quota/magpie', { signal, query: { ...(directory ? { directory } : {}), ...(refresh ? { refresh: '1' } : {}) } });
    if (!response.ok) throw new Error('Unable to discover Magpie quota sources');
    const data = await response.json();
    if (!data || !Array.isArray(data.sources) || !data.sources.every((source: MagpieSource) =>
      source && typeof source.id === 'string' && typeof source.name === 'string'
      && Array.isArray(source.results) && source.results.every((result) => isProviderResult(result)
        && result.source === 'magpie' && result.sourceId === source.id && result.providerId.startsWith(`magpie:${source.id}:`)))) {
      throw new Error('Invalid Magpie quota response');
    }
    return data;
  },
});
