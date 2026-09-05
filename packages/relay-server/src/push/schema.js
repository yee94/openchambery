import { b64urlExact, parsePublicJwk } from './crypto.js';

export const IOS_TOKEN = /^[0-9a-fA-F]{64}$/;
export const JSON_BODY_BYTES = 16 * 1024;
export const APNS_PAYLOAD_BYTES = 4096;
export const MAX_TOKENS_PER_REQUEST = 100;
export const MAX_TITLE_BYTES = 256;
export const MAX_BODY_BYTES = 1024;
export const MAX_COLLAPSE_ID_BYTES = 64;
export const MAX_DATA_ENTRIES = 16;
export const MAX_DATA_KEY_BYTES = 64;
export const MAX_DATA_VALUE_BYTES = 256;
export const MAX_DATA_TOTAL_BYTES = 2048;
export const LIVE_ACTIVITY_KIND = 'liveactivity';
export const LIVE_ACTIVITY_EVENTS = new Set(['update', 'end']);
export const LIVE_ACTIVITY_STATUSES = new Set(['working', 'tool', 'retry', 'input', 'permission', 'stale', 'complete', 'error']);
export const LIVE_ACTIVITY_CONTENT_KEYS = new Set(['status', 'eventVersion', 'updatedAt', 'endedAt']);

const bytes = (value) => Buffer.byteLength(value, 'utf8');
const isSafeInt = (value) => typeof value === 'number' && Number.isSafeInteger(value);
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

export const isIosToken = (value) => typeof value === 'string' && IOS_TOKEN.test(value);

const parseTs = (value) => (isSafeInt(value) ? value : null);
const parseSig = (value) => b64urlExact(value, 64);

const parseData = (value) => {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > MAX_DATA_ENTRIES) return null;
  let total = 0;
  const data = {};
  for (const [key, entry] of entries) {
    if (typeof key !== 'string' || key.length === 0 || key === 'aps' || typeof entry !== 'string') return null;
    const keyBytes = bytes(key);
    const valueBytes = bytes(entry);
    if (keyBytes > MAX_DATA_KEY_BYTES || valueBytes > MAX_DATA_VALUE_BYTES) return null;
    total += keyBytes + valueBytes;
    if (total > MAX_DATA_TOTAL_BYTES) return null;
    data[key] = entry;
  }
  return data;
};

export const buildApnsPayload = ({ title, body, badge, collapseId, data }) => {
  const alert = { title };
  if (body) alert.body = body;
  const aps = { alert, sound: 'default', 'mutable-content': 1 };
  if (badge !== undefined) aps.badge = badge;
  if (collapseId) aps['thread-id'] = collapseId;
  return Object.keys(data).length > 0 ? { aps, ...data } : { aps };
};

export const buildLiveActivityPayload = ({ event, contentState, dismissalDate, staleDate, timestamp }) => {
  const aps = { timestamp, event, 'content-state': contentState };
  if (event === 'end' && dismissalDate !== undefined) aps['dismissal-date'] = dismissalDate;
  if (event === 'update' && staleDate !== undefined) aps['stale-date'] = staleDate;
  return { aps };
};

const uniqueTokens = (tokens) => {
  const unique = [];
  const seen = new Set();
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    unique.push(token);
  }
  return unique;
};

const parseContentState = (value, event) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => !LIVE_ACTIVITY_CONTENT_KEYS.has(key))) return null;
  if (typeof value.status !== 'string' || !LIVE_ACTIVITY_STATUSES.has(value.status)) return null;
  if (!isSafeInt(value.eventVersion) || !isFiniteNumber(value.updatedAt)) return null;
  if (event === 'end' && !isFiniteNumber(value.endedAt)) return null;
  if (value.endedAt !== undefined && !isFiniteNumber(value.endedAt)) return null;
  const contentState = { status: value.status, eventVersion: value.eventVersion, updatedAt: value.updatedAt };
  if (value.endedAt !== undefined) contentState.endedAt = value.endedAt;
  return contentState;
};

export const validateRegisterBody = (body) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'invalid_request' };
  if (body.platform === 'android') return { error: 'unsupported_platform' };
  if (body.platform !== 'ios') return { error: 'invalid_request' };
  if (!isIosToken(body.token)) return { error: 'invalid_request' };
  const jwk = parsePublicJwk(body.publicKeyJwk);
  const ts = parseTs(body.ts);
  const sig = parseSig(body.sig);
  if (!jwk || ts === null || !sig) return { error: 'invalid_request' };
  return { value: { token: body.token, platform: 'ios', publicKeyJwk: jwk, ts, sig } };
};

export const validateLiveActivityRegisterBody = (body) => {
  const parsed = validateRegisterBody(body);
  if (parsed.error) return parsed;
  if (body.kind !== LIVE_ACTIVITY_KIND) return { error: 'invalid_request' };
  return { value: { ...parsed.value, kind: LIVE_ACTIVITY_KIND } };
};

export const validateSendBody = (body) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'invalid_request' };
  const tokens = body.tokens;
  if (!Array.isArray(tokens) || tokens.length < 1 || tokens.length > MAX_TOKENS_PER_REQUEST) return { error: 'invalid_request' };
  if (tokens.some((token) => !isIosToken(token))) return { error: 'invalid_request' };
  if (typeof body.title !== 'string' || body.title.length === 0 || bytes(body.title) > MAX_TITLE_BYTES) return { error: 'invalid_request' };
  if (body.body !== undefined && (typeof body.body !== 'string' || bytes(body.body) > MAX_BODY_BYTES)) return { error: 'invalid_request' };
  if (body.badge !== undefined && (!isSafeInt(body.badge) || body.badge < 0)) return { error: 'invalid_request' };
  if (body.collapseId !== undefined && (typeof body.collapseId !== 'string' || bytes(body.collapseId) > MAX_COLLAPSE_ID_BYTES)) return { error: 'invalid_request' };
  if (body.env !== undefined && body.env !== 'production' && body.env !== 'sandbox') return { error: 'invalid_request' };
  const jwk = parsePublicJwk(body.publicKeyJwk);
  const ts = parseTs(body.ts);
  const sig = parseSig(body.sig);
  const data = parseData(body.data);
  if (!jwk || ts === null || !sig || !data) return { error: 'invalid_request' };
  const unique = uniqueTokens(tokens);
  const payload = buildApnsPayload({
    title: body.title,
    body: body.body ?? '',
    badge: body.badge,
    collapseId: body.collapseId,
    data,
  });
  if (bytes(JSON.stringify(payload)) > APNS_PAYLOAD_BYTES) return { error: 'invalid_request' };
  return {
    value: {
      tokens,
      uniqueTokens: unique,
      title: body.title,
      body: typeof body.body === 'string' ? body.body : '',
      badge: body.badge,
      collapseId: body.collapseId || undefined,
      env: body.env === 'production' ? 'production' : 'sandbox',
      publicKeyJwk: jwk,
      ts,
      sig,
      payload,
    },
  };
};

export const validateLiveActivityBody = (body) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'invalid_request' };
  const tokens = body.tokens;
  if (!Array.isArray(tokens) || tokens.length < 1 || tokens.length > MAX_TOKENS_PER_REQUEST) return { error: 'invalid_request' };
  if (tokens.some((token) => !isIosToken(token))) return { error: 'invalid_request' };
  if (typeof body.event !== 'string' || !LIVE_ACTIVITY_EVENTS.has(body.event)) return { error: 'invalid_request' };
  const contentState = parseContentState(body.contentState, body.event);
  if (!contentState) return { error: 'invalid_request' };
  if (body.dismissalDate !== undefined && !isSafeInt(body.dismissalDate)) return { error: 'invalid_request' };
  if (body.staleDate !== undefined && !isSafeInt(body.staleDate)) return { error: 'invalid_request' };
  if (body.env !== undefined && body.env !== 'production' && body.env !== 'sandbox') return { error: 'invalid_request' };
  const jwk = parsePublicJwk(body.publicKeyJwk);
  const ts = parseTs(body.ts);
  const sig = parseSig(body.sig);
  if (!jwk || ts === null || !sig) return { error: 'invalid_request' };
  const payload = buildLiveActivityPayload({
    event: body.event,
    contentState,
    dismissalDate: body.dismissalDate,
    staleDate: body.staleDate,
    timestamp: 1_000_000_000,
  });
  if (bytes(JSON.stringify(payload)) > APNS_PAYLOAD_BYTES) return { error: 'invalid_request' };
  return {
    value: {
      tokens,
      uniqueTokens: uniqueTokens(tokens),
      event: body.event,
      contentState,
      dismissalDate: body.dismissalDate,
      staleDate: body.staleDate,
      env: body.env === 'production' ? 'production' : 'sandbox',
      publicKeyJwk: jwk,
      ts,
      sig,
      payload,
    },
  };
};
