import { queryOptions } from '@tanstack/react-query';

import { runtimeFetch } from '@/lib/runtime-fetch';
import { queryKeys } from '@/lib/queryRuntime';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';

export const SESSION_CONTENT_SEARCH_LIMIT = 30;

export type SessionContentSearchHit = {
  sessionID: string;
  messageID: string;
  role: 'user' | 'assistant';
  createdAt: number;
  snippet: string;
  directory: string;
  title?: string;
};

export type SessionContentSearchScope = {
  transport: string;
  generation: number;
  directory: string;
};

type SessionContentSearchLoader = (input: {
  scope: SessionContentSearchScope;
  query: string;
  limit: number;
  signal?: AbortSignal;
}) => Promise<SessionContentSearchHit[]>;

type SessionContentSearchQueryOptions = {
  scope: SessionContentSearchScope | null;
  searchContent?: SessionContentSearchLoader;
};

const isHit = (value: unknown, directory: string): value is SessionContentSearchHit => {
  if (!value || typeof value !== 'object') return false;
  const hit = value as Record<string, unknown>;
  return (hit.role === 'user' || hit.role === 'assistant')
    && typeof hit.sessionID === 'string'
    && hit.sessionID.length > 0
    && typeof hit.messageID === 'string'
    && hit.messageID.length > 0
    && typeof hit.snippet === 'string'
    && typeof hit.createdAt === 'number'
    && Number.isFinite(hit.createdAt)
    && directory.length > 0;
};

/**
 * Host-owned global search. Runtime transport supplies host identity; callers
 * never narrow results to whichever project happens to be selected in the UI.
 */
export const searchSessionContent = async (input: {
  scope: SessionContentSearchScope;
  query: string;
  limit?: number;
  signal?: AbortSignal;
  fetch?: typeof runtimeFetch;
}): Promise<SessionContentSearchHit[]> => {
  const query = input.query.trim();
  if (!query) return [];
  const fetch = input.fetch ?? runtimeFetch;
  const response = await fetch('/api/openchamber/content-search', {
    query: {
      q: query,
      limit: String(input.limit ?? SESSION_CONTENT_SEARCH_LIMIT),
    },
    signal: input.signal,
  });
  if (!response.ok) {
    throw new Error(`session content search failed (${response.status})`);
  }
  const payload = await response.json() as { hits?: unknown };
  if (!Array.isArray(payload?.hits)) {
    throw new Error('session content search returned no hits');
  }
  return payload.hits.flatMap((hit) => (
    isHit(hit, typeof hit?.directory === 'string' ? hit.directory : '') ? [hit] : []
  ));
};

export const sessionContentSearchQueryOptions = (
  query: string,
  options: SessionContentSearchQueryOptions,
) => {
  const search = query.trim();
  const scope = options.scope;
  const transport = scope?.transport ?? getRuntimeTransportIdentity();
  const generation = scope?.generation ?? getRuntimeGeneration();
  const directory = '';
  const searchContent = options.searchContent ?? searchSessionContent;

  return queryOptions({
    queryKey: queryKeys.sessionContentSearch.query(search, directory, generation, transport),
    enabled: search.length > 0 && scope !== null,
    queryFn: ({ signal }) => {
      if (!scope) return [];
      return searchContent({
        scope,
        query: search,
        limit: SESSION_CONTENT_SEARCH_LIMIT,
        signal,
      });
    },
    staleTime: 0,
    refetchInterval: 3000,
    retry: 1,
  });
};

export const sessionContentIndexStatusOptions = () => queryOptions({
  queryKey: [getRuntimeTransportIdentity(), 'contentSearchStatus', getRuntimeGeneration()],
  queryFn: async ({ signal }) => {
    const response = await runtimeFetch('/api/openchamber/content-search', { signal });
    if (!response.ok) throw new Error(`Content index unavailable (${response.status})`);
    return (await response.json() as { index: { phase: string; total: number; completed: number; failed: number; messages: number } }).index;
  },
  refetchInterval: 3000,
  staleTime: 0,
});
