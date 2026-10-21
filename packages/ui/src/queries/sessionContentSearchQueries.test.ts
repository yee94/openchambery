import { describe, expect, test, vi } from 'vitest';

import { queryKeys } from '@/lib/queryRuntime';

import {
  SESSION_CONTENT_SEARCH_LIMIT,
  searchSessionContent,
  sessionContentSearchQueryOptions,
  sessionContentIndexStatusOptions,
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
        directory: '/other-project',
        title: 'Unvisited conversation',
      }],
    }));

    const hits = await searchSessionContent({
      scope,
      query: 'retry budget',
      fetch,
    });

    expect(fetch).toHaveBeenCalledWith('/api/openchamber/content-search', {
      query: {
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
      directory: '/other-project',
      title: 'Unvisited conversation',
    }]);
  });

  test('throws when the global index is unavailable rather than claiming no hits', async () => {
    const disabled = vi.fn(async () => jsonResponse(501, { error: 'unavailable' }));
    await expect(searchSessionContent({ scope, query: 'budget', fetch: disabled })).rejects.toThrow('501');

    const failed = vi.fn(async () => jsonResponse(500, { error: 'boom' }));
    await expect(searchSessionContent({ scope, query: 'budget', fetch: failed })).rejects.toThrow('500');
  });
});

describe('sessionContentIndexStatusOptions', () => {
  test('passes the signal and returns durable initialization coverage', async () => {
    const index = { phase: 'partial', total: 2, completed: 1, failed: 1, messages: 5,
      initializationRequired: true, indexStartedAt: 100, indexCompletedAt: null, updatedAt: 200 };
    const fetch = vi.fn(async () => jsonResponse(200, { index }));
    const options = sessionContentIndexStatusOptions(fetch);
    const signal = new AbortController().signal;
    expect(await options.queryFn?.({ signal } as never)).toEqual(index);
    expect(fetch).toHaveBeenCalledWith('/api/openchamber/content-search', { signal });
  });

  test('distinguishes unsupported, legacy progress, failure and malformed coverage', async () => {
    for (const status of [404, 501]) {
      const options = sessionContentIndexStatusOptions(async () => jsonResponse(status, {}));
      expect(await options.queryFn?.({} as never)).toBeNull();
    }
    const legacy = { phase: 'ready', total: 0, completed: 0, failed: 0, messages: 0 };
    expect(await sessionContentIndexStatusOptions(async () => jsonResponse(200, { index: legacy })).queryFn?.({} as never)).toEqual(legacy);
    for (const [status, index] of [[503, legacy], [200, undefined], [200, { ...legacy, initializationRequired: 'false' }]]) {
      const options = sessionContentIndexStatusOptions(async () => jsonResponse(Number(status), { index }));
      await expect(options.queryFn?.({} as never)).rejects.toThrow();
    }
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
      queryKeys.sessionContentSearch.query('retry budget', '', 3, 'runtime-a'),
    );
    const signal = new AbortController().signal;
    await options.queryFn?.({ signal } as never);
    expect(calls).toEqual(['retry budget']);
  });
});
