import { afterEach, expect, it } from 'bun:test';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { WebSocket } from 'ws';

import { createPrivateRelayServer } from '../src/index.js';

const relays = [];
const sockets = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const eventually = async (check, timeout = 1_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await wait(5);
  }
  expect(check()).toBe(true);
};
const once = (emitter, name) => new Promise((resolve) => emitter.once(name, (...args) => resolve(args)));
const open = async (url) => {
  const socket = new WebSocket(url);
  socket.on('error', () => {});
  socket._messages = [];
  socket.on('message', (data, binary) => socket._messages.push([Buffer.from(data), binary]));
  sockets.push(socket);
  await once(socket, 'open');
  return socket;
};
const closeCode = async (url) => {
  const socket = new WebSocket(url);
  socket.on('error', () => {});
  sockets.push(socket);
  return (await once(socket, 'close'))[0];
};
const nextMessage = (socket) => {
  if (socket._messages?.length) return Promise.resolve(socket._messages.shift());
  return new Promise((resolve) => socket.once('message', () => resolve(socket._messages.shift())));
};
const identity = (now = Date.now) => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  const serverId = crypto.createHash('sha256').update(canonical).digest('base64url');
  let last = 0;
  const auth = (role, connectionId, timestamp = Math.max(now(), last + 1)) => {
    last = Math.max(last, timestamp);
    const ts = String(timestamp);
    const sig = crypto.sign('SHA256', Buffer.from(`${ts}.${serverId}.${role}.${connectionId ?? ''}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    return { ts, sig, pk: Buffer.from(canonical).toString('base64url') };
  };
  return { serverId, auth };
};
const clientUrl = (relay, host, extra = {}) => `${relay.wsUrl}?${new URLSearchParams({ v: '1', role: 'client', serverId: host.serverId, ...extra })}`;
const hostUrl = (relay, host, role, connectionId, auth = host.auth(role, connectionId)) => `${relay.wsUrl}?${new URLSearchParams({ v: '1', role, serverId: host.serverId, ...(connectionId ? { connectionId } : {}), ...auth })}`;
const start = async (limits, options = {}) => {
  const relay = createPrivateRelayServer({ host: '127.0.0.1', port: 0, limits, ...options });
  relays.push(relay);
  await relay.start();
  return relay;
};
const control = async (relay, host) => {
  const socket = await open(hostUrl(relay, host, 'host-control'));
  await nextMessage(socket);
  return socket;
};
const connected = async (relay, host, socket) => {
  const message = nextMessage(socket);
  await open(clientUrl(relay, host));
  return JSON.parse((await message)[0].toString()).connectionId;
};

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(relays.splice(0).map((relay) => relay.stop()));
});

it('separately rejects forbidden fields and malformed or future authentication', async () => {
  const relay = await start(); const host = identity();
  expect(await closeCode(clientUrl(relay, host, { ts: String(Date.now()) }))).toBe(1008);
  expect(await closeCode(hostUrl(relay, host, 'host-control', undefined, { ...host.auth('host-control'), grant: 'x' }))).toBe(1008);
  const padded = host.auth('host-control'); padded.sig += '=';
  expect(await closeCode(hostUrl(relay, host, 'host-control', undefined, padded))).toBe(4010);
  const malformed = host.auth('host-control'); malformed.pk = '*';
  expect(await closeCode(hostUrl(relay, host, 'host-control', undefined, malformed))).toBe(4010);
  const future = host.auth('host-control', undefined, Date.now() + 120_000);
  expect(await closeCode(hostUrl(relay, host, 'host-control', undefined, future))).toBe(4010);
});

it('uses 22-character base64url client ids and limits deterministic collision retries', async () => {
  const bytes = Buffer.alloc(16, 7);
  const relay = await start({ idAttempts: 2 }, { randomBytes: () => bytes }); const host = identity(); const hostControl = await control(relay, host);
  const message = nextMessage(hostControl); const first = await open(clientUrl(relay, host));
  const id = JSON.parse((await message)[0].toString()).connectionId;
  expect(id).toHaveLength(22); expect(Buffer.from(id, 'base64url')).toHaveLength(16);
  expect(await closeCode(clientUrl(relay, host))).toBe(4029);
  expect(relay.getSnapshot().reasons.limited).toBe(1);
  first.terminate();
});

it('enforces the host limit independently', async () => {
  const hostLimit = await start({ maxHosts: 1 }); const first = identity(); const second = identity(); await control(hostLimit, first);
  expect(await closeCode(hostUrl(hostLimit, second, 'host-control'))).toBe(4029);
  expect(hostLimit.getSnapshot()).toMatchObject({ hosts: 1, reasons: { limited: 1 } });
});

it('enforces the accepted socket limit independently', async () => {
  const socketLimit = await start({ maxSockets: 1 }); const socketHost = identity(); await control(socketLimit, socketHost);
  expect(await closeCode(clientUrl(socketLimit, socketHost))).toBe(4029);
  expect(socketLimit.getSnapshot()).toMatchObject({ sockets: 1, reasons: { limited: 1 } });
});

it('enforces the replay limit independently', async () => {
  const replayLimit = await start({ maxReplayEntries: 1, replayMs: 120_000 }); const replayHost = identity(); await control(replayLimit, replayHost);
  expect(await closeCode(hostUrl(replayLimit, replayHost, 'host-control'))).toBe(4010);
  expect(replayLimit.getSnapshot()).toMatchObject({ reasons: { replayRejected: 1 } });
});

it('enforces the per-IP admission limit independently', async () => {
  const admissionLimit = await start({ maxAdmissionsPerIp: 1 }, { resolveClientIp: () => 'shared-ip' }); const admissionHost = identity(); const admissionSecondHost = identity(); await control(admissionLimit, admissionHost);
  expect(await closeCode(hostUrl(admissionLimit, admissionSecondHost, 'host-control'))).toBe(4029);
  expect(admissionLimit.getSnapshot()).toMatchObject({ reasons: { limited: 1 } });
});

it('expires replay entries using the injected clock', async () => {
  let now = 10_000;
  const relay = await start({ timestampSkewMs: 10, replayMs: 20, maxReplayEntries: 1 }, { clock: { now: () => now } }); const host = identity(() => now);
  const signed = host.auth('host-control', undefined, now);
  const initial = await open(hostUrl(relay, host, 'host-control', undefined, signed)); await nextMessage(initial);
  expect(await closeCode(hostUrl(relay, host, 'host-control', undefined, signed))).toBe(4010);
  now += 21;
  const recovered = await open(hostUrl(relay, host, 'host-control', undefined, host.auth('host-control', undefined, now)));
  await nextMessage(recovered);
  expect(relay.getSnapshot().reasons.replayRejected).toBe(1);
});

it('bounds a hung control queue and releases it after grace', async () => {
  let serverControl;
  const relay = await start({ maxControlQueueEntries: 1, graceMs: 15 }, { onSocketAccepted({ socket, role }) { if (role === 'host-control') { serverControl = socket; socket.send = () => {}; } } });
  const host = identity(); const peer = await open(hostUrl(relay, host, 'host-control'));
  await eventually(() => Boolean(serverControl));
  const closed = once(peer, 'close'); const client = await open(clientUrl(relay, host));
  expect((await closed)[0]).toBe(4029);
  await eventually(() => relay.getSnapshot().controls === 0 && relay.getSnapshot().queuedBytes === 0);
  await eventually(() => relay.getSnapshot().hosts === 0);
  client.terminate();
});

it('releases a control queue when its send callback reports an error', async () => {
  let serverControl;
  const relay = await start({ graceMs: 15 }, { onSocketAccepted({ socket, role }) { if (role === 'host-control') serverControl = socket; } });
  const host = identity(); await control(relay, host); await eventually(() => Boolean(serverControl));
  serverControl.send = (_data, _options, callback) => callback(new Error('send failure'));
  await open(clientUrl(relay, host));
  await eventually(() => relay.getSnapshot().controls === 0 && relay.getSnapshot().queuedBytes === 0);
});

it('enforces aggregate pair queue bytes with both sends in flight', async () => {
  const held = new Map();
  const relay = await start({ maxQueuedBytesPerConnection: 10 }, { onSocketAccepted({ socket, role }) { if (role === 'client' || role === 'host-data') { held.set(role, socket); socket.send = () => {}; } } });
  const host = identity(); const hostControl = await control(relay, host); const id = await connected(relay, host, hostControl);
  const client = sockets.at(-1); const data = await open(hostUrl(relay, host, 'host-data', id));
  await eventually(() => held.size === 2);
  client.send(Buffer.alloc(6)); data.send(Buffer.alloc(6));
  expect((await once(client, 'close'))[0]).toBe(4029);
  await eventually(() => relay.getSnapshot().clients === 0 && relay.getSnapshot().pairs === 0 && relay.getSnapshot().queuedBytes === 0);
});

it('cleans a pair after a send callback error', async () => {
  let dataSocket;
  const relay = await start({}, { onSocketAccepted({ socket, role }) { if (role === 'host-data') dataSocket = socket; } });
  const host = identity(); const hostControl = await control(relay, host); const id = await connected(relay, host, hostControl); const client = sockets.at(-1);
  await open(hostUrl(relay, host, 'host-data', id)); await eventually(() => Boolean(dataSocket));
  dataSocket.send = (_data, _options, callback) => callback(new Error('send failure'));
  client.send('x');
  expect((await once(client, 'close'))[0]).toBe(4029);
  await eventually(() => relay.getSnapshot().clients === 0 && relay.getSnapshot().pairs === 0 && relay.getSnapshot().queuedBytes === 0);
});

it('flushes pre-attach text and binary frames in order and rejects duplicate data', async () => {
  const relay = await start(); const host = identity(); const hostControl = await control(relay, host); const id = await connected(relay, host, hostControl); const client = sockets.at(-1);
  client.send('first'); client.send(Buffer.from([2])); client.send('third');
  const data = await open(hostUrl(relay, host, 'host-data', id));
  const received = [await nextMessage(data), await nextMessage(data), await nextMessage(data)];
  expect(received.map(([payload, binary]) => [payload.toString(), binary])).toEqual([['first', false], ['\u0002', true], ['third', false]]);
  expect(await closeCode(hostUrl(relay, host, 'host-data', id))).toBe(4002);
});

it('pings a registered control once per heartbeat with no clients', async () => {
  let pings = 0; let firstPing;
  const pinged = new Promise((resolve) => { firstPing = resolve; });
  const relay = await start({ heartbeatMs: 180 }, { onSocketAccepted({ socket, role }) { if (role === 'host-control') socket.ping = () => { pings += 1; firstPing(); }; } });
  const host = identity(); await control(relay, host); await pinged;
  expect(pings).toBe(1); expect(relay.getSnapshot()).toMatchObject({ hosts: 1, controls: 1 });
});

it('pings every control and pair socket once in the first heartbeat round', async () => {
  const accepted = []; const pings = new Map(); let heartbeatTick;
  const relay = await start({ heartbeatMs: 200 }, { clock: { setInterval(callback) { heartbeatTick = callback; return 1; }, clearInterval() {} }, onSocketAccepted({ socket }) { accepted.push(socket); } });
  const host = identity(); const hostControl = await control(relay, host);
  const first = await connected(relay, host, hostControl); await open(hostUrl(relay, host, 'host-data', first));
  const second = await connected(relay, host, hostControl); await open(hostUrl(relay, host, 'host-data', second));
  await eventually(() => accepted.length === 5);
  await eventually(() => accepted.every((socket) => socket.readyState === socket.OPEN));
  for (const [index, socket] of accepted.entries()) { pings.set(index, 0); socket.ping = () => { pings.set(index, pings.get(index) + 1); }; }
  heartbeatTick();
  expect([...pings.values()]).toEqual([1, 1, 1, 1, 1]);
});

it('reaps a missing pong at the close deadline and decreases socket count', async () => {
  let accepted;
  const relay = await start({ heartbeatMs: 10, closeDeadlineMs: 20 }, { onSocketAccepted({ socket }) { accepted = socket; socket.ping = () => {}; socket.close = () => {}; socket.terminate = () => { socket.emit('close'); }; } });
  const host = identity(); await open(hostUrl(relay, host, 'host-control')); await eventually(() => relay.getSnapshot().sockets === 0);
  expect(accepted).toBeDefined(); expect(relay.getSnapshot().reasons.heartbeatReaped).toBeGreaterThan(0);
});

it.skipIf(Boolean(process.versions.bun))('bounds raw TCP sockets, observes excess close, and releases the listener on stop', async () => {
  const relay = await start({ maxRawSockets: 1, maxRawSocketsPerIp: 1, handshakeMs: 1_000 }); const port = relay.address().port;
  const first = net.connect(port, '127.0.0.1'); await once(first, 'connect'); expect(relay.getSnapshot().rawSockets).toBeLessThanOrEqual(1);
  const excess = net.connect(port, '127.0.0.1'); await once(excess, 'connect'); await once(excess, 'close'); expect(relay.getSnapshot().rawSockets).toBeLessThanOrEqual(1);
  first.destroy(); await once(first, 'close'); await eventually(() => relay.getSnapshot().rawSockets === 0);
  const third = net.connect(port, '127.0.0.1'); await once(third, 'connect'); expect(third.readyState).toBe('open'); expect(relay.getSnapshot().rawSockets).toBeLessThanOrEqual(1);
  await relay.stop(); expect(relay.getSnapshot().rawSockets).toBe(0);
  const replacement = http.createServer(); await new Promise((resolve) => replacement.listen(port, '127.0.0.1', resolve)); await new Promise((resolve) => replacement.close(resolve));
});
