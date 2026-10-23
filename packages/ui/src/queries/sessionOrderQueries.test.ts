import { beforeEach, describe, expect, test, vi } from 'vitest';
import { queryClient } from '@/lib/queryRuntime';
import { getSessionOrderSnapshot, saveSessionOrder, sessionOrderQueryOptions } from './sessionOrderQueries';

const runtime = vi.hoisted(() => ({ identity: 'host-a', generation: 1 }));
const request = vi.hoisted(() => vi.fn());
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => runtime.identity,
  getRuntimeGeneration: () => runtime.generation,
}));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: request }));
vi.mock('@/lib/openchamberEvents', () => ({ subscribeOpenchamberEvents: vi.fn(() => () => {}) }));
vi.mock('@/lib/queryRuntime', async () => {
  const { QueryClient } = await import('@tanstack/react-query');
  return { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) };
});

const snapshot = (revision: number, ids: string[]) => ({
  revision, sessionOrderByScope: { __pinned__: ids }, sessionOrderActivityByScope: { __pinned__: {} },
});

describe('server session order queries', () => {
  beforeEach(() => {
    queryClient.clear();
    request.mockReset();
    runtime.identity = 'host-a';
    runtime.generation = 1;
  });
  test('reads shared order and preserves it after a failed fetch or failed write', async () => {
    request.mockResolvedValueOnce(Response.json(snapshot(1, ['b', 'a'])));
    await queryClient.fetchQuery(sessionOrderQueryOptions());
    request.mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
    await expect(queryClient.fetchQuery({ ...sessionOrderQueryOptions(), retry: false })).rejects.toThrow();
    expect(getSessionOrderSnapshot()?.sessionOrderByScope.__pinned__).toEqual(['b', 'a']);
    request.mockResolvedValueOnce(new Response('disk full', { status: 500 }));
    await expect(saveSessionOrder('__pinned__', ['a', 'b'], {})).rejects.toThrow();
    expect(getSessionOrderSnapshot()?.revision).toBe(1);
    request.mockResolvedValueOnce(Response.json(snapshot(2, ['a', 'b'])));
    await saveSessionOrder('__pinned__', ['a', 'b'], {});
    expect(getSessionOrderSnapshot()?.sessionOrderByScope.__pinned__).toEqual(['a', 'b']);
  });
  test('fences delayed writes and queued operations when the Host switches', async () => {
    let finish!: (response: Response) => void;
    request.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const first = saveSessionOrder('__pinned__', ['b', 'a'], {});
    const second = saveSessionOrder('/repo', ['c', 'd'], {});
    const results = Promise.allSettled([first, second]);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    runtime.identity = 'host-b';
    runtime.generation += 1;
    finish(Response.json(snapshot(2, ['b', 'a'])));
    expect((await results).map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(request).toHaveBeenCalledTimes(1);
    expect(getSessionOrderSnapshot()).toBeUndefined();
  });
  test('does not regress a newer revision when a stale GET completes', () => {
    const latest = snapshot(3, ['b', 'a']);
    expect(sessionOrderQueryOptions().structuralSharing(latest, snapshot(2, ['a', 'b']))).toBe(latest);
  });
});
