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

export type SessionContentIndexStatus = {
  phase: 'pending' | 'indexing' | 'ready' | 'partial' | 'error';
  total: number;
  completed: number;
  failed: number;
  messages: number;
  // Older Hosts expose progress without the durable onboarding contract.
  initializationRequired?: boolean;
  indexStartedAt?: number | null;
  indexCompletedAt?: number | null;
  coveredSince?: number | null;
  verifiedAt?: number | null;
  updatedAt?: number | null;
};

export const sessionContentIndexStatusOptions = (fetch = runtimeFetch) => queryOptions({
  queryKey: [getRuntimeTransportIdentity(), 'contentSearchStatus', getRuntimeGeneration()],
  queryFn: async ({ signal }) => {
    const response = await fetch('/api/openchamber/content-search', { signal });
    if (response.status === 404 || response.status === 501) return null;
    if (!response.ok) throw new Error(`Content index unavailable (${response.status})`);
    const { index } = await response.json() as { index?: SessionContentIndexStatus };
    if (!index || !['pending', 'indexing', 'ready', 'partial', 'error'].includes(index.phase)
      || ![index.total, index.completed, index.failed, index.messages].every((value) => Number.isFinite(value) && value >= 0)
      || (index.initializationRequired !== undefined && typeof index.initializationRequired !== 'boolean')
      || [index.indexStartedAt, index.indexCompletedAt, index.coveredSince, index.verifiedAt, index.updatedAt]
        .some((value) => value != null && !Number.isFinite(value))) {
      throw new Error('Invalid content index status');
    }
    return index;
  },
  refetchInterval: 3000,
  staleTime: 0,
});
