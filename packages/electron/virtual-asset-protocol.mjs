/**
 * Virtual image asset protocol for Electron.
 *
 * Renderer (local page only) creates an opaque assetId, declares MIME, pushes
 * bounded binary chunks, then finishes or cancels. Main maps the assetId to a
 * protocol.handle ReadableStream. The URL uses a dedicated secure scheme and
 * never embeds host paths or credentials.
 */

import { randomUUID } from 'node:crypto';

export const ASSET_PROTOCOL = 'openchamber-asset';
export const ASSET_HOST = 'stream';

export const DEFAULT_VIRTUAL_ASSET_LIMITS = Object.freeze({
  /** Maximum assets that may exist at once (created and not yet destroyed). */
  maxConcurrent: 16,
  /** Maximum bytes buffered per asset waiting for the protocol consumer. */
  maxQueuedBytes: 4 * 1024 * 1024,
  /** Maximum size of a single push chunk. */
  maxChunkBytes: 1024 * 1024,
  /** Absolute maximum total bytes accepted for one asset. */
  maxTotalBytes: 64 * 1024 * 1024,
  /** Destroy idle/unconsumed assets after this TTL. */
  ttlMs: 120_000,
});

/**
 * Privileges for registerSchemesAsPrivileged. Includes stream so protocol.handle
 * may return a ReadableStream body without buffering the full response.
 */
export const ASSET_SCHEME_PRIVILEGES = Object.freeze({
  standard: true,
  secure: true,
  supportFetchAPI: true,
  corsEnabled: true,
  stream: true,
});

/**
 * @param {string} assetId
 * @returns {string}
 */
export const buildVirtualAssetUrl = (assetId) => {
  if (typeof assetId !== 'string' || !assetId.trim()) {
    throw new Error('assetId is required');
  }
  // Hostname is fixed ("stream"); id is only in the path. No userinfo, query,
  // or fragment that could carry credentials or host paths.
  return `${ASSET_PROTOCOL}://${ASSET_HOST}/${encodeURIComponent(assetId.trim())}`;
};

/**
 * @param {string} requestUrl
 * @returns {string | null}
 */
export const parseVirtualAssetId = (requestUrl) => {
  if (typeof requestUrl !== 'string' || !requestUrl) return null;
  try {
    const url = new URL(requestUrl);
    if (url.protocol !== `${ASSET_PROTOCOL}:`) return null;
    if (url.hostname !== ASSET_HOST) return null;
    // Reject any credential-bearing URL form.
    if (url.username || url.password) return null;
    if (url.search || url.hash) return null;
    const raw = (url.pathname || '').replace(/^\/+/, '');
    if (!raw) return null;
    const assetId = decodeURIComponent(raw);
    // Opaque id only — no nested paths that could look like host filesystem paths.
    if (!assetId || assetId.includes('/') || assetId.includes('\\') || assetId.includes('..')) {
      return null;
    }
    return assetId;
  } catch {
    return null;
  }
};

/**
 * @param {unknown} mimeType
 * @returns {string | null} normalized MIME or null when rejected
 */
export const normalizeImageMimeType = (mimeType) => {
  if (typeof mimeType !== 'string') return null;
  const normalized = mimeType.trim().toLowerCase();
  if (!normalized || normalized.length > 128) return null;
  if (normalized.includes('\n') || normalized.includes('\r') || normalized.includes('\0')) return null;
  // Virtual assets are image-only; reject non-image types to limit abuse surface.
  if (!normalized.startsWith('image/')) return null;
  // Basic token check: type/subtype with optional +suffix, no parameters here
  // (parameters would be unusual for protocol Content-Type we set ourselves).
  if (!/^image\/[a-z0-9][a-z0-9!#$&\-^_.+]*$/i.test(normalized)) return null;
  return normalized;
};

/**
 * @param {unknown} chunk
 * @returns {Uint8Array}
 */
export const coerceChunkBytes = (chunk) => {
  if (chunk instanceof Uint8Array) {
    return chunk.byteLength === chunk.buffer.byteLength
      && chunk.byteOffset === 0
      ? chunk
      : new Uint8Array(chunk);
  }
  if (chunk instanceof ArrayBuffer) {
    return new Uint8Array(chunk);
  }
  if (ArrayBuffer.isView(chunk) && chunk.buffer instanceof ArrayBuffer) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  throw new Error('chunk must be ArrayBuffer or TypedArray');
};

/**
 * @typedef {object} VirtualAssetLimits
 * @property {number} maxConcurrent
 * @property {number} maxQueuedBytes
 * @property {number} maxChunkBytes
 * @property {number} maxTotalBytes
 * @property {number} ttlMs
 */

/**
 * @typedef {object} CreateVirtualAssetResult
 * @property {string} assetId
 * @property {string} url
 * @property {string} mimeType
 */

/**
 * In-memory registry mapping opaque asset ids to pull-based ReadableStreams.
 *
 * @param {{ limits?: Partial<VirtualAssetLimits>, now?: () => number, idFactory?: () => string }} [options]
 */
export const createVirtualAssetRegistry = (options = {}) => {
  /** @type {VirtualAssetLimits} */
  const limits = {
    ...DEFAULT_VIRTUAL_ASSET_LIMITS,
    ...(options.limits && typeof options.limits === 'object' ? options.limits : {}),
  };
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const idFactory = typeof options.idFactory === 'function' ? options.idFactory : () => randomUUID();

  /** @type {Map<string, import('./virtual-asset-protocol.mjs').InternalAsset>} */
  const assets = new Map();
  let disposed = false;

  /**
   * @typedef {object} InternalAsset
   * @property {string} assetId
   * @property {string} mimeType
   * @property {number} createdAt
   * @property {Uint8Array[]} queue
   * @property {number} queuedBytes
   * @property {number} totalBytes
   * @property {boolean} finished
   * @property {boolean} cancelled
   * @property {boolean} consumerAttached
   * @property {boolean} consumed
   * @property {Error | null} error
   * @property {ReadableStreamDefaultController | null} controller
   * @property {Array<() => void>} waiters
   * @property {Array<() => void>} drainWaiters
   */

  const notifyWaiters = (/** @type {InternalAsset} */ asset) => {
    const waiters = asset.waiters.splice(0, asset.waiters.length);
    for (const wake of waiters) wake();
  };

  const notifyDrain = (/** @type {InternalAsset} */ asset) => {
    const waiters = asset.drainWaiters.splice(0, asset.drainWaiters.length);
    for (const wake of waiters) wake();
  };

  const destroyAsset = (/** @type {InternalAsset} */ asset, reason = 'destroy') => {
    if (!assets.has(asset.assetId)) return;
    asset.cancelled = true;
    if (!asset.error && reason !== 'consumed') {
      asset.error = new Error(typeof reason === 'string' ? reason : 'asset destroyed');
    }
    asset.queue.length = 0;
    asset.queuedBytes = 0;
    try {
      asset.controller?.error(asset.error || new Error('asset destroyed'));
    } catch {
      // Controller may already be closed.
    }
    asset.controller = null;
    notifyWaiters(asset);
    notifyDrain(asset);
    assets.delete(asset.assetId);
  };

  const sweepExpired = () => {
    if (disposed) return;
    const deadline = now() - limits.ttlMs;
    for (const asset of [...assets.values()]) {
      if (asset.consumed) {
        destroyAsset(asset, 'consumed');
        continue;
      }
      if (asset.createdAt < deadline) {
        destroyAsset(asset, 'ttl');
      }
    }
  };

  /**
   * @param {{ mimeType: string }} input
   * @returns {CreateVirtualAssetResult}
   */
  const create = (input) => {
    if (disposed) throw new Error('virtual asset registry disposed');
    sweepExpired();
    const mimeType = normalizeImageMimeType(input?.mimeType);
    if (!mimeType) {
      throw new Error('mimeType must be a valid image/* type');
    }
    if (assets.size >= limits.maxConcurrent) {
      throw new Error(`virtual asset concurrency limit (${limits.maxConcurrent}) reached`);
    }

    const assetId = idFactory();
    if (typeof assetId !== 'string' || !assetId.trim()) {
      throw new Error('idFactory must return a non-empty string');
    }
    if (assets.has(assetId)) {
      throw new Error('duplicate assetId from idFactory');
    }

    /** @type {InternalAsset} */
    const asset = {
      assetId,
      mimeType,
      createdAt: now(),
      queue: [],
      queuedBytes: 0,
      totalBytes: 0,
      finished: false,
      cancelled: false,
      consumerAttached: false,
      consumed: false,
      error: null,
      controller: null,
      waiters: [],
      drainWaiters: [],
    };
    assets.set(assetId, asset);

    return {
      assetId,
      url: buildVirtualAssetUrl(assetId),
      mimeType,
    };
  };

  /**
   * @param {string} assetId
   * @param {unknown} chunk
   * @returns {Promise<{ ok: true, queuedBytes: number, totalBytes: number }>}
   */
  const push = async (assetId, chunk) => {
    if (disposed) throw new Error('virtual asset registry disposed');
    if (typeof assetId !== 'string' || !assetId) {
      throw new Error('assetId is required');
    }
    sweepExpired();
    const asset = assets.get(assetId);
    if (!asset || asset.cancelled) {
      throw new Error('unknown or cancelled assetId');
    }
    if (asset.finished) {
      throw new Error('asset already finished');
    }

    const bytes = coerceChunkBytes(chunk);
    if (bytes.byteLength === 0) {
      return { ok: true, queuedBytes: asset.queuedBytes, totalBytes: asset.totalBytes };
    }
    if (bytes.byteLength > limits.maxChunkBytes) {
      throw new Error(`chunk exceeds maxChunkBytes (${limits.maxChunkBytes})`);
    }
    if (asset.totalBytes + bytes.byteLength > limits.maxTotalBytes) {
      destroyAsset(asset, 'max-total-bytes');
      throw new Error(`asset exceeds maxTotalBytes (${limits.maxTotalBytes})`);
    }

    // Backpressure: wait until the protocol consumer drains enough space.
    // Never buffer past maxQueuedBytes. When a consumer is attached this is
    // ordinary stream backpressure; when none has attached yet, still wait for
    // attach/drain — but cancel, finish, dispose, or TTL must be able to end
    // the wait so a missing <img>/protocol consumer cannot deadlock the
    // renderer pump or relay stream forever.
    while (
      !asset.cancelled
      && !asset.finished
      && asset.queuedBytes + bytes.byteLength > limits.maxQueuedBytes
    ) {
      await new Promise((resolve) => {
        let settled = false;
        /** @type {ReturnType<typeof setTimeout> | null} */
        let timer = null;
        const wake = () => {
          if (settled) return;
          settled = true;
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
          }
          resolve();
        };
        asset.drainWaiters.push(wake);

        // Arm TTL while blocked so an orphaned full queue is reaped even when
        // no other registry call drives sweepExpired.
        const remaining = limits.ttlMs - (now() - asset.createdAt);
        if (remaining <= 0) {
          queueMicrotask(() => {
            if (!settled && assets.has(asset.assetId)) {
              sweepExpired();
            }
          });
        } else if (Number.isFinite(remaining)) {
          timer = setTimeout(() => {
            if (!settled) {
              sweepExpired();
            }
          }, remaining);
        }
      });
    }
    if (asset.cancelled) {
      throw new Error('asset cancelled');
    }
    if (asset.finished) {
      throw new Error('asset already finished');
    }

    // Copy so callers can reuse their buffer; store a standalone view.
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    asset.queue.push(copy);
    asset.queuedBytes += copy.byteLength;
    asset.totalBytes += copy.byteLength;

    if (asset.controller) {
      try {
        while (asset.queue.length > 0) {
          const next = asset.queue.shift();
          if (!next) break;
          asset.queuedBytes -= next.byteLength;
          asset.controller.enqueue(next);
        }
        notifyDrain(asset);
      } catch (error) {
        destroyAsset(asset, error instanceof Error ? error.message : 'enqueue-failed');
        throw error;
      }
    } else {
      notifyWaiters(asset);
    }

    return { ok: true, queuedBytes: asset.queuedBytes, totalBytes: asset.totalBytes };
  };

  /**
   * @param {string} assetId
   * @returns {{ ok: true }}
   */
  const finish = (assetId) => {
    if (disposed) throw new Error('virtual asset registry disposed');
    if (typeof assetId !== 'string' || !assetId) {
      throw new Error('assetId is required');
    }
    const asset = assets.get(assetId);
    if (!asset || asset.cancelled) {
      throw new Error('unknown or cancelled assetId');
    }
    if (asset.finished) {
      return { ok: true };
    }
    asset.finished = true;
    if (asset.controller) {
      try {
        while (asset.queue.length > 0) {
          const next = asset.queue.shift();
          if (!next) break;
          asset.queuedBytes -= next.byteLength;
          asset.controller.enqueue(next);
        }
        asset.controller.close();
        asset.controller = null;
        asset.consumed = true;
        assets.delete(asset.assetId);
      } catch (error) {
        destroyAsset(asset, error instanceof Error ? error.message : 'close-failed');
        throw error;
      }
    }
    notifyWaiters(asset);
    notifyDrain(asset);
    return { ok: true };
  };

  /**
   * @param {string} assetId
   * @returns {{ ok: true }}
   */
  const cancel = (assetId) => {
    if (typeof assetId !== 'string' || !assetId) {
      throw new Error('assetId is required');
    }
    const asset = assets.get(assetId);
    if (!asset) {
      return { ok: true };
    }
    destroyAsset(asset, 'cancelled');
    return { ok: true };
  };

  /**
   * Flush queued chunks into the active controller (if any).
   * @param {InternalAsset} asset
   */
  const flushToController = (asset) => {
    if (!asset.controller) return;
    while (asset.queue.length > 0) {
      const next = asset.queue.shift();
      if (!next) break;
      asset.queuedBytes -= next.byteLength;
      asset.controller.enqueue(next);
    }
    notifyDrain(asset);
    if (asset.finished) {
      asset.controller.close();
      asset.controller = null;
      asset.consumed = true;
      assets.delete(asset.assetId);
    }
  };

  /**
   * @param {Request} request
   * @returns {Response}
   */
  const handleRequest = (request) => {
    if (disposed) {
      return new Response(null, { status: 503, statusText: 'Service Unavailable' });
    }
    sweepExpired();

    const requestUrl = typeof request?.url === 'string' ? request.url : '';
    const assetId = parseVirtualAssetId(requestUrl);
    if (!assetId) {
      return new Response(null, { status: 404, statusText: 'Not Found' });
    }

    const asset = assets.get(assetId);
    if (!asset || asset.cancelled) {
      return new Response(null, { status: 404, statusText: 'Not Found' });
    }
    // One consumer per asset — second request gets a conflict rather than
    // interleaving two streams over the same push queue.
    if (asset.consumerAttached) {
      return new Response(null, { status: 409, statusText: 'Conflict' });
    }
    asset.consumerAttached = true;

    const stream = new ReadableStream({
      start(controller) {
        if (asset.cancelled) {
          controller.error(asset.error || new Error('asset cancelled'));
          return;
        }
        asset.controller = controller;
        try {
          flushToController(asset);
        } catch (error) {
          destroyAsset(asset, error instanceof Error ? error.message : 'start-failed');
        }
      },
      async pull(controller) {
        if (asset.cancelled) {
          controller.error(asset.error || new Error('asset cancelled'));
          return;
        }
        if (asset.queue.length > 0 || asset.finished) {
          try {
            flushToController(asset);
          } catch (error) {
            destroyAsset(asset, error instanceof Error ? error.message : 'pull-failed');
          }
          return;
        }
        await new Promise((resolve) => {
          asset.waiters.push(resolve);
        });
        if (asset.cancelled) {
          try {
            controller.error(asset.error || new Error('asset cancelled'));
          } catch {
          }
          return;
        }
        try {
          flushToController(asset);
        } catch (error) {
          destroyAsset(asset, error instanceof Error ? error.message : 'pull-failed');
        }
      },
      cancel() {
        destroyAsset(asset, 'protocol-cancel');
      },
    });

    const signal = request && typeof request === 'object' ? request.signal : null;
    if (signal && typeof signal.addEventListener === 'function') {
      if (signal.aborted) {
        destroyAsset(asset, 'request-abort');
      } else {
        signal.addEventListener(
          'abort',
          () => {
            destroyAsset(asset, 'request-abort');
          },
          { once: true },
        );
      }
    }

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': asset.mimeType,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  };

  const dispose = () => {
    disposed = true;
    for (const asset of [...assets.values()]) {
      destroyAsset(asset, 'disposed');
    }
    assets.clear();
  };

  const getStats = () => ({
    size: assets.size,
    limits: { ...limits },
    assets: [...assets.values()].map((asset) => ({
      assetId: asset.assetId,
      mimeType: asset.mimeType,
      queuedBytes: asset.queuedBytes,
      totalBytes: asset.totalBytes,
      finished: asset.finished,
      cancelled: asset.cancelled,
      consumerAttached: asset.consumerAttached,
      consumed: asset.consumed,
      ageMs: now() - asset.createdAt,
    })),
  });

  return {
    create,
    push,
    finish,
    cancel,
    handleRequest,
    dispose,
    getStats,
    sweepExpired,
    limits,
  };
};
