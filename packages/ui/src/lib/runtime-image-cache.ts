import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { queryClient } from '@/lib/queryRuntime';
import { fileStatQueryOptions } from '@/queries/fileQueries';
import { getRuntimeTransportIdentity, getRuntimeGeneration, subscribeRuntimeEndpointChanged } from './runtime-switch';
import { getRuntimeAuthGeneration, getRuntimeBearerTokenSync, subscribeRuntimeAuthGeneration } from './runtime-auth';
import { runtimeFetch } from './runtime-fetch';
import { normalizeFilePath } from './path-utils';
import { getNativeImageCacheBridge } from './relay/native-asset-bridge';

type RuntimeImageLease = { url: string; release: () => void };
type Resource = { url: string; release: () => Promise<void> };
type Flight = { refs: number; controller: AbortController; promise: Promise<Resource>; resource?: Resource };
const flights = new Map<string, Flight>();
const anonymousScope = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
const MAX_BYTES = 32 * 1024 * 1024;
let subscribed = false;

const dispose = (key: string, flight: Flight) => {
  if (flights.get(key) !== flight) return;
  flights.delete(key);
  flight.controller.abort();
  if (flight.resource) void flight.resource.release().catch(() => {});
};

export const clearRuntimeImageCacheLeases = (): void => {
  for (const [key, flight] of flights) dispose(key, flight);
};

/** Version-checked, single-flight native resources. Unmount releases a lease, not disk bytes. */
export const acquireRuntimeImage = (path: string, signal: AbortSignal): Promise<RuntimeImageLease> => {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  const bridge = getNativeImageCacheBridge();
  if (!bridge) return Promise.resolve({ url: '', release: () => {} });
  if (!subscribed) {
    subscribed = true;
    subscribeRuntimeEndpointChanged(clearRuntimeImageCacheLeases);
    subscribeRuntimeAuthGeneration(clearRuntimeImageCacheLeases);
  }
  const transport = getRuntimeTransportIdentity();
  const generation = getRuntimeGeneration();
  const auth = getRuntimeAuthGeneration();
  const normalized = normalizeFilePath(path);
  const key = JSON.stringify([transport, generation, auth, normalized]);
  let flight = flights.get(key);
  if (!flight) {
    const controller = new AbortController();
    const assertCurrent = () => {
      if (controller.signal.aborted || generation !== getRuntimeGeneration() || auth !== getRuntimeAuthGeneration()
        || transport !== getRuntimeTransportIdentity()) throw new DOMException('Image request superseded', 'AbortError');
    };
    const files = getRegisteredRuntimeAPIs()?.files;
    const bearerScope = getRuntimeBearerTokenSync() || anonymousScope;
    const load = async (): Promise<Resource> => {
      if (!files?.statFile) throw new Error('Image file metadata is unavailable');
      const stat = () => queryClient.fetchQuery({ ...fileStatQueryOptions(files, { scopeDirectory: null, path: normalized }, transport), staleTime: 0, retry: false });
      const before = await stat();
      assertCurrent();
      if (!before.isFile || !Number.isSafeInteger(before.size) || before.size <= 0 || before.size > MAX_BYTES
        || typeof before.mtimeMs !== 'number' || !Number.isFinite(before.mtimeMs)) throw new Error('Image file version is unavailable');
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([
        transport, bearerScope, normalized, before.size, before.mtimeMs,
      ])));
      assertCurrent();
      const cacheKey = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
      const lease = await bridge.acquire({ key: cacheKey, size: before.size });
      try {
        assertCurrent();
        if (!lease.hit) {
          const response = await runtimeFetch('/api/fs/raw', { query: { path: normalized }, signal: controller.signal, cache: 'no-store' });
          if (!response.ok || !response.body) throw new Error(`Image download failed (${response.status})`);
          const mime = response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
          const reader = response.body.getReader();
          let bytes = 0;
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              assertCurrent();
              bytes += value.byteLength;
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
