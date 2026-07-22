import { afterEach, expect, it } from 'bun:test';
import http from 'node:http';
import { WebSocket } from 'ws';

import { createPrivateRelayServer, formatRelayWsUrl, resolveRelayClientIp } from '../src/index.js';

const relays = [];
afterEach(async () => { await Promise.all(relays.splice(0).map((relay) => relay.stop())); });
const request = (port, path, method = 'GET', headers = {}) => new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => { const chunks = []; res.on('data', (chunk) => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() })); }); req.end();
});

it('serves health and readiness without exposing relay state and honors a configured websocket path', async () => {
  const relay = createPrivateRelayServer({ host: '127.0.0.1', port: 0, path: '/relay' }); relays.push(relay); await relay.start();
  const port = relay.address().port;
  expect(await request(port, '/healthz')).toMatchObject({ status: 200, body: '{"status":"ok"}' });
  expect((await request(port, '/healthz')).headers['cache-control']).toBe('no-store');
  expect(await request(port, '/readyz', 'HEAD')).toMatchObject({ status: 200 });
  expect(await request(port, '/other')).toMatchObject({ status: 404 });
  expect(relay.wsUrl).toMatch(/\/relay$/);
  const socket = new WebSocket(`${relay.wsUrl}?v=1&role=client&serverId=x`); const [code] = await new Promise((resolve) => socket.once('close', (...args) => resolve(args))); expect(code).toBe(1008);
});

it('allows an injected HTTP request handler before the relay fallback', async () => {
  const relay = createPrivateRelayServer({ host: '127.0.0.1', port: 0, requestHandler(request, response) {
    if (request.url !== '/custom') return false;
    response.writeHead(204, { 'cache-control': 'no-store' }); response.end(); return true;
  } }); relays.push(relay); await relay.start();
  expect(await request(relay.address().port, '/custom')).toMatchObject({ status: 204 });
});

it('uses one valid forwarded client IP only when trustProxy is enabled', async () => {
  const request = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '203.0.113.8, 10.0.0.1' } };
  expect(resolveRelayClientIp(request)).toBe('127.0.0.1');
  expect(resolveRelayClientIp(request, true)).toBe('127.0.0.1');
  expect(resolveRelayClientIp({ ...request, headers: { 'x-forwarded-for': '203.0.113.8' } }, true)).toBe('203.0.113.8');
  expect(resolveRelayClientIp({ ...request, headers: { 'x-forwarded-for': ['203.0.113.8'] } }, true)).toBe('127.0.0.1');
  expect(resolveRelayClientIp({ ...request, headers: { 'x-forwarded-for': 'invalid' } }, true)).toBe('127.0.0.1');
});

it('formats IPv6 relay websocket URLs with brackets', () => {
  expect(formatRelayWsUrl('::1', 8787, '/ws')).toBe('ws://[::1]:8787/ws');
  expect(formatRelayWsUrl('127.0.0.1', 8787, '/ws')).toBe('ws://127.0.0.1:8787/ws');
  expect(formatRelayWsUrl('relay.test', 8787, '/ws')).toBe('ws://relay.test:8787/ws');
});
