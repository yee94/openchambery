import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { acquireMarkdownImage, useResolvedImageResource } from './imageSource';
import { acquireRuntimeImage, clearRuntimeImageCacheLeases } from '@/lib/runtime-image-cache';
import { readRuntimeFile, readRuntimeFileBlob, readVerifiedFileResource, importFileResource } from '@/lib/runtime-file-resource';
import { resetRelayImageStreamForTests } from '@/lib/relay/relay-image-stream';
import { MarkstreamImageNode } from './markstream/markstreamImage';

vi.mock('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => state.directory }));
vi.mock('@/lib/relay/runtime-tunnel', () => ({ isRelayModeActive: () => true }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/contexts/useThemeSystem', () => ({ useOptionalThemeSystem: () => undefined }));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ runtime: { isVSCode: false } }) }));
vi.mock('@/components/ui', () => ({ toast: { warning: vi.fn() } }));
vi.mock('@/lib/native-ios-composer-leave', () => ({ concealNativeComposerIfLeavingChat: () => {} }));
vi.mock('@/components/ui/dialog', () => ({ Dialog: () => null, DialogContent: () => null }));
vi.mock('./message/toolRenderers', () => ({}));
vi.mock('./message/parts/VirtualizedCodeBlock', () => ({ VirtualizedCodeBlock: () => null }));
vi.mock('@/components/code/WorkerHighlightedCode', () => ({ WorkerHighlightedCode: () => null }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: (select: (state: { isMobile: boolean }) => unknown) => select({ isMobile: false }) }));
vi.mock('./markstream/markstreamCodeBlock', () => ({ MarkstreamCodeBlockNode: () => null }));
vi.mock('./markstream/markstreamHostContext', () => ({ useMarkstreamHostContext: () => ({}) }));

const state = vi.hoisted(() => ({
  fetch: vi.fn(), stat: vi.fn(), bytes: 0, binary: undefined as undefined | ReturnType<typeof vi.fn>,
  transport: 'relay:host-a', generation: 0, auth: 0,
  endpointListeners: new Set<() => void>(), authListeners: new Set<() => void>(),
  native: false, open: vi.fn(), write: vi.fn(), end: vi.fn(), release: vi.fn(), abort: vi.fn(),
  durable: new Map<string, Blob>(), durableWrite: vi.fn(),
  diskBridge: undefined as undefined | { acquire: ReturnType<typeof vi.fn>; append: ReturnType<typeof vi.fn>; commit: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> },
  directory: '/workspace',
}));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: state.fetch }));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeKey: () => 'image-test', getRuntimeApiBaseUrl: () => '',
  getRuntimeTransportIdentity: () => state.transport, getRuntimeGeneration: () => state.generation,
  subscribeRuntimeEndpointChanged: (listener: () => void) => {
    state.endpointListeners.add(listener); return () => state.endpointListeners.delete(listener);
  },
}));
vi.mock('@/lib/runtime-auth', () => ({
  getRuntimeExtraHeadersSync: () => ({}),
  getRuntimeAuthGeneration: () => state.auth, getRuntimeBearerTokenSync: () => '',
  subscribeRuntimeAuthGeneration: (listener: () => void) => {
    state.authListeners.add(listener); return () => state.authListeners.delete(listener);
  },
}));
vi.mock('@/contexts/runtimeAPIRegistry', () => ({ getRegisteredRuntimeAPIs: () => ({ files: { statFile: state.stat, readFileBinary: state.binary } }) }));
vi.mock('@/queries/fileQueries', () => ({ fileStatQueryOptions: (_files: unknown, input: { path: string }) => ({ queryKey: ['image-stat', input.path], queryFn: () => state.stat(input.path) }) }));
vi.mock('@/lib/runtime-file-store', () => ({ runtimeFileStore: {
  read: async (key: string) => state.durable.get(key) ?? null,
  write: (...args: unknown[]) => state.durableWrite(...args),
  clear: async () => state.durable.clear(),
} }));
vi.mock('@/lib/queryRuntime', async () => {
  const { QueryClient } = await import('@tanstack/react-query');
  return { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }) };
});
vi.mock('@/lib/relay/native-asset-bridge', () => ({
  getNativeImageCacheBridge: () => state.diskBridge ?? null,
  resolveNativeRelayAssetBridge: async () => state.native ? {
    openAsset: state.open, writeChunk: state.write, endAsset: state.end,
    releaseAsset: state.release, abortAsset: state.abort,
  } : null,
}));

const IMAGE_BYTES = 256 * 1024;
function Image({ id, source = '/workspace/photo.png', directory = '/workspace' }: { id: string; source?: string; directory?: string }) {
  // Same owning Hook used by MarkstreamImageNode, attachments and full-screen preview.
  const resource = useResolvedImageResource(source, directory);
  return <img data-id={id} src={resource.source || undefined} data-error={resource.error} />;
}
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const render = async (children: React.ReactNode) => { await act(async () => root.render(children)); };
const readyImage = async () => vi.waitFor(async () => {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(document.querySelector('img')?.getAttribute('src')).toMatch(/^blob:/);
});
const fingerprintFixtures = async (entries: Record<string, Uint8Array<ArrayBuffer>>) => {
  const hashes = new Map(await Promise.all(Object.entries(entries).map(async ([path, body]) => [path,
    Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', body)), (byte) => byte.toString(16).padStart(2, '0')).join(''),
  ] as const)));
  state.stat.mockImplementation(async (path: string) => ({ path, isFile: true, size: entries[path].length, mtimeMs: 1, sha256: hashes.get(path) }));
  state.fetch.mockImplementation(async (_url: string, options: { query: { path: string } }) => {
    const body = entries[options.query.path];
    state.bytes += body.byteLength;
    return new Response(body);
  });
};

test('inline, file reader, save and destination upload reuse one complete source body', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  await fingerprintFixtures({ '/workspace/photo.png': bytes });
  await render(<Image id="inline" />); await readyImage();
  const { materializeImageBlob } = await import('./imageSave');
  const saved = await materializeImageBlob({ sourceUrl: '/workspace/photo.png', filename: 'original.png' });
  expect(new Uint8Array(await saved.blob.arrayBuffer())).toEqual(bytes);
  expect(saved.filename).toBe('original.png');
  expect(state.fetch).toHaveBeenCalledTimes(1);
  const rawSaved = await materializeImageBlob({ sourceUrl: '/api/fs/raw?path=%2Fworkspace%2Fphoto.png', filename: 'original.png' });
  expect(new Uint8Array(await rawSaved.blob.arrayBuffer())).toEqual(bytes);
  expect(state.fetch).toHaveBeenCalledTimes(1);
  await render(null); clearRuntimeImageCacheLeases();
  const source = await readRuntimeFile({ path: '/workspace/photo.png' });
  const blob = await source.blob();
  expect(state.fetch).toHaveBeenCalledTimes(1);
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  state.fetch.mockImplementationOnce(async (_route: string, options: { body: Blob }) => {
    expect(new Uint8Array(await options.body.arrayBuffer())).toEqual(bytes);
    return Response.json({ path: '/destination/original.png', size: 4, sha256, mime: 'image/png' });
  });
  const { uploadPromptAttachmentBytes } = await import('@/lib/prompt-attachment-upload');
  const result = await uploadPromptAttachmentBytes({ body: blob, mime: 'image/png', filename: 'original.png' });
  expect(result.path).toBe('/destination/original.png');
  expect(state.fetch).toHaveBeenLastCalledWith(expect.stringContaining('/api/fs/prompt-attachments/'), expect.objectContaining({ method: 'PUT' }));
  expect(state.fetch).toHaveBeenCalledTimes(2);
});

test('complete non-image body survives owner restart and serves seek ranges without transfer', async () => {
  const bytes = new TextEncoder().encode('0123456789');
  await fingerprintFixtures({ '/workspace/clip.mp4': bytes });
  const metadata = await state.stat('/workspace/clip.mp4');
  state.stat.mockResolvedValue({ ...metadata, mimeType: 'video/mp4', filename: 'clip.mp4' });
  expect(await (await readRuntimeFile({ path: '/workspace/clip.mp4' })).text()).toBe('0123456789');
  clearRuntimeImageCacheLeases();
  for (const [range, text, contentRange] of [['bytes=7-', '789', 'bytes 7-9/10'], ['bytes=-2', '89', 'bytes 8-9/10']]) {
    const response = await readRuntimeFile({ path: '/workspace/clip.mp4', range });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(contentRange);
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(await response.text()).toBe(text);
  }
  expect((await readRuntimeFile({ path: '/workspace/clip.mp4', range: 'bytes=20-' })).status).toBe(416);
  expect(state.fetch).toHaveBeenCalledTimes(1);
});

test('cold ranges and oversized files remain streaming without partial cache publication', async () => {
  state.stat.mockResolvedValue({ isFile: true, size: 5_000_000_000, mtimeMs: 1 });
  const cancel = vi.fn();
  state.fetch.mockImplementation(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1, 2])); }, cancel,
  }), { status: 206, headers: { 'content-range': 'bytes 100-101/5000000000' } }));
  const response = await readRuntimeFile({ path: '/workspace/large.mp4', range: 'bytes=100-101' });
  expect(response.status).toBe(206);
  await response.body!.cancel();
  await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
  expect(state.durableWrite).not.toHaveBeenCalled();
  expect(state.fetch).toHaveBeenCalledWith('/api/fs/raw', expect.objectContaining({ headers: { Range: 'bytes=100-101' } }));
});

test('oversized compatibility materialization returns all bytes without persistent retention', async () => {
  const size = 33 * 1024 * 1024;
  state.stat.mockResolvedValue({ isFile: true, size, mtimeMs: 1 });
  const bytes = new Uint8Array(size); bytes[0] = 1; bytes[size - 1] = 9;
  state.fetch.mockImplementation(async () => new Response(bytes, { headers: { 'content-type': 'video/mp4', 'content-length': String(size) } }));
  const blob = await readRuntimeFileBlob({ path: '/workspace/large.mp4' });
  expect(blob.size).toBe(size);
  expect(new Uint8Array(await blob.slice(-1).arrayBuffer())[0]).toBe(9);
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const { downloadRuntimeFile } = await import('@/lib/runtime-file-download');
  await downloadRuntimeFile({ path: '/workspace/large.mp4', filename: 'large.mp4' });
  expect(click).toHaveBeenCalledTimes(1);
  expect(URL.createObjectURL).toHaveBeenCalledWith(expect.objectContaining({ size }));
  expect(state.fetch).toHaveBeenCalledTimes(2);
  expect(state.durableWrite).not.toHaveBeenCalled();
});

test('descriptor and imported bytes share the file content owner without a second source download', async () => {
  const bytes = new TextEncoder().encode('shared-descriptor');
  await fingerprintFixtures({ '/workspace/shared.bin': bytes });
  const metadata = await state.stat('/workspace/shared.bin');
  await importFileResource(new Blob([bytes], { type: 'application/octet-stream' }));
  expect(await (await readRuntimeFile({ path: '/workspace/shared.bin' })).text()).toBe('shared-descriptor');
  const load = vi.fn();
  const descriptor = await readVerifiedFileResource({ identity: '/attachments/one', sha256: metadata.sha256!, size: bytes.length, persistent: true, load });
  expect(await descriptor.text()).toBe('shared-descriptor');
  expect(load).not.toHaveBeenCalled();
  expect(state.fetch).not.toHaveBeenCalled();
});
test('binary adapter and shared download reuse the same verified file body', async () => {
  const bytes = new TextEncoder().encode('binary-file');
  await fingerprintFixtures({ '/workspace/binary.bin': bytes });
  state.binary = vi.fn().mockResolvedValue({ path: '/workspace/binary.bin', dataUrl: 'data:application/octet-stream;base64,YmluYXJ5LWZpbGU=' });
  const first = await readRuntimeFileBlob({ path: '/workspace/binary.bin' });
  expect(await first.text()).toBe('binary-file');
  clearRuntimeImageCacheLeases();
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const { downloadRuntimeFile } = await import('@/lib/runtime-file-download');
  await downloadRuntimeFile({ path: '/workspace/binary.bin' });
  expect(click).toHaveBeenCalledTimes(1);
  expect(URL.createObjectURL).toHaveBeenCalledWith(expect.objectContaining({ size: bytes.length }));
  expect(state.binary).toHaveBeenCalledTimes(1);
  expect(state.fetch).not.toHaveBeenCalled();
});

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.transport = 'relay:host-a'; state.generation = 0; state.auth = 0; state.bytes = 0;
  state.native = false;
  state.diskBridge = undefined;
  state.binary = undefined;
  state.directory = '/workspace';
  state.durable.clear();
  state.durableWrite.mockImplementation(async (key: string, blob: Blob) => { state.durable.set(key, blob); });
  let nativeSerial = 0;
  state.open.mockImplementation(async () => ({ assetId: `native-${++nativeSerial}`, url: `native://image-${nativeSerial}` }));
  for (const fn of [state.write, state.end, state.release, state.abort]) fn.mockResolvedValue(undefined);
  state.stat.mockResolvedValue({ isFile: true, size: IMAGE_BYTES, mtimeMs: 1 });
  state.fetch.mockImplementation(async () => {
    state.bytes += IMAGE_BYTES;
    return new Response(new Uint8Array(IMAGE_BYTES), { headers: { 'content-type': 'image/png' } });
  });
  let serial = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:image-${++serial}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  clearRuntimeImageCacheLeases(); resetRelayImageStreamForTests();
  vi.restoreAllMocks(); vi.clearAllMocks();
  vi.useRealTimers();
});

test('successful Markdown image survives unmount and remount without retransferring its body', async () => {
  await render(<Image id="first" />);
  expect(host.querySelector('img')?.src).toMatch(/^blob:/);
  await render(null);
  await render(<Image id="second" />);
  expect(host.querySelector('img')?.src).toMatch(/^blob:/);
  console.info('image-remount transport', { requests: state.fetch.mock.calls.length, bytes: state.bytes });
  expect(state.fetch).toHaveBeenCalledTimes(1);
  expect(state.bytes).toBe(IMAGE_BYTES);
});

test('concurrent Markdown image consumers share one transfer and releasing one preserves its peer', async () => {
  await render(<><Image key="a" id="a" /><Image key="b" id="b" /></>);
  const peer = host.querySelector<HTMLImageElement>('[data-id="b"]')!.src;
  await render(<><Image key="b" id="b" /></>);
  expect(host.querySelector('img')?.src).toBe(peer);
  expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(peer);
  console.info('image-concurrent transport', { requests: state.fetch.mock.calls.length, bytes: state.bytes });
  expect(state.fetch).toHaveBeenCalledTimes(1);
  expect(state.bytes).toBe(IMAGE_BYTES);
});

test.each(['host', 'auth', 'generation', 'version'])('%s changes require fresh bytes', async (change) => {
  await render(<Image id="first" />);
  await render(null);
  if (change === 'host') state.transport = 'relay:host-b';
  if (change === 'auth') state.auth++;
  if (change === 'generation') state.generation++;
  if (change === 'version') state.stat.mockResolvedValue({ isFile: true, size: IMAGE_BYTES, mtimeMs: 2 });
  await render(<Image id="second" />);
  expect(host.querySelector('img')?.src).toMatch(/^blob:/);
  expect(state.fetch).toHaveBeenCalledTimes(2);
});

test('metadata failure cannot serve cached success and a later mount retries', async () => {
  await render(<Image id="first" />);
  await render(null);
  state.stat.mockRejectedValueOnce(new Error('offline'));
  await render(<Image id="failed" />);
  expect(host.querySelector('img')?.dataset.error).toBe('offline');
  await render(null);
  await render(<Image id="retry" />);
  expect(host.querySelector('img')?.src).toMatch(/^blob:/);
  expect(state.fetch).toHaveBeenCalledTimes(1);
});

test('transport failure and a changed file during download are not cached', async () => {
  state.fetch.mockRejectedValueOnce(new Error('offline'));
  await render(<Image id="failed" />);
  expect(host.querySelector('img')?.dataset.error).toBe('offline');
  await render(null);
  state.stat.mockResolvedValueOnce({ isFile: true, size: IMAGE_BYTES, mtimeMs: 1 })
    .mockResolvedValueOnce({ isFile: true, size: IMAGE_BYTES, mtimeMs: 2 });
  await render(<Image id="changed" />);
  expect(host.querySelector('img')?.dataset.error).toContain('changed');
  await render(null);
  await render(<Image id="retry" />);
  expect(host.querySelector('img')?.src).toMatch(/^blob:/);
  expect(state.fetch).toHaveBeenCalledTimes(3);
});

test('unmounting the first pending consumer does not cancel the shared transport', async () => {
  let finish!: (value: Response) => void;
  state.fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
  await render(<><Image key="a" id="a" /><Image key="b" id="b" /></>);
  await render(<><Image key="b" id="b" /></>);
  expect(state.fetch.mock.calls[0][1].signal.aborted).toBe(false);
  await act(async () => finish(new Response(new Uint8Array(IMAGE_BYTES))));
  expect(host.querySelector('img')?.src).toMatch(/^blob:/);
  expect(state.fetch).toHaveBeenCalledTimes(1);
  await render(null);
  expect(state.fetch.mock.calls[0][1].signal.aborted).toBe(true);
});

test('last pending consumer aborts transport and a late response is not cached', async () => {
  let finish!: (value: Response) => void;
  state.fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
  await render(<Image id="pending" />);
  await render(null);
  expect(state.fetch.mock.calls[0][1].signal.aborted).toBe(true);
  await act(async () => finish(new Response(new Uint8Array(IMAGE_BYTES))));
  await render(<Image id="retry" />);
  expect(state.fetch).toHaveBeenCalledTimes(2);
  expect(host.querySelector('img')?.src).toMatch(/^blob:/);
});

test('a cancelled lease rejects before its pending peer finishes', async () => {
  let finish!: (value: Response) => void;
  state.fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
  const controller = new AbortController();
  const pending = acquireRuntimeImage('/workspace/photo.png', controller.signal);
  await render(<Image id="peer" />);
  controller.abort();
  await expect(pending).rejects.toThrow('Aborted');
  expect(state.fetch.mock.calls[0][1].signal.aborted).toBe(false);
  await act(async () => finish(new Response(new Uint8Array(IMAGE_BYTES))));
  expect(host.querySelector('img')?.src).toMatch(/^blob:/);
});

test('external HTTP, API, data and blob sources remain browser-owned', async () => {
  for (const source of ['https://example.com/image.png', '/api/image', 'data:image/png;base64,AA==', 'blob:external']) {
    await render(<Image id="direct" source={source} />);
    expect(host.querySelector('img')?.getAttribute('src')).toBe(source);
  }
  expect(state.fetch).not.toHaveBeenCalled();
  expect(state.stat).not.toHaveBeenCalled();
});

test('legacy imperative Markdown and Hook consumers share the same body owner', async () => {
  const legacy = await acquireMarkdownImage('/workspace/photo.png', new AbortController().signal);
  await render(<Image id="hook" />);
  legacy.release();
  const peer = host.querySelector('img')!.src;
  expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(peer);
  await render(null);
  const revisit = await acquireMarkdownImage('/workspace/photo.png', new AbortController().signal);
  revisit.release();
  expect(state.fetch).toHaveBeenCalledTimes(1);
});

test('the default Markstream image adapter reuses body bytes after a real unmount', async () => {
  const props = { node: { type: 'image', src: '/workspace/photo.png', alt: 'photo' } } as React.ComponentProps<typeof MarkstreamImageNode>;
  await render(<MarkstreamImageNode {...props} />);
  expect(host.querySelector('img')?.src).toMatch(/^blob:/);
  await render(null);
  await render(<MarkstreamImageNode {...props} />);
  expect(host.querySelector('img')?.src).toMatch(/^blob:/);
  expect(state.fetch).toHaveBeenCalledTimes(1);
});

test('the legacy marked renderer releases its display lease and reuses bytes on remount', async () => {
  const { MarkdownRenderer } = await import('./MarkdownRendererImpl');
  const props = { content: '![photo](/workspace/photo.png)', messageId: 'image-test', isAnimated: false, enableFileReferences: false, onShowPopup: () => {} };
  await render(<MarkdownRenderer {...props} />);
  const first = host.querySelector('img')!.src;
  expect(first).toMatch(/^blob:/);
  await render(null);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1)); });
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(first);
  await render(<MarkdownRenderer {...props} />);
  expect(host.querySelector('img')?.src).toMatch(/^blob:/);
  expect(state.fetch).toHaveBeenCalledTimes(1);
});

test('native readers get separate progressive display URLs from one body', async () => {
  state.native = true;
  let body!: ReadableStreamDefaultController<Uint8Array>;
  state.fetch.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller; } })));
  await render(<><Image key="a" id="a" /><Image key="b" id="b" /></>);
  const urls = Array.from(host.querySelectorAll('img'), (image) => image.src);
  expect(urls[0]).toMatch(/^native:/);
  expect(urls[0]).not.toBe(urls[1]);
  expect(state.end).not.toHaveBeenCalled();
  await act(async () => { body.enqueue(new Uint8Array(IMAGE_BYTES)); body.close(); });
  await vi.waitFor(() => expect(state.end).toHaveBeenCalledTimes(2));
  await render(<><Image key="b" id="b" /></>);
  expect(state.release).not.toHaveBeenCalledWith('native-2');
  await render(null);
  await render(<Image id="revisit" />);
  expect(host.querySelector('img')?.src).toMatch(/^native:/);
  expect(state.fetch).toHaveBeenCalledTimes(1);
});

test('native progressive validation failure releases all readers and retries on remount', async () => {
  state.native = true;
  let body!: ReadableStreamDefaultController<Uint8Array>;
  state.fetch.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller; } })));
  await render(<><Image id="a" /><Image id="b" /></>);
  await act(async () => { body.enqueue(new Uint8Array(1)); body.close(); });
  await vi.waitFor(() => expect(state.release).toHaveBeenCalledTimes(2));
  await render(null);
  await render(<Image id="retry" />);
  expect(state.fetch).toHaveBeenCalledTimes(2);
});

test('idle bytes expire after five minutes', async () => {
  await render(<Image id="first" />);
  await render(null);
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5 * 60_000 + 1);
  await render(<Image id="expired" />);
  expect(state.fetch).toHaveBeenCalledTimes(2);
});

test('idle body cache evicts the least recently used entry above 32 images', async () => {
  for (let i = 0; i < 33; i++) {
    const lease = await acquireRuntimeImage(`/workspace/${i}.png`, new AbortController().signal);
    lease.release();
  }
  (await acquireRuntimeImage('/workspace/32.png', new AbortController().signal)).release();
  expect(state.fetch).toHaveBeenCalledTimes(33);
  (await acquireRuntimeImage('/workspace/0.png', new AbortController().signal)).release();
  expect(state.fetch).toHaveBeenCalledTimes(34);
});

test('idle body cache is also bounded by 64 MiB', async () => {
  const size = 24 * 1024 * 1024;
  state.stat.mockResolvedValue({ isFile: true, size, mtimeMs: 1 });
  state.fetch.mockImplementation(async () => new Response(new Uint8Array(size)));
  for (let i = 0; i < 3; i++) {
    (await acquireRuntimeImage(`/workspace/large-${i}.png`, new AbortController().signal)).release();
  }
  (await acquireRuntimeImage('/workspace/large-2.png', new AbortController().signal)).release();
  expect(state.fetch).toHaveBeenCalledTimes(3);
  (await acquireRuntimeImage('/workspace/large-0.png', new AbortController().signal)).release();
  expect(state.fetch).toHaveBeenCalledTimes(4);
});

test('auth invalidation revokes active URLs and clears completed cached bodies', async () => {
  await render(<Image id="active" />);
  const url = host.querySelector('img')!.src;
  await act(async () => {
    state.auth++;
    for (const listener of state.authListeners) listener();
  });
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(url);
  expect(host.querySelector('img')?.src).not.toBe(url);
  expect(state.fetch).toHaveBeenCalledTimes(2);
});

test('Markstream native fork revalidates delayed metadata and cannot reuse a live legacy file version', async () => {
  const disk = new Set<string>();
  const keys: string[] = [];
  state.diskBridge = {
    acquire: vi.fn(async ({ key }: { key: string }) => {
      const hit = disk.has(key); disk.add(key); keys.push(key);
      return { leaseId: key, url: `yuri-asset://cache/${key}`, hit };
    }),
    append: vi.fn(async () => {}), commit: vi.fn(async () => {}), release: vi.fn(async () => {}),
  };
  const props = { node: { type: 'image', src: 'photo.png', alt: 'photo' } } as React.ComponentProps<typeof MarkstreamImageNode>;
  await render(<MarkstreamImageNode key="A" {...props} />);
  const waitSource = async (index: number) => vi.waitFor(async () => {
    await act(async () => {});
    expect(host.querySelectorAll('img')[index]?.getAttribute('src')).toMatch(/^yuri-asset:\/\/cache\//);
  });
  await waitSource(0);
  const original = host.querySelector('img')!.getAttribute('src');
  await act(async () => host.querySelector('img')!.dispatchEvent(new Event('load')));
  expect(host.querySelector('[data-image-state]')?.getAttribute('data-image-state')).toBe('loaded');

  let finishStat!: (value: { isFile: boolean; size: number; mtimeMs: number }) => void;
  state.stat.mockImplementationOnce(() => new Promise(resolve => { finishStat = resolve; }));
  await render(<><MarkstreamImageNode key="A" {...props} /><MarkstreamImageNode key="fork" {...props} /></>);
  await vi.waitFor(() => expect(finishStat).toBeTypeOf('function'));
  expect(host.querySelectorAll('[data-image-state]')[1].getAttribute('data-image-state')).toBe('loading');
  expect(host.querySelectorAll('img')[1].getAttribute('src')).toBeNull();
  state.stat.mockResolvedValue({ isFile: true, size: IMAGE_BYTES, mtimeMs: 2 });
  await act(async () => finishStat({ isFile: true, size: IMAGE_BYTES, mtimeMs: 2 }));
  await waitSource(1);
  expect(host.querySelectorAll('img')[0].getAttribute('src')).toBe(original);
  expect(host.querySelectorAll('img')[1].getAttribute('src')).not.toBe(original);
  expect(new Set(keys).size).toBe(2);
  expect(state.fetch).toHaveBeenCalledTimes(2);

  await render(<p>Session B</p>);
  await render(<MarkstreamImageNode key="A-return" {...props} />);
  await waitSource(0);
  expect(state.fetch).toHaveBeenCalledTimes(2);
  expect(state.diskBridge.acquire).toHaveBeenCalledTimes(3);
  expect(keys[2]).toBe(keys[1]);
});

test('real fullscreen gallery A-B-A, reopen and owner restart share durable inline bytes', async () => {
  const bodies = [new Uint8Array(IMAGE_BYTES), new Uint8Array(IMAGE_BYTES).fill(1)];
  const hashes = await Promise.all(bodies.map(async (body) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', body)), (byte) => byte.toString(16).padStart(2, '0')).join('')));
  state.stat.mockImplementation(async (path: string) => ({ isFile: true, size: IMAGE_BYTES, mtimeMs: 1, sha256: hashes[path.endsWith('other.png') ? 1 : 0] }));
  state.fetch.mockImplementation(async (_url: string, options: { query: { path: string } }) => {
    state.bytes += IMAGE_BYTES;
    return new Response(bodies[options.query.path.endsWith('other.png') ? 1 : 0]);
  });
  const { default: ToolOutputDialog } = await import('./message/ToolOutputDialog');
  const popup = { open: true, title: 'Images', content: '', image: {
    url: '/workspace/photo.png', gallery: [{ url: '/workspace/photo.png' }, { url: '/workspace/other.png' }], index: 0,
  } };
  const ready = async () => {
    await vi.waitFor(async () => {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(document.querySelector('img')?.getAttribute('src')).toMatch(/^blob:/);
    });
  };
  await render(<Image id="inline" />);
  await ready();
  await render(<ToolOutputDialog popup={popup} isMobile={false} onOpenChange={() => {}} />);
  await ready();
  // Gallery switching left the toolbar for keyboard/swipe; keyboard paging is desktop-only,
  // so this case renders desktop while the cache assertions stay identical.
  const click = async (direction: string) => act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: direction === 'next' ? 'ArrowRight' : 'ArrowLeft', bubbles: true })));
  await click('next');
  await ready();
  await click('previous');
  await ready();
  expect(state.fetch).toHaveBeenCalledTimes(2);
  expect(state.durable.size).toBe(2);
  await render(null);
  await render(<ToolOutputDialog popup={popup} isMobile={false} onOpenChange={() => {}} />);
  await ready();
  expect(state.fetch).toHaveBeenCalledTimes(2);
  await render(null);
  clearRuntimeImageCacheLeases();
  await render(<ToolOutputDialog popup={popup} isMobile={false} onOpenChange={() => {}} />);
  await ready();
  console.info('gallery after owner restart', { requests: state.fetch.mock.calls.length, bytes: state.bytes });
  expect(state.fetch).toHaveBeenCalledTimes(2);
});

test('fork session relative paths reuse content across restart; different directories remain distinct', async () => {
  await fingerprintFixtures({ '/repo/photo.png': new Uint8Array([1, 2]), '/other/photo.png': new Uint8Array([3, 4]), '/copy/photo.png': new Uint8Array([1, 2]) });
  await render(<Image key="parent-session" id="parent" source="photo.png" directory="/repo" />);
  await readyImage();
  await render(null); clearRuntimeImageCacheLeases();
  await render(<Image key="fork-session" id="fork" source="./photo.png" directory="/repo" />);
  await readyImage();
  expect(state.fetch).toHaveBeenCalledTimes(1);
  await render(<Image key="other-session" id="other" source="photo.png" directory="/other" />);
  await readyImage();
  expect(state.fetch).toHaveBeenCalledTimes(2);
  await render(<Image key="copy-session" id="copy" source="photo.png" directory="/copy" />);
  await readyImage();
  expect(state.fetch).toHaveBeenCalledTimes(2);
  expect(state.durable.size).toBe(2);
});

test('content fingerprint updates invalidate equal-size equal-mtime files', async () => {
  await fingerprintFixtures({ '/workspace/photo.png': new Uint8Array([1, 2]) });
  await render(<Image id="first" />); await readyImage(); await render(null);
  await fingerprintFixtures({ '/workspace/photo.png': new Uint8Array([3, 4]) });
  await render(<Image id="changed" />); await readyImage();
  expect(state.fetch).toHaveBeenCalledTimes(2);
});

test('quota failure displays normally and retries persistence after owner recreation', async () => {
  await fingerprintFixtures({ '/workspace/photo.png': new Uint8Array([1, 2]) });
  state.durableWrite.mockRejectedValueOnce(new DOMException('Full', 'QuotaExceededError'));
  await render(<Image id="first" />); await readyImage();
  expect(state.durable.size).toBe(0);
  await render(null); clearRuntimeImageCacheLeases();
  await render(<Image id="retry" />); await readyImage();
  expect(state.durable.size).toBe(1);
  expect(state.fetch).toHaveBeenCalledTimes(2);
});

test('acquisition awaits the durable commit, and logout removes persisted bytes', async () => {
  await fingerprintFixtures({ '/workspace/photo.png': new Uint8Array([1, 2]) });
  let commit!: () => void;
  state.durableWrite.mockImplementationOnce((key: string, blob: Blob) => new Promise<void>((resolve) => {
    commit = () => { state.durable.set(key, blob); resolve(); };
  }));
  const pending = acquireRuntimeImage('/workspace/photo.png', new AbortController().signal);
  const settled = vi.fn(); void pending.then(settled);
  await vi.waitFor(() => expect(state.durableWrite).toHaveBeenCalled());
  expect(settled).not.toHaveBeenCalled();
  commit(); (await pending).release();
  expect(state.durable.size).toBe(1);
  for (const listener of state.authListeners) listener();
  await vi.waitFor(() => expect(state.durable.size).toBe(0));
});

test('native display release cannot abandon a completed body while its durable commit is pending', async () => {
  state.native = true;
  await fingerprintFixtures({ '/workspace/photo.png': new Uint8Array([1, 2]) });
  let commit!: () => void;
  let persistenceSignal!: AbortSignal;
  state.durableWrite.mockImplementationOnce((key: string, blob: Blob, signal: AbortSignal) => new Promise<void>((resolve) => {
    persistenceSignal = signal;
    commit = () => { state.durable.set(key, blob); resolve(); };
  }));
  const lease = await acquireRuntimeImage('/workspace/photo.png', new AbortController().signal);
  await vi.waitFor(() => expect(state.durableWrite).toHaveBeenCalled());
  lease.release();
  expect(persistenceSignal.aborted).toBe(false);
  commit();
  await vi.waitFor(() => expect(persistenceSignal.aborted).toBe(true));
  clearRuntimeImageCacheLeases();
  (await acquireRuntimeImage('/workspace/photo.png', new AbortController().signal)).release();
  expect(state.fetch).toHaveBeenCalledTimes(1);
});

test('a gallery keeps its originating directory when the active fork/worktree changes', async () => {
  const { default: ToolOutputDialog } = await import('./message/ToolOutputDialog');
  await fingerprintFixtures({ '/repo/photo.png': new Uint8Array([1, 2]), '/other/photo.png': new Uint8Array([3, 4]) });
  const popup = { open: true, title: 'Origin', content: '', image: { url: 'photo.png', directory: '/repo' } };
  await render(<ToolOutputDialog popup={popup} onOpenChange={() => {}} isMobile />);
  await readyImage();
  state.directory = '/other';
  await render(<ToolOutputDialog popup={{ ...popup, title: 'Still origin' }} onOpenChange={() => {}} isMobile />);
  await readyImage();
  expect(state.fetch).toHaveBeenCalledTimes(1);
  expect(state.stat).not.toHaveBeenCalledWith('/other/photo.png');
});
