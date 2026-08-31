import { afterEach, expect, it } from 'bun:test';
import crypto from 'node:crypto';
import http from 'node:http';

import { canonicalPublicJwkString, createPushRelayServer, deriveServerId, resolvePushRelayClientIp } from '../src/push/index.js';

const servers = [];
const hexToken = (seed) => crypto.createHash('sha256').update(String(seed)).digest('hex');
const identity = () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const exported = publicKey.export({ format: 'jwk' });
  const canonical = { crv: exported.crv, kty: exported.kty, x: exported.x, y: exported.y };
  const publicJwk = { kty: exported.kty, crv: exported.crv, x: exported.x, y: exported.y };
  const sign = (message) => crypto.sign('SHA256', Buffer.from(message), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return { publicJwk, canonical, serverId: deriveServerId(canonical), sign };
};
const request = (port, path, { method = 'GET', body, headers = {} } = {}) => new Promise((resolve, reject) => {
  const payload = body === undefined ? undefined : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const req = http.request({
    host: '127.0.0.1', port, path, method,
    headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}), ...headers },
  }, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString();
      let json = null;
      try { json = JSON.parse(text); } catch { /* non-JSON */ }
      resolve({ status: res.statusCode, headers: res.headers, body: text, json });
    });
  });
  req.on('error', reject);
  req.end(payload);
});
const startPush = async (overrides = {}) => {
  const sent = [];
  const apnsProvider = overrides.apnsProvider ?? {
    sent,
    async send(input) { sent.push(input); return { ok: true }; },
    close() {},
  };
  const server = createPushRelayServer({ host: '127.0.0.1', port: 0, databasePath: ':memory:', apnsProvider, ...overrides });
  servers.push(server);
  await server.start();
  return { server, port: server.address().port, apnsProvider };
};
const registerBody = (id, token, extra = {}) => {
  const ts = extra.ts ?? Date.now();
  const platform = extra.platform ?? 'ios';
  const publicKeyJwk = extra.publicKeyJwk ?? id.publicJwk;
  const sig = extra.sig ?? id.sign(`${ts}.${token}.${platform}`);
  return { token, platform, publicKeyJwk, ts, sig, ...extra.rest };
};
const sendBody = (id, tokens, extra = {}) => {
  const title = extra.title ?? 'Agent response is ready';
  const ts = extra.ts ?? Date.now();
  const sig = extra.sig ?? id.sign(`${ts}.${[...tokens].sort().join(',')}.${title}`);
  return { tokens, title, body: extra.body ?? 'session', badge: extra.badge, collapseId: extra.collapseId, env: extra.env, data: extra.data, publicKeyJwk: extra.publicKeyJwk ?? id.publicJwk, ts, sig };
};

afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.stop())); });

it('rejects replay windows smaller than twice the timestamp skew', () => {
  expect(() => createPushRelayServer({
    host: '127.0.0.1', databasePath: ':memory:',
    apnsProvider: { send: async () => ({ ok: true }), close() {} },
    limits: { timestampSkewMs: 1_000, replayMs: 1_000 },
  })).toThrow(/replay/);
});

it('canonical serverId matches signing-key key order regardless of JWK field order', () => {
  const id = identity();
  expect(canonicalPublicJwkString(id.publicJwk)).toBe(JSON.stringify({ crv: id.canonical.crv, kty: id.canonical.kty, x: id.canonical.x, y: id.canonical.y }));
  expect(deriveServerId(id.publicJwk)).toBe(crypto.createHash('sha256').update(canonicalPublicJwkString(id.canonical)).digest('base64url'));
  expect(deriveServerId({ x: id.canonical.x, y: id.canonical.y, kty: 'EC', crv: 'P-256' })).toBe(id.serverId);
});

it('serves health and readiness and rejects unknown routes', async () => {
  const { server, port } = await startPush();
  expect(await request(port, '/healthz')).toMatchObject({ status: 200, body: '{"status":"ok"}' });
  expect((await request(port, '/healthz')).headers['cache-control']).toBe('no-store');
  expect(await request(port, '/readyz', { method: 'HEAD' })).toMatchObject({ status: 200, body: '' });
  expect(await request(port, '/other')).toMatchObject({ status: 404 });
  expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(server.getSnapshot()).toMatchObject({ state: 'running' });
});

it('registers with a real P-256 signature and delivers only bound tokens', async () => {
  const { port, apnsProvider } = await startPush();
  const id = identity();
  const other = identity();
  const token = hexToken('bound');
  const foreign = hexToken('foreign');
  expect(await request(port, '/v1/push/register-token', { method: 'POST', body: registerBody(id, token) })).toMatchObject({ status: 200, json: { ok: true } });
  const send = await request(port, '/v1/push/send', { method: 'POST', body: sendBody(id, [token, foreign], { data: { sessionId: 'sess-1' } }) });
  expect(send.status).toBe(200);
  expect(send.json.results).toEqual([
    { token, ok: true },
    { token: foreign, ok: false },
  ]);
  expect(apnsProvider.sent).toHaveLength(1);
  expect(apnsProvider.sent[0].token).toBe(token);
  expect(apnsProvider.sent[0].payload.aps.alert.title).toBe('Agent response is ready');
  expect(apnsProvider.sent[0].payload.sessionId).toBe('sess-1');
  const isolated = await request(port, '/v1/push/send', { method: 'POST', body: sendBody(other, [token]) });
  expect(isolated.json.results).toEqual([{ token, ok: false }]);
  expect(JSON.stringify(isolated.json)).not.toContain(id.serverId);
});

it('accepts shuffled JWK field order and rebinds a token to a new serverId', async () => {
  const { port, apnsProvider } = await startPush();
  const first = identity();
  const second = identity();
  const token = hexToken('rebind');
  const shuffled = { x: first.publicJwk.x, crv: first.publicJwk.crv, y: first.publicJwk.y, kty: first.publicJwk.kty };
  expect(await request(port, '/v1/push/register-token', { method: 'POST', body: registerBody(first, token, { publicKeyJwk: shuffled }) })).toMatchObject({ status: 200 });
  expect(await request(port, '/v1/push/register-token', { method: 'POST', body: registerBody(second, token) })).toMatchObject({ status: 200 });
  apnsProvider.sent.length = 0;
  expect((await request(port, '/v1/push/send', { method: 'POST', body: sendBody(first, [token]) })).json.results).toEqual([{ token, ok: false }]);
  expect((await request(port, '/v1/push/send', { method: 'POST', body: sendBody(second, [token]) })).json.results).toEqual([{ token, ok: true }]);
  expect(apnsProvider.sent).toHaveLength(1);
});

it('rejects tampered, expired, future, and replayed send signatures while register replays stay idempotent', async () => {
  const { port } = await startPush();
  const id = identity();
  const token = hexToken('replay');
  const register = registerBody(id, token);
  expect(await request(port, '/v1/push/register-token', { method: 'POST', body: register })).toMatchObject({ status: 200 });
  expect(await request(port, '/v1/push/register-token', { method: 'POST', body: register })).toMatchObject({ status: 200, json: { ok: true } });
  const send = sendBody(id, [token]);
  expect(await request(port, '/v1/push/send', { method: 'POST', body: send })).toMatchObject({ status: 200 });
  expect(await request(port, '/v1/push/send', { method: 'POST', body: send })).toMatchObject({ status: 401, json: { error: 'replay' } });
  expect(await request(port, '/v1/push/send', { method: 'POST', body: { ...send, title: 'tampered' } })).toMatchObject({ status: 401, json: { error: 'invalid_signature' } });
  expect(await request(port, '/v1/push/send', { method: 'POST', body: sendBody(id, [token], { ts: Date.now() - 1_000_000 }) })).toMatchObject({ status: 401, json: { error: 'timestamp' } });
  expect(await request(port, '/v1/push/send', { method: 'POST', body: sendBody(id, [token], { ts: Date.now() + 1_000_000 }) })).toMatchObject({ status: 401, json: { error: 'timestamp' } });
});

it('rejects android, oversized bodies, invalid schema, and oversize APNs payloads', async () => {
  const { port } = await startPush();
  const id = identity();
  const token = hexToken('schema');
  expect(await request(port, '/v1/push/register-token', { method: 'POST', body: registerBody(id, token, { platform: 'android' }) })).toMatchObject({ status: 400, json: { error: 'unsupported_platform' } });
  expect(await request(port, '/v1/push/register-token', { method: 'POST', body: registerBody(id, 'not-a-token') })).toMatchObject({ status: 400, json: { error: 'invalid_request' } });
  expect(await request(port, '/v1/push/register-token', { method: 'POST', body: registerBody(id, token, { publicKeyJwk: { ...id.publicJwk, extra: 'nope' } }) })).toMatchObject({ status: 400 });
  expect(await request(port, '/v1/push/send', { method: 'POST', body: sendBody(id, Array.from({ length: 101 }, (_, index) => hexToken(index))) })).toMatchObject({ status: 400 });
  expect(await request(port, '/v1/push/send', { method: 'POST', body: sendBody(id, [token], { title: 'x'.repeat(300) }) })).toMatchObject({ status: 400 });
  expect(await request(port, '/v1/push/send', { method: 'POST', body: sendBody(id, [token], { data: { nested: { a: 'b' } } }) })).toMatchObject({ status: 400 });
  expect(await request(port, '/v1/push/send', { method: 'POST', body: sendBody(id, [token], { data: { huge: 'y'.repeat(3000) } }) })).toMatchObject({ status: 400 });
  const huge = await request(port, '/v1/push/register-token', { method: 'POST', body: 'x'.repeat(16 * 1024 + 1), headers: { 'content-type': 'application/json', 'content-length': String(16 * 1024 + 1) } });
  expect(huge.status).toBe(413);
  expect(huge.json.error).toBe('payload_too_large');
});

it('rate-limits per IP and honors a single canonical forwarded IP only when trustProxy is enabled', async () => {
  const requestLike = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '203.0.113.8, 10.0.0.1' } };
  expect(resolvePushRelayClientIp(requestLike)).toBe('127.0.0.1');
  expect(resolvePushRelayClientIp(requestLike, true)).toBe('127.0.0.1');
  expect(resolvePushRelayClientIp({ ...requestLike, headers: { 'x-forwarded-for': '203.0.113.8' } }, true)).toBe('203.0.113.8');
  expect(resolvePushRelayClientIp({ ...requestLike, headers: { 'x-forwarded-for': ['203.0.113.8'] } }, true)).toBe('127.0.0.1');
  const { port } = await startPush({ trustProxy: true, limits: { registerLimitPerMinute: 1 } });
  const id = identity();
  const first = await request(port, '/v1/push/register-token', { method: 'POST', body: registerBody(id, hexToken('ip-1')), headers: { 'x-forwarded-for': '203.0.113.9' } });
  const second = await request(port, '/v1/push/register-token', { method: 'POST', body: registerBody(id, hexToken('ip-2')), headers: { 'x-forwarded-for': '203.0.113.9' } });
  const other = await request(port, '/v1/push/register-token', { method: 'POST', body: registerBody(id, hexToken('ip-3')), headers: { 'x-forwarded-for': '198.51.100.7' } });
  expect(first.status).toBe(200);
  expect(second).toMatchObject({ status: 429, json: { error: 'rate_limited' } });
  expect(other.status).toBe(200);
});

it('drops dead tokens, keeps transient APNs failures, and returns partial results', async () => {
  const { port, apnsProvider } = await startPush({
    apnsProvider: {
      async send({ token }) {
        if (token.endsWith('aa')) return { ok: false, drop: true };
        if (token.endsWith('bb')) throw new Error('transport');
        return { ok: true };
      },
      close() {},
    },
  });
  const id = identity();
  const drop = `${'a'.repeat(62)}aa`;
  const fail = `${'b'.repeat(62)}bb`;
  const ok = `${'c'.repeat(62)}cc`;
  for (const token of [drop, fail, ok]) {
    expect((await request(port, '/v1/push/register-token', { method: 'POST', body: registerBody(id, token) })).status).toBe(200);
  }
  const sent = await request(port, '/v1/push/send', { method: 'POST', body: sendBody(id, [drop, fail, ok]) });
  expect(sent.json.results).toEqual([
    { token: drop, ok: false, drop: true },
    { token: fail, ok: false },
    { token: ok, ok: true },
  ]);
  const again = await request(port, '/v1/push/send', { method: 'POST', body: sendBody(id, [drop, fail, ok]) });
  expect(again.json.results).toEqual([
    { token: drop, ok: false },
    { token: fail, ok: false },
    { token: ok, ok: true },
  ]);
  expect(apnsProvider).toBeDefined();
});

it('enforces a max token binding cap and bounds APNs in-flight', async () => {
  const { port, server } = await startPush({ limits: { maxTokens: 1 } });
  const id = identity();
  const first = 'd'.repeat(64);
  const second = 'e'.repeat(64);
  expect((await request(port, '/v1/push/register-token', { method: 'POST', body: registerBody(id, first) })).status).toBe(200);
  expect(await request(port, '/v1/push/register-token', { method: 'POST', body: registerBody(id, second) })).toMatchObject({ status: 429, json: { error: 'token_limit' } });
  expect((await request(port, '/v1/push/register-token', { method: 'POST', body: registerBody(id, first) })).status).toBe(200);
  expect(JSON.stringify(server.getSnapshot())).not.toContain(first);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let active = 0;
  const { port: busyPort } = await startPush({
    limits: { maxInFlight: 1 },
    apnsProvider: {
      async send() { active += 1; await held; return { ok: true }; },
      close() {},
    },
  });
  const tokens = ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64)];
  const busy = identity();
  for (const token of tokens) expect((await request(busyPort, '/v1/push/register-token', { method: 'POST', body: registerBody(busy, token) })).status).toBe(200);
  const pending = request(busyPort, '/v1/push/send', { method: 'POST', body: sendBody(busy, tokens) });
  const until = Date.now() + 1_000;
  while (Date.now() < until && active < 1) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(active).toBe(1);
  release();
  const result = await pending;
  expect(result.status).toBe(200);
  expect(result.json.results).toHaveLength(3);
  expect(result.json.results.filter((row) => row.ok)).toHaveLength(2);
  expect(result.json.results.filter((row) => !row.ok)).toHaveLength(1);
});

it('rate-limits send per serverId independently of other servers', async () => {
  const { port } = await startPush({ limits: { serverSendLimitPerMinute: 1, sendLimitPerMinute: 100 } });
  const first = identity();
  const second = identity();
  const tokenA = hexToken('limit-a');
  const tokenB = hexToken('limit-b');
  expect((await request(port, '/v1/push/register-token', { method: 'POST', body: registerBody(first, tokenA) })).status).toBe(200);
  expect((await request(port, '/v1/push/register-token', { method: 'POST', body: registerBody(second, tokenB) })).status).toBe(200);
  expect((await request(port, '/v1/push/send', { method: 'POST', body: sendBody(first, [tokenA]) })).status).toBe(200);
  expect(await request(port, '/v1/push/send', { method: 'POST', body: sendBody(first, [tokenA]) })).toMatchObject({ status: 429, json: { error: 'rate_limited' } });
  expect((await request(port, '/v1/push/send', { method: 'POST', body: sendBody(second, [tokenB]) })).status).toBe(200);
});

it('shares concurrent startup, rejects port conflicts, and restarts after stop', async () => {
  const blocker = http.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const conflict = createPushRelayServer({ host: '127.0.0.1', port: blocker.address().port, databasePath: ':memory:', apnsProvider: { send: async () => ({ ok: true }), close() {} } });
  await expect(conflict.start()).rejects.toBeDefined();
  expect(conflict.getSnapshot()).toMatchObject({ state: 'stopped' });
  await conflict.stop();
  await new Promise((resolve) => blocker.close(resolve));
  const server = createPushRelayServer({ host: '127.0.0.1', port: 0, databasePath: ':memory:', apnsProvider: { send: async () => ({ ok: true }), close() {} } });
  servers.push(server);
  const first = server.start();
  const second = server.start();
  expect(first).toBe(second);
  await first;
  const stopping = server.stop();
  const restarting = server.start();
  await Promise.all([stopping, restarting]);
  expect(server.getSnapshot().state).toBe('running');
  expect(server.address().port).toBeGreaterThan(0);
});
