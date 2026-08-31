import fs from 'node:fs';
import { isIP } from 'node:net';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8788;
export const DEFAULT_DATABASE_PATH = './data/push-relay.sqlite';
export const DEFAULT_BUNDLE_ID = 'com.openchamber.app';
export const ENV_PREFIX = 'OPENCHAMBER_PUSH_RELAY_';
export const DEFAULT_LIMITS = {
  timestampSkewMs: 300_000,
  replayMs: 600_000,
  maxReplayEntries: 10_000,
  registerLimitPerMinute: 60,
  sendLimitPerMinute: 60,
  serverSendLimitPerMinute: 120,
  maxTokens: 100_000,
  maxInFlight: 64,
  maxRateLimitEntries: 10_000,
  jsonBodyBytes: 16 * 1024,
};

const LIMIT_KEYS = ['timestampSkewMs', 'replayMs', 'maxReplayEntries', 'registerLimitPerMinute', 'sendLimitPerMinute', 'serverSendLimitPerMinute', 'maxTokens', 'maxInFlight'];

export const resolvePushRelayClientIp = (request, trustProxy = false) => {
  const remoteAddress = request.socket.remoteAddress ?? 'unknown';
  if (!trustProxy) return remoteAddress;
  const forwarded = request.headers['x-forwarded-for'];
  const candidate = typeof forwarded === 'string' && !forwarded.includes(',') ? forwarded.trim() : '';
  return isIP(candidate) ? candidate : remoteAddress;
};

export const formatPushRelayUrl = (host, port) => `http://${isIP(host) === 6 ? `[${host}]` : host}:${port}`;

const upperSnake = (key) => key.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase();
export const envName = (key) => `${ENV_PREFIX}${upperSnake(key)}`;
export const fail = (name) => { throw new Error(`Invalid ${name}`); };

export const positive = (name, value) => {
  if (!/^[1-9][0-9]*$/.test(String(value))) fail(name);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) fail(name);
  return number;
};

export const bool = (name, value) => {
  if (value === undefined) return false;
  if (value === 'true' || value === '1' || value === true) return true;
  if (value === 'false' || value === '0' || value === false) return false;
  fail(name);
};

export const validHost = (name, value) => {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.includes('/') || value.includes('\\') || value.includes('@') || value.includes(':') && !isIP(value) || (!isIP(value) && !/^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?))*$/.test(value))) fail(name);
  return value;
};

export const validDatabasePath = (name, value) => {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.includes('\0')) fail(name);
  return value;
};

export const normalizePem = (value) => (typeof value === 'string' ? value.replace(/\\n/g, '\n').trim() : '');

export const validatePushRelayLimits = (limits) => {
  if (limits.replayMs < limits.timestampSkewMs * 2 || limits.maxReplayEntries < 1) throw new RangeError('invalid replay limits');
  if (limits.maxTokens < 1 || limits.maxInFlight < 1 || limits.registerLimitPerMinute < 1 || limits.sendLimitPerMinute < 1 || limits.serverSendLimitPerMinute < 1) {
    throw new RangeError('invalid push limits');
  }
  return limits;
};

export const normalizePushRelayOptions = (options = {}) => {
  const limits = validatePushRelayLimits({ ...DEFAULT_LIMITS, ...options.limits });
  const host = options.host ?? DEFAULT_HOST;
  validHost('host', host);
  const port = options.port ?? DEFAULT_PORT;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) fail('port');
  const databasePath = options.databasePath ?? DEFAULT_DATABASE_PATH;
  validDatabasePath('databasePath', databasePath);
  if (!options.apnsProvider) {
    const apns = options.apns ?? {};
    if (!apns.keyId || !apns.teamId || !apns.p8 || !apns.bundleId) throw new Error('Invalid APNs configuration');
  }
  return {
    host,
    port,
    trustProxy: Boolean(options.trustProxy),
    databasePath,
    limits,
    apns: options.apns,
    apnsProvider: options.apnsProvider,
    clock: options.clock,
    logger: options.logger,
    resolveClientIp: options.resolveClientIp,
    store: options.store,
    http2: options.http2,
  };
};

const envValue = (env, key) => {
  const value = env[envName(key)];
  return typeof value === 'string' && value.trim().length === 0 ? undefined : value;
};

const loadP8 = (env) => {
  const inline = envValue(env, 'apnsP8') ?? env[`${ENV_PREFIX}APNS_P8`];
  if (typeof inline === 'string' && inline.trim().length > 0) return normalizePem(inline);
  const p8Path = envValue(env, 'apnsP8Path') ?? env[`${ENV_PREFIX}APNS_P8_PATH`];
  if (typeof p8Path === 'string' && p8Path.trim().length > 0) {
    try { return normalizePem(fs.readFileSync(p8Path.trim(), 'utf8')); } catch { fail(`${ENV_PREFIX}APNS_P8_PATH`); }
  }
  fail(`${ENV_PREFIX}APNS_P8`);
};

export const buildPushRelayConfig = (parsed = {}, env = process.env) => {
  const pick = (key, fallback) => parsed[key] ?? envValue(env, key) ?? fallback;
  const portValue = pick('port', DEFAULT_PORT);
  const port = positive(parsed.port !== undefined ? '--port' : envName('port'), portValue);
  if (port > 65535) fail(parsed.port !== undefined ? '--port' : envName('port'));
  const host = validHost(parsed.host !== undefined ? '--host' : envName('host'), pick('host', DEFAULT_HOST));
  const databasePath = validDatabasePath(envName('databasePath'), pick('databasePath', DEFAULT_DATABASE_PATH));
  const limits = {};
  for (const key of LIMIT_KEYS) {
    const value = pick(key, undefined);
    if (value !== undefined) limits[key] = positive(parsed[key] !== undefined ? `--${upperSnake(key).toLowerCase().replaceAll('_', '-')}` : envName(key), value);
  }
  const merged = { ...DEFAULT_LIMITS, ...limits };
  if (merged.replayMs < merged.timestampSkewMs * 2) fail(parsed.replayMs !== undefined ? '--replay-ms' : envName('replayMs'));
  validatePushRelayLimits(merged);
  const keyId = pick('apnsKeyId', env[`${ENV_PREFIX}APNS_KEY_ID`]);
  const teamId = pick('apnsTeamId', env[`${ENV_PREFIX}APNS_TEAM_ID`]);
  const bundleId = pick('apnsBundleId', env[`${ENV_PREFIX}APNS_BUNDLE_ID`]) || DEFAULT_BUNDLE_ID;
  if (typeof keyId !== 'string' || keyId.trim().length === 0) fail(`${ENV_PREFIX}APNS_KEY_ID`);
  if (typeof teamId !== 'string' || teamId.trim().length === 0) fail(`${ENV_PREFIX}APNS_TEAM_ID`);
  const p8 = loadP8(env);
  if (!p8) fail(`${ENV_PREFIX}APNS_P8`);
  return {
    host,
    port,
    databasePath,
    trustProxy: parsed.trustProxy ?? bool(envName('trustProxy'), envValue(env, 'trustProxy')),
    limits: merged,
    apns: { keyId: keyId.trim(), teamId: teamId.trim(), p8, bundleId: String(bundleId).trim() },
  };
};
