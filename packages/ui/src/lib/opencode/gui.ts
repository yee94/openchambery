import { OpenCode } from '@yuriai/opencode-gui-client';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { getRuntimeGeneration, getRuntimeKey, getRuntimeTransportIdentity, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { guiBundleCache, isGuiRevisionToken } from '@/lib/gui-plugins/bundle-cache';
import { guiDownloadProgress } from '@/lib/gui-plugins/download-progress';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** The GUI ABI is pinned independently of the application's session client. */
export function createGuiClient(signal: AbortSignal) {
  const identity = getRuntimeTransportIdentity();
  const generation = getRuntimeGeneration();
  const runtime = getRuntimeKey();
  const current = () => identity === getRuntimeTransportIdentity() && generation === getRuntimeGeneration() && runtime === getRuntimeKey();
  return OpenCode.make({
    baseUrl: new URL(getRuntimeUrlResolver().api('/'), window.location.href).href,
    fetch: async (input, init) => {
      if (signal.aborted || !current()) {
        throw new DOMException('Plugin runtime ended', 'AbortError');
      }
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const target = new URL(getRuntimeUrlResolver().api(`${url.pathname}${url.search}`), window.location.href);
      const request = new Request(target, input instanceof Request ? input : init);
      const requestInit = {
        ...init,
        signal: AbortSignal.any([signal, request.signal, ...(init?.signal ? [init.signal] : [])]),
      };
      const id = url.searchParams.get('id');
      if ((init?.method ?? request.method).toUpperCase() !== 'GET' || url.pathname !== '/api/plugin/gui' || !id) {
        return runtimeFetch(request, requestInit);
      }
      const lifetime = new AbortController();
      const stop = subscribeRuntimeEndpointChanged(() => { if (!current()) lifetime.abort(); });
      const requestSignal = AbortSignal.any([requestInit.signal, lifetime.signal]);
      const assertCurrent = () => {
        requestSignal.throwIfAborted();
        if (!current()) throw new DOMException('Plugin runtime ended', 'AbortError');
      };
      let finishDownload: (() => void) | undefined;
      const downloading = () => { finishDownload ??= guiDownloadProgress.begin(identity, requestSignal); };
      try {
        const cached = await guiBundleCache.read(runtime, id, requestSignal);
        assertCurrent();
        if (!cached) downloading();
        const fetchBundle = async (token?: string) => {
          assertCurrent();
          const headers = new Headers(init?.headers ?? request.headers);
          headers.delete('X-Yuri-Gui-Revision');
          headers.delete('If-None-Match');
          if (token) headers.set('X-Yuri-Gui-Revision', token);
          return runtimeFetch(request, { ...requestInit, signal: requestSignal, headers, cache: 'no-store' });
        };
        let response = await fetchBundle(cached?.token);
        let revalidated = !!cached;
        assertCurrent();
        if (response.headers.get('X-Yuri-Gui-Code') === 'cached'
          && (!cached || response.headers.get('X-Yuri-Gui-Revision') !== cached.token)) {
          await response.body?.cancel();
          revalidated = false;
          downloading();
          response = await fetchBundle();
          assertCurrent();
        }
        if (response.status !== 200) return response;
        // Headers are authoritative: a full response now needs code bytes, even
        // when a previous revision was available on disk. Revalidation is silent.
        if (response.headers.get('X-Yuri-Gui-Code') !== 'cached') downloading();
        const payload: unknown = await response.clone().json();
        assertCurrent();
        if (!object(payload) || !object(payload.data) || typeof payload.data.code !== 'string'
          || typeof payload.data.revision !== 'string' || !object(payload.data.options)) {
          throw new Error('Invalid GUI bundle response');
        }
        const token = response.headers.get('X-Yuri-Gui-Revision');
        if (response.headers.get('X-Yuri-Gui-Code') === 'cached') {
          if (!revalidated || !cached || token !== cached.token || payload.data.code !== '') throw new Error('Invalid GUI code cache response');
          payload.data.code = cached.code;
          const headers = new Headers(response.headers);
          headers.delete('content-length');
          headers.delete('content-encoding');
          response = Response.json(payload, { status: 200, headers });
        } else if (isGuiRevisionToken(token) && payload.data.code) {
          assertCurrent();
          await guiBundleCache.write(runtime, id, { code: payload.data.code, token }, requestSignal);
        }
        assertCurrent();
        return response;
      } finally { finishDownload?.(); stop(); }
    },
  });
}
