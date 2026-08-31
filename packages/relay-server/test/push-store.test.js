import { afterEach, expect, it } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createPushRelayServer, deriveServerId } from '../src/push/index.js';
import { createTokenStore } from '../src/push/store.js';

const servers = [];
const hexToken = (seed) => crypto.createHash('sha256').update(String(seed)).digest('hex');
const identity = () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const exported = publicKey.export({ format: 'jwk' });
  const publicJwk = { kty: exported.kty, crv: exported.crv, x: exported.x, y: exported.y };
  const sign = (message) => crypto.sign('SHA256', Buffer.from(message), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return { publicJwk, serverId: deriveServerId({ crv: exported.crv, kty: exported.kty, x: exported.x, y: exported.y }), sign };
};
const request = (port, path, body) => new Promise((resolve, reject) => {
  const payload = Buffer.from(JSON.stringify(body));
  const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(payload.length) } }, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString()) }));
  });
  req.on('error', reject);
  req.end(payload);
});
const startPush = async (databasePath, apnsProvider) => {
  const server = createPushRelayServer({
    host: '127.0.0.1',
    port: 0,
    databasePath,
    apnsProvider: apnsProvider ?? { send: async () => ({ ok: true }), close() {} },
  });
  servers.push(server);
  await server.start();
  return server;
};

afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.stop())); });

it('persists token bindings across sqlite restarts', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'push-relay-'));
  const databasePath = path.join(directory, 'data', 'push-relay.sqlite');
  try {
    const id = identity();
    const token = hexToken('persist');
    const first = await startPush(databasePath);
    const ts = Date.now();
    expect(await request(first.address().port, '/v1/push/register-token', {
      token, platform: 'ios', publicKeyJwk: id.publicJwk, ts, sig: id.sign(`${ts}.${token}.ios`),
    })).toMatchObject({ status: 200 });
    expect(first.getSnapshot().tokenCount).toBe(1);
    await first.stop();
    const delivered = [];
    const second = await startPush(databasePath, {
      async send(input) { delivered.push(input.token); return { ok: true }; },
      close() {},
    });
    expect(second.getSnapshot().tokenCount).toBe(1);
    const sendTs = Date.now();
    const sent = await request(second.address().port, '/v1/push/send', {
      tokens: [token], title: 'ready', publicKeyJwk: id.publicJwk, ts: sendTs, sig: id.sign(`${sendTs}.${token}.ready`),
    });
    expect(sent.json.results).toEqual([{ token, ok: true }]);
    expect(delivered).toEqual([token]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it('creates the database directory, upserts, and enforces the store interface', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'push-relay-store-'));
  const databasePath = path.join(directory, 'nested', 'tokens.sqlite');
  const store = createTokenStore(databasePath);
  try {
    expect(fs.existsSync(databasePath)).toBe(true);
    expect(store.count()).toBe(0);
    expect(store.get('missing')).toBeNull();
    store.upsert('token-a', 'server-1', 'ios', 1);
    store.upsert('token-a', 'server-2', 'ios', 2);
    expect(store.count()).toBe(1);
    expect(store.get('token-a')).toMatchObject({ serverId: 'server-2', platform: 'ios', updatedAt: 2 });
    store.upsert('token-b', 'server-2', 'ios', 3);
    expect(store.count()).toBe(2);
    store.delete('token-a');
    expect(store.get('token-a')).toBeNull();
    expect(store.count()).toBe(1);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
