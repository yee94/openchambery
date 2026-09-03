import { createApnsProvider } from './apns.js';
import { normalizePushRelayOptions, resolvePushRelayClientIp } from './config.js';
import { deriveServerId, verifyP1363 } from './crypto.js';
import { createInFlightGate, createReplayGuard, createSlidingWindowLimiter, createWorkTracker } from './guard.js';
import { JSON_BODY_BYTES, buildLiveActivityPayload, validateLiveActivityBody, validateLiveActivityRegisterBody, validateRegisterBody, validateSendBody } from './schema.js';
import { createTokenStore } from './store.js';

const WINDOW_MS = 60_000;
const STOP_DEADLINE_MS = 5_500;

const sendJson = (response, status, payload, method = 'GET') => {
  if (response.writableEnded) return;
  response.setHeader('cache-control', 'no-store');
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(method === 'HEAD' ? undefined : JSON.stringify(payload));
};

const readBody = (request, maxBytes) => new Promise((resolve, reject) => {
  let done = false;
  const fail = (error) => { if (done) return; done = true; reject(error); };
  const succeed = (value) => { if (done) return; done = true; resolve(value); };
  const tooLarge = () => {
    const error = new Error('payload too large');
    error.code = 'PAYLOAD_TOO_LARGE';
    fail(error);
  };
  const drain = () => {
    request.removeListener('data', onData);
    request.resume();
  };
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    tooLarge();
    request.resume();
    return;
  }
  const chunks = [];
  let size = 0;
  const onData = (chunk) => {
    size += chunk.length;
    if (size > maxBytes) {
      drain();
      tooLarge();
      return;
    }
    chunks.push(chunk);
  };
  request.on('data', onData);
  request.on('end', () => succeed(Buffer.concat(chunks)));
  request.on('error', fail);
});

export const createPushRelayHandler = (options = {}) => {
  const claimHealthEndpoints = options.claimHealthEndpoints !== false;
  const config = normalizePushRelayOptions(options);
  const limits = config.limits;
  const clock = { now: Date.now, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, ...config.clock };
  const resolveClientIp = config.resolveClientIp ?? ((request) => resolvePushRelayClientIp(request, config.trustProxy));
  const ownedStore = !config.store;
  const ownedApns = !config.apnsProvider;
  const openStore = () => config.store ?? createTokenStore(config.databasePath);
  const openApns = () => config.apnsProvider ?? createApnsProvider({ ...config.apns, clock, http2: config.http2 });
  let store = openStore();
  let apns;
  try {
    apns = openApns();
  } catch (error) {
    if (ownedStore) try { store.close(); } catch { /* ignore */ }
    throw error;
  }
  const liveStore = () => {
    if (!ownedStore) return store;
    if (state === 'stopping') return store;
    try { store.count(); return store; } catch {
      store = createTokenStore(config.databasePath);
      return store;
    }
  };
  const replay = createReplayGuard({ replayMs: limits.replayMs, maxReplayEntries: limits.maxReplayEntries, now: () => clock.now() });
  const registerIpLimit = createSlidingWindowLimiter({ windowMs: WINDOW_MS, maxCount: limits.registerLimitPerMinute, maxEntries: limits.maxRateLimitEntries, now: () => clock.now() });
  const sendIpLimit = createSlidingWindowLimiter({ windowMs: WINDOW_MS, maxCount: limits.sendLimitPerMinute, maxEntries: limits.maxRateLimitEntries, now: () => clock.now() });
  const sendServerLimit = createSlidingWindowLimiter({ windowMs: WINDOW_MS, maxCount: limits.serverSendLimitPerMinute, maxEntries: limits.maxRateLimitEntries, now: () => clock.now() });
  const inFlight = createInFlightGate(limits.maxInFlight);
  const httpWork = createWorkTracker();
  const reasons = { authRejected: 0, policyRejected: 0, limited: 0, replayRejected: 0 };
  let stopPromise = null; let state = 'idle';
  const snapshot = () => {
    let tokenCount = 0;
    try { tokenCount = store.count(); } catch { /* closed after stop */ }
    return { state, tokenCount, inFlight: inFlight.active, replayEntries: replay.size, reasons: { ...reasons } };
  };

  const authenticate = (jwk, message, signature, ts) => {
    if (Math.abs(clock.now() - ts) > limits.timestampSkewMs) { reasons.authRejected += 1; return 'timestamp'; }
    if (!verifyP1363(message, jwk, signature)) { reasons.authRejected += 1; return 'invalid_signature'; }
    return null;
  };

  const handleRegister = (parsed) => {
    const message = parsed.kind
      ? `${parsed.ts}.${parsed.token}.${parsed.platform}.${parsed.kind}`
      : `${parsed.ts}.${parsed.token}.${parsed.platform}`;
    const authError = authenticate(parsed.publicKeyJwk, message, parsed.sig, parsed.ts);
    if (authError) return { status: 401, body: { error: authError } };
    const serverId = deriveServerId(parsed.publicKeyJwk);
    const replayKey = `${parsed.kind ? 'register-live-activity' : 'register'}.${serverId}.${parsed.ts}.${parsed.sig.toString('base64url')}`;
    if (replay.has(replayKey)) return { status: 200, body: { ok: true } };
    const tokens = liveStore();
    const existing = tokens.get(parsed.token);
    if (!existing && tokens.count() >= limits.maxTokens) { reasons.limited += 1; return { status: 429, body: { error: 'token_limit' } }; }
    if (!replay.remember(replayKey)) { reasons.limited += 1; return { status: 429, body: { error: 'rate_limited' } }; }
    tokens.upsert(parsed.token, serverId, parsed.platform, clock.now());
    return { status: 200, body: { ok: true } };
  };

  const handleUnregisterLiveActivity = (parsed) => {
    const authError = authenticate(parsed.publicKeyJwk, `${parsed.ts}.${parsed.token}.${parsed.platform}.${parsed.kind}`, parsed.sig, parsed.ts);
    if (authError) return { status: 401, body: { error: authError } };
    const serverId = deriveServerId(parsed.publicKeyJwk);
    const replayKey = `unregister-live-activity.${serverId}.${parsed.ts}.${parsed.sig.toString('base64url')}`;
    if (replay.has(replayKey)) return { status: 200, body: { ok: true } };
    const tokens = liveStore();
    const existing = tokens.get(parsed.token);
    if (existing && existing.serverId !== serverId) { reasons.authRejected += 1; return { status: 401, body: { error: 'invalid_signature' } }; }
    if (!replay.remember(replayKey)) { reasons.limited += 1; return { status: 429, body: { error: 'rate_limited' } }; }
    if (existing) tokens.delete(parsed.token);
    return { status: 200, body: { ok: true } };
  };

  const handleSend = async (parsed) => {
    const sorted = [...parsed.tokens].sort();
    const authError = authenticate(parsed.publicKeyJwk, `${parsed.ts}.${sorted.join(',')}.${parsed.title}`, parsed.sig, parsed.ts);
    if (authError) return { status: 401, body: { error: authError } };
    const serverId = deriveServerId(parsed.publicKeyJwk);
    const replayKey = `send.${serverId}.${parsed.ts}.${parsed.sig.toString('base64url')}`;
    if (replay.has(replayKey)) { reasons.replayRejected += 1; return { status: 401, body: { error: 'replay' } }; }
    if (!replay.remember(replayKey)) { reasons.limited += 1; return { status: 429, body: { error: 'rate_limited' } }; }
    if (!sendServerLimit.allow(serverId)) { reasons.limited += 1; return { status: 429, body: { error: 'rate_limited' } }; }
    const tokens = liveStore();
    const results = await Promise.all(parsed.uniqueTokens.map(async (token) => {
      const binding = tokens.get(token);
      if (!binding || binding.serverId !== serverId) return { token, ok: false };
      const acquired = await inFlight.acquire();
      if (!acquired) { reasons.limited += 1; return { token, ok: false }; }
      try {
        const outcome = await apns.send({ token, env: parsed.env, payload: parsed.payload, collapseId: parsed.collapseId });
        if (outcome?.drop === true) {
          tokens.delete(token);
          return { token, ok: false, drop: true };
        }
        return { token, ok: outcome?.ok === true };
      } catch {
        return { token, ok: false };
      } finally {
        inFlight.release(acquired);
      }
    }));
    return { status: 200, body: { results } };
  };

  const handleLiveActivity = async (parsed) => {
    const sorted = [...parsed.tokens].sort();
    const contentState = parsed.contentState;
    const message = `${parsed.ts}.${sorted.join(',')}.${parsed.event}.${contentState.status}.${contentState.eventVersion}.${contentState.updatedAt}.${contentState.endedAt ?? ''}.${parsed.dismissalDate ?? ''}.${parsed.staleDate ?? ''}`;
    const authError = authenticate(parsed.publicKeyJwk, message, parsed.sig, parsed.ts);
    if (authError) return { status: 401, body: { error: authError } };
    const serverId = deriveServerId(parsed.publicKeyJwk);
    const replayKey = `live-activity.${serverId}.${parsed.ts}.${parsed.sig.toString('base64url')}`;
    if (replay.has(replayKey)) { reasons.replayRejected += 1; return { status: 401, body: { error: 'replay' } }; }
    if (!replay.remember(replayKey)) { reasons.limited += 1; return { status: 429, body: { error: 'rate_limited' } }; }
    if (!sendServerLimit.allow(serverId)) { reasons.limited += 1; return { status: 429, body: { error: 'rate_limited' } }; }
    const payload = buildLiveActivityPayload({
      event: parsed.event,
      contentState,
      dismissalDate: parsed.dismissalDate,
      staleDate: parsed.staleDate,
      timestamp: Math.floor(clock.now() / 1000),
    });
    const tokens = liveStore();
    const results = await Promise.all(parsed.uniqueTokens.map(async (token) => {
      const binding = tokens.get(token);
      if (!binding || binding.serverId !== serverId) return { token, ok: false };
      const acquired = await inFlight.acquire();
      if (!acquired) { reasons.limited += 1; return { token, ok: false }; }
      try {
        const outcome = await apns.send({ token, env: parsed.env, payload, pushType: 'liveactivity' });
        if (outcome?.drop === true) {
          tokens.delete(token);
          return { token, ok: false, drop: true };
        }
        if (outcome?.ok === true && parsed.event === 'end') tokens.delete(token);
        return { token, ok: outcome?.ok === true };
      } catch {
        return { token, ok: false };
      } finally {
        inFlight.release(acquired);
      }
    }));
    return { status: 200, body: { results } };
  };

  const handleRequest = (request, response) => {
    let pathname;
    try { pathname = new URL(request.url ?? '/', 'http://push-relay').pathname; } catch {
      if (!claimHealthEndpoints) return false;
      response.writeHead(404); response.end(); return true;
    }
    if (!claimHealthEndpoints && !pathname.startsWith('/v1/push/')) return false;
    const ready = pathname === '/readyz' && state === 'running';
    const healthy = pathname === '/healthz';
    if (claimHealthEndpoints && (healthy || ready) && (request.method === 'GET' || request.method === 'HEAD')) {
      sendJson(response, 200, { status: 'ok' }, request.method);
      return true;
    }
    const isRegister = pathname === '/v1/push/register-token';
    const isRegisterLive = pathname === '/v1/push/register-live-activity-token';
    const isUnregisterLive = pathname === '/v1/push/unregister-live-activity-token';
    const isSend = pathname === '/v1/push/send';
    const isLiveActivity = pathname === '/v1/push/live-activity';
    if (request.method !== 'POST' || (!isRegister && !isRegisterLive && !isUnregisterLive && !isSend && !isLiveActivity) || state !== 'running') { response.writeHead(404); response.end(); return true; }
    const ip = resolveClientIp(request);
    const limiter = (isRegister || isRegisterLive || isUnregisterLive) ? registerIpLimit : sendIpLimit;
    if (!limiter.allow(ip)) { reasons.limited += 1; sendJson(response, 429, { error: 'rate_limited' }); return true; }
    const endHttp = httpWork.begin();
    readBody(request, limits.jsonBodyBytes ?? JSON_BODY_BYTES).then(async (buffer) => {
      let body;
      try { body = JSON.parse(buffer.toString('utf8')); } catch { reasons.policyRejected += 1; sendJson(response, 400, { error: 'invalid_request' }); return; }
      const parsed = isRegister ? validateRegisterBody(body)
        : (isRegisterLive || isUnregisterLive) ? validateLiveActivityRegisterBody(body)
          : isLiveActivity ? validateLiveActivityBody(body)
            : validateSendBody(body);
      if (parsed.error) {
        reasons.policyRejected += 1;
        sendJson(response, 400, { error: parsed.error });
        return;
      }
      const result = (isRegister || isRegisterLive) ? handleRegister(parsed.value)
        : isUnregisterLive ? handleUnregisterLiveActivity(parsed.value)
          : isLiveActivity ? await handleLiveActivity(parsed.value)
            : await handleSend(parsed.value);
      sendJson(response, result.status, result.body);
    }).catch((error) => {
      if (error?.code === 'PAYLOAD_TOO_LARGE') { reasons.policyRejected += 1; sendJson(response, 413, { error: 'payload_too_large' }); return; }
      sendJson(response, 500, { error: 'internal' });
    }).finally(endHttp);
    return true;
  };

  const activate = () => {
    if (state === 'running') return;
    liveStore();
    inFlight.reset();
    httpWork.reset();
    if (ownedApns && state === 'stopped') apns = openApns();
    state = 'running';
  };

  const deactivate = () => {
    if (stopPromise) return stopPromise;
    if (state === 'idle' || state === 'stopped') { state = 'stopped'; return Promise.resolve(); }
    state = 'stopping';
    stopPromise = Promise.resolve().then(async () => {
      inFlight.rejectWaiters();
      replay.clear();
      registerIpLimit.clear();
      sendIpLimit.clear();
      sendServerLimit.clear();
      let deadlineTimer = null;
      try {
        const graceful = Promise.all([inFlight.whenIdle(), httpWork.whenIdle()]);
        const deadline = new Promise((resolve) => {
          deadlineTimer = clock.setTimeout(() => resolve('deadline'), STOP_DEADLINE_MS);
        });
        await Promise.race([graceful.then(() => 'graceful'), deadline]);
      } finally {
        if (deadlineTimer !== null) try { clock.clearTimeout(deadlineTimer); } catch { /* ignore */ }
      }
      try { apns.close?.(); } catch { /* ignore */ }
      if (ownedStore) try { store.close(); } catch { /* ignore */ }
      state = 'stopped';
      stopPromise = null;
    });
    return stopPromise;
  };

  return {
    handleRequest,
    activate,
    deactivate,
    getSnapshot: snapshot,
  };
};
