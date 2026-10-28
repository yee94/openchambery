import { OpenCode } from '@yuriai/opencode-gui-client';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';

/** The GUI ABI is pinned independently of the application's session client. */
export function createGuiClient(signal: AbortSignal) {
  const identity = getRuntimeTransportIdentity();
  const generation = getRuntimeGeneration();
  return OpenCode.make({
    baseUrl: new URL(getRuntimeUrlResolver().api('/'), window.location.href).href,
    fetch: (input, init) => {
      if (signal.aborted || identity !== getRuntimeTransportIdentity() || generation !== getRuntimeGeneration()) {
        return Promise.reject(new DOMException('Plugin runtime ended', 'AbortError'));
      }
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const target = new URL(getRuntimeUrlResolver().api(`${url.pathname}${url.search}`), window.location.href);
      const request = new Request(target, input instanceof Request ? input : init);
      return runtimeFetch(request, {
        ...init,
        signal: AbortSignal.any([signal, request.signal, ...(init?.signal ? [init.signal] : [])]),
      });
    },
  });
}
