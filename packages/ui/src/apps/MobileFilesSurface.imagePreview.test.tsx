import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MobileFilesSurface } from './MobileFilesSurface';
import { resetRelayImageStreamForTests } from '@/lib/relay/relay-image-stream';

const state = vi.hoisted(() => ({
  fetch: vi.fn(), open: vi.fn(), write: vi.fn(), end: vi.fn(), release: vi.fn(), abort: vi.fn(),
  showPopup: vi.fn(),
  t: (key: string) => key,
  native: true,
}));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: state.fetch }));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => 'relay:mobile-test', getRuntimeGeneration: () => 0,
  getRuntimeKey: () => 'mobile-test',
  getRuntimeApiBaseUrl: () => 'http://unreachable-host', subscribeRuntimeEndpointChanged: () => () => {},
}));
vi.mock('@/lib/runtime-auth', () => ({
  getRuntimeAuthGeneration: () => 0, getRuntimeBearerTokenSync: () => '', subscribeRuntimeAuthGeneration: () => () => {},
  acquireRuntimeUrlAuthToken: vi.fn(), refreshRuntimeUrlAuthToken: vi.fn(), subscribeRuntimeUrlAuthToken: () => () => {},
}));
vi.mock('@/lib/relay/native-asset-bridge', () => ({
  getNativeImageCacheBridge: () => null,
  resolveNativeRelayAssetBridge: async () => state.native ? ({ openAsset: state.open, writeChunk: state.write, endAsset: state.end, releaseAsset: state.release, abortAsset: state.abort }) : null,
}));
vi.mock('@/lib/relay/runtime-tunnel', () => ({ isRelayModeActive: () => true }));
vi.mock('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => '/workspace' }));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ files: { readFile: vi.fn() } }) }));
vi.mock('@/queries/fileQueries', () => ({
  useFileDirectoryQuery: () => ({}), useFileSearchQuery: () => ({}), useFileContentQuery: () => ({}), useFileStatWatcher: () => {},
}));
vi.mock('@/mobile/mobileBackNavigation', () => ({ useMobileBackRoute: () => {} }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: (select: (s: unknown) => unknown) => select({ pendingFileFocusPath: null, setPendingFileFocusPath: () => {} }) }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: state.t }) }));
vi.mock('@/components/ui', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/chat/message/TextSelectionMenu', () => ({ TextSelectionMenu: () => null }));
vi.mock('@/components/views/PierreDiffViewer', () => ({ PIERRE_RUNTIME_BASE_CSS: '' }));
vi.mock('@pierre/diffs/react', () => ({ File: () => null }));
vi.mock('@/contexts/useThemeSystem', () => ({ useThemeSystem: () => ({ currentTheme: { metadata: { variant: 'light' } }, availableThemes: [] }) }));
vi.mock('@/lib/shiki/appThemeRegistry', () => ({ ensurePierreThemeRegistered: () => {} }));
vi.mock('@/components/ui/ScrollShadow', () => ({ ScrollShadow: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/ui/MobileResizableSheet', () => ({ MobileSheetHeaderActions: () => null }));
vi.mock('@/components/chat/message/ToolOutputDialog', async () => {
  const { useResolvedImageSource } = await import('@/components/chat/imageSource');
  return { default: function PreviewDialog({ popup }: { popup: { image: { url: string } } }) {
    state.showPopup(popup);
    const source = useResolvedImageSource(popup.image.url, '/workspace', 'preview');
    return <img data-test-fullscreen src={source || undefined} />;
  } };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  state.native = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  state.fetch.mockImplementation(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }));
  let id = 0;
  state.open.mockImplementation(async () => ({ assetId: `native-${++id}`, url: `openchamber-asset://v/native-${id}` }));
  state.write.mockResolvedValue(undefined); state.end.mockResolvedValue(undefined);
  state.release.mockResolvedValue(undefined); state.abort.mockResolvedValue(undefined);
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:wrong-path');
});

test('a failed image request is shown as an error rather than a broken image', async () => {
  state.fetch.mockResolvedValue(new Response('missing', { status: 404 }));
  await act(async () => root.render(<MobileFilesSurface initialFilePath="/workspace/missing.png" directFilePreview hideFileHeader />));
  expect(host.querySelector('img')).toBeNull();
  expect(host.textContent).toContain('404');
  expect(state.open).not.toHaveBeenCalled();
});

test('native image decode failure replaces the broken image with the existing error state', async () => {
  await act(async () => root.render(<MobileFilesSurface initialFilePath="/workspace/broken.png" directFilePreview hideFileHeader />));
  await act(async () => host.querySelector('img')!.dispatchEvent(new Event('error')));
  expect(host.querySelector('img')).toBeNull();
  expect(host.textContent).toContain('filesView.error.readFileFailed');
});

test('an explicit browser-only preview can fall back to an object URL', async () => {
  state.native = false;
  await act(async () => root.render(<MobileFilesSurface initialFilePath="/workspace/photo.png" directFilePreview hideFileHeader />));
  expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:wrong-path');
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); resetRelayImageStreamForTests();
  vi.restoreAllMocks(); vi.clearAllMocks();
});
test('mobile relay file detail and clicked fullscreen use native streams, never browser asset URLs or Blob', async () => {
  await act(async () => root.render(<MobileFilesSurface initialFilePath="/workspace/icons-zoom.png" directFilePreview hideFileHeader />));
  const image = host.querySelector('img')!;
  expect(image?.getAttribute('src')).toMatch(/^openchamber-asset:\/\//);
  expect(state.fetch).toHaveBeenCalledWith('/api/fs/raw', expect.objectContaining({ query: { path: '/workspace/icons-zoom.png' }, signal: expect.any(AbortSignal) }));
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  await act(async () => image.closest('button')!.click());
  await vi.waitFor(() => expect(host.querySelector('[data-test-fullscreen]')?.getAttribute('src')).toMatch(/^openchamber-asset:\/\//));
  expect(state.open).toHaveBeenCalledTimes(2);
  expect(state.showPopup).toHaveBeenCalledWith(expect.objectContaining({ image: expect.objectContaining({ url: '/workspace/icons-zoom.png' }) }));
  await act(async () => root.render(null));
  expect(state.release).toHaveBeenCalledTimes(2);
});
