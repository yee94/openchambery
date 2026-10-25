import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { openNativeVideoSource, VIDEO_RANGE_BYTES } from './native-video';

const mock = vi.hoisted(() => ({
  fetch: vi.fn(), create: vi.fn(), release: vi.fn(), respond: vi.fn(), remove: vi.fn(), ownerRead: vi.fn(),
  callback: null as ((event: Record<string, unknown>) => void) | null,
  changed: null as (() => void) | null,
}));
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios', isPluginAvailable: () => true },
  registerPlugin: () => ({ create: mock.create, release: mock.release, respond: mock.respond,
    addListener: async (_name: string, callback: typeof mock.callback) => { mock.callback = callback; return { remove: mock.remove }; } }),
}));
vi.mock('./runtime-fetch', () => ({ runtimeFetch: mock.fetch }));
vi.mock('./runtime-file-resource', () => ({
  readRuntimeFile: (input: { path: string; range: string; signal: AbortSignal }) => {
    mock.ownerRead(input);
    return mock.fetch('/api/fs/raw', { query: { path: input.path }, headers: { Range: input.range }, signal: input.signal });
  },
}));
vi.mock('./runtime-switch', () => ({ getRuntimeTransportIdentity: () => 'relay:test',
  subscribeRuntimeEndpointChanged: (callback: () => void) => { mock.changed = callback; return () => {}; } }));
let abort: AbortController;
beforeEach(() => {
  vi.clearAllMocks(); abort = new AbortController();
  mock.create.mockResolvedValue({ url: 'http://127.0.0.1:1234/opaque' });
  mock.respond.mockResolvedValue(undefined); mock.release.mockResolvedValue(undefined);
});
afterEach(() => abort.abort());
const open = () => openNativeVideoSource('/api/fs/raw', { query: { path: '/workspace/large.mp4' } }, abort.signal);
const request = (requestId: string, range = 'bytes=0-1', extra = {}) => mock.callback?.({
  assetId: mock.create.mock.calls[0][0].assetId, requestId, range, method: 'GET', ...extra,
});

test('opens without downloading any video and carries bounded seek requests through runtimeFetch', async () => {
  const lease = await open();
  expect(lease?.url).toMatch(/^http:/);
  expect(mock.fetch).not.toHaveBeenCalled();
  mock.fetch.mockResolvedValue(new Response(new Uint8Array([1, 2]), {
    status: 206, headers: { 'content-range': 'bytes 10000000-10000001/5000000000', 'content-type': 'video/mp4' },
  }));
  request('seek', 'bytes=10000000-');
  await vi.waitFor(() => expect(mock.respond).toHaveBeenCalled());
  expect(mock.fetch).toHaveBeenCalledWith('/api/fs/raw', expect.objectContaining({
    query: { path: '/workspace/large.mp4' }, headers: { Range: `bytes=10000000-${10000000 + VIDEO_RANGE_BYTES - 1}` },
  }));
  expect(mock.respond).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'seek', status: 206,
    contentRange: 'bytes 10000000-10000001/5000000000', contentLength: 2, dataBase64: 'AQI=' }));
});

test('rejects hosts that ignore Range without consuming the full file', async () => {
  let pulls = 0;
  const cancel = vi.fn();
  mock.fetch.mockResolvedValue(new Response(new ReadableStream({ pull() { pulls++; }, cancel }), { status: 200 }));
  await open(); request('old-host');
  await vi.waitFor(() => expect(mock.respond).toHaveBeenCalledWith({ requestId: 'old-host', status: 502, dataBase64: '' }));
  expect(cancel).toHaveBeenCalled(); expect(pulls).toBeLessThanOrEqual(1);
});

test('seek cancellation and runtime switch abort in-flight Relay work and release native lease', async () => {
  let signal: AbortSignal | undefined;
  mock.fetch.mockImplementation((_route, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
  });
  await open(); request('cancel');
  request('cancel', '', { cancelled: true });
  expect(signal?.aborted).toBe(true);
  mock.changed?.();
  await vi.waitFor(() => expect(mock.release).toHaveBeenCalled());
  expect(mock.remove).toHaveBeenCalled(); expect(mock.respond).not.toHaveBeenCalled();
});

test('HEAD reconstructs total size from Content-Range even when Relay strips Content-Length', async () => {
  mock.fetch.mockResolvedValue(new Response(new Uint8Array([1]), { status: 206, headers: { 'content-range': 'bytes 0-0/5000000000' } }));
  await open(); request('head', '', { method: 'HEAD' });
  await vi.waitFor(() => expect(mock.respond).toHaveBeenCalled());
  expect(mock.respond).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'head', status: 200, contentLength: 5000000000, dataBase64: '' }));
});

test('raw URL playback retains directory and outside-file grants in the shared owner', async () => {
  mock.fetch.mockResolvedValue(new Response(new Uint8Array([1, 2]), { status: 206, headers: { 'content-range': 'bytes 0-1/2' } }));
  await openNativeVideoSource('/api/fs/raw?path=clip.mp4&directory=%2Foriginal&allowOutsideWorkspace=true&outsideFileGrant=test-grant', {}, abort.signal);
  request('raw-url');
  await vi.waitFor(() => expect(mock.respond).toHaveBeenCalled());
  expect(mock.ownerRead).toHaveBeenCalledWith(expect.objectContaining({ path: 'clip.mp4', directory: '/original', allowOutsideWorkspace: true, outsideFileGrant: 'test-grant' }));
});
