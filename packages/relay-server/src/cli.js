import { startPrivateRelayServer } from './index.js';
import { isIP } from 'node:net';

const LIMIT_KEYS = ['maxUrlBytes', 'maxFieldBytes', 'maxHosts', 'maxSockets', 'maxConnections', 'maxClientsPerHost', 'maxClientsPerIp', 'maxPendingClients', 'pendingMs', 'maxRawSockets', 'maxRawSocketsPerIp', 'graceMs', 'timestampSkewMs', 'replayMs', 'maxReplayEntries', 'maxFrameBytes', 'maxQueuedBytesPerConnection', 'maxGlobalQueuedBytes', 'maxBufferedAmount', 'maxControlQueueEntries', 'maxControlQueuedBytes', 'pumpRetryMs', 'heartbeatMs', 'handshakeMs', 'closeDeadlineMs', 'admissionWindowMs', 'maxAdmissionsPerIp', 'maxAdmissionEntries', 'idAttempts'];
const upperSnake = (key) => key.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase();
const envName = (key) => `OPENCHAMBER_RELAY_SERVER_${upperSnake(key)}`;
const fail = (name) => { throw new Error(`Invalid ${name}`); };

export const parseRelayServerArgs = (argv = []) => {
  const parsed = {};
  const values = new Map([['--host', 'host'], ['--port', 'port'], ['--path', 'path'], ['--public-url', 'publicUrl']]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (values.has(arg)) { const value = argv[++index]; if (!value || value.startsWith('--')) fail(arg, value ?? ''); parsed[values.get(arg)] = value; continue; }
    if (arg === '--trust-proxy') { parsed.trustProxy = true; continue; }
    if (arg === '--no-trust-proxy') { parsed.trustProxy = false; continue; }
    if (arg === '--json') { parsed.json = true; continue; }
    if (arg === '--quiet' || arg === '-q') { parsed.quiet = true; continue; }
    if (arg === '--help' || arg === '-h') { parsed.help = true; continue; }
    if (arg === '--version' || arg === '-v') { parsed.version = true; continue; }
    fail(arg, '');
  }
  return parsed;
};

const positive = (name, value) => {
  if (!/^[1-9][0-9]*$/.test(String(value))) fail(name, value);
  const number = Number(value); if (!Number.isSafeInteger(number)) fail(name, value);
  return number;
};
const bool = (name, value) => {
  if (value === undefined) return false;
  if (value === 'true' || value === '1' || value === true) return true;
  if (value === 'false' || value === '0' || value === false) return false;
  fail(name, value);
};
const validPath = (name, value) => {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('?') || value.includes('#') || new URL(value, 'http://relay').pathname !== value) fail(name, value);
  return value;
};
const validHost = (name, value) => {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.includes('/') || value.includes('\\') || value.includes('@') || value.includes(':') && !isIP(value) || (!isIP(value) && !/^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?))*$/.test(value))) fail(name, value);
  return value;
};
const publicUrl = (name, value, path) => {
  if (!value) return undefined;
  let url; try { url = new URL(value); } catch { fail(name, value); }
  if (!['ws:', 'wss:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || url.pathname !== path) fail(name, value);
  return url.toString();
};

export const buildRelayConfig = (parsed = {}, env = process.env) => {
  const envValue = (key) => {
    const value = env[envName(key)];
    return typeof value === 'string' && value.trim().length === 0 ? undefined : value;
  };
  const pick = (key, fallback) => parsed[key] ?? envValue(key) ?? fallback;
  const portValue = pick('port', 8787); const port = positive(parsed.port !== undefined ? '--port' : envName('port'), portValue);
  if (port > 65535) fail(parsed.port !== undefined ? '--port' : envName('port'), portValue);
  const path = validPath(parsed.path !== undefined ? '--path' : envName('path'), pick('path', '/ws'));
  const host = validHost(parsed.host !== undefined ? '--host' : envName('host'), pick('host', '127.0.0.1'));
  const outputPublicUrl = publicUrl(parsed.publicUrl !== undefined ? '--public-url' : envName('publicUrl'), pick('publicUrl', undefined), path);
  const limits = {};
  for (const key of LIMIT_KEYS) { const value = pick(key, undefined); if (value !== undefined) limits[key] = positive(parsed[key] !== undefined ? `--${upperSnake(key).toLowerCase().replaceAll('_', '-')}` : envName(key), value); }
  const replayMs = limits.replayMs ?? 120_000; const timestampSkewMs = limits.timestampSkewMs ?? 60_000; const maxConnections = limits.maxConnections ?? 1_000;
  if (replayMs < timestampSkewMs * 2) fail(parsed.replayMs !== undefined ? '--replay-ms' : envName('replayMs'), replayMs);
  if ((limits.maxPendingClients ?? 30) > maxConnections) fail(parsed.maxPendingClients !== undefined ? '--max-pending-clients' : envName('maxPendingClients'), limits.maxPendingClients ?? 30);
  if ((limits.maxClientsPerHost ?? 100) > maxConnections) fail(parsed.maxClientsPerHost !== undefined ? '--max-clients-per-host' : envName('maxClientsPerHost'), limits.maxClientsPerHost ?? 100);
  return { host, port, path, publicUrl: outputPublicUrl, trustProxy: parsed.trustProxy ?? bool(envName('trustProxy'), envValue('trustProxy')), limits };
};

const helpText = 'Usage: openchamber-relay [--host HOST] [--port PORT] [--path PATH] [--public-url WS_URL] [--trust-proxy] [--json] [--quiet]\nEnable --trust-proxy only when public ingress reaches this relay through a trusted reverse proxy.\n';
const writeJson = (stdout, payload) => stdout.write(`${JSON.stringify(payload)}\n`);

export const runRelayServerCli = async (argv, dependencies = {}) => {
  const processLike = dependencies.process ?? process; const stdout = dependencies.stdout ?? process.stdout; const stderr = dependencies.stderr ?? process.stderr; const version = dependencies.version ?? '0.0.0';
  let parsed;
  try { parsed = parseRelayServerArgs(argv ?? processLike.argv?.slice(2) ?? []); } catch (error) {
    const json = (argv ?? processLike.argv?.slice(2) ?? []).includes('--json');
    if (json) writeJson(stdout, { status: 'error', error: error.message }); else stderr.write(`${error.message}\n`);
    processLike.exitCode = 1; return 1;
  }
  const json = parsed.json;
  const respond = (payload, error = false, essential = false) => { if (json) writeJson(stdout, payload); else if (payload.message && (essential || !parsed.quiet || error)) (error ? stderr : stdout).write(`${payload.message}\n`); };
  if (parsed.help) { respond(json ? { status: 'ok', help: helpText.trim() } : { message: helpText.trim() }, false, true); return 0; }
  if (parsed.version) { respond(json ? { status: 'ok', version } : { message: version }, false, true); return 0; }
  let config;
  try { config = buildRelayConfig(parsed, processLike.env ?? {}); } catch (error) { respond({ status: 'error', error: error.message, message: error.message }, true); processLike.exitCode = 1; return 1; }
  try {
    const relay = await (dependencies.start ?? startPrivateRelayServer)(config);
    const url = config.publicUrl ?? relay.wsUrl;
    respond(json ? { status: 'ok', url, host: config.host, port: relay.address?.()?.port ?? config.port, path: config.path } : { message: `Relay listening at ${url}` });
    let stopping = false;
    const stop = async () => {
      if (stopping) return Promise.resolve();
      stopping = true;
      processLike.off?.('SIGINT', stop); processLike.off?.('SIGTERM', stop);
      try {
        await relay.stop();
        processLike.exit?.(0);
      } catch {
        processLike.exitCode = 1;
        if (json) writeJson(stderr, { status: 'error', error: 'Relay stop failed' }); else stderr.write('Relay stop failed\n');
        processLike.exit?.(1);
      }
    };
    processLike.on?.('SIGINT', stop); processLike.on?.('SIGTERM', stop);
    return 0;
  } catch (error) { respond({ status: 'error', error: error.message, message: error.message }, true); processLike.exitCode = 1; return 1; }
};
