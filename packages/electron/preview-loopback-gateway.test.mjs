import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  PREVIEW_GATEWAY_PATH_PREFIX,
  coerceGatewayChunkBytes,
  createPreviewLoopbackGateway,
  isPreviewGatewayMethodAllowed,
  isPreviewGatewayPathAllowed,
  isPreviewGatewayWebSocketUpgrade,
  parseSecWebSocketProtocols,
  sanitizePreviewGatewayResponseHeaders,
} from './preview-loopback-gateway.mjs';
import { createRequire } from 'node:module';

const loadWs = () => {
  const requireHere = createRequire(import.meta.url);
  try {
    return requireHere('ws');
  } catch {
    const webPkg = requireHere.resolve('@openchambery/web/package.json');
    return createRequire(webPkg)('ws');
  }
};

test('method allowlist is GET/HEAD only', () => {
  assert.equal(isPreviewGatewayMethodAllowed('GET'), true);
  assert.equal(isPreviewGatewayMethodAllowed('get'), true);
  assert.equal(isPreviewGatewayMethodAllowed('HEAD'), true);
  assert.equal(isPreviewGatewayMethodAllowed('POST'), false);
  assert.equal(isPreviewGatewayMethodAllowed('PUT'), false);
  assert.equal(isPreviewGatewayMethodAllowed('OPTIONS'), false);
  assert.equal(isPreviewGatewayMethodAllowed(''), false);
  assert.equal(isPreviewGatewayMethodAllowed(null), false);
});

test('path allowlist is /api/preview/proxy/ prefix only', () => {
  assert.equal(isPreviewGatewayPathAllowed('/api/preview/proxy/abc123/'), true);
  assert.equal(isPreviewGatewayPathAllowed('/api/preview/proxy/abc123/index.html?oc_preview_token=x'), true);
  assert.equal(isPreviewGatewayPathAllowed('/api/session'), false);
  assert.equal(isPreviewGatewayPathAllowed('/api/preview/targets'), false);
  assert.equal(isPreviewGatewayPathAllowed('/api/preview/proxy'), false);
  assert.equal(isPreviewGatewayPathAllowed('/'), false);
  assert.equal(isPreviewGatewayPathAllowed(''), false);
  assert.equal(isPreviewGatewayPathAllowed('/api/preview/proxy/../session'), false);
  assert.equal(isPreviewGatewayPathAllowed('/api/preview/proxy/%2e%2e/session'), false);
  assert.equal(isPreviewGatewayPathAllowed('/api/preview/proxy/../../api/session'), false);
  assert.equal(isPreviewGatewayPathAllowed('/api/preview/proxy/foo/../../auth/session'), false);
  assert.equal(isPreviewGatewayPathAllowed('http://evil.example/api/preview/proxy/abc'), false);
  assert.equal(PREVIEW_GATEWAY_PATH_PREFIX, '/api/preview/proxy/');
});

test('sanitize response headers drops Set-Cookie and hop-by-hop', () => {
  const cleaned = sanitizePreviewGatewayResponseHeaders({
    'Content-Type': 'text/html',
    'Set-Cookie': 'session=secret',
    'set-cookie': 'other=1',
    Connection: 'keep-alive',
    'Transfer-Encoding': 'chunked',
    'Content-Length': '12',
    'Content-Encoding': 'gzip',
    'X-Custom': 'ok',
  });
  assert.equal(cleaned['content-type'], 'text/html');
  assert.equal(cleaned['x-custom'], 'ok');
  assert.equal(cleaned['set-cookie'], undefined);
  assert.equal(cleaned.connection, undefined);
  assert.equal(cleaned['transfer-encoding'], undefined);
  assert.equal(cleaned['content-length'], undefined);
  assert.equal(cleaned['content-encoding'], undefined);
});

test('coerceGatewayChunkBytes accepts ArrayBuffer and TypedArray', () => {
  assert.deepEqual([...coerceGatewayChunkBytes(new Uint8Array([1, 2]).buffer)], [1, 2]);
  assert.deepEqual([...coerceGatewayChunkBytes(new Uint8Array([3]))], [3]);
  assert.throws(() => coerceGatewayChunkBytes('nope'), /ArrayBuffer or TypedArray/);
});

test('handleHttpRequest returns 404 for disallowed method or path without listen', async () => {
  const sent = [];
  const gateway = createPreviewLoopbackGateway({
    sendToOwner: (payload) => {
      sent.push(payload);
      return true;
    },
  });

  const makeRes = () => {
    /** @type {{ statusCode?: number; body: string; headersSent: boolean }} */
    const state = { body: '', headersSent: false };
    return {
      state,
      headersSent: false,
      writableEnded: false,
      writeHead(status) {
        state.statusCode = status;
        state.headersSent = true;
        this.headersSent = true;
      },
      end(chunk) {
        state.body = typeof chunk === 'string' ? chunk : '';
        this.writableEnded = true;
      },
      write() {
        return true;
      },
      destroy() {
        this.writableEnded = true;
      },
      on() {
        return this;
      },
      once() {
        return this;
      },
    };
  };

  const postRes = makeRes();
  gateway.handleHttpRequest(
    /** @type {any} */ ({ method: 'POST', url: '/api/preview/proxy/abc/', on() { return this; } }),
    /** @type {any} */ (postRes),
  );
  assert.equal(postRes.state.statusCode, 404);
  assert.equal(sent.length, 0);

  const sessionRes = makeRes();
  gateway.handleHttpRequest(
    /** @type {any} */ ({ method: 'GET', url: '/api/session', on() { return this; } }),
    /** @type {any} */ (sessionRes),
  );
  assert.equal(sessionRes.state.statusCode, 404);
  assert.equal(sent.length, 0);

  await gateway.stop();
});

test('handleHttpRequest returns 503 when owner is gone', async () => {
  const gateway = createPreviewLoopbackGateway({
    sendToOwner: () => true,
  });
  gateway.markOwnerGone();

  /** @type {{ statusCode?: number }} */
  const state = {};
  gateway.handleHttpRequest(
    /** @type {any} */ ({ method: 'GET', url: '/api/preview/proxy/abc/', on() { return this; } }),
    /** @type {any} */ ({
      headersSent: false,
      writableEnded: false,
      writeHead(status) {
        state.statusCode = status;
        this.headersSent = true;
      },
      end() {
        this.writableEnded = true;
      },
      destroy() {},
      on() { return this; },
      once() { return this; },
    }),
  );
  assert.equal(state.statusCode, 503);
  await gateway.stop();
});

test('start binds 127.0.0.1 ephemeral port and streams body with backpressure', async () => {
  /** @type {import('./preview-loopback-gateway.mjs').PreviewGatewayRequestPayload[]} */
  const requests = [];
  const gateway = createPreviewLoopbackGateway({
    idFactory: () => 'req-stream-1',
    sendToOwner: (payload) => {
      requests.push(payload);
      return true;
    },
  });

  const { origin, port } = await gateway.start();
  assert.ok(origin.startsWith('http://127.0.0.1:'));
  assert.equal(origin, `http://127.0.0.1:${port}`);
  assert.equal(new URL(origin).hostname, '127.0.0.1');
  assert.notEqual(port, 0);

  const responsePromise = fetch(`${origin}/api/preview/proxy/abc123/index.html?oc_preview_token=t`);
  // Wait until owner was notified.
  for (let i = 0; i < 50 && requests.length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.requestId, 'req-stream-1');
  assert.equal(requests[0]?.method, 'GET');
  assert.equal(requests[0]?.path, '/api/preview/proxy/abc123/index.html?oc_preview_token=t');

  gateway.begin('req-stream-1', {
    status: 200,
    headers: {
      'Content-Type': 'text/html',
      'Set-Cookie': 'should-drop=1',
    },
  });
  await gateway.push('req-stream-1', new Uint8Array([72, 105])); // Hi
  await gateway.push('req-stream-1', new TextEncoder().encode('!'));
  gateway.end('req-stream-1');

  const response = await responsePromise;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/html');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(await response.text(), 'Hi!');
  assert.equal(gateway.getStats().inflight, 0);

  await gateway.stop();
});

test('disallowed paths over live server return 404; POST returns 404', async () => {
  const gateway = createPreviewLoopbackGateway({
    sendToOwner: () => true,
  });
  const { origin } = await gateway.start();

  const session = await fetch(`${origin}/api/session`);
  assert.equal(session.status, 404);

  const post = await fetch(`${origin}/api/preview/proxy/abc/`, { method: 'POST', body: 'x' });
  assert.equal(post.status, 404);

  await gateway.stop();
});

test('sendToOwner failure yields 503', async () => {
  const gateway = createPreviewLoopbackGateway({
    sendToOwner: () => false,
  });
  const { origin } = await gateway.start();
  const response = await fetch(`${origin}/api/preview/proxy/abc/`);
  assert.equal(response.status, 503);
  await gateway.stop();
});

test('isPreviewGatewayWebSocketUpgrade detects Upgrade: websocket', () => {
  assert.equal(
    isPreviewGatewayWebSocketUpgrade({ method: 'GET', headers: { upgrade: 'websocket' } }),
    true,
  );
  assert.equal(
    isPreviewGatewayWebSocketUpgrade({ method: 'POST', headers: { upgrade: 'websocket' } }),
    false,
  );
  assert.equal(
    isPreviewGatewayWebSocketUpgrade({ method: 'GET', headers: { upgrade: 'h2c' } }),
    false,
  );
  assert.deepEqual(parseSecWebSocketProtocols('vite-hmr, vite-ping'), ['vite-hmr', 'vite-ping']);
});

test('upgrade to non-preview path is rejected without notifying owner', async () => {
  /** @type {unknown[]} */
  const wsOpens = [];
  const gateway = createPreviewLoopbackGateway({
    sendToOwner: () => true,
    sendWsOpenToOwner: (payload) => {
      wsOpens.push(payload);
      return true;
    },
  });
  const { origin } = await gateway.start();
  const { WebSocket } = loadWs();

  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${origin.replace('http', 'ws')}/api/session`);
    ws.on('open', () => {
      ws.close();
      reject(new Error('unexpected open'));
    });
    ws.on('unexpected-response', (_req, res) => {
      assert.equal(res.statusCode, 404);
      res.resume();
      resolve();
    });
    ws.on('error', () => {
      // expected when handshake fails
    });
  });

  assert.equal(wsOpens.length, 0);
  await gateway.stop();
});

test('preview proxy WS upgrade notifies owner and pipes frames', async () => {
  /** @type {import('./preview-loopback-gateway.mjs').PreviewGatewayWsOpenPayload[]} */
  const wsOpens = [];
  /** @type {{ requestId: string; data: ArrayBuffer | string; binary: boolean }[]} */
  const clientMessages = [];
  const gateway = createPreviewLoopbackGateway({
    idFactory: () => 'ws-req-1',
    sendToOwner: () => true,
    sendWsOpenToOwner: (payload) => {
      wsOpens.push(payload);
      return true;
    },
    sendWsMessageToOwner: (payload) => {
      clientMessages.push(payload);
      return true;
    },
    sendWsCloseToOwner: () => true,
  });
  const { origin } = await gateway.start();
  const { WebSocket } = loadWs();

  const client = new WebSocket(
    `${origin.replace('http', 'ws')}/api/preview/proxy/abc123/?oc_preview_token=t`,
    ['vite-hmr'],
  );

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws open timeout')), 2000);
    client.on('open', () => {
      clearTimeout(timer);
      resolve();
    });
    client.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  for (let i = 0; i < 50 && wsOpens.length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(wsOpens.length, 1);
  assert.equal(wsOpens[0]?.requestId, 'ws-req-1');
  assert.equal(wsOpens[0]?.path, '/api/preview/proxy/abc123/?oc_preview_token=t');
  assert.deepEqual(wsOpens[0]?.protocols, ['vite-hmr']);

  gateway.wsOpened('ws-req-1');
  client.send('from-iframe');
  for (let i = 0; i < 50 && clientMessages.length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(clientMessages.length, 1);
  assert.equal(clientMessages[0]?.binary, false);
  assert.equal(clientMessages[0]?.data, 'from-iframe');

  const fromOwner = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('message timeout')), 2000);
    client.once('message', (data) => {
      clearTimeout(timer);
      resolve(String(data));
    });
  });
  gateway.wsSend('ws-req-1', 'from-tunnel', false);
  assert.equal(await fromOwner, 'from-tunnel');

  gateway.wsClose('ws-req-1', { code: 1000, reason: 'done' });
  await new Promise((resolve) => {
    if (client.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    client.once('close', () => resolve());
  });
  assert.equal(gateway.getStats().inflightWs, 0);

  await gateway.stop();
});

test('client abort notifies onClientAbort and clears inflight', async () => {
  /** @type {string[]} */
  const aborted = [];
  /** @type {string | null} */
  let pendingId = null;
  const gateway = createPreviewLoopbackGateway({
    idFactory: () => 'abort-me',
    sendToOwner: (payload) => {
      pendingId = payload.requestId;
      return true;
    },
    onClientAbort: (requestId) => {
      aborted.push(requestId);
    },
  });
  const { origin } = await gateway.start();

  const controller = new AbortController();
  const fetchPromise = fetch(`${origin}/api/preview/proxy/abc/`, { signal: controller.signal });
  for (let i = 0; i < 50 && !pendingId; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(pendingId, 'abort-me');
  assert.equal(gateway.getStats().inflight, 1);

  controller.abort();
  await assert.rejects(() => fetchPromise);

  for (let i = 0; i < 50 && aborted.length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.deepEqual(aborted, ['abort-me']);
  assert.equal(gateway.getStats().inflight, 0);

  await gateway.stop();
});
