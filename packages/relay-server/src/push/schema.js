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

const bytes = (value) => Buffer.byteLength(value, 'utf8');
const isSafeInt = (value) => typeof value === 'number' && Number.isSafeInteger(value);

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
  const unique = [];
  const seen = new Set();
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    unique.push(token);
  }
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
