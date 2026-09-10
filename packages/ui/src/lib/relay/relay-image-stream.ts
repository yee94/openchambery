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

/**
 * Aggregated renderer→native IPC payload size. Tunnel wire frames stay at
 * 64 KiB; this only batches those frames before writeChunk. Each flushed
 * write is at most this many bytes (a remainder may be smaller).
 */
export const RELAY_IMAGE_IPC_CHUNK_BYTES = 512 * 1024;

type TrackedAsset = {
  assetId: string;
  url: string;
  kind: 'native' | 'blob';
  transportIdentity: string;
  ttlTimer: ReturnType<typeof setTimeout> | null;
  /** When >0, TTL is suppressed until retain count returns to 0. */
  retainCount: number;
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
  if (asset.retainCount > 0) return;
  asset.ttlTimer = setTimeout(() => {
    void releaseTrackedAsset(asset, { abort: true, reason: 'ttl-expired' });
  }, RELAY_IMAGE_ASSET_TTL_MS);
};

/** True when the URL is still tracked and not released (including TTL expiry). */
export const isRelayImageDisplayUrlLive = (url: string): boolean => {
  if (!url) return false;
  const asset = assetsByUrl.get(url);
  return Boolean(asset && !asset.released);
};

/**
 * Hold a display URL against TTL expiry while a consumer lease is active.
 * Returns false when the URL is already gone (caller must rematerialize).
 */
export const retainRelayImageDisplayUrl = (url: string): boolean => {
  const asset = assetsByUrl.get(url);
  if (!asset || asset.released) return false;
  asset.retainCount += 1;
  clearTtl(asset);
  return true;
};

/** Drop one retain hold; re-arms TTL when the last retain releases. */
export const releaseRelayImageDisplayRetain = (url: string): void => {
  const asset = assetsByUrl.get(url);
  if (!asset || asset.released) return;
  asset.retainCount = Math.max(0, asset.retainCount - 1);
  if (asset.retainCount === 0) armTtl(asset);
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
    retainCount: 0,
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
    const pending: Uint8Array[] = [];
    let pendingBytes = 0;

    const takePendingBytes = (byteLength: number): Uint8Array => {
      if (byteLength <= 0) return new Uint8Array(0);
      if (pending.length === 1 && pending[0]!.byteLength === byteLength) {
        pendingBytes = 0;
        return pending.pop()!;
      }
      const out = new Uint8Array(byteLength);
      let offset = 0;
      while (offset < byteLength && pending.length > 0) {
        const head = pending[0]!;
        const need = byteLength - offset;
        if (head.byteLength <= need) {
          out.set(head, offset);
          offset += head.byteLength;
          pending.shift();
        } else {
          out.set(head.subarray(0, need), offset);
          pending[0] = head.subarray(need);
          offset += need;
        }
      }
      pendingBytes -= offset;
      return out;
    };

    const discardPending = (): void => {
      pending.length = 0;
      pendingBytes = 0;
    };

    const assertStreamActive = (): void => {
      if (signal.aborted || asset.released) {
        throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
      }
      if (getRuntimeTransportIdentity() !== transportIdentity) {
        throw new Error('Runtime transport changed during image stream');
      }
    };

    const flushPending = async (flushAll: boolean): Promise<void> => {
      while (pendingBytes > 0 && (flushAll || pendingBytes >= RELAY_IMAGE_IPC_CHUNK_BYTES)) {
        assertStreamActive();
        const size = Math.min(pendingBytes, RELAY_IMAGE_IPC_CHUNK_BYTES);
        const chunk = takePendingBytes(size);
        // Await writeChunk so a slow native consumer applies backpressure on the tunnel read.
        await bridge.writeChunk(asset.assetId, chunk);
      }
    };

    try {
      for (;;) {
        assertStreamActive();

        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;

        asset.byteLength += value.byteLength;
        if (asset.byteLength > RELAY_IMAGE_MAX_BYTES) {
          throw new Error(`Image exceeds maximum size of ${RELAY_IMAGE_MAX_BYTES} bytes`);
        }

        pending.push(value);
        pendingBytes += value.byteLength;
        if (pendingBytes >= RELAY_IMAGE_IPC_CHUNK_BYTES) {
          await flushPending(false);
        }
      }

      assertStreamActive();
      await flushPending(true);
      assertStreamActive();
      await bridge.endAsset(asset.assetId);
      inFlight.delete(asset.assetId);
    } catch (error) {
      discardPending();
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
    retainCount: 0,
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
 * Materialize an already-verified Blob as a displayable URL.
 * Desktop/mobile: openchamber-asset:// via the native bridge (full write then end).
 * Web/VS Code: object URL. Callers must release via releaseRelayImageDisplayUrl.
 */
export const streamVerifiedBlobDisplayUrl = async (
  blob: Blob,
  signal: AbortSignal,
  options: { mimeType?: string } = {},
): Promise<string> => {
  ensureTransportCleanup();

  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
  }
  if (!(blob instanceof Blob)) {
    throw new Error('Verified display requires a Blob');
  }
  if (blob.size > RELAY_IMAGE_MAX_BYTES) {
    throw new Error(`Image exceeds maximum size of ${RELAY_IMAGE_MAX_BYTES} bytes`);
  }

  const transportIdentity = getRuntimeTransportIdentity();
  const mimeType = resolveVerifiedMimeType(blob, options.mimeType);
  const bridge = await resolveNativeRelayAssetBridge();
  if (bridge) {
    return writeVerifiedBlobToNativeBridge(bridge, blob, mimeType, signal, transportIdentity);
  }
  return bufferBlobToObjectUrl(blob, signal, transportIdentity);
};

const resolveVerifiedMimeType = (blob: Blob, override?: string): string => {
  const raw = (override || blob.type || '').split(';')[0]?.trim().toLowerCase();
  if (raw && raw.startsWith('image/')) return raw;
  // Electron virtual assets reject non-image MIME; default conservatively for display.
  return raw || 'image/png';
};

const bufferBlobToObjectUrl = async (
  blob: Blob,
  signal: AbortSignal,
  transportIdentity: string,
): Promise<string> => {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
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
    retainCount: 0,
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
 * Write a complete verified Blob into the native bridge before returning the URL.
 * Unlike Response streaming, bytes are already trusted so open→write→end is awaited.
 */
const writeVerifiedBlobToNativeBridge = async (
  bridge: NativeRelayAssetBridge,
  blob: Blob,
  mimeType: string,
  signal: AbortSignal,
  transportIdentity: string,
): Promise<string> => {
  await acquireOpenSlot(signal);
  if (signal.aborted) {
    releaseOpenSlot();
    throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
  }
  if (getRuntimeTransportIdentity() !== transportIdentity) {
    releaseOpenSlot();
    throw new Error('Runtime transport changed during image load');
  }

  const suggestedId = mintAssetId();
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

  inFlight.add(opened.assetId);
  releaseOpenSlot();

  const asset: TrackedAsset = {
    assetId: opened.assetId,
    url: opened.url,
    kind: 'native',
    transportIdentity,
    ttlTimer: null,
    retainCount: 0,
    released: false,
    byteLength: blob.size,
    bridge,
  };
  assetsByUrl.set(opened.url, asset);
  assetsById.set(opened.assetId, asset);
  armTtl(asset);

  try {
    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
    }
    if (getRuntimeTransportIdentity() !== transportIdentity) {
      throw new Error('Runtime transport changed during image load');
    }

    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
    }
    let offset = 0;
    while (offset < bytes.byteLength) {
      if (signal.aborted || asset.released) {
        throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
      }
      if (getRuntimeTransportIdentity() !== transportIdentity) {
        throw new Error('Runtime transport changed during image load');
      }
      const end = Math.min(offset + RELAY_IMAGE_IPC_CHUNK_BYTES, bytes.byteLength);
      await bridge.writeChunk(opened.assetId, bytes.subarray(offset, end));
      offset = end;
    }
    await bridge.endAsset(opened.assetId);
    inFlight.delete(opened.assetId);
    return opened.url;
  } catch (error) {
    await releaseTrackedAsset(asset, {
      abort: true,
      reason: error instanceof Error ? error.message : 'verified-blob-failed',
    });
    throw error;
  }
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
