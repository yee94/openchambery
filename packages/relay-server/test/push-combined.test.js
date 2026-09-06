import { afterEach, expect, it } from 'bun:test';
import crypto from 'node:crypto';
import http from 'node:http';

import { createPrivateRelayServer } from '../src/index.js';
import { createCombinedPushMount } from '../src/push/combined.js';
import { deriveServerId } from '../src/push/index.js';

const relays = [];
const mounts = [];
const dummyP8 = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const hexToken = (seed) => crypto.createHash('sha256').update(String(seed)).digest('hex');
const identity = () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const exported = publicKey.export({ format: 'jwk' });
  const publicJwk = { kty: exported.kty, crv: exported.crv, x: exported.x, y: exported.y };
  const sign = (message) => crypto.sign('SHA256', Buffer.from(message), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return { publicJwk, serverId: deriveServerId(publicJwk), sign };
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
const completeApnsEnv = (extra = {}) => ({
  OPENCHAMBER_PUSH_RELAY_APNS_KEY_ID: 'KEYID12345',
  OPENCHAMBER_PUSH_RELAY_APNS_TEAM_ID: 'TEAMID1234',
  OPENCHAMBER_PUSH_RELAY_APNS_P8: dummyP8,
  OPENCHAMBER_PUSH_RELAY_APNS_BUNDLE_ID: 'com.yee94.openchamber',
  OPENCHAMBER_PUSH_RELAY_DATABASE_PATH: ':memory:',
  ...extra,
});

afterEach(async () => {
  await Promise.all(mounts.splice(0).map((mount) => mount.stop?.()));
  await Promise.all(relays.splice(0).map((relay) => relay.stop()));
});

it('returns null when no OPENCHAMBER_PUSH_RELAY_APNS_ env is set', () => {
  expect(createCombinedPushMount({})).toBeNull();
  expect(createCombinedPushMount({ OPENCHAMBER_PUSH_RELAY_HOST: '0.0.0.0', OPENCHAMBER_PUSH_RELAY_APNS_KEY_ID: '' })).toBeNull();
});

it('builds a mount from complete APNs env and throws on partial configuration', () => {
  const mount = createCombinedPushMount(completeApnsEnv(), {
    apnsProvider: { async send() { return { ok: true }; }, close() {} },
  });
  expect(mount).toMatchObject({ requestHandler: expect.any(Function), start: expect.any(Function), stop: expect.any(Function) });
  mounts.push(mount);
  expect(() => createCombinedPushMount({ OPENCHAMBER_PUSH_RELAY_APNS_KEY_ID: 'KEYID12345' })).toThrow();
});

it('serves push routes on the relay port without claiming relay health endpoints', async () => {
  const sent = [];
  const apnsProvider = {
    sent,
    async send(input) { sent.push(input); return { ok: true }; },
    close() {},
  };
  const mount = createCombinedPushMount(completeApnsEnv(), { apnsProvider });
  expect(mount).not.toBeNull();
  mounts.push(mount);
  const relay = createPrivateRelayServer({ port: 0, host: '127.0.0.1', requestHandler: mount.requestHandler });
  relays.push(relay);
  await relay.start();
  await mount.start();
  const port = relay.address().port;
  const id = identity();
  const token = hexToken('combined');
  expect(await request(port, '/v1/push/register-token', { method: 'POST', body: registerBody(id, token) })).toMatchObject({ status: 200, json: { ok: true } });
  const send = await request(port, '/v1/push/send', { method: 'POST', body: sendBody(id, [token]) });
  expect(send).toMatchObject({ status: 200, json: { results: [{ token, ok: true }] } });
  expect(apnsProvider.sent).toHaveLength(1);
  expect(apnsProvider.sent[0].token).toBe(token);
  expect(apnsProvider.sent[0].payload).toBeDefined();
  expect(await request(port, '/v1/push/nonexistent', { method: 'POST', body: {} })).toMatchObject({ status: 404 });
  expect(await request(port, '/healthz')).toMatchObject({ status: 200, body: '{"status":"ok"}' });
  expect(await request(port, '/v1/push/healthz')).toMatchObject({ status: 404 });
});
