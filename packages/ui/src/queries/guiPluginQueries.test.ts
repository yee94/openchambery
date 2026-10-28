import { QueryClient, QueryObserver } from '@tanstack/react-query';
import type { OpenCodeClient } from '@yuriai/opencode-gui-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { guiBundleOptions, guiInventoryOptions } from './guiPluginQueries';
import { createConfigLiveRefresh } from '@/sync/config-live-refresh';

const runtime = vi.hoisted(() => ({ transport: 'host-a', generation: 0 }));
vi.mock('@/lib/runtime-switch', () => ({ getRuntimeGeneration: () => runtime.generation, getRuntimeKey: () => runtime.transport, getRuntimeTransportIdentity: () => runtime.transport }));
beforeEach(() => { runtime.transport = 'host-a'; runtime.generation = 0; });

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

  it('limits a 20-bundle fanout to two requests, removes cancelled waiters, and drains after failure', async () => {
    const pending: Array<{ id: string; resolve: () => void; reject: () => void }> = [];
    let active = 0;
    let maximum = 0;
    const gui = vi.fn(({ id }: { id: string }) => new Promise((resolve, reject) => {
      active++;
      maximum = Math.max(maximum, active);
      pending.push({ id, resolve: () => { active--; resolve({ data: { code: id, revision: id, options: {} } }); }, reject: () => { active--; reject(new Error('failed')); } });
    }));
    const api = { plugin: { gui } } as unknown as OpenCodeClient;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const options = Array.from({ length: 20 }, (_, id) => ({ ...guiBundleOptions('host-a', `${id}`, api), retry: false }));
    const promises = options.map((option) => client.fetchQuery(option).then(() => 'ok', () => 'failed'));
    await vi.waitFor(() => expect(gui).toHaveBeenCalledTimes(2));
    await client.cancelQueries({ queryKey: options[2].queryKey, exact: true });
    pending.shift()!.reject();
    await vi.waitFor(() => expect(gui).toHaveBeenCalledTimes(3));
    expect(pending.map((entry) => entry.id)).toEqual(['1', '3']);
    for (let completed = 1; completed < 19; completed++) {
      await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
      pending.shift()!.resolve();
    }
    const results = await Promise.all(promises);
    expect(results.filter((result) => result === 'ok')).toHaveLength(18);
    expect(maximum).toBe(2);
    expect(gui.mock.calls.some(([entry]) => entry.id === '2')).toBe(false);
    client.clear();
  });

  it.each(['generation', 'transport'])('fences queued and running bundles when runtime %s changes', async (change) => {
    const pending: Array<() => void> = [];
    const gui = vi.fn(() => new Promise((resolve) => { pending.push(() => resolve({ data: { code: 'old', revision: 'old', options: {} } })); }));
    const api = { plugin: { gui } } as unknown as OpenCodeClient;
    const client = new QueryClient();
    const results = ['a', 'b', 'queued'].map((id) => client.fetchQuery({ ...guiBundleOptions('host-a', id, api), retry: false }).then(() => 'ok', () => 'stale'));
    await vi.waitFor(() => expect(gui).toHaveBeenCalledTimes(2));
    if (change === 'generation') runtime.generation++;
    else runtime.transport = 'host-b';
    for (const finish of pending) finish();
    expect(await Promise.all(results)).toEqual(['stale', 'stale', 'stale']);
    expect(gui).toHaveBeenCalledTimes(2);
    gui.mockResolvedValueOnce({ data: { code: 'current', revision: 'current', options: {} } });
    expect(await client.fetchQuery(guiBundleOptions('host-a', 'current', api))).toMatchObject({ code: 'current' });
    client.clear();
  });
});
