import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { gzipSync } from 'node:zlib';
import { registerOpenCodeProxy } from './lib/opencode/proxy.js';
import { createTunnelHost } from './lib/relay/tunnel-host.js';
import { TunnelFrameType, decodeTunnelFrame, encodeJsonPayload, encodeTunnelFrame } from './lib/relay/tunnel-codec.js';

const servers = [];
const listen = async (app) => {
  const server = await new Promise((resolve) => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  servers.push(server);
  return server.address().port;
};
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); })));
});

const setup = async ({ timeoutMs = 1000 } = {}) => {
  const seen = [];
  const state = { status: 200, revision: 'r1', options: { current: 1 }, compressed: false, stalled: false };
  const upstream = express();
  upstream.all('/api/plugin/gui', (req, res) => {
    seen.push({ method: req.method, url: req.originalUrl, headers: req.headers });
    if (state.stalled) {
      res.set('content-type', 'application/json');
      res.write('{"location":');
      return;
    }
    const body = JSON.stringify({ location: { directory: '/workspace' }, data: { code: 'x'.repeat(128 * 1024), revision: state.revision, options: state.options } });
    res.status(state.status).set('content-type', 'application/json').set('x-upstream', 'kept');
    if (state.compressed) {
      const compressed = gzipSync(body);
      res.set('content-encoding', 'gzip').set('content-length', String(compressed.length)).end(compressed);
    } else res.end(body);
  });
  const upstreamPort = await listen(upstream);
  const app = express();
  app.use((req, res, next) => req.headers.authorization === 'Bearer client-test' ? next() : res.status(401).end('unauthorized'));
  registerOpenCodeProxy(app, {
    fs: {}, os: {}, path: {}, OPEN_CODE_READY_GRACE_MS: 0, LONG_REQUEST_TIMEOUT_MS: timeoutMs,
    getRuntime: () => ({ openCodePort: upstreamPort, isOpenCodeReady: true }),
    getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic upstream-test' }),
    buildOpenCodeUrl: (path) => `http://127.0.0.1:${upstreamPort}${path}`,
    ensureOpenCodeApiPrefix: () => {},
  });
  const port = await listen(app);
  const requestPath = '/api/plugin/gui?id=plugin%2Fone&location%5Bdirectory%5D=%2Fworkspace';
  const read = (headers = {}) => fetch(`http://127.0.0.1:${port}${requestPath}`, { headers: { Authorization: 'Bearer client-test', ...headers } });
  return { seen, state, port, requestPath, read };
};

describe('Web/Electron shared backend GUI response', () => {
  it('times out an incomplete upstream body rather than reusing historical code success', async () => {
    const { read, state, seen } = await setup({ timeoutMs: 100 });
    const first = await read();
    const token = first.headers.get('x-yuri-gui-revision');
    await first.arrayBuffer();
    state.stalled = true;
    const failed = await read({ 'X-Yuri-Gui-Revision': token });
    expect(failed.status).toBe(504);
    expect(failed.headers.get('x-yuri-gui-code')).toBeNull();
    expect(await failed.json()).toEqual({ error: 'OpenCode upstream timed out' });
    expect(seen).toHaveLength(2);
  });

  it('fetches each full upstream response, preserves query/auth, and transfers fresh options with code reuse', async () => {
    const { read, seen, state, requestPath } = await setup();
    const first = await read();
    const token = first.headers.get('x-yuri-gui-revision');
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    const full = await first.json();
    state.options = { current: 2 };
    state.compressed = true;
    const second = await read({ 'X-Yuri-Gui-Revision': token, 'If-None-Match': '*', 'If-Modified-Since': 'yesterday' });
    expect(second.status).toBe(200);
    expect(second.headers.get('cache-control')).toBe('private, no-store');
    expect(second.headers.get('x-yuri-gui-code')).toBe('cached');
    expect(second.headers.get('content-encoding')).toBeNull();
    expect(second.headers.get('x-upstream')).toBe('kept');
    const thinText = await second.text();
    expect(thinText.length).toBeLessThan(256);
    expect(JSON.parse(thinText)).toEqual({ ...full, data: { ...full.data, code: '', options: { current: 2 } } });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({ method: 'GET', url: requestPath, headers: { authorization: 'Basic upstream-test', 'accept-encoding': 'identity' } });
    expect(seen[1].headers['x-yuri-gui-revision']).toBeUndefined();
    expect(seen[1].headers['if-none-match']).toBeUndefined();
    expect(seen[1].headers['if-modified-since']).toBeUndefined();
    state.revision = 'r2';
    const changed = await read({ 'X-Yuri-Gui-Revision': token });
    expect(changed.headers.get('x-yuri-gui-code')).toBeNull();
    expect((await changed.json()).data.code).toBe(full.data.code);
    state.status = 404;
    const failed = await read({ 'X-Yuri-Gui-Revision': token });
    expect(failed.status).toBe(404);
    expect(failed.headers.get('x-yuri-gui-code')).toBeNull();
    expect((await failed.json()).data.code).toBe(full.data.code);
    expect(seen).toHaveLength(4);
  });

  it('carries revision headers and current options through the actual relay HTTP path and auth gate', async () => {
    const { read, port, state, requestPath, seen } = await setup();
    const first = await read();
    const token = first.headers.get('x-yuri-gui-revision');
    await first.arrayBuffer();
    state.options = { current: 7 };
    const frames = [];
    let finish;
    const ended = new Promise((resolve) => { finish = resolve; });
    const host = createTunnelHost({ connectionId: 'gui-response', getLocalPort: () => port, getBufferedAmount: () => 0,
      sendFrame: (bytes) => { const frame = decodeTunnelFrame(bytes); frames.push(frame); if (frame.frameType === TunnelFrameType.StreamEnd) finish(); },
    });
    try {
      const url = new URL(requestPath, 'http://yuri.invalid');
      await host.handleFrame(encodeTunnelFrame(TunnelFrameType.HttpRequest, 1, encodeJsonPayload({
        method: 'GET', path: url.pathname, query: url.search.slice(1), acceptEncoding: 'gzip',
        headers: { authorization: 'Bearer client-test', 'x-yuri-gui-revision': token },
      })));
      await ended;
      const head = JSON.parse(new TextDecoder().decode(frames.find((frame) => frame.frameType === TunnelFrameType.HttpResponse).payload));
      expect(head.status).toBe(200);
      expect(head.headers['x-yuri-gui-code']).toBe('cached');
      expect(head.headers['x-yuri-gui-revision']).toBe(token);
      expect(head.headers['cache-control']).toBe('private, no-store');
      const body = new Blob(frames.filter((frame) => frame.frameType === TunnelFrameType.HttpBody).map((frame) => frame.payload));
      const text = head.encoding === 'gzip'
        ? await new Response(body.stream().pipeThrough(new DecompressionStream('gzip'))).text() : await body.text();
      expect(JSON.parse(text).data).toEqual({ code: '', revision: 'r1', options: { current: 7 } });
      expect(seen).toHaveLength(2);
      const denied = await fetch(`http://127.0.0.1:${port}${requestPath}`, { headers: { 'X-Yuri-Gui-Revision': token } });
      expect(denied.status).toBe(401);
      expect(seen).toHaveLength(2);
    } finally { host.close(); }
  });
});
