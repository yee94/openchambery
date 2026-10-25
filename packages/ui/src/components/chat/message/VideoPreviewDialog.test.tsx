import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { VideoPreviewDialog } from './VideoPreviewDialog';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), save: vi.fn(), native: vi.fn().mockResolvedValue(null) }));
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
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear(); host.remove(); vi.useRealTimers(); vi.restoreAllMocks();
});
async function render(url: string) {
  await act(async () => root.render(<QueryClientProvider client={client}>
    <VideoPreviewDialog video={{ url, filename: 'clip.mp4', mimeType: 'video/mp4' }} onClose={() => {}} isMobile />
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
  expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ kind: 'video', sourceUrl: 'https://example.com/clip.mp4' }), expect.any(AbortSignal));
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
