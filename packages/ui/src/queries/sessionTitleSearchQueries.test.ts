import { describe, expect, test } from 'vitest';

import { queryKeys } from '@/lib/queryRuntime';
import type { Session } from '@/lib/opencode/v2-types';
import {
  SESSION_TITLE_SEARCH_LIMIT,
  sessionTitleSearchQueryOptions,
} from './sessionTitleSearchQueries';

const session = (id: string, title: string): Session => ({
  id,
  title,
  directory: '/repo',
} as Session);

describe('sessionTitleSearchQueryOptions', () => {
  test('keys title search by transport and trimmed query, and forwards the abort signal', async () => {
    const calls: Array<{ search: string; limit: number; signal?: AbortSignal }> = [];
    const options = sessionTitleSearchQueryOptions('  protocol  ', {
      transport: 'runtime-a',
      searchSessions: async (input) => {
        calls.push(input);
        return [session('ses_a', 'Protocol notes')];
      },
    });

    expect(options.queryKey).toEqual(queryKeys.sessionTitleSearch.query('protocol', 'runtime-a'));
    expect(options.enabled).toBe(true);

    const signal = new AbortController().signal;
    const result = await options.queryFn?.({
      signal,
      queryKey: options.queryKey,
      meta: undefined,
      client: {} as never,
    });

    expect(calls).toEqual([{
      search: 'protocol',
      limit: SESSION_TITLE_SEARCH_LIMIT,
      signal,
    }]);
    expect(result).toEqual([session('ses_a', 'Protocol notes')]);
  });

  test('does not enable an empty query and does not turn a failed search into an empty list', async () => {
    const idle = sessionTitleSearchQueryOptions('   ', { transport: 'runtime-a' });
    expect(idle.enabled).toBe(false);
    expect(idle.queryKey).toEqual(queryKeys.sessionTitleSearch.query('', 'runtime-a'));

    const failing = sessionTitleSearchQueryOptions('notes', {
      transport: 'runtime-a',
      searchSessions: async () => {
        throw new Error('session.list search failed');
      },
    });

    await expect(failing.queryFn?.({
      signal: new AbortController().signal,
      queryKey: failing.queryKey,
      meta: undefined,
      client: {} as never,
    })).rejects.toThrow('session.list search failed');
  });
});
