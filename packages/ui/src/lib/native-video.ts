import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { runtimeFetch, type RuntimeFetchOptions } from './runtime-fetch';
import { readRuntimeFile } from './runtime-file-resource';
import { getRuntimeTransportIdentity, subscribeRuntimeEndpointChanged } from './runtime-switch';
import { subscribeRuntimeAuthGeneration } from './runtime-auth';

export const VIDEO_RANGE_BYTES = 1024 * 1024;
type VideoRequest = { assetId: string; requestId: string; range?: string; method: string; cancelled?: boolean };
type VideoReply = { requestId: string; status: number; contentType?: string; contentRange?: string; contentLength?: number; dataBase64: string };
type VideoPlugin = {
  create(options: { assetId: string }): Promise<{ url: string }>;
  release(options: { assetId: string }): Promise<void>;
  respond(options: VideoReply): Promise<void>;
  addListener(event: 'request', callback: (event: VideoRequest) => void): Promise<PluginListenerHandle>;
};
const plugin = registerPlugin<VideoPlugin>('OpenChamberVideo');

const boundedRange = (range: string | undefined): string => {
  const match = /^bytes=(\d*)-(\d*)$/.exec(range || `bytes=0-${VIDEO_RANGE_BYTES - 1}`);
  if (!match || (!match[1] && !match[2])) throw new Error('Invalid media range');
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new Error('Invalid media range');
    return `bytes=-${Math.min(suffix, VIDEO_RANGE_BYTES)}`;
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : start + VIDEO_RANGE_BYTES - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) throw new Error('Invalid media range');
  return `bytes=${start}-${Math.min(end, start + VIDEO_RANGE_BYTES - 1)}`;
};

const base64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

export async function openNativeVideoSource(
  route: string,
  options: Pick<RuntimeFetchOptions, 'query' | 'headers'>,
  signal: AbortSignal,
): Promise<{ url: string; release: () => Promise<void> } | null> {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'ios' || !Capacitor.isPluginAvailable('OpenChamberVideo')) return null;
  const identity = getRuntimeTransportIdentity();
  const assetId = crypto.randomUUID();
  const requests = new Map<string, AbortController>();
  let disposed = false;
  let unsubscribe = () => {};
  let unsubscribeAuth = () => {};
  const release = async () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    unsubscribeAuth();
    signal.removeEventListener('abort', onAbort);
    for (const controller of requests.values()) controller.abort();
    requests.clear();
    await Promise.allSettled([listener?.remove(), plugin.release({ assetId })]);
  };
  const onAbort = () => { void release(); };
  const respond = async (request: VideoRequest) => {
    if (request.assetId !== assetId || disposed) return;
    if (request.cancelled) { requests.get(request.requestId)?.abort(); return; }
    if (requests.has(request.requestId)) return;
    const controller = new AbortController();
    requests.set(request.requestId, controller);
    let response: Response | undefined;
    try {
      if (identity !== getRuntimeTransportIdentity() || signal.aborted) throw new Error('Video runtime changed');
      const range = request.method === 'HEAD' ? 'bytes=0-0' : boundedRange(request.range);
      const query = new URLSearchParams(route.split('?')[1] ?? '');
      const supplied = options.query instanceof URLSearchParams ? options.query : new URLSearchParams(options.query as Record<string, string> | undefined);
      supplied.forEach((value, key) => query.set(key, value));
      const path = query.get('path');
      response = route.split('?')[0] === '/api/fs/raw' && path
        ? await readRuntimeFile({ path, range, signal: controller.signal,
          directory: new Headers(options.headers).get('x-opencode-directory') ?? query.get('directory') ?? undefined,
          allowOutsideWorkspace: query.get('allowOutsideWorkspace') === 'true', outsideFileGrant: query.get('outsideFileGrant') ?? undefined })
        : await runtimeFetch(route, { ...options, headers: { Range: range }, signal: controller.signal });
      const contentRange = response.headers.get('content-range') || '';
      if (response.status === 416 && /^bytes \*\/\d+$/.test(contentRange)) {
        await plugin.respond({ requestId: request.requestId, status: 416, contentRange, dataBase64: '' });
        return;
      }
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange);
      if (response.status !== 206 || !match) throw new Error('Host does not support video ranges');
      const [start, end, total] = match.slice(1).map(Number);
      const length = end - start + 1;
      if (![start, end, total].every(Number.isSafeInteger) || length <= 0 || length > VIDEO_RANGE_BYTES || end >= total) throw new Error('Invalid video range response');
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Missing video response body');
      const bytes = new Uint8Array(length);
      let offset = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (offset + value.length > length) throw new Error('Oversized video range');
          bytes.set(value, offset); offset += value.length;
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      if (offset !== length) throw new Error('Truncated video range');
      if (disposed || controller.signal.aborted || identity !== getRuntimeTransportIdentity()) return;
      const mime = response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream';
      await plugin.respond({ requestId: request.requestId,
        status: request.method === 'HEAD' ? 200 : 206, contentType: mime,
        contentRange: request.method === 'HEAD' ? undefined : contentRange,
        contentLength: request.method === 'HEAD' ? total : length,
        dataBase64: request.method === 'HEAD' ? '' : base64(bytes) });
    } catch {
      if (!disposed && !controller.signal.aborted) {
        await plugin.respond({ requestId: request.requestId, status: 502, dataBase64: '' }).catch(() => {});
      }
    } finally {
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
      requests.delete(request.requestId);
    }
  };
  const listener = await plugin.addListener('request', event => { void respond(event); });
  signal.addEventListener('abort', onAbort, { once: true });
  unsubscribe = subscribeRuntimeEndpointChanged(onAbort);
  unsubscribeAuth = subscribeRuntimeAuthGeneration(onAbort);
  try {
    signal.throwIfAborted();
    const { url } = await plugin.create({ assetId });
    if (disposed || signal.aborted) { await plugin.release({ assetId }); throw new DOMException('Aborted', 'AbortError'); }
    return { url, release };
  } catch (error) { await release(); throw error; }
}
