/**
 * Shared contract for native preload / Capacitor bridges that materialize a
 * browser-consumable virtual URL from renderer-owned Relay image bytes.
 *
 * The renderer keeps transport credentials and host paths. Native code only
 * receives an opaque assetId, a MIME type, and bounded binary chunks.
 *
 * Native shells may install a compatible object on globalThis under
 * NATIVE_RELAY_ASSET_BRIDGE_KEY. When absent, resolveNativeRelayAssetBridge()
 * also adapts the existing Electron desktop virtualAsset API and the Capacitor
 * OpenChamberVirtualAsset plugin — without importing electron/ or mobile/ packages.
 */

export const NATIVE_RELAY_ASSET_BRIDGE_KEY = '__openchamberNativeRelayAssetBridge' as const;

export type NativeRelayAssetOpenOptions = {
  /**
   * Opaque one-use id suggested by the renderer.
   * Native may mint a different id; openAsset must return the authoritative assetId.
   */
  assetId: string;
  mimeType: string;
};

export type NativeRelayAssetOpenResult = {
  /** Authoritative id for writeChunk / end / abort / release. */
  assetId: string;
  /** Browser-consumable URL for img.src. */
  url: string;
};

/**
 * Native-side bridge. All methods may be sync or async.
 * - openAsset: allocate storage / protocol mapping; return authoritative id + URL
 * - writeChunk: append the next bounded body chunk (await to apply backpressure)
 * - endAsset: mark the stream complete so the URL can finish loading
 * - abortAsset: cancel an in-flight stream (reader abort, transport teardown)
 * - releaseAsset: drop the virtual URL / free native buffers when the UI is done
 */
export type NativeRelayAssetBridge = {
  openAsset: (options: NativeRelayAssetOpenOptions) => NativeRelayAssetOpenResult | Promise<NativeRelayAssetOpenResult>;
  writeChunk: (assetId: string, chunk: Uint8Array) => void | Promise<void>;
  endAsset: (assetId: string) => void | Promise<void>;
  abortAsset: (assetId: string, reason?: string) => void | Promise<void>;
  releaseAsset: (assetId: string) => void | Promise<void>;
};

type GlobalWithBridge = typeof globalThis & {
  [NATIVE_RELAY_ASSET_BRIDGE_KEY]?: unknown;
};

const isFunction = (value: unknown): value is (...args: never[]) => unknown => typeof value === 'function';

export const isNativeRelayAssetBridge = (value: unknown): value is NativeRelayAssetBridge => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    isFunction(candidate.openAsset)
    && isFunction(candidate.writeChunk)
    && isFunction(candidate.endAsset)
    && isFunction(candidate.abortAsset)
    && isFunction(candidate.releaseAsset)
  );
};

/** Returns a bridge installed on the global key, or null. */
export const getNativeRelayAssetBridge = (): NativeRelayAssetBridge | null => {
  const value = (globalThis as GlobalWithBridge)[NATIVE_RELAY_ASSET_BRIDGE_KEY];
  return isNativeRelayAssetBridge(value) ? value : null;
};

// ── Platform adapters (existing preload / Capacitor surfaces) ───────────────

type DesktopVirtualAssetApi = {
  create: (options: { mimeType?: string }) => Promise<{ assetId: string; url: string; mimeType?: string }>;
  push: (assetId: string, chunk: ArrayBuffer | Uint8Array) => Promise<unknown>;
  finish: (assetId: string) => Promise<unknown>;
  cancel: (assetId: string) => Promise<unknown>;
};

type CapacitorVirtualAssetPlugin = {
  create: (options: { assetId: string; mime: string }) => Promise<{ assetId: string; url: string }>;
  append: (options: { assetId: string; chunk: string }) => Promise<void>;
  finish: (options: { assetId: string }) => Promise<void>;
  cancel: (options: { assetId: string }) => Promise<void>;
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.byteLength));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
};

const adaptDesktopVirtualAsset = (api: DesktopVirtualAssetApi): NativeRelayAssetBridge => ({
  openAsset: async ({ mimeType }) => {
    const result = await api.create({ mimeType });
    if (!result?.assetId || !result?.url) {
      throw new Error('Desktop virtualAsset.create returned an incomplete result');
    }
    return { assetId: result.assetId, url: result.url };
  },
  writeChunk: async (assetId, chunk) => {
    // Copy into a standalone buffer so the IPC structured-clone path is safe.
    const copy = chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength
      ? chunk
      : chunk.slice();
    await api.push(assetId, copy);
  },
  endAsset: async (assetId) => {
    await api.finish(assetId);
  },
  abortAsset: async (assetId) => {
    try {
      await api.cancel(assetId);
    } catch {
      // cancel is best-effort after errors
    }
  },
  releaseAsset: async (assetId) => {
    try {
      await api.cancel(assetId);
    } catch {
      // already finished/cancelled
    }
  },
});

const adaptCapacitorVirtualAsset = (plugin: CapacitorVirtualAssetPlugin): NativeRelayAssetBridge => ({
  openAsset: async ({ assetId, mimeType }) => {
    const result = await plugin.create({ assetId, mime: mimeType });
    if (!result?.url) {
      throw new Error('Capacitor virtual asset create returned no url');
    }
    return { assetId: result.assetId || assetId, url: result.url };
  },
  writeChunk: async (assetId, chunk) => {
    await plugin.append({ assetId, chunk: bytesToBase64(chunk) });
  },
  endAsset: async (assetId) => {
    await plugin.finish({ assetId });
  },
  abortAsset: async (assetId) => {
    try {
      await plugin.cancel({ assetId });
    } catch {
      // best-effort
    }
  },
  releaseAsset: async (assetId) => {
    try {
      await plugin.cancel({ assetId });
    } catch {
      // already finished/cancelled
    }
  },
});

const readDesktopVirtualAsset = (): DesktopVirtualAssetApi | null => {
  if (typeof window === 'undefined') return null;
  const desktop = (window as unknown as {
    __OPENCHAMBER_DESKTOP__?: { virtualAsset?: Partial<DesktopVirtualAssetApi> };
  }).__OPENCHAMBER_DESKTOP__;
  const api = desktop?.virtualAsset;
  if (
    !api
    || !isFunction(api.create)
    || !isFunction(api.push)
    || !isFunction(api.finish)
    || !isFunction(api.cancel)
  ) {
    return null;
  }
  return api as DesktopVirtualAssetApi;
};

let capacitorPluginPromise: Promise<CapacitorVirtualAssetPlugin | null> | null = null;

const loadCapacitorVirtualAssetPlugin = async (): Promise<CapacitorVirtualAssetPlugin | null> => {
  if (typeof window === 'undefined') return null;
  const cap = (window as unknown as {
    Capacitor?: { isNativePlatform?: () => boolean; Plugins?: Record<string, unknown> };
  }).Capacitor;
  if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) {
    return null;
  }

  // Prefer the already-registered plugin instance when present (no import needed).
  const existing = cap.Plugins?.OpenChamberVirtualAsset;
  if (
    existing
    && typeof existing === 'object'
    && isFunction((existing as CapacitorVirtualAssetPlugin).create)
    && isFunction((existing as CapacitorVirtualAssetPlugin).append)
    && isFunction((existing as CapacitorVirtualAssetPlugin).finish)
    && isFunction((existing as CapacitorVirtualAssetPlugin).cancel)
  ) {
    return existing as CapacitorVirtualAssetPlugin;
  }

  // Lazy registerPlugin — same pattern as other mobile UI bridges.
  try {
    const { registerPlugin } = await import('@capacitor/core');
    const plugin = registerPlugin<CapacitorVirtualAssetPlugin>('OpenChamberVirtualAsset');
    if (
      isFunction(plugin.create)
      && isFunction(plugin.append)
      && isFunction(plugin.finish)
      && isFunction(plugin.cancel)
    ) {
      return plugin;
    }
  } catch {
    // Web / missing native implementation
  }
  return null;
};

/**
 * Resolve the active native bridge:
 * 1. Explicit global install (NATIVE_RELAY_ASSET_BRIDGE_KEY)
 * 2. Electron local-page virtualAsset API
 * 3. Capacitor OpenChamberVirtualAsset plugin
 */
export const resolveNativeRelayAssetBridge = async (): Promise<NativeRelayAssetBridge | null> => {
  const installed = getNativeRelayAssetBridge();
  if (installed) return installed;

  const desktop = readDesktopVirtualAsset();
  if (desktop) return adaptDesktopVirtualAsset(desktop);

  capacitorPluginPromise ??= loadCapacitorVirtualAssetPlugin();
  const plugin = await capacitorPluginPromise;
  if (plugin) return adaptCapacitorVirtualAsset(plugin);

  return null;
};

/** Test helper: drop the cached Capacitor plugin probe. */
export const resetNativeRelayAssetBridgeCacheForTests = (): void => {
  capacitorPluginPromise = null;
};
