/**
 * Loopback HTTP + WebSocket gateway for Electron Preview over Relay.
 *
 * Main process is a dumb pipe: bind 127.0.0.1 + ephemeral port, accept only
 * GET/HEAD (and WS upgrade) under `/api/preview/proxy/`, and stream bytes /
 * WS frames from the owner renderer over IPC. No Relay keys, Host URLs, or
 * bearer tokens live here.
 *
 * Auth for the Host preview proxy stays in the renderer (`runtimeFetch` /
 * `openRuntimeWebSocket` + `oc_preview_token` / `oc_url_token` query rewrite).
 * Chromium cannot surface upstream `Set-Cookie` from the tunneled response
 * into the iframe jar, so we never re-emit Set-Cookie — previewed-app login
 * cookies are dropped on Relay.
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

export const PREVIEW_GATEWAY_PATH_PREFIX = '/api/preview/proxy/';

/** Resolve `ws` through `@openchambery/web` (no direct electron dependency). */
const loadWs = () => {
  const requireHere = createRequire(import.meta.url);
  try {
    return requireHere('ws');
  } catch {
    const webPkg = requireHere.resolve('@openchambery/web/package.json');
    return createRequire(webPkg)('ws');
  }
};

/** Hop-by-hop + cookie headers never forwarded on the dumb pipe. */
export const PREVIEW_GATEWAY_RESPONSE_HEADER_BLOCKLIST = Object.freeze(new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  // Streamed IPC body is re-chunked; upstream length/encoding no longer apply.
  'content-length',
  'content-encoding',
  // Chromium renderer cannot apply tunneled Set-Cookie into the iframe jar.
  // Auth relies on oc_preview_token + oc_url_token query rewrite only.
  'set-cookie',
  'set-cookie2',
]));

/**
 * @param {unknown} method
 * @returns {boolean}
 */
export const isPreviewGatewayMethodAllowed = (method) => {
  const normalized = typeof method === 'string' ? method.trim().toUpperCase() : '';
  return normalized === 'GET' || normalized === 'HEAD';
};

/**
 * Path filter for the unauthenticated loopback front door.
 * Accepts pathname only or path+search; only the pathname is checked.
 * Same prefix for HTTP GET/HEAD and WebSocket upgrade.
 *
 * @param {unknown} pathWithOptionalQuery
 * @returns {boolean}
 */
export const isPreviewGatewayPathAllowed = (pathWithOptionalQuery) => {
  if (typeof pathWithOptionalQuery !== 'string' || !pathWithOptionalQuery) return false;
  const pathOnly = pathWithOptionalQuery.split('?', 1)[0] || '';
  if (pathOnly.includes('\\') || pathOnly.includes('\0')) return false;
  try {
    const parsed = new URL(pathOnly, 'http://127.0.0.1');
    if (parsed.hostname !== '127.0.0.1') return false;
    return parsed.pathname.startsWith(PREVIEW_GATEWAY_PATH_PREFIX);
  } catch {
    return false;
  }
};

/**
 * @param {import('node:http').IncomingMessage | { headers?: Record<string, unknown>; method?: string }} req
 * @returns {boolean}
 */
export const isPreviewGatewayWebSocketUpgrade = (req) => {
  if (!req || typeof req !== 'object') return false;
  const method = typeof req.method === 'string' ? req.method.trim().toUpperCase() : 'GET';
  if (method !== 'GET') return false;
  const headers = req.headers && typeof req.headers === 'object' ? req.headers : {};
  const upgradeRaw = headers.upgrade ?? headers.Upgrade;
  const upgrade = Array.isArray(upgradeRaw) ? upgradeRaw[0] : upgradeRaw;
  return String(upgrade || '').toLowerCase() === 'websocket';
};

/**
 * @param {unknown} header
 * @returns {string[]}
 */
export const parseSecWebSocketProtocols = (header) => {
  const raw = Array.isArray(header) ? header.join(',') : header;
  if (typeof raw !== 'string' || !raw.trim()) return [];
  return raw.split(',').map((part) => part.trim()).filter(Boolean);
};

/**
 * @param {unknown} chunk
 * @returns {Uint8Array}
 */
export const coerceGatewayChunkBytes = (chunk) => {
  if (chunk instanceof Uint8Array) {
    return chunk.byteLength === chunk.buffer.byteLength && chunk.byteOffset === 0
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
 * @param {Record<string, unknown> | Headers | undefined | null} headers
 * @returns {Record<string, string | string[]>}
 */
export const sanitizePreviewGatewayResponseHeaders = (headers) => {
  /** @type {Record<string, string | string[]>} */
  const out = {};
  if (!headers || typeof headers !== 'object') return out;

  const append = (rawName, rawValue) => {
    if (typeof rawName !== 'string' || !rawName.trim()) return;
    const name = rawName.trim().toLowerCase();
    if (PREVIEW_GATEWAY_RESPONSE_HEADER_BLOCKLIST.has(name)) return;
    if (rawValue === undefined || rawValue === null) return;
    if (Array.isArray(rawValue)) {
      const values = rawValue
        .filter((value) => typeof value === 'string' || typeof value === 'number')
        .map((value) => String(value));
      if (values.length === 0) return;
      out[name] = values.length === 1 ? values[0] : values;
      return;
    }
    if (typeof rawValue === 'string' || typeof rawValue === 'number' || typeof rawValue === 'boolean') {
      out[name] = String(rawValue);
    }
  };

  if (typeof headers.forEach === 'function') {
    headers.forEach((value, name) => append(name, value));
    return out;
  }

  for (const [name, value] of Object.entries(headers)) {
    append(name, value);
  }
  return out;
};

/**
 * @typedef {object} PreviewGatewayRequestPayload
 * @property {string} requestId
 * @property {string} method
 * @property {string} path  pathname + search (no origin); includes query tokens
 */

/**
 * @typedef {object} PreviewGatewayWsOpenPayload
 * @property {string} requestId
 * @property {string} path  pathname + search (no origin); includes query tokens
 * @property {string[]} [protocols]
 */

/**
 * @typedef {object} CreatePreviewLoopbackGatewayOptions
 * @property {(payload: PreviewGatewayRequestPayload) => boolean | void} sendToOwner
 *   Deliver an HTTP request to the owner renderer. Return false when delivery fails.
 * @property {(payload: PreviewGatewayWsOpenPayload) => boolean | void} [sendWsOpenToOwner]
 *   Deliver a WebSocket open to the owner renderer. Defaults to false (reject upgrade).
 * @property {(payload: { requestId: string; data: ArrayBuffer; binary: boolean }) => boolean | void} [sendWsMessageToOwner]
 *   Client → owner frame. Return false when delivery fails.
 * @property {(payload: { requestId: string; code: number; reason: string }) => boolean | void} [sendWsCloseToOwner]
 *   Client closed the local socket.
 * @property {(path: string) => boolean} [isPathAllowed]
 * @property {(requestId: string) => void} [onClientAbort]
 *   Owner-facing abort when the iframe/client closes the HTTP socket (not WS).
 * @property {() => string} [idFactory]
 */

/**
 * @param {CreatePreviewLoopbackGatewayOptions} options
 */
export const createPreviewLoopbackGateway = (options = {}) => {
  if (typeof options.sendToOwner !== 'function') {
    throw new Error('sendToOwner is required');
  }
  const sendToOwner = options.sendToOwner;
  const sendWsOpenToOwner = typeof options.sendWsOpenToOwner === 'function'
    ? options.sendWsOpenToOwner
    : null;
  const sendWsMessageToOwner = typeof options.sendWsMessageToOwner === 'function'
    ? options.sendWsMessageToOwner
    : null;
  const sendWsCloseToOwner = typeof options.sendWsCloseToOwner === 'function'
    ? options.sendWsCloseToOwner
    : null;
  const isPathAllowed = typeof options.isPathAllowed === 'function'
    ? options.isPathAllowed
    : isPreviewGatewayPathAllowed;
  const onClientAbort = typeof options.onClientAbort === 'function'
    ? options.onClientAbort
    : null;
  const idFactory = typeof options.idFactory === 'function'
    ? options.idFactory
    : () => randomUUID();

  /** @type {import('node:http').Server | null} */
  let server = null;
  /** @type {string | null} */
  let origin = null;
  let ownerPresent = true;

  /** @type {import('ws').WebSocketServer | null} */
  let wsServer = null;

  /**
   * @typedef {object} InFlight
   * @property {import('node:http').ServerResponse} res
   * @property {boolean} headersSent
   * @property {boolean} finished
   * @property {boolean} aborted
   * @property {Array<() => void>} drainWaiters
   */

  /** @type {Map<string, InFlight>} */
  const inflight = new Map();

  /**
   * @typedef {object} InFlightWs
   * @property {import('ws').WebSocket} socket
   * @property {boolean} opened
   * @property {boolean} finished
   * @property {Array<[unknown, boolean]>} pendingFromClient
   */

  /** @type {Map<string, InFlightWs>} */
  const inflightWs = new Map();

  const wakeDrain = (/** @type {InFlight} */ entry) => {
    const waiters = entry.drainWaiters.splice(0, entry.drainWaiters.length);
    for (const wake of waiters) wake();
  };

  const failInFlight = (/** @type {InFlight} */ entry, status = 503) => {
    if (entry.finished || entry.aborted) return;
    entry.aborted = true;
    entry.finished = true;
    wakeDrain(entry);
    try {
      if (!entry.headersSent && !entry.res.headersSent) {
        entry.res.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' });
        entry.headersSent = true;
        entry.res.end(status === 503 ? 'Service Unavailable' : '');
      } else if (!entry.res.writableEnded) {
        entry.res.destroy();
      }
    } catch {
      try {
        entry.res.destroy();
      } catch {
        // ignore
      }
    }
  };

  const destroyInFlight = (requestId, status = 503) => {
    const entry = inflight.get(requestId);
    if (!entry) return;
    inflight.delete(requestId);
    failInFlight(entry, status);
  };

  const abortAllInFlight = (status = 503) => {
    for (const requestId of [...inflight.keys()]) {
      destroyInFlight(requestId, status);
    }
    for (const requestId of [...inflightWs.keys()]) {
      destroyInFlightWs(requestId, 1011, 'owner gone');
    }
  };

  /**
   * @param {string} requestId
   * @param {number} [code]
   * @param {string} [reason]
   */
  const destroyInFlightWs = (requestId, code = 1011, reason = 'aborted') => {
    const entry = inflightWs.get(requestId);
    if (!entry) return;
    inflightWs.delete(requestId);
    if (entry.finished) return;
    entry.finished = true;
    entry.pendingFromClient.length = 0;
    try {
      const socket = entry.socket;
      if (
        socket.readyState === socket.OPEN
        || socket.readyState === socket.CONNECTING
      ) {
        socket.close(code, reason);
      }
    } catch {
      try {
        entry.socket.terminate();
      } catch {
        // ignore
      }
    }
  };

  /**
   * Reject a raw upgrade socket without completing the handshake.
   * @param {import('node:stream').Duplex} socket
   * @param {number} statusCode
   * @param {string} message
   */
  const rejectUpgrade = (socket, statusCode, message) => {
    try {
      const body = typeof message === 'string' ? message : '';
      socket.write(
        `HTTP/1.1 ${statusCode} ${statusCode === 404 ? 'Not Found' : statusCode === 503 ? 'Service Unavailable' : 'Error'}\r\n`
        + 'Connection: close\r\n'
        + 'Cache-Control: no-store\r\n'
        + 'Content-Type: text/plain; charset=utf-8\r\n'
        + `Content-Length: ${Buffer.byteLength(body)}\r\n`
        + '\r\n'
        + body,
      );
    } catch {
      // ignore
    }
    try {
      socket.destroy();
    } catch {
      // ignore
    }
  };

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:stream').Duplex} socket
   * @param {Buffer} head
   */
  const handleUpgrade = (req, socket, head) => {
    const rawUrl = typeof req.url === 'string' ? req.url : '/';

    if (!isPreviewGatewayWebSocketUpgrade(req) || !isPathAllowed(rawUrl)) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }

    if (!ownerPresent || !server || !wsServer || !sendWsOpenToOwner) {
      rejectUpgrade(socket, 503, 'Service Unavailable');
      return;
    }

    const requestId = idFactory();
    if (typeof requestId !== 'string' || !requestId.trim()) {
      rejectUpgrade(socket, 500, 'Internal Error');
      return;
    }

    const protocols = parseSecWebSocketProtocols(req.headers['sec-websocket-protocol']);

    try {
      wsServer.handleUpgrade(req, socket, head, (ws) => {
        /** @type {InFlightWs} */
        const entry = {
          socket: ws,
          opened: false,
          finished: false,
          pendingFromClient: [],
        };
        inflightWs.set(requestId, entry);

        ws.on('message', (data, isBinary) => {
          if (entry.finished) return;
          if (!entry.opened) {
            entry.pendingFromClient.push([data, Boolean(isBinary)]);
            return;
          }
          forwardClientWsMessage(requestId, data, Boolean(isBinary));
        });

        ws.on('close', (code, reasonBuffer) => {
          if (entry.finished) return;
          entry.finished = true;
          inflightWs.delete(requestId);
          entry.pendingFromClient.length = 0;
          const reason = reasonBuffer ? reasonBuffer.toString('utf8') : '';
          try {
            sendWsCloseToOwner?.({
              requestId,
              code: typeof code === 'number' ? code : 1000,
              reason,
            });
          } catch {
            // best-effort
          }
        });

        ws.on('error', () => {
          if (entry.finished) return;
          // close follows
        });

        let delivered = false;
        try {
          delivered = sendWsOpenToOwner({
            requestId,
            path: rawUrl,
            ...(protocols.length > 0 ? { protocols } : {}),
          }) !== false;
        } catch {
          delivered = false;
        }

        if (!delivered) {
          inflightWs.delete(requestId);
          entry.finished = true;
          try {
            ws.close(1011, 'owner unavailable');
          } catch {
            try {
              ws.terminate();
            } catch {
              // ignore
            }
          }
        }
      });
    } catch {
      rejectUpgrade(socket, 500, 'Upgrade failed');
    }
  };

  /**
   * @param {string} requestId
   * @param {unknown} data
   * @param {boolean} binary
   */
  const forwardClientWsMessage = (requestId, data, binary) => {
    if (!sendWsMessageToOwner) return;
    try {
      // Prefer string for text frames so IPC + tunnel stay UTF-8 text (Vite HMR).
      if (!binary && (typeof data === 'string' || Buffer.isBuffer(data))) {
        const text = typeof data === 'string' ? data : data.toString('utf8');
        sendWsMessageToOwner({ requestId, data: text, binary: false });
        return;
      }
      /** @type {ArrayBuffer} */
      let buffer;
      if (typeof data === 'string') {
        const bytes = Buffer.from(data, 'utf8');
        buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      } else if (Buffer.isBuffer(data)) {
        buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      } else if (data instanceof ArrayBuffer) {
        buffer = data;
      } else if (ArrayBuffer.isView(data)) {
        buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      } else {
        return;
      }
      sendWsMessageToOwner({ requestId, data: buffer, binary: true });
    } catch {
      // owner notify is best-effort
    }
  };

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  const handleHttpRequest = (req, res) => {
    const method = typeof req.method === 'string' ? req.method : 'GET';
    const rawUrl = typeof req.url === 'string' ? req.url : '/';

    if (!isPreviewGatewayMethodAllowed(method) || !isPathAllowed(rawUrl)) {
      res.writeHead(404, { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    if (!ownerPresent || !server) {
      res.writeHead(503, { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Service Unavailable');
      return;
    }

    const requestId = idFactory();
    if (typeof requestId !== 'string' || !requestId.trim()) {
      res.writeHead(500, { 'Cache-Control': 'no-store' });
      res.end('Internal Error');
      return;
    }

    /** @type {InFlight} */
    const entry = {
      res,
      headersSent: false,
      finished: false,
      aborted: false,
      drainWaiters: [],
    };
    inflight.set(requestId, entry);

    const cleanupClientAbort = () => {
      if (entry.finished || entry.aborted) return;
      entry.aborted = true;
      entry.finished = true;
      inflight.delete(requestId);
      wakeDrain(entry);
      try {
        onClientAbort?.(requestId);
      } catch {
        // owner notify is best-effort
      }
      try {
        if (!res.writableEnded) res.destroy();
      } catch {
        // ignore
      }
    };

    req.on('aborted', cleanupClientAbort);
    res.on('close', () => {
      if (!entry.finished && !entry.headersSent) {
        cleanupClientAbort();
        return;
      }
      // Client cancelled mid-stream after headers.
      if (!entry.finished && entry.headersSent && !res.writableEnded) {
        cleanupClientAbort();
      }
    });

    let delivered = false;
    try {
      delivered = sendToOwner({
        requestId,
        method: method.toUpperCase(),
        // Path includes query (tokens). Never log this value.
        path: rawUrl,
      }) !== false;
    } catch {
      delivered = false;
    }

    if (!delivered) {
      inflight.delete(requestId);
      failInFlight(entry, 503);
    }
  };

  /**
   * @returns {Promise<{ origin: string; port: number }>}
   */
  const start = () => new Promise((resolve, reject) => {
    if (server && origin) {
      try {
        const parsed = new URL(origin);
        resolve({ origin, port: Number(parsed.port) || 0 });
        return;
      } catch {
        // fall through and recreate
      }
    }

    ownerPresent = true;
    const next = http.createServer((req, res) => {
      handleHttpRequest(req, res);
    });

    const { WebSocketServer } = loadWs();
    // Echo Vite HMR subprotocols so the iframe client accepts the handshake.
    const nextWs = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols) => {
        if (protocols.has('vite-hmr')) return 'vite-hmr';
        if (protocols.has('vite-ping')) return 'vite-ping';
        const first = protocols.values().next();
        return first.done ? false : first.value;
      },
    });
    next.on('upgrade', (req, socket, head) => {
      handleUpgrade(req, socket, head || Buffer.alloc(0));
    });

    next.on('error', (error) => {
      if (!server) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

    next.listen(0, '127.0.0.1', () => {
      const address = next.address();
      if (!address || typeof address === 'string') {
        next.close();
        try {
          nextWs.close();
        } catch {
          // ignore
        }
        reject(new Error('failed to bind preview loopback gateway'));
        return;
      }
      server = next;
      wsServer = nextWs;
      origin = `http://127.0.0.1:${address.port}`;
      resolve({ origin, port: address.port });
    });
  });

  /**
   * @returns {Promise<void>}
   */
  const stop = () => new Promise((resolve) => {
    ownerPresent = false;
    abortAllInFlight(503);
    const active = server;
    const activeWs = wsServer;
    server = null;
    wsServer = null;
    origin = null;
    if (activeWs) {
      try {
        activeWs.close();
      } catch {
        // ignore
      }
    }
    if (!active) {
      resolve();
      return;
    }
    active.close(() => resolve());
    // Force-close lingering sockets so stop() cannot hang.
    try {
      active.closeAllConnections?.();
    } catch {
      // ignore
    }
  });

  /** Mark owner gone: in-flight → 503; new requests → 503 until ensure again. */
  const markOwnerGone = () => {
    ownerPresent = false;
    abortAllInFlight(503);
  };

  const markOwnerPresent = () => {
    ownerPresent = true;
  };

  /**
   * @param {string} requestId
   * @param {{ status?: number; headers?: Record<string, unknown> | Headers | null }} payload
   * @returns {{ ok: true }}
   */
  const begin = (requestId, payload = {}) => {
    if (typeof requestId !== 'string' || !requestId) {
      throw new Error('requestId is required');
    }
    const entry = inflight.get(requestId);
    if (!entry || entry.aborted || entry.finished) {
      throw new Error('unknown or finished requestId');
    }
    if (entry.headersSent || entry.res.headersSent) {
      return { ok: true };
    }
    const statusRaw = payload?.status;
    const status = typeof statusRaw === 'number' && Number.isFinite(statusRaw) && statusRaw >= 100 && statusRaw <= 599
      ? Math.trunc(statusRaw)
      : 200;
    const headers = sanitizePreviewGatewayResponseHeaders(payload?.headers);
    headers['cache-control'] = headers['cache-control'] || 'no-store';
    entry.res.writeHead(status, headers);
    entry.headersSent = true;
    return { ok: true };
  };

  /**
   * Stream one body chunk with backpressure (await drain like virtualAsset push).
   *
   * @param {string} requestId
   * @param {unknown} chunk
   * @returns {Promise<{ ok: true }>}
   */
  const push = async (requestId, chunk) => {
    if (typeof requestId !== 'string' || !requestId) {
      throw new Error('requestId is required');
    }
    const entry = inflight.get(requestId);
    if (!entry || entry.aborted || entry.finished) {
      throw new Error('unknown or finished requestId');
    }
    if (!entry.headersSent) {
      throw new Error('begin must be called before push');
    }
    const bytes = coerceGatewayChunkBytes(chunk);
    if (bytes.byteLength === 0) {
      return { ok: true };
    }

    const ok = entry.res.write(Buffer.from(bytes));
    if (!ok) {
      await new Promise((resolve) => {
        if (entry.aborted || entry.finished) {
          resolve();
          return;
        }
        entry.drainWaiters.push(resolve);
        entry.res.once('drain', () => {
          wakeDrain(entry);
        });
      });
    }
    if (entry.aborted || entry.finished) {
      throw new Error('request aborted');
    }
    return { ok: true };
  };

  /**
   * @param {string} requestId
   * @returns {{ ok: true }}
   */
  const end = (requestId) => {
    if (typeof requestId !== 'string' || !requestId) {
      throw new Error('requestId is required');
    }
    const entry = inflight.get(requestId);
    if (!entry) {
      return { ok: true };
    }
    if (entry.finished || entry.aborted) {
      inflight.delete(requestId);
      return { ok: true };
    }
    if (!entry.headersSent && !entry.res.headersSent) {
      entry.res.writeHead(200, { 'Cache-Control': 'no-store' });
      entry.headersSent = true;
    }
    entry.finished = true;
    inflight.delete(requestId);
    wakeDrain(entry);
    try {
      entry.res.end();
    } catch {
      try {
        entry.res.destroy();
      } catch {
        // ignore
      }
    }
    return { ok: true };
  };

  /**
   * Renderer-side abort / fetch failure.
   *
   * @param {string} requestId
   * @returns {{ ok: true }}
   */
  const abort = (requestId) => {
    if (typeof requestId !== 'string' || !requestId) {
      throw new Error('requestId is required');
    }
    destroyInFlight(requestId, 503);
    destroyInFlightWs(requestId, 1011, 'aborted');
    return { ok: true };
  };

  /**
   * Owner tunnel WS is open — flush buffered client frames and mark opened.
   *
   * @param {string} requestId
   * @param {{ protocol?: string }} [payload]
   * @returns {{ ok: true }}
   */
  const wsOpened = (requestId, _payload = {}) => {
    if (typeof requestId !== 'string' || !requestId) {
      throw new Error('requestId is required');
    }
    const entry = inflightWs.get(requestId);
    if (!entry || entry.finished) {
      throw new Error('unknown or finished requestId');
    }
    entry.opened = true;
    const pending = entry.pendingFromClient.splice(0, entry.pendingFromClient.length);
    for (const [data, binary] of pending) {
      forwardClientWsMessage(requestId, data, binary);
    }
    return { ok: true };
  };

  /**
   * Owner → client WS frame (tunnel message).
   *
   * @param {string} requestId
   * @param {unknown} data
   * @param {boolean} [binary]
   * @returns {{ ok: true }}
   */
  const wsSend = (requestId, data, binary = false) => {
    if (typeof requestId !== 'string' || !requestId) {
      throw new Error('requestId is required');
    }
    const entry = inflightWs.get(requestId);
    if (!entry || entry.finished) {
      throw new Error('unknown or finished requestId');
    }
    if (entry.socket.readyState !== entry.socket.OPEN) {
      throw new Error('socket not open');
    }
    if (typeof data === 'string') {
      entry.socket.send(data, { binary: false });
      return { ok: true };
    }
    const bytes = coerceGatewayChunkBytes(data);
    entry.socket.send(Buffer.from(bytes), { binary: binary === true });
    return { ok: true };
  };

  /**
   * Owner tunnel closed — close the local iframe socket.
   *
   * @param {string} requestId
   * @param {{ code?: number; reason?: string }} [payload]
   * @returns {{ ok: true }}
   */
  const wsClose = (requestId, payload = {}) => {
    if (typeof requestId !== 'string' || !requestId) {
      throw new Error('requestId is required');
    }
    const codeRaw = payload?.code;
    const code = typeof codeRaw === 'number' && Number.isFinite(codeRaw)
      ? Math.trunc(codeRaw)
      : 1000;
    const reason = typeof payload?.reason === 'string' ? payload.reason : '';
    destroyInFlightWs(requestId, code, reason);
    return { ok: true };
  };

  const getOrigin = () => origin;

  const getInFlightRequestIds = () => [...inflight.keys()];

  const getInFlightWsRequestIds = () => [...inflightWs.keys()];

  const getStats = () => ({
    origin,
    ownerPresent,
    listening: Boolean(server),
    inflight: inflight.size,
    inflightWs: inflightWs.size,
    requestIds: getInFlightRequestIds(),
    wsRequestIds: getInFlightWsRequestIds(),
  });

  return {
    start,
    stop,
    markOwnerGone,
    markOwnerPresent,
    begin,
    push,
    end,
    abort,
    wsOpened,
    wsSend,
    wsClose,
    getOrigin,
    getInFlightRequestIds,
    getInFlightWsRequestIds,
    getStats,
    // Exported for tests that inject a fake IncomingMessage without listen().
    handleHttpRequest,
    handleUpgrade,
  };
};
