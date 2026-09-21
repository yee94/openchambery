/**
 * Electron + Relay Preview gateway client (renderer).
 *
 * Owns: ensure loopback origin, listen for gateway HTTP + WS from main,
 * `runtimeFetch` / `openRuntimeWebSocket` the same path (tunnel when relay is
 * active), and stream response / WS frames back via IPC.
 *
 * Main never sees Relay credentials — only method + path (query tokens included).
 * Upstream Set-Cookie is intentionally dropped at the gateway; auth is query-token only.
 */

import { runtimeFetch } from '@/lib/runtime-fetch';
import { isRelayModeActive } from '@/lib/relay/runtime-tunnel';
import { isNormalizedPreviewProxyPath } from '@/lib/preview/relay-preview-frame-src';
import { openRuntimeWebSocket } from '@/lib/relay/runtime-socket';
import type { RelayTunnelWebSocket } from '@/lib/relay/tunnel-client';
import { refreshRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';

const REQUEST_EVENT = 'openchamber:preview-gateway-request';
const ABORT_EVENT = 'openchamber:preview-gateway-abort';
const WS_OPEN_EVENT = 'openchamber:preview-gateway-ws-open';
const WS_MESSAGE_EVENT = 'openchamber:preview-gateway-ws-message';
const WS_CLOSE_EVENT = 'openchamber:preview-gateway-ws-close';

type PreviewGatewayApi = {
  ensure: () => Promise<{ origin: string }>;
  release?: () => Promise<{ ok: true } | void>;
  begin: (payload: {
    requestId: string;
    status: number;
    headers: Record<string, string>;
  }) => Promise<unknown>;
  push: (requestId: string, chunk: ArrayBuffer | Uint8Array) => Promise<unknown>;
  end: (requestId: string) => Promise<unknown>;
  abort: (requestId: string) => Promise<unknown>;
  wsOpened?: (payload: { requestId: string; protocol?: string }) => Promise<unknown>;
  wsSend?: (requestId: string, data: ArrayBuffer | string, binary?: boolean) => Promise<unknown>;
  wsClose?: (requestId: string, payload?: { code?: number; reason?: string }) => Promise<unknown>;
};

type DesktopBridge = {
  previewGateway?: PreviewGatewayApi;
  listen?: (
    event: string,
    handler: (evt: { payload?: unknown }) => void,
  ) => Promise<() => void> | (() => void);
};

const isFunction = (value: unknown): value is (...args: never[]) => unknown =>
  typeof value === 'function';

const readPreviewGatewayApi = (): PreviewGatewayApi | null => {
  if (typeof window === 'undefined') return null;
  const desktop = (window as unknown as { __OPENCHAMBER_DESKTOP__?: DesktopBridge })
    .__OPENCHAMBER_DESKTOP__;
  const api = desktop?.previewGateway;
  if (
    !api
    || !isFunction(api.ensure)
    || !isFunction(api.begin)
    || !isFunction(api.push)
    || !isFunction(api.end)
    || !isFunction(api.abort)
  ) {
    return null;
  }
  return api;
};

const readDesktopListen = (): DesktopBridge['listen'] | null => {
  if (typeof window === 'undefined') return null;
  const desktop = (window as unknown as { __OPENCHAMBER_DESKTOP__?: DesktopBridge })
    .__OPENCHAMBER_DESKTOP__;
  return isFunction(desktop?.listen) ? desktop.listen : null;
};

/** True when the desktop preload exposed the local-only preview gateway API. */
export const hasDesktopPreviewGateway = (): boolean => readPreviewGatewayApi() !== null;

const headersToRecord = (headers: Headers): Record<string, string> => {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    // Gateway strips Set-Cookie; skip early so we never IPC cookie material.
    if (lower === 'set-cookie' || lower === 'set-cookie2') return;
    if (lower === 'content-length' || lower === 'content-encoding') return;
    out[lower] = value;
  });
  return out;
};

type GatewayRequestDetail = {
  requestId: string;
  method: string;
  path: string;
};

const isGatewayRequestDetail = (value: unknown): value is GatewayRequestDetail => {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.requestId === 'string'
    && record.requestId.length > 0
    && typeof record.method === 'string'
    && typeof record.path === 'string'
    && isNormalizedPreviewProxyPath(record.path)
  );
};

type GatewayWsOpenDetail = {
  requestId: string;
  path: string;
  protocols?: string[];
};

const isGatewayWsOpenDetail = (value: unknown): value is GatewayWsOpenDetail => {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (
    typeof record.requestId !== 'string'
    || !record.requestId
    || typeof record.path !== 'string'
    || !isNormalizedPreviewProxyPath(record.path)
  ) {
    return false;
  }
  if (record.protocols !== undefined) {
    if (!Array.isArray(record.protocols) || !record.protocols.every((p) => typeof p === 'string')) {
      return false;
    }
  }
  return true;
};

type GatewayWsMessageDetail = {
  requestId: string;
  data: ArrayBuffer | string;
  binary: boolean;
};

const isGatewayWsMessageDetail = (value: unknown): value is GatewayWsMessageDetail => {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (typeof record.requestId !== 'string' || !record.requestId) return false;
  if (typeof record.binary !== 'boolean') return false;
  // Text frames may arrive as string; binary as ArrayBuffer / view.
  if (typeof record.data === 'string') return true;
  if (record.data instanceof ArrayBuffer) return true;
  if (ArrayBuffer.isView(record.data)) return true;
  return false;
};

type GatewayWsCloseDetail = {
  requestId: string;
  code: number;
  reason: string;
};

const isGatewayWsCloseDetail = (value: unknown): value is GatewayWsCloseDetail => {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.requestId === 'string'
    && record.requestId.length > 0
    && typeof record.code === 'number'
    && typeof record.reason === 'string'
  );
};

/** In-flight AbortControllers keyed by gateway HTTP requestId. */
const inflightControllers = new Map<string, AbortController>();

/** In-flight tunnel sockets keyed by gateway WS requestId. */
const inflightWs = new Map<string, RelayTunnelWebSocket>();

let attachPromise: Promise<void> | null = null;
let unsubscribers: Array<() => void> = [];
let ensurePromise: Promise<string | null> | null = null;
let cachedOrigin: string | null = null;

const detachListeners = () => {
  for (const unsub of unsubscribers) {
    try {
      unsub();
    } catch {
      // ignore
    }
  }
  unsubscribers = [];
  for (const controller of inflightControllers.values()) {
    try {
      controller.abort();
    } catch {
      // ignore
    }
  }
  inflightControllers.clear();
  for (const [requestId, socket] of inflightWs.entries()) {
    inflightWs.delete(requestId);
    try {
      socket.close(1001, 'gateway detach');
    } catch {
      // ignore
    }
  }
};

/**
 * Build a runtime WS URL for the gateway path: mint a fresh oc_url_token while
 * preserving oc_preview_token (and any other query) from the iframe request.
 */
const buildPreviewProxyWebSocketUrl = (pathWithQuery: string): string => {
  let pathname = pathWithQuery;
  let search = '';
  const q = pathWithQuery.indexOf('?');
  if (q >= 0) {
    pathname = pathWithQuery.slice(0, q);
    search = pathWithQuery.slice(q + 1);
  }
  const params = new URLSearchParams(search);
  // Drop stale URL auth; resolver re-appends the minted token.
  params.delete('oc_url_token');
  const queryRecord: Record<string, string> = {};
  params.forEach((value, key) => {
    queryRecord[key] = value;
  });
  return getRuntimeUrlResolver().websocket(pathname, queryRecord);
};

const handleGatewayRequest = async (detail: GatewayRequestDetail): Promise<void> => {
  const api = readPreviewGatewayApi();
  if (!api) return;
  if (!isRelayModeActive()) {
    try {
      await api.abort(detail.requestId);
    } catch {
      // best-effort
    }
    return;
  }

  const existing = inflightControllers.get(detail.requestId);
  if (existing) {
    existing.abort();
    inflightControllers.delete(detail.requestId);
  }

  const controller = new AbortController();
  inflightControllers.set(detail.requestId, controller);

  try {
    // Path includes query tokens (oc_preview_token / oc_url_token). runtimeFetch
    // attaches bearer/tunnel auth; do not forward iframe Cookie/Authorization.
    const response = await runtimeFetch(detail.path, {
      method: detail.method || 'GET',
      signal: controller.signal,
      // Avoid browser cookie jar on the parent document; tokens are in the query.
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'manual',
    });

    if (controller.signal.aborted) {
      try {
        await api.abort(detail.requestId);
      } catch {
        // best-effort
      }
      return;
    }

    await api.begin({
      requestId: detail.requestId,
      status: response.status,
      headers: headersToRecord(response.headers),
    });

    // HEAD has no body.
    if (detail.method.toUpperCase() === 'HEAD' || !response.body) {
      await api.end(detail.requestId);
      return;
    }

    const reader = response.body.getReader();
    try {
      while (true) {
        if (controller.signal.aborted) {
          try {
            await reader.cancel();
          } catch {
            // ignore
          }
          try {
            await api.abort(detail.requestId);
          } catch {
            // ignore
          }
          return;
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        // Copy for structured-clone IPC; await push for backpressure.
        const copy = value.byteOffset === 0 && value.byteLength === value.buffer.byteLength
          ? value
          : value.slice();
        await api.push(detail.requestId, copy);
      }
      await api.end(detail.requestId);
    } catch (error) {
      if (controller.signal.aborted) {
        try {
          await api.abort(detail.requestId);
        } catch {
          // ignore
        }
        return;
      }
      try {
        await api.abort(detail.requestId);
      } catch {
        // ignore
      }
      throw error;
    }
  } catch {
    if (!controller.signal.aborted) {
      try {
        await api.abort(detail.requestId);
      } catch {
        // ignore
      }
    }
  } finally {
    inflightControllers.delete(detail.requestId);
  }
};

const closeTunnelWs = (requestId: string, code = 1000, reason = '') => {
  const socket = inflightWs.get(requestId);
  if (!socket) return;
  inflightWs.delete(requestId);
  try {
    socket.close(code, reason);
  } catch {
    // ignore
  }
};

const handleGatewayWsOpen = async (detail: GatewayWsOpenDetail): Promise<void> => {
  const api = readPreviewGatewayApi();
  if (!api || !isFunction(api.wsOpened) || !isFunction(api.wsSend) || !isFunction(api.wsClose)) {
    return;
  }
  if (!isRelayModeActive()) {
    try {
      await api.wsClose(detail.requestId, { code: 1011, reason: 'relay inactive' });
    } catch {
      // best-effort
    }
    return;
  }

  // Replace any prior socket for the same id (should not happen).
  closeTunnelWs(detail.requestId, 1001, 'replaced');

  try {
    // WebSocket upgrades cannot carry Authorization; mint URL token first.
    try {
      await refreshRuntimeUrlAuthToken();
    } catch {
      // Local runtimes without auth can connect without a URL token.
    }

    const url = buildPreviewProxyWebSocketUrl(detail.path);
    const protocols = detail.protocols && detail.protocols.length > 0
      ? detail.protocols
      : undefined;
    const socket = openRuntimeWebSocket(url, protocols);
    inflightWs.set(detail.requestId, socket);

    socket.onopen = () => {
      if (inflightWs.get(detail.requestId) !== socket) return;
      void api.wsOpened?.({ requestId: detail.requestId }).catch(() => {
        closeTunnelWs(detail.requestId, 1011, 'wsOpened failed');
      });
    };

    socket.onmessage = (event) => {
      if (inflightWs.get(detail.requestId) !== socket) return;
      const data = event.data;
      if (typeof data === 'string') {
        void api.wsSend?.(detail.requestId, data, false).catch(() => {
          // local socket may already be gone
        });
        return;
      }
      if (data instanceof ArrayBuffer) {
        void api.wsSend?.(detail.requestId, data, true).catch(() => {});
        return;
      }
      if (ArrayBuffer.isView(data)) {
        const view = data as ArrayBufferView;
        const copy = view.byteOffset === 0 && view.byteLength === view.buffer.byteLength
          ? view.buffer
          : view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
        void api.wsSend?.(detail.requestId, copy as ArrayBuffer, true).catch(() => {});
      }
    };

    socket.onerror = () => {
      // Prefer onclose for teardown.
    };

    socket.onclose = (event) => {
      if (inflightWs.get(detail.requestId) === socket) {
        inflightWs.delete(detail.requestId);
      }
      void api.wsClose?.(detail.requestId, {
        code: typeof event?.code === 'number' ? event.code : 1006,
        reason: typeof event?.reason === 'string' ? event.reason : '',
      }).catch(() => {});
    };
  } catch {
    try {
      await api.wsClose?.(detail.requestId, { code: 1011, reason: 'tunnel open failed' });
    } catch {
      // ignore
    }
  }
};

const toArrayBuffer = (data: ArrayBuffer | ArrayBufferView): ArrayBuffer => {
  if (data instanceof ArrayBuffer) return data;
  const view = data;
  const copy = new Uint8Array(view.byteLength);
  copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  return copy.buffer;
};

const handleGatewayWsMessage = (detail: GatewayWsMessageDetail): void => {
  const socket = inflightWs.get(detail.requestId);
  if (!socket) return;
  try {
    if (typeof detail.data === 'string') {
      socket.send(detail.data);
      return;
    }
    const buffer = ArrayBuffer.isView(detail.data) || detail.data instanceof ArrayBuffer
      ? toArrayBuffer(detail.data as ArrayBuffer | ArrayBufferView)
      : null;
    if (!buffer) return;
    // Preserve text vs binary so Vite HMR JSON frames stay text on the tunnel.
    if (!detail.binary) {
      socket.send(new TextDecoder().decode(buffer));
      return;
    }
    socket.send(buffer);
  } catch {
    // socket may already be closed
  }
};

const handleGatewayWsClose = (detail: GatewayWsCloseDetail): void => {
  closeTunnelWs(detail.requestId, detail.code, detail.reason);
};

const onRequestEvent = (evt: { payload?: unknown }) => {
  const detail = evt?.payload;
  if (!isGatewayRequestDetail(detail)) return;
  void handleGatewayRequest(detail);
};

const onAbortEvent = (evt: { payload?: unknown }) => {
  const detail = evt?.payload;
  if (!detail || typeof detail !== 'object') return;
  const requestId = (detail as { requestId?: unknown }).requestId;
  if (typeof requestId !== 'string' || !requestId) return;
  const controller = inflightControllers.get(requestId);
  if (controller) {
    controller.abort();
    inflightControllers.delete(requestId);
  }
  // HTTP abort channel only; WS teardown uses ws-close from main.
};

const onWsOpenEvent = (evt: { payload?: unknown }) => {
  const detail = evt?.payload;
  if (!isGatewayWsOpenDetail(detail)) return;
  void handleGatewayWsOpen(detail);
};

const onWsMessageEvent = (evt: { payload?: unknown }) => {
  const detail = evt?.payload;
  if (!isGatewayWsMessageDetail(detail)) return;
  handleGatewayWsMessage(detail);
};

const onWsCloseEvent = (evt: { payload?: unknown }) => {
  const detail = evt?.payload;
  if (!isGatewayWsCloseDetail(detail)) return;
  handleGatewayWsClose(detail);
};

/**
 * Attach gateway request/abort/WS listeners once (module singleton).
 * Safe to call repeatedly; no-ops when the desktop API is absent.
 */
export const attachRelayPreviewGatewayClient = (): Promise<void> => {
  if (attachPromise) return attachPromise;

  attachPromise = (async () => {
    const api = readPreviewGatewayApi();
    const listen = readDesktopListen();
    if (!api || !listen) {
      attachPromise = null;
      return;
    }

    detachListeners();

    const bind = async (event: string, handler: (evt: { payload?: unknown }) => void) => {
      const unsub = await listen(event, handler);
      if (typeof unsub === 'function') {
        unsubscribers.push(unsub);
      }
    };

    await bind(REQUEST_EVENT, onRequestEvent);
    await bind(ABORT_EVENT, onAbortEvent);
    await bind(WS_OPEN_EVENT, onWsOpenEvent);
    await bind(WS_MESSAGE_EVENT, onWsMessageEvent);
    await bind(WS_CLOSE_EVENT, onWsCloseEvent);
  })().catch((error) => {
    attachPromise = null;
    throw error;
  });

  return attachPromise;
};

/**
 * Ensure the local loopback gateway is running and this renderer is the owner.
 * Only meaningful on Electron local pages when Relay is active.
 *
 * @returns gateway origin (`http://127.0.0.1:<port>`) or null when unavailable
 */
export const ensurePreviewGatewayOrigin = async (): Promise<string | null> => {
  if (!isRelayModeActive()) {
    cachedOrigin = null;
    return null;
  }

  const api = readPreviewGatewayApi();
  if (!api) {
    cachedOrigin = null;
    return null;
  }

  await attachRelayPreviewGatewayClient();

  if (ensurePromise) {
    return ensurePromise;
  }

  ensurePromise = (async () => {
    try {
      const result = await api.ensure();
      const origin = typeof result?.origin === 'string' ? result.origin.trim() : '';
      if (!origin) {
        cachedOrigin = null;
        return null;
      }
      // Defense in depth: only accept loopback origins from main.
      try {
        const parsed = new URL(origin);
        if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
          cachedOrigin = null;
          return null;
        }
      } catch {
        cachedOrigin = null;
        return null;
      }
      cachedOrigin = origin;
      return origin;
    } catch {
      cachedOrigin = null;
      return null;
    } finally {
      ensurePromise = null;
    }
  })();

  return ensurePromise;
};

/** Last successfully ensured origin (may be stale if window/owner changed). */
export const getCachedPreviewGatewayOrigin = (): string | null => cachedOrigin;

/** Test helper: reset module singleton state. */
export const resetRelayPreviewGatewayClientForTests = (): void => {
  detachListeners();
  attachPromise = null;
  ensurePromise = null;
  cachedOrigin = null;
};
