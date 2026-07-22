import { afterEach, expect, it } from 'bun:test';
import crypto from 'node:crypto';
import net from 'node:net';
import { WebSocket } from 'ws';

import { createPrivateRelayServer } from '../src/index.js';

const sockets = [];
const relays = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const eventually = async (check) => {
  const until = Date.now() + 1_000;
  while (Date.now() < until) { if (check()) return; await wait(5); }
  expect(check()).toBe(true);
};
const event = (socket, name) => new Promise((resolve) => socket.once(name, (...args) => resolve(args)));
const open = async (value) => { const socket = new WebSocket(value); sockets.push(socket); await event(socket, 'open'); return socket; };
const closed = async (value) => { const socket = new WebSocket(value); sockets.push(socket); return (await event(socket, 'close'))[0]; };
const identity = () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }); const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  const serverId = crypto.createHash('sha256').update(canonical).digest('base64url'); let last = 0;
  return { serverId, auth(role, connectionId) { const ts = Math.max(Date.now(), last + 1); last = ts; return { ts, sig: crypto.sign('SHA256', Buffer.from(`${ts}.${serverId}.${role}.${connectionId ?? ''}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url'), pk: Buffer.from(canonical).toString('base64url') }; } };
};
const connect = (relay, host, role, connectionId) => `${relay.wsUrl}?${new URLSearchParams({ v: '1', role, serverId: host.serverId, ...(connectionId ? { connectionId } : {}), ...(role === 'client' ? {} : host.auth(role, connectionId)) })}`;
const relay = async (limits, extra = {}) => { const value = createPrivateRelayServer({ host: '127.0.0.1', port: 0, limits, ...extra }); relays.push(value); await value.start(); return value; };

afterEach(async () => {
  for (const socket of sockets.splice(0)) { try { socket.terminate(); } catch {} }
  await Promise.all(relays.splice(0).map((value) => value.stop()));
});

it('reports raw socket accounting in snapshots', () => {
  const relay = createPrivateRelayServer();
  expect(relay.getSnapshot()).toMatchObject({ rawSockets: 0 });
});

it('enforces per-IP client and raw TCP limits and releases both counters', async () => {
  const value = await relay({ maxClientsPerIp: 1 }, { resolveClientIp: () => 'test-ip' });
  const host = identity(); const control = await open(connect(value, host, 'host-control')); await event(control, 'message');
  const first = await open(connect(value, host, 'client'));
  expect(await closed(connect(value, host, 'client'))).toBe(4029);
  first.close(); await event(first, 'close');
  await open(connect(value, host, 'client'));
  const rawValue = await relay({ maxRawSockets: 1, maxRawSocketsPerIp: 1, handshakeMs: 500 });
  const raw = net.connect(rawValue.address().port, '127.0.0.1');
  await event(raw, 'connect'); await eventually(() => rawValue.getSnapshot().rawSockets <= 1);
  const excess = net.connect(rawValue.address().port, '127.0.0.1'); await event(excess, 'connect'); excess.destroy(); raw.destroy();
  await rawValue.stop(); expect(rawValue.getSnapshot().rawSockets).toBe(0);
});

it('detaches a control once on callback failure and releases its queue', async () => {
  let controlSocket;
  const value = await relay({ graceMs: 10 }, { onSocketAccepted({ socket, role }) { if (role === 'host-control') controlSocket = socket; } });
  const host = identity(); const control = await open(connect(value, host, 'host-control'));
  await eventually(() => Boolean(controlSocket));
  controlSocket.send = (_data, _options, callback) => callback(new Error('test'));
  await open(connect(value, host, 'client'));
  await eventually(() => value.getSnapshot().controls === 0 && value.getSnapshot().queuedBytes === 0);
  await wait(20); expect(value.getSnapshot().hosts).toBe(0); control.terminate();
});

it('pings each accepted socket once per heartbeat and terminates an unclosed heartbeat peer at its deadline', async () => {
  let accepted;
  const value = await relay({ heartbeatMs: 10, closeDeadlineMs: 20 }, { onSocketAccepted({ socket }) { accepted = socket; } });
  const host = identity(); await open(connect(value, host, 'host-control'));
  await eventually(() => Boolean(accepted)); let pings = 0; let terminated = 0;
  accepted.ping = () => { pings += 1; }; accepted.close = () => {}; accepted.terminate = () => { terminated += 1; accepted.emit('close'); };
  await eventually(() => pings >= 1); await eventually(() => terminated === 1 && value.getSnapshot().sockets === 0);
  expect(pings).toBeGreaterThanOrEqual(1);
});

it('does not schedule a close deadline after a client closes an attached pair', async () => {
  let closeDeadlineSchedules = 0;
  const clock = {
    setTimeout(callback, ms, ...args) {
      if (ms === 5_000) closeDeadlineSchedules += 1;
      return setTimeout(callback, ms, ...args);
    },
    clearTimeout,
  };
  const value = await relay({ closeDeadlineMs: 5_000 }, { clock });
  const host = identity(); const control = await open(connect(value, host, 'host-control')); await event(control, 'message');
  const connection = event(control, 'message'); const client = await open(connect(value, host, 'client'));
  const connectionId = JSON.parse((await connection)[0].toString()).connectionId;
  const data = await open(connect(value, host, 'host-data', connectionId));
  closeDeadlineSchedules = 0;
  const dataClosed = event(data, 'close'); client.close(); await event(client, 'close'); await dataClosed;
  expect(closeDeadlineSchedules).toBe(0);
});

it('accepts restart requested during stopping and leaves one running listener', async () => {
  const value = await relay(); const stopping = value.stop(); const restarting = value.start();
  await Promise.all([stopping, restarting]); expect(value.getSnapshot().state).toBe('running'); expect(value.address().port).toBeGreaterThan(0);
});
