/**
 * Renderer-owned Relay image stream service.
 *
 * Fetches host file bytes through runtimeFetch('/api/fs/raw') (tunnel-transparent),
 * then either:
 * - openAsset → return virtual URL immediately; background reader writeChunk/endAsset, or
 * - falls back to Blob / object URL when no bridge is installed.
 *
 * Transport keys and file paths never leave the renderer.
 */

import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeTransportIdentity, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

import {
  resolveNativeRelayAssetBridge,
  type NativeRelayAssetBridge,
} from './native-asset-bridge';

/** Per-asset lifetime before automatic abort/release if the UI never cleans up. */
export const RELAY_IMAGE_ASSET_TTL_MS = 5 * 60_000;

/**
 * Hard cap on a single image body (bytes). Kept at or below the mobile native
 * ceiling (32 MiB) so the renderer aborts before native rejects.
 */
export const RELAY_IMAGE_MAX_BYTES = 32 * 1024 * 1024;

/** Max concurrent in-flight native (or tracked) image streams for backpressure. */
export const RELAY_IMAGE_MAX_CONCURRENT = 6;

type TrackedAsset = {
  assetId: string;
  url: string;
  kind: 'native' | 'blob';
  transportIdentity: string;
  ttlTimer: ReturnType<typeof setTimeout> | null;
  released: boolean;
  byteLength: number;
  bridge: NativeRelayAssetBridge | null;
};

const assetsByUrl = new Map<string, TrackedAsset>();
const assetsById = new Map<string, TrackedAsset>();
/** Asset ids currently streaming (after open) or reserved before open. */
const inFlight = new Set<string>();
/** Reservations that have not yet received an authoritative assetId. */
let pendingOpenCount = 0;

let transportUnsubscribe: (() => void) | null = null;
let nextAssetSerial = 0;

const concurrentLoadCount = (): number => inFlight.size + pendingOpenCount;

const mintAssetId = (): string => {
  nextAssetSerial += 1;
  // Mobile native accepts ^[A-Za-z0-9_-]{8,80}$; stay well under 80 chars.
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  return `ria_${random.replace(/-/g, '').slice(0, 24)}_${(nextAssetSerial % 1e6).toString(36)}`;
};

const clearTtl = (asset: TrackedAsset): void => {
  if (asset.ttlTimer !== null) {
    clearTimeout(asset.ttlTimer);
    asset.ttlTimer = null;
  }
};

const untrack = (asset: TrackedAsset): void => {
  clearTtl(asset);
  assetsByUrl.delete(asset.url);
  assetsById.delete(asset.assetId);
  inFlight.delete(asset.assetId);
};

const safeCall = async (run: () => void | Promise<void>): Promise<void> => {
  try {
    await run();
  } catch {
    // Native teardown is best-effort; renderer state is the source of truth.
  }
};

const releaseTrackedAsset = async (
  asset: TrackedAsset,
  options: { abort?: boolean; reason?: string } = {},
): Promise<void> => {
  if (asset.released) return;
  asset.released = true;
  untrack(asset);

  if (asset.kind === 'blob') {
    try {
      URL.revokeObjectURL(asset.url);
    } catch {
      // ignore
    }
    return;
  }

  const bridge = asset.bridge;
  if (!bridge) return;
  if (options.abort) {
    await safeCall(() => bridge.abortAsset(asset.assetId, options.reason));
  }
  await safeCall(() => bridge.releaseAsset(asset.assetId));
};

const armTtl = (asset: TrackedAsset): void => {
  clearTtl(asset);
  asset.ttlTimer = setTimeout(() => {
    void releaseTrackedAsset(asset, { abort: true, reason: 'ttl-expired' });
  }, RELAY_IMAGE_ASSET_TTL_MS);
};

const waitForConcurrencySlot = async (signal: AbortSignal): Promise<void> => {
  while (concurrentLoadCount() >= RELAY_IMAGE_MAX_CONCURRENT) {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, 25);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
};

/** Atomically wait for and reserve one concurrent open slot. */
const acquireOpenSlot = async (signal: AbortSignal): Promise<void> => {
  for (;;) {
    await waitForConcurrencySlot(signal);
    if (concurrentLoadCount() < RELAY_IMAGE_MAX_CONCURRENT) {
      pendingOpenCount += 1;
      return;
    }
  }
};

const releaseOpenSlot = (): void => {
  pendingOpenCount = Math.max(0, pendingOpenCount - 1);
};

const resolveMimeType = (response: Response): string => {
  const raw = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (raw && raw.startsWith('image/')) return raw;
  // Electron virtual assets reject non-image MIME; default conservatively.
  return 'image/png';
};

const streamToNativeBridge = async (
  bridge: NativeRelayAssetBridge,
  response: Response,
  signal: AbortSignal,
  transportIdentity: string,
): Promise<string> => {
  await acquireOpenSlot(signal);
  if (signal.aborted) {
    releaseOpenSlot();
    throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
  }

  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    releaseOpenSlot();
    throw new Error('Image response body is not readable');
  }

  const suggestedId = mintAssetId();
  const mimeType = resolveMimeType(response);
  let opened: { assetId: string; url: string };
  try {
    opened = await bridge.openAsset({ assetId: suggestedId, mimeType });
  } catch (error) {
    releaseOpenSlot();
    throw error;
  }

  if (!opened?.url || typeof opened.url !== 'string' || !opened.assetId) {
    releaseOpenSlot();
    await safeCall(() => bridge.abortAsset(suggestedId, 'invalid-open'));
    throw new Error('Native asset bridge returned an incomplete open result');
  }

  // Convert pending open reservation into an in-flight id reservation.
  // Add inFlight first so concurrentLoadCount never dips and leaks a slot.
  inFlight.add(opened.assetId);
  releaseOpenSlot();

  const asset: TrackedAsset = {
    assetId: opened.assetId,
    url: opened.url,
    kind: 'native',
    transportIdentity,
    ttlTimer: null,
    released: false,
    byteLength: 0,
    bridge,
  };
  assetsByUrl.set(opened.url, asset);
  assetsById.set(opened.assetId, asset);
  armTtl(asset);

  // Return the virtual URL immediately so <img> can request it while chunks stream.
  // Background task owns reader → writeChunk backpressure → endAsset / abort+release.
  void pumpNativeBodyInBackground(bridge, body, asset, signal, transportIdentity);

  return opened.url;
};

/**
 * Drain the Response body into the native bridge with write backpressure.
 * Failures abort+release the tracked asset; never leave an unhandled rejection.
 */
const pumpNativeBodyInBackground = (
  bridge: NativeRelayAssetBridge,
  body: ReadableStream<Uint8Array>,
  asset: TrackedAsset,
  signal: AbortSignal,
  transportIdentity: string,
): Promise<void> => {
  const reader = body.getReader();
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
    void releaseTrackedAsset(asset, { abort: true, reason: 'aborted' });
  };
  signal.addEventListener('abort', onAbort, { once: true });

  return (async () => {
    try {
      for (;;) {
        if (signal.aborted || asset.released) {
          throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
        }
        if (getRuntimeTransportIdentity() !== transportIdentity) {
          throw new Error('Runtime transport changed during image stream');
        }

        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;

        asset.byteLength += value.byteLength;
        if (asset.byteLength > RELAY_IMAGE_MAX_BYTES) {
          throw new Error(`Image exceeds maximum size of ${RELAY_IMAGE_MAX_BYTES} bytes`);
        }

        // Await writeChunk so a slow native consumer applies backpressure on the tunnel read.
        await bridge.writeChunk(asset.assetId, value);
      }

      if (signal.aborted || asset.released) {
        throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
      }
      await bridge.endAsset(asset.assetId);
      inFlight.delete(asset.assetId);
    } catch (error) {
      await releaseTrackedAsset(asset, {
        abort: true,
        reason: error instanceof Error ? error.message : 'stream-failed',
      });
      // Background pump: surface is via abort/release; do not rethrow (avoids unhandled rejection).
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  })().catch(() => {
    // Defense-in-depth: never leave an unhandled rejection from the fire-and-forget pump.
  });
};

const bufferToBlobUrl = async (
  response: Response,
  signal: AbortSignal,
  transportIdentity: string,
): Promise<string> => {
  const blob = await response.blob();
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
  }
  if (blob.size > RELAY_IMAGE_MAX_BYTES) {
    throw new Error(`Image exceeds maximum size of ${RELAY_IMAGE_MAX_BYTES} bytes`);
  }
  if (getRuntimeTransportIdentity() !== transportIdentity) {
    throw new Error('Runtime transport changed during image load');
  }

  const url = URL.createObjectURL(blob);
  const asset: TrackedAsset = {
    assetId: mintAssetId(),
    url,
    kind: 'blob',
    transportIdentity,
    ttlTimer: null,
    released: false,
    byteLength: blob.size,
    bridge: null,
  };
  assetsByUrl.set(url, asset);
  assetsById.set(asset.assetId, asset);
  armTtl(asset);
  return url;
};

/**
 * Load a host file path as a displayable image URL.
 * Uses the native bridge when present; otherwise Blob object URLs.
 */
export const streamRelayImageDisplayUrl = async (
  path: string,
  signal: AbortSignal,
): Promise<string> => {
  ensureTransportCleanup();

  const transportIdentity = getRuntimeTransportIdentity();
  const response = await runtimeFetch('/api/fs/raw', {
    method: 'GET',
    cache: 'no-store',
    query: { path },
    signal,
  });

  if (!response.ok) {
    throw new Error(`Image source request failed with status ${response.status}`);
  }

  const bridge = await resolveNativeRelayAssetBridge();
  if (bridge) {
    return streamToNativeBridge(bridge, response, signal, transportIdentity);
  }
  return bufferToBlobUrl(response, signal, transportIdentity);
};

/** Release a URL returned by streamRelayImageDisplayUrl (blob or native). */
export const releaseRelayImageDisplayUrl = (url: string): void => {
  if (!url) return;
  const asset = assetsByUrl.get(url);
  if (asset) {
    void releaseTrackedAsset(asset, { abort: true, reason: 'released' });
    return;
  }
  if (url.startsWith('blob:')) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  }
};

/** Abort and release every tracked asset (transport change / test teardown). */
export const clearAllRelayImageAssets = (reason = 'cleared'): void => {
  const snapshot = Array.from(assetsByUrl.values());
  for (const asset of snapshot) {
    void releaseTrackedAsset(asset, { abort: true, reason });
  }
  inFlight.clear();
  pendingOpenCount = 0;
};

const ensureTransportCleanup = (): void => {
  if (transportUnsubscribe || typeof window === 'undefined') return;
  transportUnsubscribe = subscribeRuntimeEndpointChanged(() => {
    clearAllRelayImageAssets('transport-changed');
  });
};

/** Test helper: drop the transport subscription so suites can reinstall cleanly. */
export const resetRelayImageStreamForTests = (): void => {
  clearAllRelayImageAssets('test-reset');
  transportUnsubscribe?.();
  transportUnsubscribe = null;
  nextAssetSerial = 0;
};
