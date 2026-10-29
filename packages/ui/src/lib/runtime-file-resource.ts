import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { queryClient } from '@/lib/queryRuntime';
import { fileStatQueryOptions } from '@/queries/fileQueries';
import { getRuntimeTransportIdentity, getRuntimeGeneration, getRuntimeKey, subscribeRuntimeEndpointChanged } from './runtime-switch';
import { getRuntimeAuthGeneration, getRuntimeBearerTokenSync, getRuntimeExtraHeadersSync, subscribeRuntimeAuthGeneration } from './runtime-auth';
import { runtimeFileStore as runtimeImageStore } from './runtime-file-store';
import { runtimeFetch } from './runtime-fetch';
import { readDownloadBlob, type DownloadProgress } from './download-progress';
import { getRuntimeUrlResolver, type RuntimeUrlQuery } from './runtime-url';
import { normalizeFilePath, toAbsoluteFilePath } from './path-utils';
import { getNativeImageCacheBridge } from './relay/native-asset-bridge';
import { releaseRelayImageDisplayUrl, retainRelayImageDisplayUrl, streamRelayImageDisplayUrl, streamRelayImageResponse } from './relay/relay-image-stream';

export type RuntimeImageIntent = 'inline' | 'preview';
type FileResourceLease = {
  response: Response;
  complete: Promise<void>;
  release: () => void;
  filename: string;
  coverage: 'complete' | 'stream';
};
type RuntimeImageLease = { url: string; release: () => void };
type Resource = { url: string; release: () => Promise<void> };
type Flight = { refs: number; controller: AbortController; promise: Promise<Resource>; resource?: Resource };
const flights = new Map<string, Flight>();
const anonymousScope = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
const MAX_BYTES = 32 * 1024 * 1024;
let subscribed = false;
let persistenceWarning = false;
let fingerprintWarning = false;
const digest = async (bytes: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<string> => (
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('')
);
const durableKey = (sha256: string): Promise<string> => digest(new TextEncoder().encode(JSON.stringify([
  'runtime-image-v2', getRuntimeKey(), getRuntimeBearerTokenSync(), Object.entries(getRuntimeExtraHeadersSync()).sort(([a], [b]) => a.localeCompare(b)), sha256,
])));
const fingerprintOf = (value?: string) => value && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
const reportPersistenceFallback = () => {
  if (persistenceWarning) return;
  persistenceWarning = true;
  console.warn('Image persistence unavailable; using bounded memory cache. A later acquisition will retry persistence.');
};

// Byte ownership stays here; display URLs retain their existing per-reader lifetime.
// In particular, mobile virtual URLs are one-use streams and must never be shared.
type BufferedImage = { version: string; blob: Blob; expires: number };
type ImageSource = { response: Response; complete: Promise<void> };
type SourceFlight = { refs: number; controller: AbortController; promise: Promise<ImageSource>; source?: ImageSource; committing?: boolean };
const sources = new Map<string, SourceFlight>();
const bufferedImages = new Map<string, BufferedImage>();
const BUFFERED_IMAGE_MAX_COUNT = 32;
const BUFFERED_IMAGE_MAX_BYTES = 64 * 1024 * 1024;
const BUFFERED_IMAGE_TTL_MS = 5 * 60_000;
let bufferedBytes = 0;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;

const pruneBufferedImages = () => {
  clearTimeout(expiryTimer);
  expiryTimer = undefined;
  for (const [key, image] of bufferedImages) {
    if (image.expires <= Date.now() || bufferedImages.size > BUFFERED_IMAGE_MAX_COUNT || bufferedBytes > BUFFERED_IMAGE_MAX_BYTES) {
      bufferedImages.delete(key);
      bufferedBytes -= image.blob.size;
    }
  }
  if (bufferedImages.size) {
    const expires = Math.min(...Array.from(bufferedImages.values(), (image) => image.expires));
    expiryTimer = setTimeout(pruneBufferedImages, Math.max(0, expires - Date.now()));
  }
};

const disposeSource = (key: string, flight: SourceFlight) => {
  if (sources.get(key) === flight) sources.delete(key);
  flight.controller.abort();
  void flight.source?.response.body?.cancel().catch(() => {});
};

// A subscriber may leave while a peer still owns the transfer or metadata read.
// Reject that subscriber promptly without cancelling the peer's work.
const cancellableLease = <T extends { release: () => void }>(pending: Promise<T>, signal: AbortSignal): Promise<T> => (
  new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    void pending.then((lease) => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) { lease.release(); abort(); }
      else resolve(lease);
    }, (error) => {
      signal.removeEventListener('abort', abort);
      reject(error);
    });
  })
);

type FileReadScope = { directory?: string; allowOutsideWorkspace?: boolean; outsideFileGrant?: string };
type VerifiedFileSource = {
  metadata: { isFile: boolean; size: number; mtimeMs: number; sha256: string; mimeType?: string; filename?: string };
  load: (signal: AbortSignal) => Promise<Response>;
  persistent: boolean;
  tags?: string[];
  maxBytes?: number;
};
const rawOptions = (path: string, scope: FileReadScope = {}) => ({
  query: { path, ...(scope.allowOutsideWorkspace ? { allowOutsideWorkspace: 'true' } : {}),
    ...(scope.outsideFileGrant ? { outsideFileGrant: scope.outsideFileGrant } : {}) },
  ...(scope.directory ? { headers: { 'x-opencode-directory': scope.directory } } : {}),
});

const fetchFileBody = async (path: string, scope: FileReadScope, signal: AbortSignal, range?: string): Promise<Response> => {
  const files = getRegisteredRuntimeAPIs()?.files;
  if (!range && files?.readFileBinary) {
    const result = await files.readFileBinary(path, scope);
    signal.throwIfAborted();
    return fetch(result.dataUrl, { signal });
  }
  const options = rawOptions(path, scope);
  return runtimeFetch('/api/fs/raw', { ...options, signal, cache: 'no-store', headers: { ...options.headers, ...(range ? { Range: range } : {}) } });
};

const acquireBufferedFile = async (path: string, signal: AbortSignal, readScope: FileReadScope = {}, source?: VerifiedFileSource): Promise<FileResourceLease> => {
  const files = getRegisteredRuntimeAPIs()?.files;
  // Older runtimes without version metadata retain the one-use, noncached path.
  if (!source && !files?.statFile) return acquireUncachedFile(path, signal, undefined, readScope);
  const transport = getRuntimeTransportIdentity();
  const generation = getRuntimeGeneration();
  const auth = getRuntimeAuthGeneration();
  const normalized = normalizeFilePath(path);
  const assertScope = () => {
    if (generation !== getRuntimeGeneration() || auth !== getRuntimeAuthGeneration()
      || transport !== getRuntimeTransportIdentity()) throw new DOMException('Image request superseded', 'AbortError');
  };
  const assertCurrent = () => { signal.throwIfAborted(); assertScope(); };
  const options = files && fileStatQueryOptions(files, { scopeDirectory: readScope.directory ?? null, path: normalized, options: { ...readScope, fingerprint: true } }, transport);
  const stat = () => source ? Promise.resolve(source.metadata) : queryClient.fetchQuery({ ...options!, queryKey: [...(options!.queryKey ?? []), generation, auth], staleTime: 0, retry: false });
  const before = await stat();
  assertCurrent();
  if (!before.isFile || !Number.isSafeInteger(before.size) || before.size < 0
    || typeof before.mtimeMs !== 'number' || !Number.isFinite(before.mtimeMs)) throw new Error('Image file version is unavailable');
  if (before.size > MAX_BYTES) {
    if (source) return { response: await source.load(signal), complete: Promise.resolve(), release: () => {}, filename: source.metadata.filename || 'file', coverage: 'stream' };
    return acquireUncachedFile(path, signal, undefined, readScope);
  }
  const fingerprint = fingerprintOf(before.sha256);
  if (!fingerprint && !fingerprintWarning) {
    fingerprintWarning = true;
    console.warn('Host image fingerprints unavailable; browser image reuse is memory-only until the Host is updated.');
  }
  const persistentKey = fingerprint && source?.persistent !== false ? await durableKey(fingerprint) : undefined;
  assertCurrent();
  const scope = JSON.stringify([transport, generation, auth, fingerprint ?? normalized]);
  const version = fingerprint ?? JSON.stringify([before.size, before.mtimeMs]);
  const key = JSON.stringify([scope, version]);
  pruneBufferedImages();
  let flight = sources.get(key);
  if (!flight) {
    const controller = new AbortController();
    const load = async (): Promise<ImageSource> => {
      const cached = bufferedImages.get(scope);
      if (cached?.version === version) {
        bufferedImages.delete(scope); bufferedImages.set(scope, cached);
        return { response: new Response(cached.blob), complete: Promise.resolve() };
      }
      if (persistentKey) {
        try {
          const stored = await runtimeImageStore.read(persistentKey, controller.signal);
          assertScope();
          if (stored && stored.size === before.size && await digest(await stored.arrayBuffer()) === fingerprint) {
            return { response: new Response(stored), complete: Promise.resolve() };
          }
        } catch { assertScope(); controller.signal.throwIfAborted(); reportPersistenceFallback(); }
        const bridge = getNativeImageCacheBridge();
        const native = bridge?.fileResources && bridge.lookup ? await bridge.lookup({ key: persistentKey, size: before.size }).catch(() => {
          assertScope(); controller.signal.throwIfAborted();
          console.warn('Native file cache lookup unavailable; reading from the active runtime.');
          return null;
        }) : null;
        if (native && bridge) {
          try {
            const cached = await fetch(native.url, { signal: controller.signal });
            if (!cached.ok) throw new Error(`Cached file read failed (${cached.status})`);
            const blob = await cached.blob();
            assertScope(); controller.signal.throwIfAborted();
            if (blob.size === before.size && await digest(await blob.arrayBuffer()) === fingerprint) return { response: new Response(blob), complete: Promise.resolve() };
          } finally { await bridge.release(native.leaseId); }
        }
      }
      const response = source ? await source.load(controller.signal) : await fetchFileBody(normalized, readScope, controller.signal);
      assertScope();
      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (response.status !== 200 || !response.body) throw new Error(`File source request failed (${response.status})`);
      // Keep an unread template for concurrent readers. Validation consumes a clone,
      // so the first native reader still receives chunks progressively, as before.
      const complete = (async () => {
        const reader = response.clone().body!.getReader();
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        let bytes = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (source?.maxBytes && bytes > source.maxBytes) throw new Error('File exceeds descriptor limit');
            if (controller.signal.aborted || bytes > before.size) throw new Error('Image changed during download');
            chunks.push(new Uint8Array(value));
          }
          created.committing = true;
          const after = await stat();
          if (controller.signal.aborted || generation !== getRuntimeGeneration() || auth !== getRuntimeAuthGeneration()
            || transport !== getRuntimeTransportIdentity()) throw new DOMException('Image request superseded', 'AbortError');
          if (!after.isFile || bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('Image changed during download');
          const blob = new Blob(chunks, { type: response.headers.get('content-type') ?? 'application/octet-stream' });
          if (fingerprint) {
            if (fingerprintOf(after.sha256) !== fingerprint || await digest(await blob.arrayBuffer()) !== fingerprint) {
              throw new Error('Image fingerprint changed during download');
            }
            assertScope();
            controller.signal.throwIfAborted();
            try { if (persistentKey) await runtimeImageStore.write(persistentKey, blob, controller.signal, source?.tags); }
            catch { assertScope(); controller.signal.throwIfAborted(); reportPersistenceFallback(); }
          }
          assertScope();
          controller.signal.throwIfAborted();
          const previous = bufferedImages.get(scope);
          if (previous) bufferedBytes -= previous.blob.size;
          bufferedImages.delete(scope);
          bufferedImages.set(scope, { version, blob, expires: Date.now() + BUFFERED_IMAGE_TTL_MS });
          bufferedBytes += blob.size;
          pruneBufferedImages();
        } finally { void reader.cancel().catch(() => {}); }
      })();
      void complete.catch(() => disposeSource(key, created));
      return { response, complete };
    };
    const created: SourceFlight = { refs: 0, controller, promise: Promise.resolve().then(load) };
    flight = created;
    sources.set(key, created);
    void created.promise.then((source) => {
      created.source = source;
      if (controller.signal.aborted) disposeSource(key, created);
      void source.complete.finally(() => {
        created.committing = false;
        if (!created.refs) disposeSource(key, created);
      }).catch(() => {});
    }).catch(() => disposeSource(key, created));
  }
  const current = flight;
  current.refs += 1;
  const local = new AbortController();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    signal.removeEventListener('abort', release);
    current.controller.signal.removeEventListener('abort', release);
    local.abort();
    if (--current.refs === 0 && !current.committing) disposeSource(key, current);
  };
  current.controller.signal.addEventListener('abort', release, { once: true });
  signal.addEventListener('abort', release, { once: true });
  try {
    const source = await current.promise;
    assertCurrent();
    if (local.signal.aborted || current.controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const clone = source.response.clone();
    const response = new Response(clone.body, { status: clone.status, headers: clone.headers });
    if (before.mimeType) response.headers.set('Content-Type', before.mimeType);
    response.headers.set('Content-Length', String(before.size));
    response.headers.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(before.filename || normalized.split('/').pop() || 'file')}`);
    return { response, complete: source.complete, release,
      filename: before.filename || normalized.split('/').pop() || 'file', coverage: 'complete' };
  } catch (error) {
    release();
    throw error;
  }
};

/** Descriptor adapters own their endpoint authorization/error vocabulary. The
 * shared owner owns verified bytes, capacity, persistence and download flights. */
export const readVerifiedFileResource = async (input: {
  identity: string; sha256: string; size: number; mime?: string; filename?: string;
  persistent: boolean; tags?: string[]; signal?: AbortSignal; maxBytes?: number;
  load: (signal: AbortSignal) => Promise<Response>;
}): Promise<Blob> => {
  subscribeFileResources();
  const controller = new AbortController();
  const signal = controller.signal;
  const abort = () => controller.abort();
  input.signal?.addEventListener('abort', abort, { once: true });
  const stopEndpoint = subscribeRuntimeEndpointChanged(abort);
  const stopAuth = subscribeRuntimeAuthGeneration(abort);
  let lease: FileResourceLease | undefined;
  try {
    input.signal?.throwIfAborted();
    lease = await cancellableLease(acquireBufferedFile(input.identity, signal, {}, {
      metadata: { isFile: true, size: input.size, mtimeMs: 0, sha256: input.sha256, mimeType: input.mime, filename: input.filename },
      load: input.load, persistent: input.persistent, tags: input.tags, maxBytes: input.maxBytes,
    }), signal);
    const blob = await readDownloadBlob(lease.response, signal, () => {}, input.maxBytes);
    await lease.complete;
    signal.throwIfAborted();
    if (blob.size !== input.size || await digest(await blob.arrayBuffer()) !== input.sha256.toLowerCase()) throw new Error('File fingerprint mismatch');
    signal.throwIfAborted();
    if (input.persistent && input.tags?.length && blob.size <= MAX_BYTES) {
      try { await runtimeImageStore.tag(await durableKey(input.sha256), input.tags, signal); } catch { signal.throwIfAborted(); reportPersistenceFallback(); }
    }
    return blob;
  } finally { lease?.release(); input.signal?.removeEventListener('abort', abort); stopEndpoint(); stopAuth(); }
};

export const forgetFileResourceTag = async (tag?: string): Promise<void> => {
  clearRuntimeImageCacheLeases();
  try { if (tag) await runtimeImageStore.clearTag(tag); else await runtimeImageStore.clear(); } catch { reportPersistenceFallback(); }
};

const acquireUncachedFile = async (path: string, signal: AbortSignal, range?: string, scope: FileReadScope = {}): Promise<FileResourceLease> => {
  const controller = new AbortController();
  const release = () => { controller.abort(); signal.removeEventListener('abort', release); stopEndpoint(); stopAuth(); };
  const stopEndpoint = subscribeRuntimeEndpointChanged(release);
  const stopAuth = subscribeRuntimeAuthGeneration(release);
  signal.addEventListener('abort', release, { once: true });
  try {
    signal.throwIfAborted();
    const response = await fetchFileBody(path, scope, controller.signal, range ?? (getRegisteredRuntimeAPIs()?.files.readFileBinary ? undefined : 'bytes=0-'));
    if (!response.ok && response.status !== 416) throw new Error(`File request failed (${response.status})`);
    return { response, release, complete: Promise.resolve(), filename: path.split('/').pop() || 'file', coverage: 'stream' };
  } catch (error) { release(); throw error; }
};

const acquireBufferedImage = async (path: string, signal: AbortSignal): Promise<RuntimeImageLease> => {
  if (!getRegisteredRuntimeAPIs()?.files?.statFile) return acquireImageStream(path, signal);
  const source = await acquireBufferedFile(path, signal);
  const local = new AbortController();
  let url = '';
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    signal.removeEventListener('abort', release);
    local.abort();
    if (url) releaseRelayImageDisplayUrl(url);
    source.release();
  };
  signal.addEventListener('abort', release, { once: true });
  try {
    signal.throwIfAborted();
    url = await streamRelayImageResponse(source.response, local.signal, getRuntimeTransportIdentity(), path);
    // Blob URLs have already buffered the body; do not publish a failed validation.
    // Native streams publish early and surface late failures through their abort path.
    if (url.startsWith('blob:')) await source.complete;
    void source.complete.catch(release);
    signal.throwIfAborted();
    if (released) throw new DOMException('Aborted', 'AbortError');
    retainRelayImageDisplayUrl(url);
    return { url, release };
  } catch (error) {
    if (released && url) releaseRelayImageDisplayUrl(url);
    release(); throw error;
  }
};

const dispose = (key: string, flight: Flight) => {
  if (flights.get(key) !== flight) return;
  flights.delete(key);
  flight.controller.abort();
  if (flight.resource) void flight.resource.release().catch(() => {});
};

export const clearRuntimeImageCacheLeases = (): void => {
  for (const [key, flight] of flights) dispose(key, flight);
  for (const [key, flight] of sources) disposeSource(key, flight);
  bufferedImages.clear(); bufferedBytes = 0;
  clearTimeout(expiryTimer); expiryTimer = undefined;
};

const acquireImageStream = async (path: string, signal: AbortSignal): Promise<RuntimeImageLease> => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const generation = getRuntimeGeneration();
  const auth = getRuntimeAuthGeneration();
  let url = '';
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    signal.removeEventListener('abort', abort);
    controller.abort();
    if (url) releaseRelayImageDisplayUrl(url);
  };
  try {
    if (signal.aborted || generation !== getRuntimeGeneration() || auth !== getRuntimeAuthGeneration()) {
      throw new DOMException('Image request superseded', 'AbortError');
    }
    url = await streamRelayImageDisplayUrl(path, controller.signal);
    if (signal.aborted || generation !== getRuntimeGeneration() || auth !== getRuntimeAuthGeneration()) {
      throw new DOMException('Image request superseded', 'AbortError');
    }
    return { url, release };
  } catch (error) {
    release();
    throw error;
  }
};

/** Prefer native disk caching; otherwise share bounded, version-validated bytes between display leases. */
export const acquireRuntimeImage = (path: string, signal: AbortSignal, _intent: RuntimeImageIntent = 'inline'): Promise<RuntimeImageLease> => {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  subscribeFileResources();
  const bridge = getNativeImageCacheBridge();
  if (!bridge) return cancellableLease(acquireBufferedImage(path, signal), signal);
  return cancellableLease(acquireNativeImage(path, signal, bridge), signal);
};

const subscribeFileResources = () => {
  if (!subscribed) {
    subscribed = true;
    subscribeRuntimeEndpointChanged(clearRuntimeImageCacheLeases);
    subscribeRuntimeAuthGeneration((detail) => {
      clearRuntimeImageCacheLeases();
      if (detail?.reason !== 'endpoint-switch') {
        void runtimeImageStore.clear().catch(reportPersistenceFallback);
        void getNativeImageCacheBridge()?.clear?.().catch(reportPersistenceFallback);
      }
    });
  }
};

export type FileResourceRequest = FileReadScope & { path: string; signal?: AbortSignal; range?: string };

/** Navigation stays browser/native-owned, including HTML origin and subresources.
 * This handle promises no client persistence; HTTP caching is server/browser policy. */
export const directFileResource = (route: string, query?: RuntimeUrlQuery): { url: string; cache: 'browser' } => ({
  url: getRuntimeUrlResolver().authenticatedAsset(route, query), cache: 'browser',
});

/** Import already staged/local bytes once; seeding is optional retention, never
 * a second remote read. Destination upload still executes its real authorization. */
export const importFileResource = async (source: Blob | (() => Promise<Blob>)): Promise<Blob> => {
  const remember = captureFileResourceWriter();
  const blob = typeof source === 'function' ? await source() : source;
  if (blob.size <= MAX_BYTES) await remember(blob, await digest(await blob.arrayBuffer()));
  return blob;
};

/** Compatibility materialization for destinations requiring Blob/base64.
 * Streaming callers consume readRuntimeFile without materialization. */
export const readRuntimeFileBlob = async (input: FileResourceRequest, onProgress?: DownloadProgress): Promise<Blob> => {
  const response = await readRuntimeFile(input);
  // Legacy destinations require a Blob/base64. Oversized reads remain uncached;
  // retention limits must never become a limit on a valid user operation.
  return readDownloadBlob(response, input.signal, onProgress);
};

/** URL sources retain their existing origin/CORS policy. Only runtime raw-file
 * URLs can resolve into the authenticated content store; other URLs are uncached. */
export const readFileResourceUrl = async (url: string, signal?: AbortSignal, onProgress?: DownloadProgress): Promise<Blob> => {
  let runtimeUrl = url;
  if (/^https?:\/\//i.test(url)) {
    const expected = new URL(getRuntimeUrlResolver().api('/api/fs/raw'), globalThis.location?.href);
    const actual = new URL(url);
    if (actual.origin === expected.origin && actual.pathname === expected.pathname) runtimeUrl = `/api/fs/raw${actual.search}`;
  }
  if (/^\/api\/fs\/raw\?/.test(runtimeUrl)) {
    const query = new URLSearchParams(runtimeUrl.slice(runtimeUrl.indexOf('?') + 1));
    const path = query.get('path');
    if (path) return readRuntimeFileBlob({ path, signal, directory: query.get('directory') ?? undefined,
      allowOutsideWorkspace: query.get('allowOutsideWorkspace') === 'true', outsideFileGrant: query.get('outsideFileGrant') ?? undefined }, onProgress);
  }
  const response = /^\/api(?=\/|[?#]|$)/.test(url)
    ? await runtimeFetch(url, { signal, cache: 'no-store' }) : await fetch(url, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`File request failed (${response.status})`);
  return readDownloadBlob(response, signal, onProgress);
};

/** Capture before a destination write. Only confirmed, hash-matching bytes may
 * seed local reuse; persistence failure never turns a successful upload into failure. */
export const captureFileResourceWriter = () => {
  subscribeFileResources();
  const generation = getRuntimeGeneration();
  const auth = getRuntimeAuthGeneration();
  return async (blob: Blob, sha256: string): Promise<void> => {
    if (blob.size > MAX_BYTES || !fingerprintOf(sha256)) return;
    const controller = new AbortController();
    const stopEndpoint = subscribeRuntimeEndpointChanged(() => controller.abort());
    const stopAuth = subscribeRuntimeAuthGeneration(() => controller.abort());
    try {
      if (generation !== getRuntimeGeneration() || auth !== getRuntimeAuthGeneration()) return;
      const key = await durableKey(sha256);
      if (await digest(await blob.arrayBuffer()) !== sha256) return;
      controller.signal.throwIfAborted();
      const scope = JSON.stringify([getRuntimeTransportIdentity(), generation, auth, sha256]);
      const previous = bufferedImages.get(scope);
      if (previous) bufferedBytes -= previous.blob.size;
      bufferedImages.delete(scope);
      bufferedImages.set(scope, { version: sha256, blob, expires: Date.now() + BUFFERED_IMAGE_TTL_MS });
      bufferedBytes += blob.size;
      pruneBufferedImages();
      const bridge = getNativeImageCacheBridge();
      if (bridge?.fileResources && blob.size > 0) {
        const lease = await bridge.acquire({ key, size: blob.size });
        try {
          controller.signal.throwIfAborted();
          if (!lease.hit) {
            const bytes = new Uint8Array(await blob.arrayBuffer());
            for (let offset = 0; offset < bytes.length; offset += 512 * 1024) {
              controller.signal.throwIfAborted();
              await bridge.append(lease.leaseId, bytes.slice(offset, offset + 512 * 1024));
            }
            controller.signal.throwIfAborted();
            await bridge.commit(lease.leaseId, blob.type || 'application/octet-stream');
          }
        } finally { await bridge.release(lease.leaseId); }
      } else await runtimeImageStore.write(key, blob, controller.signal);
    } catch { if (!controller.signal.aborted) reportPersistenceFallback(); }
    finally { stopEndpoint(); stopAuth(); }
  };
};

const rangedBlobResponse = (blob: Blob, range: string): Response => {
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  const total = blob.size;
  const start = match?.[1] ? Number(match[1]) : Math.max(0, total - Number(match?.[2]));
  const end = match?.[1] && match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
  if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start < 0 || start >= total || end < start) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
  }
  return new Response(blob.slice(start, end + 1, blob.type), { status: 206, headers: {
    'Content-Type': blob.type || 'application/octet-stream', 'Content-Length': String(end - start + 1),
    'Content-Range': `bytes ${start}-${end}/${total}`, 'Accept-Ranges': 'bytes',
  } });
};

/** Complete bodies only enter persistence. Cold ranges and oversized files stream
 * without a tee or body accumulation. EOF waits for commit; cancel releases the lease. */
export const readRuntimeFile = async (input: FileResourceRequest): Promise<Response> => {
  subscribeFileResources();
  const signal = input.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const path = input.directory ? toAbsoluteFilePath(input.directory, input.path) : normalizeFilePath(input.path);
  const generation = getRuntimeGeneration();
  const auth = getRuntimeAuthGeneration();
  const current = () => {
    signal.throwIfAborted();
    if (generation !== getRuntimeGeneration() || auth !== getRuntimeAuthGeneration()) throw new DOMException('File request superseded', 'AbortError');
  };
  let lease: FileResourceLease;
  if (input.range) {
    const files = getRegisteredRuntimeAPIs()?.files;
    const options = files?.statFile && fileStatQueryOptions(files, { scopeDirectory: input.directory ?? null, path, options: { ...input, fingerprint: true } }, getRuntimeTransportIdentity());
    const stat = options ? await queryClient.fetchQuery({ ...options, queryKey: [...(options.queryKey ?? []), generation, auth], staleTime: 0, retry: false }) : undefined;
    current();
    const sha = fingerprintOf(stat?.sha256);
    const key = sha ? await durableKey(sha) : undefined;
    let blob: Blob | null = null;
    if (key) {
      try { blob = await runtimeImageStore.read(key, signal); } catch { reportPersistenceFallback(); }
      current();
      if (blob && (blob.size !== stat?.size || await digest(await blob.arrayBuffer()) !== sha)) blob = null;
    }
    if (blob) { current(); return rangedBlobResponse(stat?.mimeType ? new Blob([blob], { type: stat.mimeType }) : blob, input.range); }
    const bridge = getNativeImageCacheBridge();
    const native = key && stat && bridge?.fileResources && bridge.lookup ? await bridge.lookup({ key, size: stat.size }).catch(() => {
      current();
      console.warn('Native file cache lookup unavailable; reading from the active runtime.');
      return null;
    }) : null;
    if (native && bridge) {
      try {
        current();
        const cached = await fetch(native.url, { signal, headers: { Range: input.range } });
        if (!cached.ok && cached.status !== 416) throw new Error(`Cached range failed (${cached.status})`);
        const headers = new Headers(cached.headers);
        if (stat?.mimeType) headers.set('Content-Type', stat.mimeType);
        const response = new Response(cached.body, { status: cached.status, headers });
        lease = { response, complete: Promise.resolve(), release: () => { void bridge.release(native.leaseId); }, filename: path.split('/').pop() || 'file', coverage: 'stream' };
      } catch (error) { await bridge.release(native.leaseId); throw error; }
    } else lease = await acquireUncachedFile(path, signal, input.range, input);
  } else {
    const bridge = getNativeImageCacheBridge();
    if (bridge?.fileResources && !input.outsideFileGrant && !input.allowOutsideWorkspace && !input.directory) {
      const files = getRegisteredRuntimeAPIs()?.files;
      const stat = files?.statFile ? await files.statFile(path) : undefined;
      current();
      if (stat && stat.size > 0 && stat.size <= MAX_BYTES) {
        const native = await acquireNativeImage(path, signal, bridge);
        try {
          const cached = await fetch(native.url, { signal });
          if (!cached.ok) throw new Error(`Cached file read failed (${cached.status})`);
          const headers = new Headers(cached.headers);
          if (stat.mimeType) headers.set('Content-Type', stat.mimeType);
          headers.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(stat.filename || path.split('/').pop() || 'file')}`);
          const response = new Response(cached.body, { status: cached.status, headers });
          lease = { response, complete: Promise.resolve(), release: native.release, filename: path.split('/').pop() || 'file', coverage: 'complete' };
        } catch (error) { native.release(); throw error; }
      } else lease = await acquireUncachedFile(path, signal);
    } else lease = await acquireBufferedFile(path, signal, input);
  }
  try { current(); } catch (error) { lease.release(); throw error; }
  const reader = lease.response.body?.getReader();
  if (!reader) { lease.release(); return lease.response; }
  let closed = false;
  const release = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener('abort', release);
    unsubscribeEndpoint(); unsubscribeAuth();
    lease.release();
    void reader.cancel().catch(() => {});
  };
  const unsubscribeEndpoint = subscribeRuntimeEndpointChanged(release);
  const unsubscribeAuth = subscribeRuntimeAuthGeneration(release);
  signal.addEventListener('abort', release, { once: true });
  return new Response(new ReadableStream({
    async pull(controller) {
      try {
        current();
        const next = await reader.read();
        current();
        if (next.done) { await lease.complete; current(); controller.close(); release(); }
        else controller.enqueue(next.value);
      } catch (error) { controller.error(error); release(); }
    },
    cancel: release,
  }), { status: lease.response.status, statusText: lease.response.statusText, headers: lease.response.headers });
};

const acquireNativeImage = async (path: string, signal: AbortSignal, bridge: NonNullable<ReturnType<typeof getNativeImageCacheBridge>>): Promise<RuntimeImageLease> => {
  const transport = getRuntimeTransportIdentity();
  const generation = getRuntimeGeneration();
  const auth = getRuntimeAuthGeneration();
  const normalized = normalizeFilePath(path);
  const files = getRegisteredRuntimeAPIs()?.files;
  if (!files?.statFile) throw new Error('Image file metadata is unavailable');
  const options = fileStatQueryOptions(files, { scopeDirectory: null, path: normalized, options: { fingerprint: true } }, transport);
  const stat = () => queryClient.fetchQuery({ ...options, queryKey: [...(options.queryKey ?? []), generation, auth], staleTime: 0, retry: false });
  const before = await stat();
  signal.throwIfAborted();
  if (generation !== getRuntimeGeneration() || auth !== getRuntimeAuthGeneration() || transport !== getRuntimeTransportIdentity()) throw new DOMException('Image request superseded', 'AbortError');
  if (!before.isFile || !Number.isSafeInteger(before.size) || before.size <= 0 || before.size > MAX_BYTES
    || typeof before.mtimeMs !== 'number' || !Number.isFinite(before.mtimeMs)) throw new Error('Image file version is unavailable');
  const key = JSON.stringify([transport, generation, auth, fingerprintOf(before.sha256) ?? [normalized, before.size, before.mtimeMs]]);
  let flight = flights.get(key);
  if (!flight) {
    const controller = new AbortController();
    const assertCurrent = () => {
      if (controller.signal.aborted || generation !== getRuntimeGeneration() || auth !== getRuntimeAuthGeneration()
        || transport !== getRuntimeTransportIdentity()) throw new DOMException('Image request superseded', 'AbortError');
    };
    const bearerScope = getRuntimeBearerTokenSync() || anonymousScope;
    const load = async (): Promise<Resource> => {
      assertCurrent();
      const fingerprint = fingerprintOf(before.sha256);
      const keyDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([
        transport, bearerScope, normalized, before.size, before.mtimeMs,
      ])));
      assertCurrent();
      const cacheKey = fingerprint ? await durableKey(fingerprint) : Array.from(new Uint8Array(keyDigest), (byte) => byte.toString(16).padStart(2, '0')).join('');
      const lease = await bridge.acquire({ key: cacheKey, size: before.size });
      try {
        assertCurrent();
        if (!lease.hit) {
          const stored = fingerprint ? await runtimeImageStore.read(cacheKey, controller.signal).catch(() => null) : null;
          assertCurrent();
          const response = stored && stored.size === before.size && await digest(await stored.arrayBuffer()) === fingerprint
            ? new Response(stored) : await fetchFileBody(normalized, {}, controller.signal);
          if (!response.ok || !response.body) throw new Error(`Image download failed (${response.status})`);
          const mime = response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
          const reader = response.body.getReader();
          let bytes = 0;
          const chunks: Uint8Array<ArrayBuffer>[] = [];
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              assertCurrent();
              bytes += value.byteLength;
              if (fingerprint) chunks.push(new Uint8Array(value));
              if (bytes > before.size) throw new Error('Image changed during download');
              for (let offset = 0; offset < value.byteLength; offset += 512 * 1024) {
                assertCurrent();
                await bridge.append(lease.leaseId, value.slice(offset, offset + 512 * 1024));
              }
            }
          } finally { await reader.cancel().catch(() => {}); }
          const after = await stat();
          assertCurrent();
          if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('Image changed during download');
          if (fingerprint && (fingerprintOf(after.sha256) !== fingerprint || await digest(await new Blob(chunks).arrayBuffer()) !== fingerprint)) throw new Error('Image fingerprint changed during download');
          await bridge.commit(lease.leaseId, mime);
        }
        assertCurrent();
        return { url: lease.url, release: () => bridge.release(lease.leaseId) };
      } catch (error) {
        await bridge.release(lease.leaseId).catch(() => {});
        throw error;
      }
    };
    flight = { refs: 0, controller, promise: load() };
    const created = flight;
    flights.set(key, created);
    void created.promise.then((resource) => {
      created.resource = resource;
      if (created.controller.signal.aborted || !created.refs) {
        if (flights.get(key) === created) dispose(key, created);
        else void resource.release().catch(() => {});
      }
    }).catch(() => { if (flights.get(key) === created) flights.delete(key); });
  }
  const current = flight;
  current.refs += 1;
  return new Promise((resolve, reject) => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      current.refs -= 1;
      if (!current.refs) dispose(key, current);
    };
    const abort = () => { release(); reject(new DOMException('Aborted', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
    void current.promise.then((resource) => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted || current.controller.signal.aborted) { abort(); return; }
      resolve({ url: resource.url, release });
    }, (error) => {
      signal.removeEventListener('abort', abort);
      release();
      reject(error);
    });
  });
};
