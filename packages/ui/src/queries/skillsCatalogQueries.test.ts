import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { InfiniteQueryObserver } from '@tanstack/react-query';

let activeProjectPath = '/workspace/project';
let runtimeKey = 'runtime-a';
type FetchCall = { input: string; init?: RequestInit };
const fetchCalls: FetchCall[] = [];
let fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = async () => new Response('{}');

mock.module('@/lib/opencode/client', () => ({ opencodeClient: { getDirectory: () => '/fallback/project' } }));
mock.module('@/stores/useProjectsStore', () => ({
  useProjectsStore: Object.assign(() => null, { getState: () => ({ getActiveProject: () => ({ path: activeProjectPath }) }) }),
}));
mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: (input: string, init?: RequestInit) => {
    fetchCalls.push({ input, init });
    return fetchImpl(input, init);
  },
}));
mock.module('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => runtimeKey,
  getRuntimeGeneration: () => 0,
  isRuntimeEndpointIdentityChange: () => false,
  subscribeRuntimeEndpointChanged: () => () => undefined,
}));

const {
  FALLBACK_SKILLS_CATALOG_SOURCES,
  flattenSkillsCatalogSourcePages,
  readSkillsCatalogSourcesSnapshot,
  refreshSkillsCatalogSourceQuery,
  refreshSkillsCatalogSourcesQuery,
  skillsCatalogSourceInfiniteQueryOptions,
  skillsCatalogSourcesQueryOptions,
} = await import('./skillsCatalogQueries');
const { queryClient, queryKeys } = await import('@/lib/queryRuntime');

const jsonResponse = (body: unknown, init?: ResponseInit): Response => new Response(JSON.stringify(body), {
  status: init?.status ?? 200,
  headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
});

const item = (skillDir: string, description = skillDir) => ({ sourceId: 'clawdhub', skillDir, skillName: skillDir, repoSource: 'clawdhub:registry', installable: true, description });

describe('skillsCatalogQueries', () => {
  beforeEach(() => {
    queryClient.clear();
    activeProjectPath = '/workspace/project';
    runtimeKey = 'runtime-a';
    fetchCalls.length = 0;
    fetchImpl = async () => jsonResponse({ ok: true });
  });

  test('keys standardize directories and begin with transport', () => {
    expect(queryKeys.skillsCatalog.sources(' /workspace/a ', 'runtime-b')).toEqual(['runtime-b', 'skillsCatalog', 'sources', '/workspace/a']);
    expect(queryKeys.skillsCatalog.source('   ', 'source-a', 'runtime-b')).toEqual(['runtime-b', 'skillsCatalog', 'source', null, 'source-a']);
  });

  test('sources forwards the query signal and returns fallback sources', async () => {
    const controller = new AbortController();
    fetchImpl = async () => jsonResponse({ ok: true, sources: [] });
    const sources = await skillsCatalogSourcesQueryOptions(' /workspace/a ', 'runtime-b').queryFn({ signal: controller.signal });
    expect(sources).toEqual(FALLBACK_SKILLS_CATALOG_SOURCES);
    expect(fetchCalls[0]?.input).toBe('/api/config/skills/catalog?directory=%2Fworkspace%2Fa');
    expect(fetchCalls[0]?.init?.signal?.aborted).toBe(false);
    controller.abort();
    expect(fetchCalls[0]?.init?.signal?.aborted).toBe(true);
  });

  test('source pages continue through duplicate-only pages and stop at a seen cursor', () => {
    const options = skillsCatalogSourceInfiniteQueryOptions('/workspace/a', 'clawdhub', 'runtime-a');
    const first = { items: [item('a')], nextCursor: 'cursor-1' };
    const duplicate = { items: [item('a', 'updated')], nextCursor: 'cursor-2' };
    const later = { items: [item('b')], nextCursor: 'cursor-2' };
    expect(options.getNextPageParam(first, [first], null, [null])).toBe('cursor-1');
    expect(options.getNextPageParam(duplicate, [first, duplicate], 'cursor-1', [null, 'cursor-1'])).toBe('cursor-2');
    expect(options.getNextPageParam(later, [first, duplicate, later], 'cursor-2', [null, 'cursor-1', 'cursor-2'])).toBe(undefined);
    expect(flattenSkillsCatalogSourcePages([first, duplicate])).toEqual([item('a', 'updated')]);
  });

  test('source endpoint falls back to catalog items when the endpoint fails', async () => {
    fetchImpl = async (input) => input.includes('/source')
      ? jsonResponse({ ok: false, error: { message: 'legacy endpoint' } }, { status: 404 })
      : jsonResponse({ ok: true, itemsBySource: { clawdhub: [item('a')] } });
    const data = await queryClient.fetchInfiniteQuery({ ...skillsCatalogSourceInfiniteQueryOptions('/workspace/a', 'clawdhub'), retry: false });
    expect(data.pages[0]).toEqual({ items: [item('a')], nextCursor: null });
    expect(fetchCalls).toHaveLength(2);
  });

  test('refresh writes sources to the standard key and preserves snapshots after failure', async () => {
    fetchImpl = async () => jsonResponse({ ok: true, sources: [{ ...FALLBACK_SKILLS_CATALOG_SOURCES[0], label: 'Updated' }] });
    await refreshSkillsCatalogSourcesQuery(queryClient, activeProjectPath, runtimeKey);
    expect(readSkillsCatalogSourcesSnapshot(queryClient, activeProjectPath, runtimeKey)[0]?.label).toBe('Updated');
    fetchImpl = async () => jsonResponse({ ok: false, error: { message: 'broken' } }, { status: 500 });
    await expect(refreshSkillsCatalogSourcesQuery(queryClient, activeProjectPath, runtimeKey)).rejects.toThrow('broken');
    expect(readSkillsCatalogSourcesSnapshot(queryClient, activeProjectPath, runtimeKey)[0]?.label).toBe('Updated');
  });

  test('source refresh resets to one page and inactive transports retain their snapshot without requests', async () => {
    queryClient.setQueryData(queryKeys.skillsCatalog.source(activeProjectPath, 'clawdhub', runtimeKey), { pages: [{ items: [item('old')], nextCursor: 'next' }], pageParams: [null] });
    fetchImpl = async () => jsonResponse({ ok: true, items: [item('fresh')], nextCursor: 'next' });
    await refreshSkillsCatalogSourceQuery(queryClient, activeProjectPath, 'clawdhub', runtimeKey);
    expect(queryClient.getQueryData(queryKeys.skillsCatalog.source(activeProjectPath, 'clawdhub', runtimeKey))).toEqual({ pages: [{ items: [item('fresh')], nextCursor: 'next' }], pageParams: [null] });
    runtimeKey = 'runtime-b';
    await refreshSkillsCatalogSourceQuery(queryClient, activeProjectPath, 'clawdhub', 'runtime-a');
    expect(fetchCalls).toHaveLength(1);
  });

  test('force refresh cancels an in-flight next page and retains its refreshed first page', async () => {
    let resolveNextPage: ((response: Response) => void) | undefined;
    let call = 0;
    fetchImpl = async (_input, init) => {
      call += 1;
      if (call === 1) return jsonResponse({ ok: true, items: [item('first')], nextCursor: 'next' });
      if (call === 2) return new Promise<Response>((resolve) => { resolveNextPage = resolve; });
      expect(init?.signal?.aborted).toBe(false);
      return jsonResponse({ ok: true, items: [item('refreshed')], nextCursor: null });
    };
    const options = skillsCatalogSourceInfiniteQueryOptions(activeProjectPath, 'clawdhub', runtimeKey);
    const observer = new InfiniteQueryObserver(queryClient, options);
    const unsubscribe = observer.subscribe(() => undefined);
    await observer.refetch();
    const nextPage = observer.fetchNextPage();
    const refresh = refreshSkillsCatalogSourceQuery(queryClient, activeProjectPath, 'clawdhub', runtimeKey);
    await refresh;
    resolveNextPage?.(jsonResponse({ ok: true, items: [item('stale')], nextCursor: null }));
    await nextPage.catch(() => undefined);
    unsubscribe();

    expect(fetchCalls[1]?.init?.signal?.aborted).toBe(true);
    expect(queryClient.getQueryData(queryKeys.skillsCatalog.source(activeProjectPath, 'clawdhub', runtimeKey))).toEqual({
      pages: [{ items: [item('refreshed')], nextCursor: null }],
      pageParams: [null],
    });
  });

  test('a newer source refresh wins when an older refresh completes later', async () => {
    const resolvers: Array<(response: Response) => void> = [];
    fetchImpl = async () => new Promise<Response>((resolve) => { resolvers.push(resolve); });
    const first = refreshSkillsCatalogSourceQuery(queryClient, activeProjectPath, 'clawdhub', runtimeKey);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = refreshSkillsCatalogSourceQuery(queryClient, activeProjectPath, 'clawdhub', runtimeKey);
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolvers[1]?.(jsonResponse({ ok: true, items: [item('newer')], nextCursor: null }));
    await second;
    resolvers[0]?.(jsonResponse({ ok: true, items: [item('older')], nextCursor: null }));
    await first;

    expect(queryClient.getQueryData(queryKeys.skillsCatalog.source(activeProjectPath, 'clawdhub', runtimeKey))).toEqual({
      pages: [{ items: [item('newer')], nextCursor: null }],
      pageParams: [null],
    });
  });

  test('stale refresh completion cannot restore a cleared old-runtime cache', async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    fetchImpl = async () => new Promise<Response>((resolve) => { resolveResponse = resolve; });
    const refresh = refreshSkillsCatalogSourceQuery(queryClient, activeProjectPath, 'clawdhub', runtimeKey);
    await new Promise((resolve) => setTimeout(resolve, 0));
    runtimeKey = 'runtime-b';
    queryClient.clear();
    resolveResponse?.(jsonResponse({ ok: true, items: [item('old-runtime')], nextCursor: null }));

    expect(await refresh).toBe(undefined);
    expect(queryClient.getQueryData(queryKeys.skillsCatalog.source(activeProjectPath, 'clawdhub', 'runtime-a'))).toBe(undefined);
  });
});