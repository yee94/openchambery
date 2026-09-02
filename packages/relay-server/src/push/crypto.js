import crypto from 'node:crypto';

const B64 = /^[A-Za-z0-9_-]+$/;

export const canonicalPublicJwkString = (jwk) => JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });

export const b64urlExact = (value, length) => {
  if (typeof value !== 'string' || !B64.test(value)) return null;
  try {
    const decoded = Buffer.from(value, 'base64url');
    return decoded.length === length && decoded.toString('base64url') === value ? decoded : null;
  } catch {
    return null;
  }
};

export const parsePublicJwk = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 4 || !keys.includes('crv') || !keys.includes('kty') || !keys.includes('x') || !keys.includes('y')) return null;
  if (value.kty !== 'EC' || value.crv !== 'P-256' || !b64urlExact(value.x, 32) || !b64urlExact(value.y, 32)) return null;
  return { crv: value.crv, kty: value.kty, x: value.x, y: value.y };
};

export const deriveServerId = (jwk) => crypto.createHash('sha256').update(canonicalPublicJwkString(jwk)).digest('base64url');

export const verifyP1363 = (message, jwk, signature) => {
  try {
    const key = crypto.createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, format: 'jwk' });
    return crypto.verify('SHA256', Buffer.from(message), { key, dsaEncoding: 'ieee-p1363' }, signature);
  } catch {
    return false;
  }
};
