import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openCodeUpdateQueryOptions } from './openCodeUpdateQuery';

const fixture = vi.hoisted(() => ({ transport: 'host-a', generation: 1, fetch: vi.fn() }));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: (...args: unknown[]) => fixture.fetch(...args) }));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => fixture.transport,
  getRuntimeGeneration: () => fixture.generation,
}));

beforeEach(() => { fixture.transport = 'host-a'; fixture.generation = 1; fixture.fetch.mockReset(); });

describe('OpenCode update query', () => {
  it('passes cancellation through and isolates host generations', async () => {
    fixture.fetch.mockResolvedValue(Response.json({ available: true, targetVersion: '2.0.18' }));
    const options = openCodeUpdateQueryOptions('host-a', 1);
    const signal = new AbortController().signal;
    expect(await options.queryFn({ signal })).toMatchObject({ available: true });
    expect(fixture.fetch.mock.calls[0][1].signal).toBe(signal);
    expect(options.queryKey).not.toEqual(openCodeUpdateQueryOptions('host-b', 1).queryKey);
    expect(options.queryKey).not.toEqual(openCodeUpdateQueryOptions('host-a', 2).queryKey);
  });

  it('rejects a response arriving after a mobile host switch', async () => {
    fixture.fetch.mockImplementation(async () => {
      fixture.transport = 'host-b';
      return Response.json({ available: true, targetVersion: '2.0.18' });
    });
    await expect(openCodeUpdateQueryOptions('host-a', 1).queryFn({ signal: new AbortController().signal })).rejects.toThrow('Stale');
  });

  it('keeps failed checks as failures rather than empty success', async () => {
    fixture.fetch.mockResolvedValue(new Response('unavailable', { status: 503 }));
    await expect(openCodeUpdateQueryOptions('host-a', 1).queryFn({ signal: new AbortController().signal })).rejects.toThrow('failed');
  });
});
