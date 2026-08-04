import { afterEach, describe, expect, test } from 'bun:test';

import {
  NATIVE_RELAY_ASSET_BRIDGE_KEY,
  getNativeRelayAssetBridge,
  isNativeRelayAssetBridge,
  resetNativeRelayAssetBridgeCacheForTests,
  resolveNativeRelayAssetBridge,
} from './native-asset-bridge';

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[NATIVE_RELAY_ASSET_BRIDGE_KEY];
  resetNativeRelayAssetBridgeCacheForTests();
});

describe('isNativeRelayAssetBridge', () => {
  test('accepts a complete bridge shape', () => {
    expect(isNativeRelayAssetBridge({
      openAsset: async () => ({ assetId: 'a', url: 'u' }),
      writeChunk: async () => undefined,
      endAsset: async () => undefined,
      abortAsset: async () => undefined,
      releaseAsset: async () => undefined,
    })).toBe(true);
  });

  test('rejects partial objects', () => {
    expect(isNativeRelayAssetBridge(null)).toBe(false);
    expect(isNativeRelayAssetBridge({ openAsset: () => undefined })).toBe(false);
  });
});

describe('resolveNativeRelayAssetBridge', () => {
  test('prefers the explicit global install', async () => {
    const bridge = {
      openAsset: async () => ({ assetId: 'g', url: 'global-url' }),
      writeChunk: async () => undefined,
      endAsset: async () => undefined,
      abortAsset: async () => undefined,
      releaseAsset: async () => undefined,
    };
    (globalThis as Record<string, unknown>)[NATIVE_RELAY_ASSET_BRIDGE_KEY] = bridge;
    expect(getNativeRelayAssetBridge()).toBe(bridge);
    expect(await resolveNativeRelayAssetBridge()).toBe(bridge);
  });

  test('adapts Electron virtualAsset into the shared bridge shape', async () => {
    const created: Array<{ mimeType?: string }> = [];
    const pushes: Array<{ assetId: string; bytes: number }> = [];
    const finishes: string[] = [];
    const cancels: string[] = [];

    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const runtimeWindow = {
      __OPENCHAMBER_DESKTOP__: {
        virtualAsset: {
          create: async (options: { mimeType?: string }) => {
            created.push(options);
            return { assetId: 'electron-id-1', url: 'openchamber-asset://stream/electron-id-1', mimeType: options.mimeType };
          },
          push: async (assetId: string, chunk: Uint8Array) => {
            pushes.push({ assetId, bytes: chunk.byteLength });
            return { ok: true, queuedBytes: 0, totalBytes: chunk.byteLength };
          },
          finish: async (assetId: string) => {
            finishes.push(assetId);
            return { ok: true };
          },
          cancel: async (assetId: string) => {
            cancels.push(assetId);
            return { ok: true };
          },
        },
      },
    };
    Object.defineProperty(globalThis, 'window', { configurable: true, value: runtimeWindow });

    try {
      const bridge = await resolveNativeRelayAssetBridge();
      expect(bridge).not.toBeNull();
      const opened = await bridge!.openAsset({ assetId: 'suggested', mimeType: 'image/png' });
      expect(opened).toEqual({
        assetId: 'electron-id-1',
        url: 'openchamber-asset://stream/electron-id-1',
      });
      expect(created).toEqual([{ mimeType: 'image/png' }]);

      await bridge!.writeChunk('electron-id-1', new Uint8Array([1, 2, 3]));
      await bridge!.endAsset('electron-id-1');
      await bridge!.releaseAsset('electron-id-1');

      expect(pushes).toEqual([{ assetId: 'electron-id-1', bytes: 3 }]);
      expect(finishes).toEqual(['electron-id-1']);
      expect(cancels).toEqual(['electron-id-1']);
    } finally {
      if (previousWindow) {
        Object.defineProperty(globalThis, 'window', previousWindow);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });
});
