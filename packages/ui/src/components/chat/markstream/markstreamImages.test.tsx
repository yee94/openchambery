import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MarkstreamRenderer } from '../MarkstreamRendererImpl';

const { streamImage, releaseImage, showPopup, transport } = vi.hoisted(() => ({
  streamImage: vi.fn(), releaseImage: vi.fn(), showPopup: vi.fn(),
  transport: { identity: 'direct:http://lan-host' },
}));
vi.mock('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => '/workspace/project' }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: (selector: (state: { isMobile: boolean }) => unknown) => selector({ isMobile: true }) }));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ runtime: { isVSCode: false } }) }));
vi.mock('@/contexts/useThemeSystem', () => ({ useOptionalThemeSystem: () => undefined }));
vi.mock('@/lib/relay/relay-image-stream', () => ({
  streamRelayImageDisplayUrl: streamImage, releaseRelayImageDisplayUrl: releaseImage,
}));
vi.mock('@/lib/runtime-image-cache', () => ({
  acquireRuntimeImage: async (path: string, signal: AbortSignal) => {
    const url = await streamImage(path, signal);
    return { url, release: () => releaseImage(url) };
  },
}));
vi.mock('@/lib/runtime-switch', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/runtime-switch')>(),
  getRuntimeKey: () => 'image-test',
  getRuntimeTransportIdentity: () => transport.identity,
  subscribeRuntimeEndpointChanged: () => () => {},
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  streamImage.mockResolvedValue('blob:runtime-image');
  transport.identity = 'direct:http://lan-host';
});

test('mobile image reserves a loading canvas until the runtime URL and image bytes are ready', async () => {
  let resolve!: (url: string) => void;
  streamImage.mockReturnValue(new Promise<string>((done) => { resolve = done; }));
  await act(async () => root.render(<MarkstreamRenderer content="![photo](/workspace/photo.png)" messageId="pending-image" enableFileReferences={false} />));
  expect(host.querySelector('[data-image-state="loading"]')).not.toBeNull();
  expect(host.querySelector('img')?.style.opacity).toBe('0');
  await act(async () => resolve('blob:runtime-image'));
  expect(host.querySelector('[data-image-state="loading"]')).not.toBeNull();
  await act(async () => host.querySelector('img')!.dispatchEvent(new Event('load')));
  expect(host.querySelector('[data-image-state="loaded"]')).not.toBeNull();
  expect(host.querySelector('img')?.style.opacity).not.toBe('0');
});

test('mobile runtime image failure ends loading without exposing a broken image', async () => {
  streamImage.mockRejectedValue(new Error('Unavailable'));
  await act(async () => root.render(<MarkstreamRenderer content="![photo](/workspace/photo.png)" messageId="failed-image" enableFileReferences={false} />));
  expect(host.querySelector('[data-image-state="error"]')).not.toBeNull();
  expect(host.querySelector('[data-image-state="loading"]')).toBeNull();
  expect(host.querySelector('img')?.style.opacity).toBe('0');
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

test.each(['/workspace/photo.png', 'assets/photo.png'])(
  'Markstream streams %s through the runtime and opens the original source', async (source) => {
    await act(async () => root.render(<MarkstreamRenderer content={`![photo](${source})`} messageId="images" enableFileReferences={false} onShowPopup={showPopup} />));
    expect(streamImage).toHaveBeenCalledWith(
      source === 'assets/photo.png' ? '/workspace/project/assets/photo.png' : '/workspace/photo.png',
      expect.any(AbortSignal),
    );
    const image = host.querySelector('img')!;
    expect(image.getAttribute('src')).toBe('blob:runtime-image');
    await act(async () => image.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ image: expect.objectContaining({ url: source }) }));
    await act(async () => root.render(null));
    expect(releaseImage).toHaveBeenCalledWith('blob:runtime-image');
  },
);

test('relay/native image keeps its original source for keyboard preview', async () => {
  transport.identity = 'relay:test-host';
  streamImage.mockResolvedValue('openchamber-asset://image/asset');
  await act(async () => root.render(<MarkstreamRenderer content="![photo](/workspace/photo.png)" messageId="relay-image" enableFileReferences={false} onShowPopup={showPopup} />));
  const image = host.querySelector('img')!;
  expect(image.getAttribute('src')).toBe('openchamber-asset://image/asset');
  await act(async () => image.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ image: expect.objectContaining({ url: '/workspace/photo.png' }) }));
});

test('remote images remain direct and a display error does not remove the preview target', async () => {
  const source = 'https://example.com/photo.png';
  await act(async () => root.render(<MarkstreamRenderer content={`![photo](${source})`} messageId="external-image" enableFileReferences={false} onShowPopup={showPopup} />));
  const image = host.querySelector('img')!;
  expect(image.getAttribute('src')).toBe(source);
  expect(streamImage).not.toHaveBeenCalled();
  await act(async () => image.dispatchEvent(new Event('error')));
  expect(host.querySelector('img')).toBe(image);
  await act(async () => image.click());
  expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ image: expect.objectContaining({ url: source }) }));
});
