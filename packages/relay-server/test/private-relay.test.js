import { afterEach, describe, expect, it } from 'bun:test';
import crypto from 'node:crypto';
import { WebSocket } from 'ws';

import { createPrivateRelayServer } from '../src/index.js';

const sockets = [];
const relays = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const eventually = async (check) => {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await wait(5);
  }
  expect(check()).toBe(true);
};
const event = (socket, name) => {
  if (name === 'message' && socket.messages?.length) return Promise.resolve(socket.messages.shift());
  if (name === 'close' && socket.readyState === WebSocket.CLOSED) return Promise.resolve(socket._observedClose ?? [socket._closeCode, socket._closeMessage]);
  return new Promise((resolve) => socket.once(name, (...args) => resolve(args)));
};
const open = async (url) => {
  const socket = new WebSocket(url);
  socket.messages = [];
  socket.on('message', (...args) => socket.messages.push(args));
  socket.on('close', (code, reason) => { socket._observedClose = [code, reason]; });
  sockets.push(socket);
  await event(socket, 'open');
  return socket;
};
const rejected = (url) => new Promise((resolve) => {
  const socket = new WebSocket(url);
  sockets.push(socket);
  socket.once('close', (code) => resolve(code));
});
const close = async (socket) => {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = event(socket, 'close');
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
  await Promise.race([closed, wait(100)]);
};
const identity = () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  const serverId = crypto.createHash('sha256').update(canonical).digest('base64url');
  let lastTimestamp = 0;
  const auth = (role, connectionId) => {
    const ts = Math.max(Date.now(), lastTimestamp + 1);
    lastTimestamp = ts;
    const sig = crypto.sign('SHA256', Buffer.from(`${ts}.${serverId}.${role}.${connectionId ?? ''}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    return { ts, sig, pk: Buffer.from(canonical).toString('base64url') };
  };
  return { serverId, auth, jwk };
};
const relay = async (limits) => {
  const instance = createPrivateRelayServer({ host: '127.0.0.1', port: 0, limits, logger: { info() {}, warn() {}, error() {} } });
  relays.push(instance);
  await instance.start();
  return instance;
};
const url = (instance, params) => `${instance.wsUrl}?${new URLSearchParams(params)}`;
const hostUrl = (instance, host, role, connectionId) => {
  const auth = host.auth(role, connectionId);
  return url(instance, { v: '1', role, serverId: host.serverId, ...(connectionId ? { connectionId } : {}), ...auth });
};

afterEach(async () => {
  await Promise.all(sockets.splice(0).map(close));
  await Promise.all(relays.splice(0).map((instance) => instance.stop()));
});

describe('private relay contract', () => {
  it('validates path, unique version/role fields and authenticated host upgrades', async () => {
    const instance = await relay();
    const host = identity();
    const bad = new WebSocket(`${instance.wsUrl.replace('/ws', '/bad')}?v=1&role=client&serverId=x`);
    sockets.push(bad);
    const [code] = await event(bad, 'close');
    expect(code).toBe(1008);
    const duplicate = new WebSocket(`${instance.wsUrl}?v=1&v=1&role=client&serverId=x`);
    sockets.push(duplicate);
    expect((await event(duplicate, 'close'))[0]).toBe(1008);
    const signedControlUrl = hostUrl(instance, host, 'host-control');
    const control = await open(signedControlUrl);
    expect(JSON.parse((await event(control, 'message'))[0].toString())).toEqual({ type: 'sync', connectionIds: [] });
    const tampered = new WebSocket(url(instance, { v: '1', role: 'host-control', serverId: host.serverId, ...host.auth('host-data') }));
    sockets.push(tampered);
    expect((await event(tampered, 'close'))[0]).toBe(4010);
    expect(await rejected(signedControlUrl)).toBe(4010);
    const stale = host.auth('host-control');
    stale.ts -= 120_000;
    expect(await rejected(url(instance, { v: '1', role: 'host-control', serverId: host.serverId, ...stale }))).toBe(4010);
    const foreign = host.auth('host-control');
    expect(await rejected(url(instance, { v: '1', role: 'host-control', serverId: `${host.serverId}x`, ...foreign }))).toBe(1008);
  });

  it('generates client ids, syncs host, attaches data and forwards ordered text and binary frames', async () => {
    const instance = await relay(); const host = identity();
    const control = await open(hostUrl(instance, host, 'host-control'));
    await event(control, 'message');
    const client = await open(url(instance, { v: '1', role: 'client', serverId: host.serverId }));
    const connected = JSON.parse((await event(control, 'message'))[0].toString());
    expect(connected.type).toBe('connected'); expect(connected.connectionId).toMatch(/^[\w-]{20,}$/);
    const data = await open(hostUrl(instance, host, 'host-data', connected.connectionId));
    const received = [];
    data.on('message', (payload, binary) => received.push([Buffer.from(payload), binary]));
    client.send('one'); client.send(Buffer.from([2])); client.send('three');
    await eventually(() => received.length === 3);
    expect(received.map(([payload, binary]) => [payload.toString(), binary])).toEqual([['one', false], ['\u0002', true], ['three', false]]);
    const clientFrames = [];
    client.on('message', (payload, binary) => clientFrames.push([Buffer.from(payload), binary]));
    data.send('reply'); data.send(Buffer.from([3]));
    await eventually(() => clientFrames.length === 2);
    expect(clientFrames.map(([payload, binary]) => [payload.toString(), binary])).toEqual([['reply', false], ['\u0003', true]]);
  });

  it('replays authenticated recovery safely and replaces active controls by epoch', async () => {
    const instance = await relay({ graceMs: 30 }); const host = identity();
    const first = await open(hostUrl(instance, host, 'host-control'));
    await event(first, 'message');
    const client = await open(url(instance, { v: '1', role: 'client', serverId: host.serverId }));
    const connectionId = JSON.parse((await event(first, 'message'))[0].toString()).connectionId;
    await new Promise((resolve) => setImmediate(resolve));
    const replacement = await open(hostUrl(instance, host, 'host-control'));
    expect((await event(first, 'close'))[0]).toBe(4001);
    expect(JSON.parse((await event(replacement, 'message'))[0].toString()).connectionIds).toEqual([]);
    expect((await event(client, 'close'))[0]).toBe(4001);
    await new Promise((resolve) => setImmediate(resolve));
    const replayUrl = hostUrl(instance, host, 'host-control');
    const replay = new WebSocket(replayUrl); sockets.push(replay); await event(replay, 'open'); await event(replay, 'message');
    const duplicate = new WebSocket(replayUrl); sockets.push(duplicate);
    expect((await event(duplicate, 'close'))[0]).toBe(4010);
    expect(connectionId).toBeTruthy();
  });

  it('preserves paired sessions during control grace, syncs recovery, then expires them', async () => {
    const instance = await relay({ graceMs: 30 }); const host = identity();
    const first = await open(hostUrl(instance, host, 'host-control')); await event(first, 'message');
    const client = await open(url(instance, { v: '1', role: 'client', serverId: host.serverId }));
    const connectionId = JSON.parse((await event(first, 'message'))[0].toString()).connectionId;
    const data = await open(hostUrl(instance, host, 'host-data', connectionId));
    const closed = event(first, 'close'); first.close(); await closed;
    data.send('during-grace');
    expect((await event(client, 'message'))[0].toString()).toBe('during-grace');
    const recovered = await open(hostUrl(instance, host, 'host-control'));
    expect(JSON.parse((await event(recovered, 'message'))[0].toString()).connectionIds).toEqual([connectionId]);
    const recoveryClosed = event(recovered, 'close'); recovered.close(); await recoveryClosed;
    expect((await event(client, 'close'))[0]).toBe(1012);
    expect(instance.getSnapshot().hosts).toBe(0);
  });

  it('enforces pending, host, global, IP, frame and queued-byte limits then cleans snapshot', async () => {
    const instance = await relay({ graceMs: 1, maxClientsPerHost: 1, maxConnections: 3, maxClientsPerIp: 1, maxPendingClients: 1, pendingMs: 25, maxFrameBytes: 8, maxQueuedBytesPerConnection: 4 });
    const host = identity();
    const control = await open(hostUrl(instance, host, 'host-control')); await event(control, 'message');
    const client = await open(url(instance, { v: '1', role: 'client', serverId: host.serverId }));
    const excess = new WebSocket(url(instance, { v: '1', role: 'client', serverId: host.serverId })); sockets.push(excess);
    expect((await event(excess, 'close'))[0]).toBe(4029);
    client.send(Buffer.alloc(9));
    expect((await event(client, 'close'))[0]).toBe(4029);
    await close(control);
    await new Promise((resolve) => {
      const poll = () => { const snapshot = instance.getSnapshot(); return snapshot.sockets === 0 && snapshot.hosts === 0 ? resolve() : setTimeout(poll, 1); };
      poll();
    });
    expect(instance.getSnapshot()).toMatchObject({ state: 'running', hosts: 0, controls: 0, clients: 0, pairs: 0, pending: 0, queuedBytes: 0, sockets: 0 });
  });

  it('starts and stops idempotently on an ephemeral port', async () => {
    const instance = createPrivateRelayServer({ host: '127.0.0.1', port: 0 }); relays.push(instance);
    await instance.start(); await instance.start();
    expect(instance.address().port).toBeGreaterThan(0); expect(instance.wsUrl).toMatch(/\/ws$/);
    await instance.stop(); await instance.stop();
    expect(instance.getSnapshot().state).toBe('stopped');
  });

  it('exposes bounded socket and rejection counters', async () => {
    const instance = await relay({ maxSockets: 1 });
    expect(instance.getSnapshot().sockets).toBe(0);
    expect(instance.getSnapshot().reasons.authRejected).toBe(0);
  });

  it('enforces the real WebSocket payload bound and releases the pair', async () => {
    const instance = await relay(); const host = identity();
    const control = await open(hostUrl(instance, host, 'host-control')); await event(control, 'message');
    const client = await open(url(instance, { v: '1', role: 'client', serverId: host.serverId }));
    const connectionId = JSON.parse((await event(control, 'message'))[0].toString()).connectionId;
    await open(hostUrl(instance, host, 'host-data', connectionId));
    client.send(Buffer.alloc(128 * 1024 + 1));
    await event(client, 'close');
    await new Promise((resolve) => {
      const poll = () => instance.getSnapshot().clients === 0 ? resolve() : setTimeout(poll, 1);
      poll();
    });
    expect(instance.getSnapshot()).toMatchObject({ clients: 0, pairs: 0, queuedBytes: 0 });
  });
});
