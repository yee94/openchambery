import crypto from 'node:crypto';
import http2 from 'node:http2';

const APNS_HOST = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
};
const JWT_TTL_MS = 50 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 4_096;
export const DEAD_TOKEN_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic']);

const normalizePem = (value) => (typeof value === 'string' ? value.replace(/\\n/g, '\n').trim() : '');

export const createApnsProvider = (options = {}) => {
  const clock = { now: Date.now, setTimeout, clearTimeout, ...options.clock };
  const connect = options.http2?.connect ?? http2.connect;
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey(normalizePem(options.p8));
  } catch {
    throw new Error('Invalid APNs key');
  }
  const bundleId = options.bundleId;
  const sessions = new Map();
  let cachedJwt = null;

  const signJwt = () => {
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: options.keyId })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ iss: options.teamId, iat: Math.floor(clock.now() / 1000) })).toString('base64url');
    const signingInput = `${header}.${claims}`;
    const signature = crypto.sign('sha256', Buffer.from(signingInput), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    return `${signingInput}.${signature}`;
  };

  const getJwt = (force) => {
    const now = clock.now();
    if (!force && cachedJwt && now - cachedJwt.issuedAtMs < JWT_TTL_MS) return cachedJwt.token;
    cachedJwt = { token: signJwt(), issuedAtMs: now };
    return cachedJwt.token;
  };

  const dropSession = (env, client) => {
    if (sessions.get(env) === client) sessions.delete(env);
    try { client.close(); } catch { /* session already gone */ }
  };

  const getSession = (env) => {
    const existing = sessions.get(env);
    if (existing && !existing.closed && existing.destroyed !== true) return existing;
    const client = connect(APNS_HOST[env]);
    client.on('error', () => dropSession(env, client));
    client.on('close', () => { if (sessions.get(env) === client) sessions.delete(env); });
    sessions.set(env, client);
    return client;
  };

  const dispatch = (input, forceJwt) => new Promise((resolve) => {
    const jwt = getJwt(forceJwt);
    let client;
    try { client = getSession(input.env); } catch { resolve({ ok: false }); return; }
    const headers = {
      ':method': 'POST',
      ':path': `/3/device/${input.token}`,
      authorization: `bearer ${jwt}`,
      'apns-topic': bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
    };
    if (input.collapseId) headers['apns-collapse-id'] = input.collapseId;
    let req;
    try { req = client.request(headers); } catch { resolve({ ok: false }); return; }
    let status = 0;
    let responseBody = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clock.clearTimeout(timer);
      resolve(result);
    };
    const timer = clock.setTimeout(() => {
      try { req.close(); } catch { /* ignore */ }
      finish({ ok: false });
    }, options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
    req.on('response', (responseHeaders) => { status = Number(responseHeaders[':status']) || 0; });
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      if (responseBody.length < MAX_RESPONSE_BYTES) responseBody += chunk.slice(0, MAX_RESPONSE_BYTES - responseBody.length);
    });
    req.on('end', () => {
      if (status === 200) { finish({ ok: true }); return; }
      let reason = '';
      try { reason = JSON.parse(responseBody)?.reason || ''; } catch { /* non-JSON */ }
      if (reason === 'ExpiredProviderToken') { finish({ ok: false, expired: true }); return; }
      if (status === 410 || DEAD_TOKEN_REASONS.has(reason)) { finish({ ok: false, drop: true }); return; }
      finish({ ok: false });
    });
    req.on('error', () => finish({ ok: false }));
    req.end(JSON.stringify(input.payload));
  });

  return {
    async send(input) {
      const first = await dispatch(input, false);
      if (first.expired) {
        const retry = await dispatch(input, true);
        return { ok: retry.ok === true, drop: retry.drop === true ? true : undefined };
      }
      return { ok: first.ok === true, drop: first.drop === true ? true : undefined };
    },
    close() {
      for (const [env, client] of sessions) {
        sessions.delete(env);
        try { client.close(); } catch { /* ignore */ }
      }
      cachedJwt = null;
    },
  };
};
