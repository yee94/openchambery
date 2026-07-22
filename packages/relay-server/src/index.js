import crypto from 'node:crypto';
import http from 'node:http';
import { isIP } from 'node:net';
import { WebSocketServer } from 'ws';

const CLOSE = { replaced: 4001, duplicate: 4002, stuck: 4003, unavailable: 4008, auth: 4010, limit: 4029, away: 1012, malformed: 1008 };
const B64 = /^[A-Za-z0-9_-]+$/;
const SERVER_ID_BYTES = 32;
const DEFAULT_LIMITS = {
  maxUrlBytes: 4096, maxFieldBytes: 512, maxHosts: 256, maxSockets: 2048, maxConnections: 1000,
  maxClientsPerHost: 100, maxClientsPerIp: 30, maxPendingClients: 30, pendingMs: 15_000,
  maxRawSockets: 4096, maxRawSocketsPerIp: 128,
  graceMs: 30_000, timestampSkewMs: 60_000, replayMs: 120_000, maxReplayEntries: 10_000,
  maxFrameBytes: 128 * 1024, maxQueuedBytesPerConnection: 2 * 1024 * 1024,
  maxGlobalQueuedBytes: 32 * 1024 * 1024, maxBufferedAmount: 2 * 1024 * 1024,
  maxControlQueueEntries: 256, maxControlQueuedBytes: 2 * 1024 * 1024,
  pumpRetryMs: 25, heartbeatMs: 30_000, handshakeMs: 10_000, closeDeadlineMs: 5_000,
  admissionWindowMs: 60_000, maxAdmissionsPerIp: 120, maxAdmissionEntries: 10_000,
  idAttempts: 4,
};
const fields = {
  client: new Set(['v', 'role', 'serverId', 'grant']),
  'host-control': new Set(['v', 'role', 'serverId', 'ts', 'sig', 'pk']),
  'host-data': new Set(['v', 'role', 'serverId', 'connectionId', 'ts', 'sig', 'pk']),
};
const bytes = (value) => Buffer.byteLength(value, 'utf8');
const canonical = (jwk) => JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
const b64 = (value, length) => {
  if (typeof value !== 'string' || !B64.test(value)) return null;
  try { const decoded = Buffer.from(value, 'base64url'); return decoded.length === length && decoded.toString('base64url') === value ? decoded : null; } catch { return null; }
};

export const resolveRelayClientIp = (request, trustProxy = false) => {
  const remoteAddress = request.socket.remoteAddress ?? 'unknown';
  if (!trustProxy) return remoteAddress;
  const forwarded = request.headers['x-forwarded-for'];
  const candidate = typeof forwarded === 'string' && !forwarded.includes(',') ? forwarded.trim() : '';
  return isIP(candidate) ? candidate : remoteAddress;
};

export const formatRelayWsUrl = (host, port, relayPath) => `ws://${isIP(host) === 6 ? `[${host}]` : host}:${port}${relayPath}`;

/** @param {string} encoded */
const decodeJwk = (encoded) => {
  const raw = b64(encoded, Buffer.byteLength(encoded, 'base64url'));
  if (!raw) return null;
  try {
    const text = raw.toString('utf8'); const jwk = JSON.parse(text);
    if (text !== canonical(jwk) || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !b64(jwk.x, 32) || !b64(jwk.y, 32)) return null;
    return { jwk, key: crypto.createPublicKey({ key: jwk, format: 'jwk' }) };
  } catch { return null; }
};

/**
 * Creates the Layer 1 self-hosted relay. It routes opaque Layer 2/3 frames.
 * @param {{ host?: string, port?: number, path?: string, trustProxy?: boolean, requestHandler?: (request: http.IncomingMessage, response: http.ServerResponse) => boolean, clock?: Partial<typeof globalThis>, randomBytes?: (size: number) => Buffer, logger?: Pick<Console, 'info'|'warn'|'error'>, limits?: Partial<typeof DEFAULT_LIMITS>, resolveClientIp?: (request: http.IncomingMessage) => string, onSocketAccepted?: ({ socket: import('ws').WebSocket, role: string }) => void }} options
 */
export const createPrivateRelayServer = (options = {}) => {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  if (limits.replayMs < limits.timestampSkewMs * 2 || limits.maxReplayEntries < 1) throw new RangeError('invalid replay limits');
  const clock = { now: Date.now, setTimeout, clearTimeout, setInterval, clearInterval, ...options.clock };
  const randomBytes = options.randomBytes ?? crypto.randomBytes;
  const hosts = new Map(); const replay = new Map(); const admissions = new Map(); const clientIpCounts = new Map(); const rawIpCounts = new Map();
  const accepted = new Set(); const rawSockets = new Set();
  const counts = { hosts: 0, sockets: 0, rawSockets: 0, controls: 0, clients: 0, pairs: 0, pending: 0, queuedBytes: 0 };
  const reasons = { authRejected: 0, policyRejected: 0, limited: 0, heartbeatReaped: 0, replayRejected: 0 };
  let server = null; let wss = null; let heartbeat = null; let startPromise = null; let stopPromise = null; let abortStart = null; let state = 'idle'; let generation = 0;
  const addReason = (key) => { reasons[key] += 1; };
  const snapshot = () => ({ state, ...counts, reasons: { ...reasons } });
  const resolveClientIp = options.resolveClientIp ?? ((request) => resolveRelayClientIp(request, options.trustProxy));
  const relayPath = options.path ?? '/ws';
  const decrement = (map, key) => { const value = map.get(key) ?? 0; if (value <= 1) map.delete(key); else map.set(key, value - 1); };
  const safeClose = (socket, code, reason = '') => {
    if (socket.readyState === socket.CLOSED) return;
    try {
      if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) socket.close(code, reason);
      if (socket.readyState === socket.CLOSED) return;
      if (socket.readyState !== socket.OPEN && socket.readyState !== socket.CONNECTING && socket.readyState !== socket.CLOSING) return;
      if (!socket._relayCloseDeadline) socket._relayCloseDeadline = clock.setTimeout(() => {
        socket._relayCloseDeadline = null;
        if (socket.readyState !== socket.CLOSED) socket.terminate();
      }, limits.closeDeadlineMs);
    } catch { socket.terminate(); }
  };
  const purge = () => {
    const now = clock.now();
    for (const [key, expiry] of replay) if (expiry <= now) replay.delete(key);
    for (const [key, record] of admissions) if (record.until <= now) admissions.delete(key);
  };
  const admitIp = (ip, role) => {
    purge(); const key = `${role}:${ip}`; let record = admissions.get(key);
    if (!record) {
      if (admissions.size >= limits.maxAdmissionEntries) { addReason('limited'); return false; }
      record = { count: 0, until: clock.now() + limits.admissionWindowMs }; admissions.set(key, record);
    }
    record.count += 1;
    if (record.count > limits.maxAdmissionsPerIp) { addReason('limited'); return false; }
    return true;
  };
  const removeSocket = (socket) => {
    if (!accepted.delete(socket)) return;
    counts.sockets -= 1;
    if (socket._relayHandshake) clock.clearTimeout(socket._relayHandshake);
    if (socket._relayCloseDeadline) clock.clearTimeout(socket._relayCloseDeadline);
  };
  const detachControl = (host, control, { code = CLOSE.away, reason = 'control closed', grace = true } = {}) => {
    if (!control || hosts.get(host.serverId) !== host || host.control !== control || control.epoch !== host.epoch) return;
    host.control = null;
    counts.controls -= 1;
    const queued = control.queuedBytes;
    control.queue = []; control.queuedBytes = 0; control.busy = false;
    counts.queuedBytes = Math.max(0, counts.queuedBytes - queued);
    safeClose(control.socket, code, reason);
    if (grace) beginGrace(host, control.epoch);
  };
  const controlPump = (host, message) => {
    if (!host.control || host.control.epoch !== host.epoch) return;
    const control = host.control; const payload = Buffer.from(JSON.stringify(message));
    if (control.queue.length >= limits.maxControlQueueEntries || control.queuedBytes + payload.length > limits.maxControlQueuedBytes || counts.queuedBytes + payload.length > limits.maxGlobalQueuedBytes) {
      addReason('limited'); detachControl(host, control, { code: CLOSE.limit, reason: 'control queue limit' }); return;
    }
    control.queue.push(payload); control.queuedBytes += payload.length; counts.queuedBytes += payload.length;
    const pump = () => {
      const control = host.control;
      if (!control || control.epoch !== host.epoch || control.busy || !control.queue.length) return;
      if (control.socket.readyState !== control.socket.OPEN) return detachControl(host, control, { code: CLOSE.away, reason: 'control unavailable' });
      control.busy = true; const item = control.queue[0];
      control.socket.send(item, { binary: false }, (error) => {
        if (!host.control || host.control !== control || control.epoch !== host.epoch) return;
        control.busy = false;
        if (error) { detachControl(host, control, { code: CLOSE.away, reason: 'control send failure' }); return; }
        control.queue.shift(); control.queuedBytes -= item.length; counts.queuedBytes = Math.max(0, counts.queuedBytes - item.length); pump();
      });
    };
    pump();
  };
  const releasePump = (entry, pump) => {
    if (pump.retry) clock.clearTimeout(pump.retry);
    const total = pump.bytes; pump.queue = []; pump.bytes = 0; pump.busy = false; pump.retry = null;
    entry.queuedBytes = Math.max(0, entry.queuedBytes - total);
    counts.queuedBytes = Math.max(0, counts.queuedBytes - total);
  };
  const removeClient = (host, entry, code, reason, notify = true) => {
    if (host.clients.get(entry.id) !== entry) return;
    host.clients.delete(entry.id); counts.clients -= 1; decrement(clientIpCounts, entry.ip); if (entry.data) counts.pairs -= 1; else counts.pending -= 1;
    if (entry.pendingTimer) clock.clearTimeout(entry.pendingTimer);
    releasePump(entry, entry.toData); releasePump(entry, entry.toClient);
    if (entry.client) safeClose(entry.client, code, reason); if (entry.data) safeClose(entry.data, code, reason);
    if (notify) controlPump(host, { type: 'disconnected', connectionId: entry.id });
    if (!host.control && host.clients.size === 0 && !host.graceTimer && hosts.delete(host.serverId)) counts.hosts -= 1;
  };
  const expireHost = (host, epoch) => {
    if (hosts.get(host.serverId) !== host || host.epoch !== epoch || host.control) return;
    host.graceTimer = null;
    for (const entry of [...host.clients.values()]) removeClient(host, entry, CLOSE.away, 'host went away', false);
    if (hosts.get(host.serverId) === host && hosts.delete(host.serverId)) counts.hosts -= 1;
  };
  const beginGrace = (host, epoch) => {
    if (hosts.get(host.serverId) !== host || host.epoch !== epoch || host.graceTimer) return;
    host.graceTimer = clock.setTimeout(() => expireHost(host, epoch), limits.graceMs);
  };
  const pump = (host, entry, direction) => {
    const channel = entry[direction]; const target = direction === 'toData' ? entry.data : entry.client;
    if (host.clients.get(entry.id) !== entry || channel.busy || !channel.queue.length) return;
    if (!target || target.readyState !== target.OPEN || target.bufferedAmount > limits.maxBufferedAmount) {
      if (!channel.retry) channel.retry = clock.setTimeout(() => { channel.retry = null; pump(host, entry, direction); }, limits.pumpRetryMs);
      return;
    }
    channel.busy = true; const item = channel.queue[0];
    target.send(item.data, { binary: item.binary }, (error) => {
      if (host.clients.get(entry.id) !== entry || entry[direction] !== channel) return;
      channel.busy = false;
      if (error) { removeClient(host, entry, CLOSE.limit, 'send failure'); return; }
      channel.queue.shift(); channel.bytes = Math.max(0, channel.bytes - item.data.length); entry.queuedBytes = Math.max(0, entry.queuedBytes - item.data.length); counts.queuedBytes = Math.max(0, counts.queuedBytes - item.data.length);
      pump(host, entry, direction);
    });
  };
  const enqueue = (host, entry, direction, data, binary) => {
    const payload = Buffer.from(data); const channel = entry[direction];
    if (payload.length > limits.maxFrameBytes || entry.queuedBytes + payload.length > limits.maxQueuedBytesPerConnection || counts.queuedBytes + payload.length > limits.maxGlobalQueuedBytes) { addReason('limited'); removeClient(host, entry, CLOSE.limit, 'queue limit'); return; }
    channel.queue.push({ data: payload, binary }); channel.bytes += payload.length; entry.queuedBytes += payload.length; counts.queuedBytes += payload.length; pump(host, entry, direction);
  };
  const bindClient = (host, entry, socket) => {
    entry.client = socket;
    socket.on('message', (data, binary) => enqueue(host, entry, 'toData', data, binary));
    socket.on('close', () => removeClient(host, entry, 1000, '', true)); socket.on('error', () => {});
  };
  const bindData = (host, entry, socket) => {
    entry.data = socket; counts.pending -= 1; counts.pairs += 1; if (entry.pendingTimer) clock.clearTimeout(entry.pendingTimer);
    socket.on('message', (data, binary) => enqueue(host, entry, 'toClient', data, binary));
    socket.on('close', () => { if (host.clients.get(entry.id) === entry && entry.data === socket) removeClient(host, entry, CLOSE.away, 'host data closed'); }); socket.on('error', () => {});
    pump(host, entry, 'toData');
  };
  const parse = (request) => {
    if (!request.url || bytes(request.url) > limits.maxUrlBytes) return null;
    let url; try { url = new URL(request.url, 'http://relay'); } catch { return null; }
    if (url.pathname !== relayPath) return null;
    const role = url.searchParams.get('role'); const allowed = fields[role];
    if (!allowed || url.searchParams.get('v') !== '1') return null;
    for (const [key, value] of url.searchParams) if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1 || bytes(value) > limits.maxFieldBytes) return null;
    for (const key of allowed) if (key !== 'grant' && !url.searchParams.has(key)) return null;
    const serverId = url.searchParams.get('serverId');
    if (!b64(serverId, SERVER_ID_BYTES)) return null;
    const connectionId = url.searchParams.get('connectionId');
    if (connectionId && !b64(connectionId, 16)) return null;
    return { role, serverId, connectionId, params: url.searchParams };
  };
  const authenticate = (parsed) => {
    if (parsed.role === 'client') return true;
    const ts = parsed.params.get('ts'); const sig = parsed.params.get('sig'); const pk = parsed.params.get('pk');
    if (!/^(0|[1-9][0-9]{0,15})$/.test(ts ?? '')) return false;
    const timestamp = Number(ts); if (!Number.isSafeInteger(timestamp) || Math.abs(clock.now() - timestamp) > limits.timestampSkewMs) return false;
    const signature = b64(sig, 64); const publicKey = decodeJwk(pk);
    if (!signature || !publicKey) return false;
    const id = crypto.createHash('sha256').update(canonical(publicKey.jwk)).digest('base64url'); if (id !== parsed.serverId) return false;
    const key = `${parsed.serverId}.${parsed.role}.${parsed.connectionId ?? ''}.${ts}`;
    purge(); if (replay.has(key) || replay.size >= limits.maxReplayEntries) { addReason('replayRejected'); return false; }
    const message = `${ts}.${parsed.serverId}.${parsed.role}.${parsed.connectionId ?? ''}`;
    if (!crypto.verify('SHA256', Buffer.from(message), { key: publicKey.key, dsaEncoding: 'ieee-p1363' }, signature)) return false;
    replay.set(key, clock.now() + limits.replayMs); return true;
  };
  const idFor = (host) => {
    for (let attempt = 0; attempt < limits.idAttempts; attempt += 1) { const id = Buffer.from(randomBytes(16)).toString('base64url'); if (id.length === 22 && !host.clients.has(id)) return id; }
    return null;
  };
  const attach = (socket, request, parsed) => {
    const ip = resolveClientIp(request); socket._relayRole = parsed.role; socket._relayAlive = true;
    socket.on('pong', () => { socket._relayAlive = true; });
    if (parsed.role === 'host-control') {
      let host = hosts.get(parsed.serverId);
      if (!host && counts.hosts >= limits.maxHosts) { addReason('limited'); return safeClose(socket, CLOSE.limit, 'host limit'); }
      if (!host) { host = { serverId: parsed.serverId, clients: new Map(), control: null, epoch: 0, graceTimer: null }; hosts.set(parsed.serverId, host); counts.hosts += 1; }
      if (host.control) { const previous = host.control; host.epoch += 1; for (const entry of [...host.clients.values()]) removeClient(host, entry, CLOSE.replaced, 'control replaced', false); host.epoch -= 1; detachControl(host, previous, { code: CLOSE.replaced, reason: 'control replaced', grace: false }); }
      if (host.graceTimer) { clock.clearTimeout(host.graceTimer); host.graceTimer = null; }
      host.epoch += 1; const epoch = host.epoch; host.control = { socket, epoch, queue: [], queuedBytes: 0, busy: false }; counts.controls += 1;
      socket.on('close', () => detachControl(host, host.control?.socket === socket ? host.control : null, { code: CLOSE.away, reason: 'control closed' })); socket.on('error', () => {});
      controlPump(host, { type: 'sync', connectionIds: [...host.clients.keys()] }); return;
    }
    if (parsed.role === 'client') {
      const host = hosts.get(parsed.serverId);
      if (!host) return safeClose(socket, CLOSE.unavailable, 'host unavailable');
      if (counts.clients >= limits.maxConnections || host.clients.size >= limits.maxClientsPerHost || counts.pending >= limits.maxPendingClients || (clientIpCounts.get(ip) ?? 0) >= limits.maxClientsPerIp) { addReason('limited'); return safeClose(socket, CLOSE.limit, 'client limit'); }
      const id = idFor(host); if (!id) { addReason('limited'); return safeClose(socket, CLOSE.limit, 'id collision'); }
      const entry = { id, ip, client: null, data: null, queuedBytes: 0, toData: { queue: [], bytes: 0, busy: false, retry: null }, toClient: { queue: [], bytes: 0, busy: false, retry: null }, pendingTimer: null };
      host.clients.set(id, entry); counts.clients += 1; counts.pending += 1; clientIpCounts.set(ip, (clientIpCounts.get(ip) ?? 0) + 1); bindClient(host, entry, socket);
      entry.pendingTimer = clock.setTimeout(() => { if (host.clients.get(id) === entry && !entry.data) removeClient(host, entry, CLOSE.limit, 'pending timeout'); }, limits.pendingMs);
      controlPump(host, { type: 'connected', connectionId: id }); return;
    }
    const host = hosts.get(parsed.serverId); const entry = host?.clients.get(parsed.connectionId);
    if (!host || !entry || entry.data) return safeClose(socket, CLOSE.duplicate, 'data attach');
    bindData(host, entry, socket);
  };
  const reject = (request, socket, head, code) => wss.handleUpgrade(request, socket, head, (ws) => safeClose(ws, code, 'rejected'));
  const start = () => {
    if (state === 'running') return Promise.resolve(); if (state === 'stopping') return stopPromise.then(() => start()); if (startPromise) return startPromise;
    state = 'starting'; const localGeneration = ++generation; const localServer = http.createServer((request, response) => {
      if (options.requestHandler?.(request, response) || response.writableEnded) return;
      const pathname = new URL(request.url ?? '/', 'http://relay').pathname;
      const ready = pathname === '/readyz' && state === 'running';
      const healthy = pathname === '/healthz';
      response.setHeader('cache-control', 'no-store');
      if ((healthy || ready) && (request.method === 'GET' || request.method === 'HEAD')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(request.method === 'HEAD' ? undefined : '{"status":"ok"}');
        return;
      }
      response.writeHead(404); response.end();
    }); const localWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: limits.maxFrameBytes }); server = localServer; wss = localWss;
    localServer.on('connection', (socket) => {
      const ip = socket.remoteAddress ?? 'unknown';
      if (counts.rawSockets >= limits.maxRawSockets || (rawIpCounts.get(ip) ?? 0) >= limits.maxRawSocketsPerIp) { addReason('limited'); socket.destroy(); return; }
      rawSockets.add(socket); counts.rawSockets += 1; rawIpCounts.set(ip, (rawIpCounts.get(ip) ?? 0) + 1); socket._relayRawIp = ip;
      socket._relayTcpTimer = clock.setTimeout(() => socket.destroy(), limits.handshakeMs);
      socket.on('close', () => { if (socket._relayTcpTimer) clock.clearTimeout(socket._relayTcpTimer); if (rawSockets.delete(socket)) { counts.rawSockets -= 1; decrement(rawIpCounts, ip); } });
    });
    localServer.on('upgrade', (request, socket, head) => {
      if (socket._relayTcpTimer) { clock.clearTimeout(socket._relayTcpTimer); socket._relayTcpTimer = null; }
      const parsed = parse(request); const ip = resolveClientIp(request);
      if (!parsed) { addReason('policyRejected'); return reject(request, socket, head, CLOSE.malformed); }
      if (!admitIp(ip, parsed.role)) return reject(request, socket, head, CLOSE.limit);
      if (!authenticate(parsed)) { addReason('authRejected'); return reject(request, socket, head, CLOSE.auth); }
      if (counts.sockets >= limits.maxSockets) { addReason('limited'); return reject(request, socket, head, CLOSE.limit); }
      localWss.handleUpgrade(request, socket, head, (ws) => { accepted.add(ws); counts.sockets += 1; ws.on('close', () => removeSocket(ws)); ws._relayHandshake = clock.setTimeout(() => { if (!ws._relayRole) safeClose(ws, CLOSE.malformed, 'handshake timeout'); }, limits.handshakeMs); options.onSocketAccepted?.({ socket: ws, role: parsed.role }); attach(ws, request, parsed); if (ws._relayHandshake) { clock.clearTimeout(ws._relayHandshake); ws._relayHandshake = null; } });
    });
    heartbeat = clock.setInterval(() => { purge(); for (const socket of accepted) { if (socket.readyState !== socket.OPEN) continue; if (!socket._relayAlive) { addReason('heartbeatReaped'); safeClose(socket, socket._relayRole === 'host-control' ? CLOSE.stuck : CLOSE.away, 'heartbeat'); continue; } socket._relayAlive = false; try { socket.ping(); } catch { safeClose(socket, CLOSE.away, 'heartbeat'); } } }, limits.heartbeatMs);
    startPromise = new Promise((resolve, rejectStart) => {
      const fail = (error) => { if (localGeneration !== generation) return; localServer.off('listening', ready); cleanupStart(); rejectStart(error); };
      const ready = () => { localServer.off('error', fail); if (localGeneration !== generation || state !== 'starting') return; state = 'running'; resolve(); };
      const cleanupStart = () => { if (heartbeat) { clock.clearInterval(heartbeat); heartbeat = null; } localWss.close(); localServer.close(); if (server === localServer) { server = null; wss = null; } state = 'stopped'; };
      abortStart = () => { if (state === 'starting') { cleanupStart(); rejectStart(new Error('relay stopped during start')); } };
      localServer.once('error', fail); localServer.once('listening', ready); localServer.listen(options.port ?? 0, options.host ?? '127.0.0.1');
    }).finally(() => { startPromise = null; abortStart = null; });
    return startPromise;
  };
  const stop = () => {
    if (stopPromise) return stopPromise;
    if (state === 'idle' || state === 'stopped') { state = 'stopped'; return Promise.resolve(); }
    if (state === 'starting') abortStart?.();
    state = 'stopping'; generation += 1; const localServer = server; const localWss = wss;
    stopPromise = new Promise((resolve) => {
      if (heartbeat) { clock.clearInterval(heartbeat); heartbeat = null; }
      for (const host of hosts.values()) { if (host.graceTimer) clock.clearTimeout(host.graceTimer); if (host.control) detachControl(host, host.control, { code: CLOSE.away, reason: 'server stopping', grace: false }); for (const entry of [...host.clients.values()]) removeClient(host, entry, CLOSE.away, 'server stopping', false); }
      hosts.clear(); replay.clear(); admissions.clear(); clientIpCounts.clear(); counts.hosts = 0; counts.controls = 0; counts.clients = 0; counts.pairs = 0; counts.pending = 0; counts.queuedBytes = 0;
      for (const socket of accepted) { if (socket._relayCloseDeadline) clock.clearTimeout(socket._relayCloseDeadline); socket.terminate(); } for (const socket of rawSockets) socket.destroy(); accepted.clear(); rawSockets.clear(); rawIpCounts.clear(); counts.sockets = 0; counts.rawSockets = 0;
      if (!localServer) return resolve(); localWss?.close(); localServer.close(() => resolve()); clock.setTimeout(resolve, 100);
    }).then(() => { if (server === localServer && wss === localWss) { server = null; wss = null; state = 'stopped'; } stopPromise = null; });
    return stopPromise;
  };
  return { start, stop, address: () => server?.address(), get wsUrl() { const address = server?.address(); return address && typeof address === 'object' ? formatRelayWsUrl(options.host ?? '127.0.0.1', address.port, relayPath) : null; }, getSnapshot: snapshot };
};

export const startPrivateRelayServer = async (options) => { const relay = createPrivateRelayServer(options); await relay.start(); return relay; };
