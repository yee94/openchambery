import { QueryClient, QueryObserver } from '@tanstack/react-query';
import type { OpenCodeClient } from '@yuriai/opencode-gui-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { guiBundleOptions, guiInventoryOptions } from './guiPluginQueries';
import { createConfigLiveRefresh } from '@/sync/config-live-refresh';

afterEach(() => vi.useRealTimers());

describe('GUI plugin snapshots', () => {
  it('loads the global inventory through the SDK, preserves failures, and keeps runtime keys apart', async () => {
    const data = [{ id: 'dsl', features: { gui: true }, source: { type: 'local', path: '/plugins/dsl' }, state: { status: 'active' } }];
    const list = vi.fn().mockResolvedValue({ data });
    const api = { plugin: { list } } as unknown as OpenCodeClient;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const options = { ...guiInventoryOptions('host-a', api), retry: false };
    expect(await client.fetchQuery(options)).toEqual(data);
    expect(list.mock.calls[0][0]).toBeUndefined();
    expect(list.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(client.getQueryData(guiInventoryOptions('host-b', api).queryKey)).toBeUndefined();
    list.mockRejectedValue(new Error('offline'));
    await expect(client.fetchQuery({ ...options, staleTime: 0 })).rejects.toThrow('offline');
    expect(client.getQueryData(options.queryKey)).toEqual(data);
    list.mockResolvedValue({ data: [] });
    expect(await client.fetchQuery({ ...options, staleTime: 0 })).toEqual([]);
    client.clear();
  });

  it('the existing plugin.updated/reconnect pipeline invalidates active bundles without polling', async () => {
    vi.useFakeTimers();
    const gui = vi.fn().mockResolvedValue({ data: { code: 'exports.default={setup(){}}', revision: 'one', options: {} } });
    const api = { plugin: { gui } } as unknown as OpenCodeClient;
    const client = new QueryClient();
    const options = guiBundleOptions('host-a', 'dsl', api);
    await client.fetchQuery(options);
    const observer = new QueryObserver(client, options);
    const stop = observer.subscribe(() => {});
    const refresh = createConfigLiveRefresh({
      client, identity: () => ({ transport: 'host-a', generation: 1 }), refreshProjections: async () => {}, onError: () => {},
    });
    refresh.event('plugin.updated', '/project');
    refresh.event('plugin.updated', '/project');
    await vi.advanceTimersByTimeAsync(120);
    expect(gui).toHaveBeenCalledTimes(2);
    expect(gui.mock.calls[1][0]).toEqual({ id: 'dsl' });
    refresh.event('server.connected');
    await vi.advanceTimersByTimeAsync(120);
    expect(gui).toHaveBeenCalledTimes(3);
    refresh.dispose();
    stop();
    client.clear();
  });
});
