import { queryOptions } from '@tanstack/react-query';

import { opencodeClient } from '@/lib/opencode/client';
import type { Session } from '@/lib/opencode/v2-types';
import { queryKeys } from '@/lib/queryRuntime';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';

export const SESSION_TITLE_SEARCH_LIMIT = 30;

type SessionTitleSearchLoader = (input: {
  search: string;
  limit: number;
  signal?: AbortSignal;
}) => Promise<Session[]>;

type SessionTitleSearchQueryOptions = {
  transport?: string;
  searchSessions?: SessionTitleSearchLoader;
};

/**
 * Official OpenCode title search. `session.list?search=` matches session
 * titles only; it does not search message bodies. Callers must not treat a
 * thrown query as an empty result.
 */
export const sessionTitleSearchQueryOptions = (
  query: string,
  options: SessionTitleSearchQueryOptions = {},
) => {
  const search = query.trim();
  const transport = options.transport ?? getRuntimeTransportIdentity();
  const searchSessions = options.searchSessions ?? ((input) => opencodeClient.searchSessionsByTitle(input));

  return queryOptions({
    queryKey: queryKeys.sessionTitleSearch.query(search, transport),
    enabled: search.length > 0,
    queryFn: ({ signal }) => searchSessions({
      search,
      limit: SESSION_TITLE_SEARCH_LIMIT,
      signal,
    }),
    staleTime: 5_000,
    retry: 1,
  });
};
