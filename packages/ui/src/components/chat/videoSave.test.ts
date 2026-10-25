import { afterEach, expect, test, vi } from 'vitest';
import { materializeImageBlob, saveImageToDevice } from './imageSave';

const mocks = vi.hoisted(() => ({ saveFile: vi.fn(), saveImage: vi.fn(), fetch: vi.fn() }));
vi.mock('@capacitor/core', () => ({
  Capacitor: { isPluginAvailable: () => true },
  registerPlugin: () => ({ saveFile: mocks.saveFile, saveImage: mocks.saveImage }),
}));
vi.mock('@/lib/platform', () => ({ isCapacitorApp: () => true }));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: mocks.fetch }));
afterEach(() => vi.clearAllMocks());

test('native video save preserves original bytes and uses the document picker, not Photos image decoding', async () => {
  mocks.saveFile.mockResolvedValue({ cancelled: false });
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'video/quicktime' });
  await expect(saveImageToDevice({ kind: 'video', sourceUrl: 'blob:clip', prefetchedBlob: blob })).resolves.toBe('saved');
  expect(mocks.saveFile).toHaveBeenCalledWith({ dataBase64: 'AQID', mimeType: 'video/quicktime', filename: 'video.mov' });
  expect(mocks.saveImage).not.toHaveBeenCalled();
});

test('native picker cancellation is not reported as successful saving', async () => {
  mocks.saveFile.mockResolvedValue({ cancelled: true });
  await expect(saveImageToDevice({ kind: 'video', sourceUrl: 'blob:clip', prefetchedBlob: new Blob(['v'], { type: 'video/mp4' }) })).rejects.toMatchObject({ name: 'AbortError' });
});

test('runtime video download uses authenticated raw-file bytes and preserves the MIME', async () => {
  mocks.fetch.mockResolvedValue(new Response(new Blob(['video'], { type: 'video/webm' })));
  const result = await materializeImageBlob({ kind: 'video', sourceUrl: 'file:///workspace/clip.webm', filename: 'clip' });
  expect(result.mimeType).toBe('video/webm');
  expect(result.filename).toBe('clip.webm');
  expect(mocks.fetch).toHaveBeenCalledWith('/api/fs/raw', expect.objectContaining({ query: { path: '/workspace/clip.webm' } }));
});

test('video save reports byte percentages over a full Range response before native saving', async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  mocks.fetch.mockResolvedValue(new Response(new ReadableStream({ start(controller) { stream = controller; } }), {
    status: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-3/4' },
  }));
  mocks.saveFile.mockResolvedValue({ cancelled: false });
  const progress = vi.fn();
  const saved = saveImageToDevice({ kind: 'video', sourceUrl: 'file:///workspace/clip.mp4' }, undefined, progress);
  stream.enqueue(new Uint8Array([1, 2]));
  await vi.waitFor(() => expect(progress).toHaveBeenLastCalledWith(50));
  expect(mocks.saveFile).not.toHaveBeenCalled();
  stream.enqueue(new Uint8Array([3, 4])); stream.close();
  await expect(saved).resolves.toBe('saved');
  expect(progress).toHaveBeenLastCalledWith(100);
  expect(mocks.fetch).toHaveBeenCalledWith('/api/fs/raw', expect.objectContaining({ headers: { Range: 'bytes=0-' } }));
  expect(mocks.saveFile).toHaveBeenCalledWith(expect.objectContaining({ dataBase64: 'AQIDBA==' }));
});
