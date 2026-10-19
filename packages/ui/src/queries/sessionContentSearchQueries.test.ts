import { describe, expect, test, vi } from 'vitest';

import { queryKeys } from '@/lib/queryRuntime';

import {
  SESSION_CONTENT_SEARCH_LIMIT,
  searchSessionContent,
  sessionContentSearchQueryOptions,
} from './sessionContentSearchQueries';

const scope = {
  transport: 'runtime-a',
  generation: 3,
  directory: '/repo',
};

const jsonResponse = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
}) as Response;

describe('searchSessionContent', () => {
  test('requests directory scope and keeps the directory on each hit', async () => {
    const fetch = vi.fn(async () => jsonResponse(200, {
      available: true,
      hits: [{
        sessionID: 'ses_1',
        messageID: 'msg_1',
        role: 'user',
        createdAt: 10,
        snippet: 'retry budget stays at three',
      }],
    }));

    const hits = await searchSessionContent({
      scope,
      query: 'retry budget',
      fetch,
    });

    expect(fetch).toHaveBeenCalledWith('/api/openchamber/transcript-cache/search', {
      query: {
        transport: 'runtime-a',
        generation: '3',
        directory: '/repo',
        q: 'retry budget',
        limit: String(SESSION_CONTENT_SEARCH_LIMIT),
      },
      signal: undefined,
    });
    expect(hits).toEqual([{
      sessionID: 'ses_1',
      messageID: 'msg_1',
      role: 'user',
      createdAt: 10,
      snippet: 'retry budget stays at three',
      directory: '/repo',
    }]);
  });

  test('treats a disabled cache as no hits and throws when the index fails', async () => {
    const disabled = vi.fn(async () => jsonResponse(501, { error: 'unavailable' }));
    await expect(searchSessionContent({ scope, query: 'budget', fetch: disabled })).resolves.toEqual([]);

    const failed = vi.fn(async () => jsonResponse(500, { error: 'boom' }));
    await expect(searchSessionContent({ scope, query: 'budget', fetch: failed })).rejects.toThrow('500');
  });
});

describe('sessionContentSearchQueryOptions', () => {
  test('stays idle without a directory or query, and keys hits by transport, generation, and directory', async () => {
    const idle = sessionContentSearchQueryOptions('budget', { scope: null });
    expect(idle.enabled).toBe(false);

    const calls: string[] = [];
    const options = sessionContentSearchQueryOptions('  retry budget  ', {
      scope,
      searchContent: async (input) => {
        calls.push(input.query);
        return [];
      },
    });

    expect(options.enabled).toBe(true);
    expect(options.queryKey).toEqual(
      queryKeys.sessionContentSearch.query('retry budget', '/repo', 3, 'runtime-a'),
    );
    const signal = new AbortController().signal;
    await options.queryFn?.({ signal } as never);
    expect(calls).toEqual(['retry budget']);
  });
});
