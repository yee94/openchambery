import { queryOptions } from '@tanstack/react-query';

import { runtimeFetch } from '@/lib/runtime-fetch';
import { queryKeys } from '@/lib/queryRuntime';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { searchIndexedDBTranscriptContent } from '@/sync/transcript-content-search';

export const SESSION_CONTENT_SEARCH_LIMIT = 30;

export type SessionContentSearchHit = {
  sessionID: string;
  messageID: string;
  role: 'user' | 'assistant';
  createdAt: number;
  snippet: string;
  directory: string;
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
 * Directory-wide search of projected conversation text. A disabled transcript
 * cache (501) is an empty result. Any other failure throws so callers do not
 * treat a broken index as "nothing matched".
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
  const response = await fetch('/api/openchamber/transcript-cache/search', {
    query: {
      transport: input.scope.transport,
      generation: String(input.scope.generation),
      directory: input.scope.directory,
      q: query,
      limit: String(input.limit ?? SESSION_CONTENT_SEARCH_LIMIT),
    },
    signal: input.signal,
  });
  if (response.status === 501) return [];
  if (!response.ok) {
    throw new Error(`session content search failed (${response.status})`);
  }
  const payload = await response.json() as { hits?: unknown };
  if (!Array.isArray(payload?.hits)) {
    throw new Error('session content search returned no hits');
  }
  return payload.hits.flatMap((hit) => (
    isHit(hit, input.scope.directory) ? [{ ...hit, directory: input.scope.directory }] : []
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
  const directory = scope?.directory ?? '';
  const searchContent = options.searchContent ?? searchIndexedDBTranscriptContent;

  return queryOptions({
    queryKey: queryKeys.sessionContentSearch.query(search, directory, generation, transport),
    enabled: search.length > 0 && directory.length > 0,
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
    retry: 1,
  });
};
