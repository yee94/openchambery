import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { VideoPreviewDialog } from './VideoPreviewDialog';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), save: vi.fn(), native: vi.fn().mockResolvedValue(null), relay: true }));
vi.mock('@/lib/relay/runtime-tunnel', () => ({ isRelayModeActive: () => mocks.relay }));
vi.mock('@/contexts/runtimeAPIRegistry', () => ({ getRegisteredRuntimeAPIs: () => ({ files: { statFile: async () => ({ size: 5, isFile: true }) } }) }));
vi.mock('@/lib/runtime-file-resource', () => ({
  readRuntimeFileBlob: async ({ path, signal }: { path: string; signal: AbortSignal }) => {
    const response = await mocks.fetch('/api/fs/raw', { query: { path }, signal });
    if (!response.ok) throw new Error('File request failed');
    return response.blob();
  },
  readFileResourceUrl: async (url: string, signal: AbortSignal) => (await mocks.fetch(url, { signal })).blob(),
}));
vi.mock('@/lib/runtime-file-download', () => ({ fileResourceBrowserUrl: async (route: string, query: Record<string, string>) => `${route}?${new URLSearchParams(query)}` }));
vi.mock('@/lib/runtime-auth', () => ({ acquireRuntimeUrlAuthToken: () => () => {}, refreshRuntimeUrlAuthToken: async () => '', subscribeRuntimeUrlAuthToken: () => () => {}, getRuntimeAuthGeneration: () => 0, subscribeRuntimeAuthGeneration: () => () => {} }));
vi.mock('@/lib/runtime-url', () => ({ getRuntimeUrlResolver: () => ({ authenticatedAsset: (route: string, query: Record<string, string>) => `${route}?${new URLSearchParams(query)}` }) }));
vi.mock('@/lib/native-video', () => ({ openNativeVideoSource: mocks.native }));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: mocks.fetch }));
vi.mock('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => '/workspace' }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('../imageSave', () => ({ saveImageToDevice: mocks.save }));
vi.mock('../imageSource', async (original) => ({ ...await original<typeof import('../imageSource')>(), useRuntimeTransportIdentity: () => 'test-runtime' }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.relay = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear(); host.remove(); vi.useRealTimers(); vi.restoreAllMocks();
});
async function render(url: string, directory?: string) {
  await act(async () => root.render(<QueryClientProvider client={client}>
    <VideoPreviewDialog video={{ url, directory, filename: 'clip.mp4', mimeType: 'video/mp4' }} onClose={() => {}} isMobile />
  </QueryClientProvider>));
}

test('native playback stays user-initiated and only the download icon saves the original video', async () => {
  vi.useFakeTimers();
  await render('https://example.com/clip.mp4');
  const video = host.querySelector('video')!;
  expect(video.controls).toBe(true);
  expect(video.hasAttribute('playsinline')).toBe(true);
  expect(video.autoplay).toBe(false);
  expect(mocks.fetch).not.toHaveBeenCalled();
  await act(async () => {
    video.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, isPrimary: true, pointerType: 'touch', button: 0 }));
    vi.advanceTimersByTime(500);
  });
  expect(mocks.save).not.toHaveBeenCalled();
  const download = host.querySelector<HTMLButtonElement>('[data-media-save]')!;
  expect(download.textContent).toBe('');
  await act(async () => download.click());
  expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ kind: 'video', sourceUrl: 'https://example.com/clip.mp4' }), expect.any(AbortSignal), expect.any(Function));
  expect(download.dataset.mediaSave).toBe('saved');
});

test('video gestures never trigger saving', async () => {
  vi.useFakeTimers();
  await render('https://example.com/clip.mp4');
  const video = host.querySelector('video')!;
  await act(async () => {
    video.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, isPrimary: true, button: 0 }));
    video.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: 50 }));
    vi.advanceTimersByTime(500);
  });
  expect(mocks.save).not.toHaveBeenCalled();
});

test('runtime file playback leases bytes and revokes its object URL when switching sources', async () => {
  const blob = new Blob(['video'], { type: 'video/mp4' });
  mocks.fetch.mockResolvedValue(new Response(blob));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:video-test');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  await render('file:///workspace/clip.mp4');
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(mocks.fetch).toHaveBeenCalledWith('/api/fs/raw', expect.objectContaining({ query: { path: '/workspace/clip.mp4' }, signal: expect.any(AbortSignal) }));
  expect(host.querySelector('video')?.src).toBe('blob:video-test');
  await render('https://example.com/next.mp4');
  expect(revoke).toHaveBeenCalledWith('blob:video-test');
  expect(host.querySelector('video')?.src).toBe('https://example.com/next.mp4');
});

test('request failure shows an error and retains the download action', async () => {
  mocks.fetch.mockResolvedValue(new Response('', { status: 403 }));
  await render('file:///workspace/clip.mp4');
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  expect(host.querySelector('video')).toBeNull();
  expect(host.querySelector('[data-media-save]')?.getAttribute('aria-label')).toBe('filesView.editor.saveFile');
});

test('runtime video exposes a playback URL before the complete response body arrives', async () => {
  const release = vi.fn();
  mocks.native.mockResolvedValueOnce({ url: 'http://127.0.0.1:12345/opaque-video', release });
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([0, 0, 0, 24])); } });
  mocks.fetch.mockResolvedValue(new Response(body, { headers: { 'content-type': 'video/mp4' } }));
  await render('file:///workspace/clip.mp4');
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(host.querySelector('video')?.getAttribute('src')).toBeTruthy();
  expect(mocks.fetch).not.toHaveBeenCalled();
  await render('https://example.com/next.mp4');
  expect(release).toHaveBeenCalled();
});

test('direct runtime video uses an authenticated streaming URL without buffering the body', async () => {
  mocks.relay = false;
  await render('file:///workspace/large.mp4');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(host.querySelector('video')?.getAttribute('src')).toBe('/api/fs/raw?path=%2Fworkspace%2Flarge.mp4');
  expect(mocks.fetch).not.toHaveBeenCalled();
});

test('relative video and save retain the originating worktree while the active directory differs', async () => {
  mocks.relay = false;
  await render('./clip.mp4', '/original-worktree');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(host.querySelector('video')?.getAttribute('src')).toBe('/api/fs/raw?path=%2Foriginal-worktree%2Fclip.mp4');
  await act(async () => host.querySelector<HTMLButtonElement>('[data-media-save]')!.click());
  expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ effectiveDirectory: '/original-worktree' }), expect.any(AbortSignal), expect.any(Function));
});

test('browser Relay playback above the retention budget keeps the uncached Blob compatibility path', async () => {
  const blob = new Blob([new Uint8Array(33 * 1024 * 1024)], { type: 'video/mp4' });
  mocks.fetch.mockResolvedValue(new Response(blob));
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:large-video');
  await render('/workspace/large.mp4');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(host.querySelector('video')?.getAttribute('src')).toBe('blob:large-video');
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ size: blob.size }));
});
