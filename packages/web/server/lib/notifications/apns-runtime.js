// APNs (Apple Push Notification service) runtime for the native iOS mobile app.
//
// Device tokens are persisted per UI session (mirrors push-runtime.js). Delivery has two
// modes, chosen at send time:
//   - Relay (default): POST tokens + generic text to the same-origin Push service
//     (`/v1/push/*` on the effective Relay host). The isolated Push process holds the
//     project APNs key and signs+sends — so users configure nothing.
//   - Direct (fallback): sign an ES256 JWT with Node crypto and send over HTTP/2 ourselves,
//     for self-hosters who set OPENCHAMBER_APNS_* and OPENCHAMBER_PUSH_RELAY_DISABLED=true.
// Wired into the same trigger fanout as web push (see runtime.js); the relay carries only
// generic, model-based text (no session content) — see APNS.md.

import {
  getOrCreateRelaySigningKeypair,
  signRelayMessage as signRelayMessageShared,
} from '../relay/signing-key.js';
import { DEFAULT_RELAY_URL, derivePushSendUrlFromRelayUrl } from '../relay/service.js';
import {
  APNS_DEFAULT_LOCALE,
  localizeApnsPayload,
  normalizeApnsLocale,
} from './apns-titles.js';

const APNS_TOKENS_VERSION = 2;
const APNS_TOKENS_SUPPORTED_VERSIONS = new Set([1, APNS_TOKENS_VERSION]);
const APNS_HOST_PRODUCTION = 'https://api.push.apple.com';
const APNS_HOST_SANDBOX = 'https://api.sandbox.push.apple.com';
// APNs rejects auth tokens older than 1h; refresh well inside that window.
const JWT_TTL_MS = 50 * 60 * 1000;
const DEFAULT_BUNDLE_ID = 'com.yee94.openchamber';
const MAX_TOKENS_PER_SESSION = 10;
const MAX_LIVE_ACTIVITY_TOKENS_PER_SESSION = 8;
const MAX_LIVE_ACTIVITY_TOKEN_CHARS = 512;
const MAX_LIVE_ACTIVITY_ID_CHARS = 128;
const LIVE_ACTIVITY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const LIVE_ACTIVITY_COMPLETE_DISMISSAL_SECONDS = 15 * 60;
const LIVE_ACTIVITY_ERROR_DISMISSAL_SECONDS = 60 * 60;
const LIVE_ACTIVITY_STALE_SECONDS = 20 * 60;
const MAX_RELAY_SEND_TOKENS = 100;
const RELAY_REGISTER_CONCURRENCY = 16;
const APNS_COLLAPSE_ID_MAX_BYTES = 64;
const LIVE_ACTIVITY_KIND = 'liveactivity';
const LIVE_ACTIVITY_PLATFORM = 'ios';
const LIVE_ACTIVITY_TERMINAL_STATUSES = new Set(['complete', 'error']);
// APNs reasons that mean the token is permanently invalid → drop it.
const DEAD_TOKEN_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic']);

const mapWithBoundedConcurrency = async (items, concurrency, mapper) => {
  const results = new Array(items.length);
  const limit = Math.max(1, concurrency);
  for (let start = 0; start < items.length; start += limit) {
    const end = Math.min(start + limit, items.length);
    await Promise.all(
      items.slice(start, end).map(async (item, offset) => {
        results[start + offset] = await mapper(item, start + offset);
      }),
    );
  }
  return results;
};

const apnsCollapseId = (tag) => {
  if (typeof tag !== 'string' || tag.length === 0) return undefined;
  if (Buffer.byteLength(tag, 'utf8') > APNS_COLLAPSE_ID_MAX_BYTES) return undefined;
  return tag;
};

const trimmedEnv = (name) => {
  const value = process.env[name];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
};

// Env vars commonly store the .p8 with literal "\n" sequences; restore real newlines.
const normalizePem = (value) => (typeof value === 'string' ? value.replace(/\\n/g, '\n').trim() : '');

export const createApnsRuntime = (deps) => {
  const {
    fsPromises,
    path,
    crypto,
    http2,
    APNS_TOKENS_FILE_PATH,
    readSettingsFromDiskMigrated,
    writeSettingsToDisk,
    // Strict settings reader gating identity regeneration (see signing-key.js).
    readSettingsStrict,
    resolveEffectiveRelayUrl,
  } = deps;

  let persistLock = Promise.resolve();
  let cachedJwt = null; // { token, issuedAtMs, keyId }
  let cachedRelayKey = null; // { privateKey, publicJwk }
  let warnedUnconfigured = false;
  let registrationSuccessCache = new Map();
  let registrationCacheRegisterUrl = null;
  let liveActivityRegistrationSuccessCache = new Map();
  let liveActivityRegistrationCacheRegisterUrl = null;

  // ---------------------------------------------------------------------------
  // Per-server relay signing identity (ECDSA P-256). Auto-generated + persisted in settings
  // (mirrors getOrCreateVapidKeys). The relay derives serverId = SHA-256(publicKey), verifies
  // each request's signature, and only delivers to tokens this server registered — so a leaked
  // device token alone can't be used to push. Zero-config: the keypair generates on first use.
  // ---------------------------------------------------------------------------

  // Key access lives in lib/relay/signing-key.js now (shared with the private
  // relay identity — same keypair, same storage, same serverId derivation).
  const getOrCreateRelayKeypair = async () => {
    if (cachedRelayKey) return cachedRelayKey;
    cachedRelayKey = await getOrCreateRelaySigningKeypair({ crypto, readSettingsFromDiskMigrated, writeSettingsToDisk, readSettingsStrict });
    return cachedRelayKey;
  };

  const signRelayMessage = (privateKey, message) => signRelayMessageShared({ crypto }, privateKey, message);

  // Trim to the 4 fields the relay's schema accepts (and that feed the serverId hash).
  const relayPublicJwk = (publicJwk) => ({
    kty: publicJwk.kty,
    crv: publicJwk.crv,
    x: publicJwk.x,
    y: publicJwk.y,
  });

  const registrationCacheKey = (registerUrl, token, platform) =>
    `${registerUrl}\0${token}\0${platform}`;

  const rememberRelayRegisterUrl = (registerUrl) => {
    if (registrationCacheRegisterUrl === registerUrl) return;
    registrationSuccessCache = new Map();
    registrationCacheRegisterUrl = registerUrl;
  };

  const rememberLiveActivityRelayRegisterUrl = (registerUrl) => {
    if (liveActivityRegistrationCacheRegisterUrl === registerUrl) return;
    liveActivityRegistrationSuccessCache = new Map();
    liveActivityRegistrationCacheRegisterUrl = registerUrl;
  };

  const liveActivityRegistrationCacheKey = (registerUrl, token) =>
    `${registerUrl}\0${token}\0${LIVE_ACTIVITY_PLATFORM}\0${LIVE_ACTIVITY_KIND}`;

  const isLimitedId = (value, maxChars) =>
    typeof value === 'string' && value.length > 0 && value.length <= maxChars;

  const boundRegistrationCache = (registerUrl, entries) => {
    rememberRelayRegisterUrl(registerUrl);
    const allowed = new Set(
      entries.map((entry) => registrationCacheKey(registerUrl, entry.deviceToken, entry.platform)),
    );
    for (const key of registrationSuccessCache.keys()) {
      if (!allowed.has(key)) registrationSuccessCache.delete(key);
    }
  };

  const registerTokenWithRelay = async (token, platform = 'ios', relayOverride) => {
    const relay = relayOverride ?? (await resolveRelayConfig());
    if (!relay) return true; // direct mode — no relay binding needed
    rememberRelayRegisterUrl(relay.registerUrl);
    const cacheKey = registrationCacheKey(relay.registerUrl, token, platform);
    if (registrationSuccessCache.has(cacheKey)) return true;
    try {
      const { privateKey, publicJwk } = await getOrCreateRelayKeypair();
      const ts = Date.now();
      // platform is part of the signed message so it can't be tampered en route.
      const sig = signRelayMessage(privateKey, `${ts}.${token}.${platform}`);
      const res = await fetch(relay.registerUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, platform, publicKeyJwk: relayPublicJwk(publicJwk), ts, sig }),
      });
      if (!res.ok) {
        console.warn(`[Push relay] register-token failed status=${res.status}`);
        return false;
      }
      registrationSuccessCache.set(cacheKey, true);
      return true;
    } catch (error) {
      console.warn('[Push relay] register-token request failed:', error?.message ?? error);
      return false;
    }
  };

  const registerLiveActivityTokenWithRelay = async (token, relayOverride) => {
    const relay = relayOverride ?? (await resolveRelayConfig());
    if (!relay) return true;
    rememberLiveActivityRelayRegisterUrl(relay.liveActivityRegisterUrl);
    const cacheKey = liveActivityRegistrationCacheKey(relay.liveActivityRegisterUrl, token);
    if (liveActivityRegistrationSuccessCache.has(cacheKey)) return true;
    try {
      const { privateKey, publicJwk } = await getOrCreateRelayKeypair();
      const ts = Date.now();
      const sig = signRelayMessage(
        privateKey,
        `${ts}.${token}.${LIVE_ACTIVITY_PLATFORM}.${LIVE_ACTIVITY_KIND}`,
      );
      const res = await fetch(relay.liveActivityRegisterUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token,
          platform: LIVE_ACTIVITY_PLATFORM,
          kind: LIVE_ACTIVITY_KIND,
          publicKeyJwk: relayPublicJwk(publicJwk),
          ts,
          sig,
        }),
      });
      if (!res.ok) {
        console.warn(`[Push relay] register-live-activity-token failed status=${res.status}`);
        return false;
      }
      liveActivityRegistrationSuccessCache.set(cacheKey, true);
      return true;
    } catch (error) {
      console.warn('[Push relay] register-live-activity-token request failed:', error?.message ?? error);
      return false;
    }
  };

  const unregisterLiveActivityTokenWithRelay = async (token) => {
    const relay = await resolveRelayConfig();
    if (!relay || !isLimitedId(token, MAX_LIVE_ACTIVITY_TOKEN_CHARS)) return;
    rememberLiveActivityRelayRegisterUrl(relay.liveActivityRegisterUrl);
    liveActivityRegistrationSuccessCache.delete(
      liveActivityRegistrationCacheKey(relay.liveActivityRegisterUrl, token),
    );
    try {
      const { privateKey, publicJwk } = await getOrCreateRelayKeypair();
      const ts = Date.now();
      const sig = signRelayMessage(
        privateKey,
        `${ts}.${token}.${LIVE_ACTIVITY_PLATFORM}.${LIVE_ACTIVITY_KIND}`,
      );
      const res = await fetch(relay.liveActivityUnregisterUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token,
          platform: LIVE_ACTIVITY_PLATFORM,
          kind: LIVE_ACTIVITY_KIND,
          publicKeyJwk: relayPublicJwk(publicJwk),
          ts,
          sig,
        }),
      });
      if (!res.ok) {
        console.warn(`[Push relay] unregister-live-activity-token failed status=${res.status}`);
      }
    } catch (error) {
      console.warn('[Push relay] unregister-live-activity-token request failed:', error?.message ?? error);
    }
  };

  // ---------------------------------------------------------------------------
  // Token persistence (same shape + write-lock pattern as push-runtime.js)
  // ---------------------------------------------------------------------------

  const emptyStore = () => ({
    version: APNS_TOKENS_VERSION,
    tokensBySession: {},
    liveActivityTokensBySession: {},
    liveActivityEventVersions: {},
  });

  const readTokensFromDisk = async () => {
    try {
      const raw = await fsPromises.readFile(APNS_TOKENS_FILE_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !APNS_TOKENS_SUPPORTED_VERSIONS.has(parsed.version)) {
        return emptyStore();
      }
      const tokensBySession =
        parsed.tokensBySession && typeof parsed.tokensBySession === 'object' ? parsed.tokensBySession : {};
      const liveActivityTokensBySession =
        parsed.liveActivityTokensBySession && typeof parsed.liveActivityTokensBySession === 'object'
          ? parsed.liveActivityTokensBySession
          : {};
      const liveActivityEventVersions =
        parsed.liveActivityEventVersions && typeof parsed.liveActivityEventVersions === 'object'
          ? parsed.liveActivityEventVersions
          : {};
      return {
        version: APNS_TOKENS_VERSION,
        tokensBySession,
        liveActivityTokensBySession,
        liveActivityEventVersions,
      };
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        return emptyStore();
      }
      console.warn('Failed to read APNs tokens file:', error);
      return emptyStore();
    }
  };

  const writeTokensToDisk = async (data) => {
    await fsPromises.mkdir(path.dirname(APNS_TOKENS_FILE_PATH), { recursive: true });
    await fsPromises.writeFile(APNS_TOKENS_FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
  };

  const persistTokenUpdate = async (mutate) => {
    persistLock = persistLock.then(async () => {
      const current = await readTokensFromDisk();
      const base = {
        version: APNS_TOKENS_VERSION,
        tokensBySession: current.tokensBySession || {},
        liveActivityTokensBySession: current.liveActivityTokensBySession || {},
        liveActivityEventVersions: current.liveActivityEventVersions || {},
      };
      const next = mutate(base);
      const written = {
        version: APNS_TOKENS_VERSION,
        tokensBySession: next.tokensBySession || {},
        liveActivityTokensBySession: next.liveActivityTokensBySession ?? base.liveActivityTokensBySession,
        liveActivityEventVersions: next.liveActivityEventVersions ?? base.liveActivityEventVersions,
      };
      await writeTokensToDisk(written);
      return written;
    });
    return persistLock;
  };

  const normalizeTokens = (record) => {
    if (!Array.isArray(record)) return [];
    return record
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const deviceToken = entry.deviceToken;
        if (typeof deviceToken !== 'string' || deviceToken.trim().length === 0) return null;
        return {
          deviceToken: deviceToken.trim(),
          createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : null,
          lastSeenAt: typeof entry.lastSeenAt === 'number' ? entry.lastSeenAt : null,
          userAgent: typeof entry.userAgent === 'string' ? entry.userAgent : undefined,
          // 'ios' (APNs) or 'android' (FCM). Older entries without one are APNs by default.
          platform: entry.platform === 'android' ? 'android' : 'ios',
          // App UI locale at last registration; missing → English titles (legacy tokens).
          locale: normalizeApnsLocale(entry.locale),
        };
      })
      .filter(Boolean);
  };

  const normalizeLiveActivityTokens = (record, now = Date.now()) => {
    if (!Array.isArray(record)) return [];
    return record
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const token = typeof entry.token === 'string' ? entry.token.trim() : '';
        const activityId = typeof entry.activityId === 'string' ? entry.activityId.trim() : '';
        const sessionId = typeof entry.sessionId === 'string' ? entry.sessionId.trim() : '';
        if (!isLimitedId(token, MAX_LIVE_ACTIVITY_TOKEN_CHARS)) return null;
        if (!isLimitedId(activityId, MAX_LIVE_ACTIVITY_ID_CHARS)) return null;
        if (!isLimitedId(sessionId, MAX_LIVE_ACTIVITY_ID_CHARS)) return null;
        const createdAt = typeof entry.createdAt === 'number' ? entry.createdAt : null;
        const lastSeenAt = typeof entry.lastSeenAt === 'number' ? entry.lastSeenAt : createdAt;
        if (typeof lastSeenAt === 'number' && now - lastSeenAt > LIVE_ACTIVITY_TOKEN_TTL_MS) return null;
        return { token, activityId, sessionId, createdAt, lastSeenAt };
      })
      .filter(Boolean);
  };

  const pruneLiveActivityTokensBySession = (liveActivityTokensBySession, now = Date.now()) => {
    const next = {};
    for (const [uiSessionToken, record] of Object.entries(liveActivityTokensBySession || {})) {
      const entries = normalizeLiveActivityTokens(record, now);
      if (entries.length > 0) next[uiSessionToken] = entries;
    }
    return next;
  };

  const countLiveActivityTokenCopies = (liveActivityTokensBySession, token) => {
    let count = 0;
    for (const record of Object.values(liveActivityTokensBySession || {})) {
      for (const entry of record) {
        if (entry?.token === token) count += 1;
      }
    }
    return count;
  };

  // Normalize an incoming platform hint to the two we support; default to APNs/iOS since that
  // was the only registrant before Android/FCM existed.
  const normalizePlatform = (platform) => (platform === 'android' ? 'android' : 'ios');

  const listUniqueTokenEntries = (store) => {
    const unique = [];
    const seen = new Map();
    for (const record of Object.values(store.tokensBySession || {})) {
      for (const entry of normalizeTokens(record)) {
        const key = `${entry.deviceToken}\0${entry.platform}`;
        const priorIndex = seen.get(key);
        if (priorIndex == null) {
          seen.set(key, unique.length);
          unique.push(entry);
          continue;
        }
        // Same device may register under multiple UI sessions; keep the freshest locale.
        const prior = unique[priorIndex];
        const priorSeen = typeof prior.lastSeenAt === 'number' ? prior.lastSeenAt : 0;
        const nextSeen = typeof entry.lastSeenAt === 'number' ? entry.lastSeenAt : 0;
        if (nextSeen >= priorSeen) unique[priorIndex] = entry;
      }
    }
    return unique;
  };

  const addOrUpdateApnsToken = async (uiSessionToken, deviceToken, userAgent, platform, locale) => {
    if (!uiSessionToken || typeof deviceToken !== 'string' || deviceToken.trim().length === 0) return;
    const token = deviceToken.trim();
    const tokenPlatform = normalizePlatform(platform);
    const tokenLocale = normalizeApnsLocale(locale);
    const now = Date.now();

    await persistTokenUpdate((current) => {
      const tokensBySession = { ...(current.tokensBySession || {}) };
      const existing = normalizeTokens(tokensBySession[uiSessionToken]);
      const prior = existing.find((entry) => entry.deviceToken === token);
      const filtered = existing.filter((entry) => entry.deviceToken !== token);
      filtered.unshift({
        deviceToken: token,
        createdAt: typeof prior?.createdAt === 'number' ? prior.createdAt : now,
        lastSeenAt: now,
        userAgent: typeof userAgent === 'string' && userAgent.length > 0 ? userAgent : undefined,
        platform: tokenPlatform,
        locale: tokenLocale,
      });
      tokensBySession[uiSessionToken] = filtered.slice(0, MAX_TOKENS_PER_SESSION);
      return { version: APNS_TOKENS_VERSION, tokensBySession };
    });

    // (Re)bind this token to our server on the relay so only we can push to it. The device
    // re-sends its token on each launch; this is an idempotent upsert relay-side, and binding
    // every time (not just for new tokens) keeps existing tokens bound after a relay/server
    // upgrade rather than silently going unbound. Platform is bound too so the relay routes
    // it to APNs vs FCM.
    await registerTokenWithRelay(token, tokenPlatform);
  };

  const removeApnsToken = async (uiSessionToken, deviceToken) => {
    if (!uiSessionToken || !deviceToken) return;
    await persistTokenUpdate((current) => {
      const tokensBySession = { ...(current.tokensBySession || {}) };
      const filtered = normalizeTokens(tokensBySession[uiSessionToken]).filter(
        (entry) => entry.deviceToken !== deviceToken,
      );
      if (filtered.length === 0) delete tokensBySession[uiSessionToken];
      else tokensBySession[uiSessionToken] = filtered;
      return { version: APNS_TOKENS_VERSION, tokensBySession };
    });
  };

  const removeApnsTokenFromAllSessions = async (deviceToken) => {
    if (!deviceToken) return;
    await persistTokenUpdate((current) => {
      const tokensBySession = { ...(current.tokensBySession || {}) };
      for (const [session, entries] of Object.entries(tokensBySession)) {
        const filtered = normalizeTokens(entries).filter((entry) => entry.deviceToken !== deviceToken);
        if (filtered.length === 0) delete tokensBySession[session];
        else tokensBySession[session] = filtered;
      }
      return { version: APNS_TOKENS_VERSION, tokensBySession };
    });
  };

  const addOrUpdateLiveActivityToken = async (uiSessionToken, token, activityId, sessionId) => {
    if (!uiSessionToken) return;
    const trimmedToken = typeof token === 'string' ? token.trim() : '';
    const trimmedActivityId = typeof activityId === 'string' ? activityId.trim() : '';
    const trimmedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!isLimitedId(trimmedToken, MAX_LIVE_ACTIVITY_TOKEN_CHARS)) return;
    if (!isLimitedId(trimmedActivityId, MAX_LIVE_ACTIVITY_ID_CHARS)) return;
    if (!isLimitedId(trimmedSessionId, MAX_LIVE_ACTIVITY_ID_CHARS)) return;
    const now = Date.now();
    let replacedToken = null;

    await persistTokenUpdate((current) => {
      const liveActivityTokensBySession = pruneLiveActivityTokensBySession(
        current.liveActivityTokensBySession,
        now,
      );
      const existing = liveActivityTokensBySession[uiSessionToken] || [];
      const replaced = existing.find((entry) => entry.activityId === trimmedActivityId);
      if (replaced && replaced.token !== trimmedToken) replacedToken = replaced.token;
      const filtered = existing.filter(
        (entry) => entry.activityId !== trimmedActivityId && entry.token !== trimmedToken,
      );
      filtered.unshift({
        token: trimmedToken,
        activityId: trimmedActivityId,
        sessionId: trimmedSessionId,
        createdAt: typeof replaced?.createdAt === 'number' ? replaced.createdAt : now,
        lastSeenAt: now,
      });
      liveActivityTokensBySession[uiSessionToken] = filtered.slice(0, MAX_LIVE_ACTIVITY_TOKENS_PER_SESSION);
      return { ...current, liveActivityTokensBySession };
    });

    await registerLiveActivityTokenWithRelay(trimmedToken);
    if (replacedToken) {
      const store = await readTokensFromDisk();
      if (countLiveActivityTokenCopies(store.liveActivityTokensBySession, replacedToken) === 0) {
        await unregisterLiveActivityTokenWithRelay(replacedToken);
      }
    }
  };

  const removeLiveActivityToken = async (uiSessionToken, token) => {
    if (!uiSessionToken || typeof token !== 'string' || token.length === 0) return;
    let removed = false;
    await persistTokenUpdate((current) => {
      const liveActivityTokensBySession = pruneLiveActivityTokensBySession(
        current.liveActivityTokensBySession,
      );
      const existing = liveActivityTokensBySession[uiSessionToken] || [];
      const filtered = existing.filter((entry) => {
        if (entry.token !== token) return true;
        removed = true;
        return false;
      });
      if (filtered.length === 0) delete liveActivityTokensBySession[uiSessionToken];
      else liveActivityTokensBySession[uiSessionToken] = filtered;
      return { ...current, liveActivityTokensBySession };
    });
    if (!removed) return;
    const store = await readTokensFromDisk();
    if (countLiveActivityTokenCopies(store.liveActivityTokensBySession, token) === 0) {
      await unregisterLiveActivityTokenWithRelay(token);
    }
  };

  const removeLiveActivityTokens = async (tokensToRemove) => {
    const unique = [...new Set((tokensToRemove || []).filter((token) => typeof token === 'string' && token.length > 0))];
    if (unique.length === 0) return;
    const drop = new Set(unique);
    await persistTokenUpdate((current) => {
      const liveActivityTokensBySession = pruneLiveActivityTokensBySession(
        current.liveActivityTokensBySession,
      );
      for (const [uiSessionToken, entries] of Object.entries(liveActivityTokensBySession)) {
        const filtered = entries.filter((entry) => !drop.has(entry.token));
        if (filtered.length === 0) delete liveActivityTokensBySession[uiSessionToken];
        else liveActivityTokensBySession[uiSessionToken] = filtered;
      }
      return { ...current, liveActivityTokensBySession };
    });
  };

  // ---------------------------------------------------------------------------
  // Config (env first, then settings.apnsConfig) — mirrors resolveVapidSubject
  // ---------------------------------------------------------------------------

  const resolveApnsConfig = async () => {
    let keyId = trimmedEnv('OPENCHAMBER_APNS_KEY_ID');
    let teamId = trimmedEnv('OPENCHAMBER_APNS_TEAM_ID');
    let bundleId = trimmedEnv('OPENCHAMBER_APNS_BUNDLE_ID');
    let environment = (trimmedEnv('OPENCHAMBER_APNS_ENVIRONMENT') || '').toLowerCase();
    let p8 = normalizePem(process.env.OPENCHAMBER_APNS_P8 || '');

    const p8Path = trimmedEnv('OPENCHAMBER_APNS_P8_PATH');
    if (!p8 && p8Path) {
      try {
        p8 = (await fsPromises.readFile(p8Path, 'utf8')).trim();
      } catch (error) {
        console.warn('[APNs] Failed to read OPENCHAMBER_APNS_P8_PATH:', error?.message ?? error);
      }
    }

    if (!keyId || !teamId || !p8) {
      try {
        const settings = await readSettingsFromDiskMigrated();
        const stored = settings?.apnsConfig;
        if (stored && typeof stored === 'object') {
          keyId = keyId || (typeof stored.keyId === 'string' ? stored.keyId.trim() : null);
          teamId = teamId || (typeof stored.teamId === 'string' ? stored.teamId.trim() : null);
          bundleId = bundleId || (typeof stored.bundleId === 'string' ? stored.bundleId.trim() : null);
          environment = environment || (typeof stored.environment === 'string' ? stored.environment.toLowerCase() : '');
          if (!p8 && typeof stored.p8 === 'string') p8 = normalizePem(stored.p8);
        }
      } catch {
        // settings unavailable — fall through to the unconfigured result
      }
    }

    if (!keyId || !teamId || !p8) return null;

    return {
      keyId,
      teamId,
      p8,
      bundleId: bundleId || DEFAULT_BUNDLE_ID,
      environment: environment === 'production' ? 'production' : 'sandbox',
    };
  };

  // ---------------------------------------------------------------------------
  // JWT (ES256, JOSE/raw signature) + HTTP/2 send
  // ---------------------------------------------------------------------------

  const signApnsJwt = (config) => {
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: config.keyId })).toString('base64url');
    const claims = Buffer.from(
      JSON.stringify({ iss: config.teamId, iat: Math.floor(Date.now() / 1000) }),
    ).toString('base64url');
    const signingInput = `${header}.${claims}`;
    const signature = crypto
      .sign('sha256', Buffer.from(signingInput), { key: config.p8, dsaEncoding: 'ieee-p1363' })
      .toString('base64url');
    return `${signingInput}.${signature}`;
  };

  const getJwt = (config) => {
    const now = Date.now();
    if (cachedJwt && cachedJwt.keyId === config.keyId && now - cachedJwt.issuedAtMs < JWT_TTL_MS) {
      return cachedJwt.token;
    }
    const token = signApnsJwt(config);
    cachedJwt = { token, issuedAtMs: now, keyId: config.keyId };
    return token;
  };

  const buildBody = (payload) => {
    const data = payload && typeof payload.data === 'object' && payload.data ? payload.data : {};
    return JSON.stringify({
      aps: {
        alert: {
          title: typeof payload?.title === 'string' ? payload.title : undefined,
          body: typeof payload?.body === 'string' ? payload.body : undefined,
        },
        badge: Number.isFinite(payload?.badge) && payload.badge >= 0 ? Math.trunc(payload.badge) : undefined,
        sound: 'default',
        'thread-id': typeof payload?.tag === 'string' ? payload.tag : undefined,
        // Wakes the Notification Service Extension so it can refresh the home/lock-screen
        // widgets (attention count + unread dot) from the push, even when the app is closed.
        // No extra network call — just an extra key on the push we already send.
        'mutable-content': 1,
      },
      ...data,
    });
  };

  const sendOne = (client, deviceToken, body, jwt, config) =>
    new Promise((resolve) => {
      const headers = {
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${jwt}`,
        'apns-topic': config.bundleId,
        'apns-push-type': 'alert',
        'apns-priority': '10',
      };
      // collapse-id dedups like web-push tags; APNs caps it at 64 UTF-8 bytes.
      // Keep legal values; omit anything over the limit (do not truncate mid-codepoint).
      const collapseId = apnsCollapseId(config.tag);
      if (collapseId) headers['apns-collapse-id'] = collapseId;

      let req;
      try {
        req = client.request(headers);
      } catch (error) {
        console.warn('[APNs] request open failed:', error?.message ?? error);
        resolve();
        return;
      }

      let status = 0;
      let responseBody = '';
      req.on('response', (resHeaders) => {
        status = Number(resHeaders[':status']) || 0;
      });
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        responseBody += chunk;
      });
      req.on('end', async () => {
        if (status === 200) {
          resolve();
          return;
        }
        let reason = '';
        try {
          reason = JSON.parse(responseBody)?.reason || '';
        } catch {
          // non-JSON error body
        }
        if (status === 410 || DEAD_TOKEN_REASONS.has(reason)) {
          await removeApnsTokenFromAllSessions(deviceToken);
        } else {
          console.warn(`[APNs] push failed status=${status} reason=${reason || 'unknown'}`);
        }
        resolve();
      });
      req.on('error', (error) => {
        console.warn('[APNs] request error:', error?.message ?? error);
        resolve();
      });
      req.end(body);
    });

  // Relay mode (default): the single APNs key lives in the isolated Push process on the same
  // Relay origin (`/v1/push/*`), not on each user's server — so users configure nothing. The
  // server just POSTs device tokens + generic text; Push signs + sends and reports which tokens
  // to drop. Direct mode (below) is the fallback for self-hosters who set OPENCHAMBER_APNS_*
  // and disable the relay.
  const buildRelayConfig = (url) => ({
    url,
    registerUrl: url.replace(/\/send$/, '/register-token'),
    liveActivityRegisterUrl: url.replace(/\/send$/, '/register-live-activity-token'),
    liveActivityUnregisterUrl: url.replace(/\/send$/, '/unregister-live-activity-token'),
    liveActivitySendUrl: url.replace(/\/send$/, '/live-activity'),
    environment:
      (trimmedEnv('OPENCHAMBER_APNS_ENVIRONMENT') || 'sandbox').toLowerCase() === 'production'
        ? 'production'
        : 'sandbox',
  });

  const resolveRelayConfig = async () => {
    if (trimmedEnv('OPENCHAMBER_PUSH_RELAY_DISABLED') === 'true') return null;
    const explicit = trimmedEnv('OPENCHAMBER_PUSH_RELAY_URL');
    if (explicit) return buildRelayConfig(explicit);

    let relayWsUrl = DEFAULT_RELAY_URL;
    if (typeof resolveEffectiveRelayUrl === 'function') {
      try {
        const resolved = await resolveEffectiveRelayUrl();
        if (typeof resolved === 'string' && resolved.trim()) {
          if (derivePushSendUrlFromRelayUrl(resolved)) relayWsUrl = resolved.trim();
          else console.warn('[Push relay] resolver returned a non-WebSocket URL; falling back to default');
        }
      } catch {
        console.warn('[Push relay] resolver failed; falling back to default');
      }
    }
    const url = derivePushSendUrlFromRelayUrl(relayWsUrl) || derivePushSendUrlFromRelayUrl(DEFAULT_RELAY_URL);
    if (!url) return null;
    return buildRelayConfig(url);
  };

  const sendViaRelay = async (deviceTokens, payload, relay) => {
    if (!Array.isArray(deviceTokens) || deviceTokens.length === 0) return;
    const title = typeof payload?.title === 'string' && payload.title.length > 0 ? payload.title : 'OpenChamber';
    const { privateKey, publicJwk } = await getOrCreateRelayKeypair();
    for (let start = 0; start < deviceTokens.length; start += MAX_RELAY_SEND_TOKENS) {
      const tokens = deviceTokens.slice(start, start + MAX_RELAY_SEND_TOKENS);
      const ts = Date.now();
      // Sign over the same canonical form the relay verifies: ts.sortedTokens.title.
      const sig = signRelayMessage(privateKey, `${ts}.${[...tokens].sort().join(',')}.${title}`);
      const requestBody = JSON.stringify({
        tokens,
        title,
        body: typeof payload?.body === 'string' ? payload.body : '',
        badge: Number.isFinite(payload?.badge) && payload.badge >= 0 ? Math.trunc(payload.badge) : undefined,
        collapseId: apnsCollapseId(payload?.tag),
        env: relay.environment,
        data: payload?.data && typeof payload.data === 'object' ? payload.data : undefined,
        publicKeyJwk: relayPublicJwk(publicJwk),
        ts,
        sig,
      });
      try {
        const res = await fetch(relay.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: requestBody,
        });
        if (!res.ok) {
          console.warn(`[APNs relay] send failed status=${res.status}`);
          continue;
        }
        const data = await res.json().catch(() => null);
        const results = Array.isArray(data?.results) ? data.results : [];
        for (const result of results) {
          if (result && result.drop === true && typeof result.token === 'string') {
            await removeApnsTokenFromAllSessions(result.token);
          }
        }
      } catch (error) {
        console.warn('[APNs relay] request failed:', error?.message ?? error);
      }
    }
  };

  const sendViaDirectApns = async (deviceTokens, payload) => {
    const config = await resolveApnsConfig();
    if (!config) {
      if (!warnedUnconfigured) {
        warnedUnconfigured = true;
        console.warn(
          '[APNs] Relay disabled and no direct config; set OPENCHAMBER_APNS_KEY_ID / OPENCHAMBER_APNS_TEAM_ID / OPENCHAMBER_APNS_P8 for direct send.',
        );
      }
      return;
    }

    const host = config.environment === 'production' ? APNS_HOST_PRODUCTION : APNS_HOST_SANDBOX;
    const jwt = getJwt(config);
    const body = buildBody(payload);
    const sendConfig = { ...config, tag: typeof payload?.tag === 'string' ? payload.tag : undefined };

    let client;
    try {
      client = http2.connect(host);
    } catch (error) {
      console.warn('[APNs] connect failed:', error?.message ?? error);
      return;
    }

    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        try {
          client.close();
        } catch {
          // ignore close errors
        }
        resolve();
      };
      client.on('error', (error) => {
        console.warn('[APNs] session error:', error?.message ?? error);
        finish();
      });
      Promise.all(
        deviceTokens.map((token) => sendOne(client, token, body, jwt, sendConfig)),
      ).finally(finish);
    });
  };

  const toLiveActivityUnixSeconds = (value, fallbackMs) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value > 1e12 ? value / 1000 : value;
    }
    return fallbackMs / 1000;
  };

  const nextLiveActivityEventVersion = (nowMs, previous, provided) => {
    const prior = typeof previous === 'number' && Number.isFinite(previous) ? previous : 0;
    let next = Math.max(Math.floor(nowMs), prior + 1);
    if (typeof provided === 'number' && Number.isFinite(provided) && provided > 0) {
      next = Math.max(next, Math.floor(provided));
    }
    return next;
  };

  const liveActivityDismissalDate = (status, nowMs) => {
    const extra = status === 'error'
      ? LIVE_ACTIVITY_ERROR_DISMISSAL_SECONDS
      : LIVE_ACTIVITY_COMPLETE_DISMISSAL_SECONDS;
    return Math.floor(nowMs / 1000) + extra;
  };

  // End carries dismissalDate only. Update (not sent here) would set staleDate = updatedAt+20min.
  const liveActivityPushDates = (event, status, updatedAtSeconds, nowMs) => {
    if (event === 'update') return { staleDate: updatedAtSeconds + LIVE_ACTIVITY_STALE_SECONDS };
    return { dismissalDate: liveActivityDismissalDate(status, nowMs) };
  };

  const liveActivityRelaySignMessage = ({ ts, tokens, event, contentState, dismissalDate, staleDate }) => (
    `${ts}.${[...tokens].sort().join(',')}.${event}.${contentState.status}.${contentState.eventVersion}.${contentState.updatedAt}.${contentState.endedAt ?? ''}.${dismissalDate ?? ''}.${staleDate ?? ''}`
  );

  const sendLiveActivityViaRelay = async (deviceTokens, payload, relay) => {
    if (!Array.isArray(deviceTokens) || deviceTokens.length === 0) return [];
    const accepted = [];
    const { privateKey, publicJwk } = await getOrCreateRelayKeypair();
    for (let start = 0; start < deviceTokens.length; start += MAX_RELAY_SEND_TOKENS) {
      const tokens = deviceTokens.slice(start, start + MAX_RELAY_SEND_TOKENS);
      const ts = Date.now();
      const sig = signRelayMessage(
        privateKey,
        liveActivityRelaySignMessage({
          ts,
          tokens,
          event: payload.event,
          contentState: payload.contentState,
          dismissalDate: payload.dismissalDate,
          staleDate: payload.staleDate,
        }),
      );
      const requestBody = {
        tokens,
        event: payload.event,
        contentState: payload.contentState,
        env: relay.environment,
        publicKeyJwk: relayPublicJwk(publicJwk),
        ts,
        sig,
      };
      if (payload.dismissalDate != null) requestBody.dismissalDate = payload.dismissalDate;
      if (payload.staleDate != null) requestBody.staleDate = payload.staleDate;
      try {
        const res = await fetch(relay.liveActivitySendUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(requestBody),
        });
        if (!res.ok) {
          console.warn(`[APNs relay] live-activity send failed status=${res.status}`);
          continue;
        }
        accepted.push(...tokens);
        const data = await res.json().catch(() => null);
        const results = Array.isArray(data?.results) ? data.results : [];
        for (const result of results) {
          if (result && result.drop === true && typeof result.token === 'string') {
            await removeLiveActivityTokens([result.token]);
          }
        }
      } catch (error) {
        console.warn('[APNs relay] live-activity request failed:', error?.message ?? error);
      }
    }
    return accepted;
  };

  const sendLiveActivityOne = (client, deviceToken, body, jwt, config) =>
    new Promise((resolve) => {
      const headers = {
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${jwt}`,
        'apns-topic': `${config.bundleId}.push-type.liveactivity`,
        'apns-push-type': 'liveactivity',
        'apns-priority': '10',
      };

      let req;
      try {
        req = client.request(headers);
      } catch (error) {
        console.warn('[APNs] live-activity request open failed:', error?.message ?? error);
        resolve({ token: deviceToken, accepted: false });
        return;
      }

      let status = 0;
      let responseBody = '';
      req.on('response', (resHeaders) => {
        status = Number(resHeaders[':status']) || 0;
      });
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        responseBody += chunk;
      });
      req.on('end', async () => {
        if (status === 200) {
          resolve({ token: deviceToken, accepted: true });
          return;
        }
        let reason = '';
        try {
          reason = JSON.parse(responseBody)?.reason || '';
        } catch {
          // non-JSON error body
        }
        if (status === 410 || DEAD_TOKEN_REASONS.has(reason)) {
          await removeLiveActivityTokens([deviceToken]);
        } else {
          console.warn(`[APNs] live-activity push failed status=${status} reason=${reason || 'unknown'}`);
        }
        resolve({ token: deviceToken, accepted: false });
      });
      req.on('error', (error) => {
        console.warn('[APNs] live-activity request error:', error?.message ?? error);
        resolve({ token: deviceToken, accepted: false });
      });
      req.end(body);
    });

  const buildLiveActivityDirectBody = (payload) => {
    const aps = {
      timestamp: Math.floor(Date.now() / 1000),
      event: payload.event,
      'content-state': {
        status: payload.contentState.status,
        eventVersion: payload.contentState.eventVersion,
        updatedAt: payload.contentState.updatedAt,
        endedAt: payload.contentState.endedAt,
      },
    };
    if (payload.dismissalDate != null) aps['dismissal-date'] = payload.dismissalDate;
    if (payload.staleDate != null) aps['stale-date'] = payload.staleDate;
    return JSON.stringify({ aps });
  };

  const sendLiveActivityViaDirectApns = async (deviceTokens, payload) => {
    if (!Array.isArray(deviceTokens) || deviceTokens.length === 0) return [];
    const config = await resolveApnsConfig();
    if (!config) {
      if (!warnedUnconfigured) {
        warnedUnconfigured = true;
        console.warn(
          '[APNs] Relay disabled and no direct config; set OPENCHAMBER_APNS_KEY_ID / OPENCHAMBER_APNS_TEAM_ID / OPENCHAMBER_APNS_P8 for direct send.',
        );
      }
      return [];
    }

    const host = config.environment === 'production' ? APNS_HOST_PRODUCTION : APNS_HOST_SANDBOX;
    const jwt = getJwt(config);
    const body = buildLiveActivityDirectBody(payload);

    let client;
    try {
      client = http2.connect(host);
    } catch (error) {
      console.warn('[APNs] live-activity connect failed:', error?.message ?? error);
      return [];
    }

    const outcomes = await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        try {
          client.close();
        } catch {
          // ignore close errors
        }
        resolve(value);
      };
      client.on('error', (error) => {
        console.warn('[APNs] live-activity session error:', error?.message ?? error);
        finish([]);
      });
      Promise.all(
        deviceTokens.map((token) => sendLiveActivityOne(client, token, body, jwt, config)),
      ).then((results) => finish(results), () => finish([]));
    });

    return (outcomes || []).filter((result) => result?.accepted).map((result) => result.token);
  };

  const collectLiveActivityEntriesForSession = (store, sessionId, now = Date.now()) => {
    const entries = [];
    const seen = new Set();
    for (const record of Object.values(pruneLiveActivityTokensBySession(store.liveActivityTokensBySession, now))) {
      for (const entry of record) {
        if (entry.sessionId !== sessionId || seen.has(entry.token)) continue;
        seen.add(entry.token);
        entries.push(entry);
      }
    }
    return entries;
  };

  const sendLiveActivityEnd = async ({ sessionId, status, eventVersion, endedAt } = {}) => {
    const trimmedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!isLimitedId(trimmedSessionId, MAX_LIVE_ACTIVITY_ID_CHARS)) return;
    if (!LIVE_ACTIVITY_TERMINAL_STATUSES.has(status)) return;

    const now = Date.now();
    let pendingEntries = [];
    let nextVersion = 0;
    await persistTokenUpdate((current) => {
      const liveActivityTokensBySession = pruneLiveActivityTokensBySession(
        current.liveActivityTokensBySession,
        now,
      );
      pendingEntries = collectLiveActivityEntriesForSession(
        { liveActivityTokensBySession },
        trimmedSessionId,
        now,
      );
      if (pendingEntries.length === 0) {
        return { ...current, liveActivityTokensBySession };
      }
      const previous = current.liveActivityEventVersions?.[trimmedSessionId];
      nextVersion = nextLiveActivityEventVersion(now, previous, eventVersion);
      return {
        ...current,
        liveActivityTokensBySession,
        liveActivityEventVersions: {
          ...(current.liveActivityEventVersions || {}),
          [trimmedSessionId]: nextVersion,
        },
      };
    });
    if (pendingEntries.length === 0) return;

    const updatedAt = now / 1000;
    const endedAtSeconds = toLiveActivityUnixSeconds(endedAt, now);
    const contentState = {
      status,
      eventVersion: nextVersion,
      updatedAt,
      endedAt: endedAtSeconds,
    };
    const payload = {
      event: 'end',
      contentState,
      ...liveActivityPushDates('end', status, updatedAt, now),
    };

    const tokens = pendingEntries.map((entry) => entry.token);
    let accepted = [];
    try {
      const relay = await resolveRelayConfig();
      if (relay) {
        rememberLiveActivityRelayRegisterUrl(relay.liveActivityRegisterUrl);
        const outcomes = await mapWithBoundedConcurrency(
          tokens,
          RELAY_REGISTER_CONCURRENCY,
          async (token) => {
            const registered = await registerLiveActivityTokenWithRelay(token, relay);
            return registered ? token : null;
          },
        );
        const readyTokens = outcomes.filter((token) => typeof token === 'string');
        if (readyTokens.length > 0) {
          accepted = await sendLiveActivityViaRelay(readyTokens, payload, relay);
        }
      } else {
        accepted = await sendLiveActivityViaDirectApns(tokens, payload);
      }
    } catch (error) {
      console.warn('[Live Activity] end failed:', error?.message ?? error);
      return;
    }

    if (accepted.length > 0) {
      await removeLiveActivityTokens(accepted);
    }
  };

  // NOT gated on UI visibility (unlike web push). A backgrounded WKWebView can't reliably
  // report "hidden" before iOS suspends it, so a visibility gate wrongly suppressed
  // background push for short responses. Instead we always send, and rely on iOS to NOT
  // display the alert while the app is foreground (presentationOptions: [] in
  // capacitor.config) — so there is no notification when the app is active, with no race.
  const reRegisterAllTokens = async () => {
    const relay = await resolveRelayConfig();
    if (!relay) {
      return { attempted: 0, succeeded: 0, failed: 0 };
    }
    const store = await readTokensFromDisk();
    const entries = listUniqueTokenEntries(store);
    boundRegistrationCache(relay.registerUrl, entries);
    const outcomes = await mapWithBoundedConcurrency(
      entries,
      RELAY_REGISTER_CONCURRENCY,
      (entry) => registerTokenWithRelay(entry.deviceToken, entry.platform, relay),
    );
    let succeeded = 0;
    let failed = 0;
    for (const ok of outcomes) {
      if (ok) succeeded += 1;
      else failed += 1;
    }
    return { attempted: entries.length, succeeded, failed };
  };

  // Group ready device tokens by app locale so each batch can carry a localized title.
  // Relay signatures cover title, so mixed-locale tokens must not share one send body.
  const groupTokensByLocale = (entries) => {
    const groups = new Map();
    for (const entry of entries) {
      const locale = entry?.locale ? normalizeApnsLocale(entry.locale) : APNS_DEFAULT_LOCALE;
      const token = entry?.deviceToken;
      if (typeof token !== 'string' || token.length === 0) continue;
      let list = groups.get(locale);
      if (!list) {
        list = [];
        groups.set(locale, list);
      }
      list.push(token);
    }
    return groups;
  };

  const sendApnsToAllUiSessions = async (payload, _options = {}) => {
    const store = await readTokensFromDisk();
    const uniqueEntries = listUniqueTokenEntries(store);
    if (uniqueEntries.length === 0) return;

    const relay = await resolveRelayConfig();
    if (relay) {
      boundRegistrationCache(relay.registerUrl, uniqueEntries);
      const outcomes = await mapWithBoundedConcurrency(
        uniqueEntries,
        RELAY_REGISTER_CONCURRENCY,
        async (entry) => {
          const registered = await registerTokenWithRelay(entry.deviceToken, entry.platform, relay);
          return registered ? entry : null;
        },
      );
      const readyEntries = [];
      const readySeen = new Set();
      for (const entry of outcomes) {
        if (!entry?.deviceToken || readySeen.has(entry.deviceToken)) continue;
        readySeen.add(entry.deviceToken);
        readyEntries.push(entry);
      }
      if (readyEntries.length === 0) return;
      for (const [locale, tokens] of groupTokensByLocale(readyEntries)) {
        await sendViaRelay(tokens, localizeApnsPayload(payload, locale), relay);
      }
      return;
    }
    const byLocale = groupTokensByLocale(uniqueEntries);
    for (const [locale, deviceTokens] of byLocale) {
      await sendViaDirectApns(deviceTokens, localizeApnsPayload(payload, locale));
    }
  };

  return {
    addOrUpdateApnsToken,
    removeApnsToken,
    removeApnsTokenFromAllSessions,
    addOrUpdateLiveActivityToken,
    removeLiveActivityToken,
    sendLiveActivityEnd,
    sendApnsToAllUiSessions,
    reRegisterAllTokens,
    resolveApnsConfig,
    // exposed for tests
    signApnsJwt,
  };
};
