import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { createConfigLiveRefresh } from './config-live-refresh';

afterEach(() => vi.useRealTimers());

function setup() {
  vi.useFakeTimers();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  let identity = { transport: 'runtime-a', generation: 1 };
  const refreshProjections = vi.fn(async () => undefined);
  const onError = vi.fn();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const refresh = createConfigLiveRefresh({ client, identity: () => identity, refreshProjections, onError });
  return { client, refresh, invalidate, refreshProjections, onError, switchRuntime: () => { identity = { transport: 'runtime-b', generation: 2 }; } };
}

describe('V2 configuration event refresh', () => {
  it('coalesces a credential/provider/model burst and invalidates every directory, not sessions or other runtimes', async () => {
    const s = setup();
    const keys = [
      ['runtime-a', 'configCatalog', 'providers', '/one'],
      ['runtime-a', 'configCatalog', 'providers', '/two'],
      ['runtime-a', 1, 'provider-connections', '/two'],
      ['runtime-b', 'configCatalog', 'providers', '/one'],
      ['runtime-a', 'sessionIndex', 'snapshot'],
    ];
    keys.forEach((key) => s.client.setQueryData(key, ['previous']));
    for (let i = 0; i < 50; i++) {
      s.refresh.event('credential.switched', 'global');
      s.refresh.event('provider.updated', '/one');
      s.refresh.event('model.updated', '/one');
    }
    await vi.advanceTimersByTimeAsync(100);
    expect(s.invalidate).toHaveBeenCalledTimes(1);
    expect(keys.map((key) => s.client.getQueryState(key)?.isInvalidated)).toEqual([true, true, true, false, false]);
    expect(s.client.getQueryData(keys[0])).toEqual(['previous']);
    s.refresh.dispose(); s.client.clear();
  });

  it('only invalidates the matching location and domain', async () => {
    const s = setup();
    const keys = [
      ['runtime-a', 'commands', '/one'], ['runtime-a', 'commands', '/two'],
      ['runtime-a', 'mcp', 'status', '/one'], ['runtime-a', 'plugins', 'list', '/one'],
    ];
    keys.forEach((key) => s.client.setQueryData(key, []));
    s.refresh.event('command.updated', '/one/');
    await vi.advanceTimersByTimeAsync(100);
    expect(keys.map((key) => s.client.getQueryState(key)?.isInvalidated)).toEqual([true, false, false, false]);
    s.refresh.dispose(); s.client.clear();
  });

  it('ignores high-frequency transcript events without scheduling or scanning queries', async () => {
    const s = setup();
    for (let i = 0; i < 1000; i++) expect(s.refresh.event('message.part.delta', '/one')).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.invalidate).not.toHaveBeenCalled();
    expect(s.refreshProjections).not.toHaveBeenCalled();
    s.refresh.dispose(); s.client.clear();
  });

  it('drops queued work after runtime switch', async () => {
    const s = setup();
    s.refresh.event('config.updated', '/one');
    s.switchRuntime();
    await vi.advanceTimersByTimeAsync(100);
    expect(s.invalidate).not.toHaveBeenCalled();
    expect(s.refreshProjections).not.toHaveBeenCalled();
    s.refresh.dispose(); s.client.clear();
  });

  it('settles MCP status bursts with one active refetch, leaving inactive queries stale', async () => {
    const s = setup();
    const key = ['runtime-a', 'mcp', 'status', '/one'];
    const queryFn = vi.fn(async () => ['connected']);
    s.client.setQueryData(key, ['connecting']);
    s.client.setQueryData(['runtime-a', 'mcp', 'configs', '/one'], []);
    const observer = new QueryObserver(s.client, { queryKey: key, queryFn });
    const unsubscribe = observer.subscribe(() => undefined);
    for (let i = 0; i < 9; i++) s.refresh.event('mcp.status.changed', '/one');
    await vi.advanceTimersByTimeAsync(100);
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(s.client.getQueryData(key)).toEqual(['connected']);
    expect(s.client.getQueryState(['runtime-a', 'mcp', 'configs', '/one'])?.isInvalidated).toBe(true);
    unsubscribe(); s.refresh.dispose(); s.client.clear();
  });

  it('retains a trailing event received while a refresh is in flight', async () => {
    const s = setup();
    let release!: () => void;
    s.invalidate.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    s.refresh.event('model.updated', '/one');
    await vi.advanceTimersByTimeAsync(100);
    s.refresh.event('model.updated', '/one');
    expect(s.invalidate).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(100);
    expect(s.invalidate).toHaveBeenCalledTimes(2);
    s.refresh.dispose(); s.client.clear();
  });

  it('does not publish old-runtime projections after an in-flight refresh completes', async () => {
    const s = setup();
    let release!: () => void;
    s.invalidate.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    s.refresh.event('model.updated', '/old');
    await vi.advanceTimersByTimeAsync(100);
    s.switchRuntime();
    s.refresh.event('model.updated', '/new');
    release();
    await vi.advanceTimersByTimeAsync(100);
    expect(s.refreshProjections).toHaveBeenCalledTimes(1);
    expect(s.refreshProjections).toHaveBeenCalledWith('/new', new Set(['providers']));
    s.refresh.dispose(); s.client.clear();
  });

  it('preserves a previous snapshot when active refresh fails', async () => {
    const s = setup();
    const key = ['runtime-a', 'plugins', 'list', '/one'];
    s.client.setQueryData(key, ['installed']);
    const observer = new QueryObserver(s.client, { queryKey: key, queryFn: async () => { throw new Error('offline'); } });
    const unsubscribe = observer.subscribe(() => undefined);
    s.refresh.event('plugin.updated', '/one');
    await vi.advanceTimersByTimeAsync(100);
    expect(s.client.getQueryData(key)).toEqual(['installed']);
    expect(s.client.getQueryState(key)?.status).toBe('error');
    unsubscribe(); s.refresh.dispose(); s.client.clear();
  });

  it('reconnect invalidates all configuration families without touching unrelated queries', async () => {
    const s = setup();
    const keys = [['runtime-a', 'skills', '/two'], ['runtime-a', 'agents', 'raw'], ['runtime-a', 'plugins', 'list', '/one']];
    keys.forEach((key) => s.client.setQueryData(key, []));
    s.refresh.event('server.connected');
    await vi.advanceTimersByTimeAsync(100);
    expect(keys.every((key) => s.client.getQueryState(key)?.isInvalidated)).toBe(true);
    s.refresh.dispose(); s.client.clear();
  });
});
