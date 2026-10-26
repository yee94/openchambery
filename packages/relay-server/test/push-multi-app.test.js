import { expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildPushRelayConfig } from '../src/push/config.js';
import { createApnsProvider } from '../src/push/apns.js';
import { createCachedTokenStore } from '../src/push/cached-store.js';

const key = () => crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
const pem = (privateKey) => privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

it('loads allowlisted apps with a shared key or a complete separate credential', () => {
  const env = {
    YURI_PUSH_RELAY_APNS_KEY_ID: 'KEYONE', YURI_PUSH_RELAY_APNS_TEAM_ID: 'TEAMONE',
    YURI_PUSH_RELAY_APNS_P8: pem(key()), YURI_PUSH_RELAY_APNS_BUNDLE_ID: 'com.example.legacy',
    YURI_PUSH_RELAY_APNS_APPS_JSON: JSON.stringify([
      { bundleId: 'com.yee94.yuri' },
      { bundleId: 'com.example.other', keyId: 'KEYTWO', teamId: 'TEAMTWO', p8: pem(key()) },
    ]),
  };
  const { apns } = buildPushRelayConfig({}, env);
  expect(apns.apps[0]).toEqual({ bundleId: 'com.yee94.yuri', keyId: apns.keyId, teamId: apns.teamId, p8: apns.p8 });
  expect(apns.apps[1]).toMatchObject({ keyId: 'KEYTWO', teamId: 'TEAMTWO' });
  for (const invalid of ['{', '{}', '[null]', '[{"bundleId":"com.example.legacy"}]', '[{"bundleId":"com.other.app","keyId":"incomplete"}]']) {
    expect(() => buildPushRelayConfig({}, { ...env, YURI_PUSH_RELAY_APNS_APPS_JSON: invalid })).toThrow();
  }
});

it('selects the correct signing key/topic for alerts and activities, isolates connections and rejects unknown apps', async () => {
  const firstKey = key(); const secondKey = key();
  const calls = []; const clients = [];
  const http2 = { connect(url) {
    const client = { url, on() { return this; }, close() { this.closed = true; }, request(headers) {
      const listeners = {};
      return { on(event, listener) { listeners[event] = listener; return this; }, end() {
        calls.push({ headers, client });
        queueMicrotask(() => { listeners.response({ ':status': 200 }); listeners.end(); });
      }, close() {} };
    } };
    clients.push(client); return client;
  } };
  const provider = createApnsProvider({
    bundleId: 'com.example.legacy', keyId: 'FIRST', teamId: 'TEAMONE', p8: pem(firstKey), http2,
    apps: [{ bundleId: 'com.yee94.yuri', keyId: 'SECOND', teamId: 'TEAMTWO', p8: pem(secondKey) }],
  });
  try {
    const base = { token: 'a'.repeat(64), env: 'production', payload: { aps: {} } };
    await provider.send(base);
    await provider.send({ ...base, bundleId: 'com.yee94.yuri' });
    await provider.send({ ...base, bundleId: 'com.yee94.yuri', pushType: 'liveactivity' });
    expect(await provider.send({ ...base, bundleId: 'com.unknown.app' })).toEqual({ ok: false });
    expect(calls.map(({ headers }) => headers['apns-topic'])).toEqual(['com.example.legacy', 'com.yee94.yuri', 'com.yee94.yuri.push-type.liveactivity']);
    expect(clients).toHaveLength(2);
    expect(calls[1].client).toBe(calls[2].client);
    for (const [index, privateKey] of [firstKey, secondKey, secondKey].entries()) {
      const [header, claims, signature] = calls[index].headers.authorization.slice(7).split('.');
      expect(crypto.verify('sha256', Buffer.from(`${header}.${claims}`), { key: crypto.createPublicKey(privateKey), dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))).toBe(true);
    }
  } finally { provider.close(); }
  expect(clients.every((client) => client.closed)).toBe(true);
});

it('migrates old SQLite without guessing identities and preserves new bindings across worker restarts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-apps-'));
  const file = path.join(dir, 'tokens.sqlite');
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE push_tokens(token TEXT PRIMARY KEY, server_id TEXT NOT NULL, platform TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT; INSERT INTO push_tokens VALUES ('old', 'server', 'ios', 1)");
  db.close();
  let store = createCachedTokenStore(file, { maxTokens: 10 });
  try {
    await store.ready();
    expect(store.get('old')).toEqual({ serverId: 'server', platform: 'ios', updatedAt: 1 });
    await store.upsert('new', 'server', 'ios', 2, 'com.yee94.yuri');
    const stale = store.get('new');
    await store.upsert('new', 'server', 'ios', 3, 'com.yee94.yuri');
    await store.delete('new', stale);
    expect(store.get('new').updatedAt).toBe(3);
    await store.close();
    store = createCachedTokenStore(file, { maxTokens: 10 });
    await store.ready();
    expect(store.get('new')).toMatchObject({ bundleId: 'com.yee94.yuri', updatedAt: 3 });
    expect(store.count()).toBe(2);
  } finally { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
