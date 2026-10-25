import { afterEach, expect, test, vi } from 'vitest';
import { saveImageToDevice } from './imageSave';
import { streamVerifiedBlobDisplayUrl, releaseRelayImageDisplayUrl } from '@/lib/relay/relay-image-stream';
import { NATIVE_RELAY_ASSET_BRIDGE_KEY } from '@/lib/relay/native-asset-bridge';

const native = vi.hoisted(() => ({ saveImage: vi.fn() }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isPluginAvailable: () => true }, registerPlugin: () => native }));
vi.mock('@/lib/platform', () => ({ isCapacitorApp: () => true }));
vi.mock('@/lib/runtime-switch', () => ({ getRuntimeTransportIdentity: () => 'relay:test', subscribeRuntimeEndpointChanged: () => () => {} }));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test('saving an already displayed iOS one-use image uses its original bytes, not a second scheme read', async () => {
  vi.stubGlobal(NATIVE_RELAY_ASSET_BRIDGE_KEY, {
    openAsset: async ({ assetId }: { assetId: string }) => ({ assetId, url: `openchamber-asset://v/${assetId}` }),
    writeChunk: async () => {}, endAsset: async () => {}, abortAsset: async () => {}, releaseAsset: async () => {},
  });
  const blob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
  const url = await streamVerifiedBlobDisplayUrl(blob, new AbortController().signal);
  const fetch = vi.fn().mockRejectedValue(new TypeError('WKURLSchemeHandler asset has already been consumed'));
  vi.stubGlobal('fetch', fetch);
  try {
    await expect(saveImageToDevice({ sourceUrl: url, displayUrl: url, filename: 'photo.png' })).resolves.toBe('saved');
    expect(fetch).not.toHaveBeenCalled();
    expect(native.saveImage).toHaveBeenCalledWith(expect.objectContaining({ dataBase64: 'iVBORw==' }));
  } finally { releaseRelayImageDisplayUrl(url); }
});
