import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenCode } from '@opencode/client';
import { releaseDeletedWorktreeLocation } from './location-release.js';

afterEach(() => vi.useRealTimers());

describe('explicit worktree location release', () => {
  it('uses the official SDK exact target, current origin and auth', async () => {
    const requests = [];
    let origin = 'https://old.invalid';
    const getClient = () => OpenCode.make({ baseUrl: origin, headers: { Authorization: 'test-auth' }, fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(null, { status: 204 });
    } });
    origin = 'https://current.invalid';
    expect(await releaseDeletedWorktreeLocation({ getClient, directory: '/repo/work tree' })).toEqual({ state: 'released' });
    expect(requests).toHaveLength(1);
    const url = new URL(requests[0].url);
    expect(url.origin + url.pathname).toBe('https://current.invalid/api/debug/location');
    expect(url.searchParams.get('location[directory]')).toBe('/repo/work tree');
    expect(requests[0].method).toBe('DELETE');
    expect(requests[0].headers.get('Authorization')).toBe('test-auth');
  });

  it('reports failure without claiming successful disposal', async () => {
    const getClient = () => ({ debug: { location: { evict: async () => { throw new Error('unavailable'); } } } });
    expect(await releaseDeletedWorktreeLocation({ getClient, directory: '/repo' })).toEqual({ state: 'failed' });
    expect(await releaseDeletedWorktreeLocation({ getClient: () => null, directory: '/repo' })).toEqual({ state: 'unavailable' });
  });

  it('bounds even a transport that ignores abort and never settles', async () => {
    vi.useFakeTimers();
    let signal;
    const getClient = () => ({ debug: { location: { evict: (_input, options) => {
      signal = options.signal;
      return new Promise(() => {});
    } } } });
    const result = releaseDeletedWorktreeLocation({ getClient, directory: '/repo', timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toEqual({ state: 'timeout' });
    expect(signal.aborted).toBe(true);
  });
});
