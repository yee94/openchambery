import { beforeEach, afterEach, expect, test, vi } from 'vitest';
const state = vi.hoisted(() => ({
  acquire: vi.fn(), append: vi.fn(), commit: vi.fn(), release: vi.fn(), stat: vi.fn(), fetch: vi.fn(),
  transport: 'direct:host-a', generation: 0, supported: true,
}));
vi.mock('./relay/native-asset-bridge', () => ({ getNativeImageCacheBridge: () => state.supported ? state : null }));
vi.mock('@/contexts/runtimeAPIRegistry', () => ({ getRegisteredRuntimeAPIs: () => ({ files: { statFile: state.stat } }) }));
vi.mock('@/queries/fileQueries', () => ({ fileStatQueryOptions: () => ({ queryFn: state.stat }) }));
vi.mock('@/lib/queryRuntime', () => ({ queryClient: { fetchQuery: ({ queryFn }: { queryFn: () => unknown }) => queryFn() } }));
vi.mock('./runtime-fetch', () => ({ runtimeFetch: state.fetch }));
vi.mock('./runtime-switch', () => ({
  getRuntimeTransportIdentity: () => state.transport, getRuntimeGeneration: () => state.generation,
  subscribeRuntimeEndpointChanged: () => () => {},
}));
vi.mock('./runtime-auth', () => ({
  getRuntimeAuthGeneration: () => 1, getRuntimeBearerTokenSync: () => 'test-credential', subscribeRuntimeAuthGeneration: () => () => {},
}));
import { acquireRuntimeImage, clearRuntimeImageCacheLeases } from './runtime-image-cache';
beforeEach(() => {
  state.transport = 'direct:host-a'; state.generation = 0; state.supported = true;
  state.stat.mockResolvedValue({ isFile: true, size: 3, mtimeMs: 1 });
  const disk = new Set<string>();
  state.acquire.mockImplementation(async ({ key }: { key: string }) => {
    const hit = disk.has(key); disk.add(key);
    return { leaseId: key, url: `openchamber-asset://cache/${key}`, hit };
  });
  state.fetch.mockImplementation(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }));
  state.append.mockResolvedValue(undefined); state.commit.mockResolvedValue(undefined); state.release.mockResolvedValue(undefined);
});
afterEach(() => { clearRuntimeImageCacheLeases(); vi.clearAllMocks(); });
const acquire = (signal = new AbortController().signal) => acquireRuntimeImage('/repo/image.png', signal);

test('ten completed session revisits download once; preview shares the native lease', async () => {
  const initial = await acquire(); initial.release();
  for (let i = 0; i < 10; i++) {
    const [inline, preview] = await Promise.all([acquire(), acquire()]);
    expect(inline.url).toBe(initial.url); expect(preview.url).toBe(initial.url);
    inline.release(); preview.release();
  }
  expect(state.fetch).toHaveBeenCalledTimes(1);
  expect(state.append).toHaveBeenCalledTimes(1);
  expect(state.acquire).toHaveBeenCalledTimes(11);
  expect(state.release).toHaveBeenCalledTimes(11);
});
test('changed file version and changed host cannot reuse old bytes', async () => {
  (await acquire()).release();
  state.stat.mockResolvedValue({ isFile: true, size: 3, mtimeMs: 2 });
  (await acquire()).release();
  state.transport = 'relay:host-b';
  (await acquire()).release();
  expect(state.fetch).toHaveBeenCalledTimes(3);
});
test('metadata failure is not a cache hit and unsupported runtimes do no work', async () => {
  (await acquire()).release();
  state.stat.mockRejectedValue(new Error('offline'));
  await expect(acquire()).rejects.toThrow('offline');
  expect(state.acquire).toHaveBeenCalledTimes(1);
  state.supported = false;
  expect((await acquire()).url).toBe('');
  expect(state.fetch).toHaveBeenCalledTimes(1);
});
test('one cancelled subscriber cannot abort its peer', async () => {
  const a = new AbortController();
  const first = acquire(a.signal);
  const peer = acquire();
  a.abort();
  await expect(first).rejects.toThrow('Aborted');
  const result = await peer;
  expect(result.url).toMatch(/^openchamber-asset:/);
  expect(state.release).not.toHaveBeenCalled();
  result.release();
  expect(state.release).toHaveBeenCalledTimes(1);
});
test('late results after a runtime switch are released without publishing', async () => {
  state.acquire.mockImplementation(async () => {
    state.generation += 1;
    return { leaseId: 'late', hit: true, url: 'openchamber-asset://cache/late' };
  });
  await expect(acquire()).rejects.toThrow('superseded');
  expect(state.release).toHaveBeenCalledWith('late');
});
test('file mutation during download cannot commit a cache entry', async () => {
  state.stat.mockResolvedValueOnce({ isFile: true, size: 3, mtimeMs: 1 })
    .mockResolvedValueOnce({ isFile: true, size: 3, mtimeMs: 2 });
  await expect(acquire()).rejects.toThrow('changed');
  expect(state.commit).not.toHaveBeenCalled();
  expect(state.release).toHaveBeenCalledTimes(1);
});

test('a late native acquire after the last subscriber leaves is released without download', async () => {
  let finish!: (value: { leaseId: string; url: string; hit: boolean }) => void;
  state.acquire.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const controller = new AbortController();
  const pending = acquire(controller.signal);
  await vi.waitFor(() => expect(state.acquire).toHaveBeenCalledTimes(1));
  controller.abort();
  await expect(pending).rejects.toThrow('Aborted');
  finish({ leaseId: 'orphan', url: 'openchamber-asset://cache/orphan', hit: false });
  await vi.waitFor(() => expect(state.release).toHaveBeenCalledWith('orphan'));
  expect(state.fetch).not.toHaveBeenCalled();
});
