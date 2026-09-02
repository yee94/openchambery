import { startPushRelayServer } from './server.js';
import { buildPushRelayConfig, fail, formatPushRelayUrl } from './config.js';

export { buildPushRelayConfig } from './config.js';

export const parsePushRelayArgs = (argv = []) => {
  const parsed = {};
  const values = new Map([['--host', 'host'], ['--port', 'port']]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (values.has(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) fail(arg);
      parsed[values.get(arg)] = value;
      continue;
    }
    if (arg === '--trust-proxy') { parsed.trustProxy = true; continue; }
    if (arg === '--no-trust-proxy') { parsed.trustProxy = false; continue; }
    if (arg === '--json') { parsed.json = true; continue; }
    if (arg === '--quiet' || arg === '-q') { parsed.quiet = true; continue; }
    if (arg === '--help' || arg === '-h') { parsed.help = true; continue; }
    if (arg === '--version' || arg === '-v') { parsed.version = true; continue; }
    fail(arg);
  }
  return parsed;
};

const helpText = 'Usage: openchamber-push-relay [--host HOST] [--port PORT] [--trust-proxy] [--json] [--quiet]\nEnable --trust-proxy only when public ingress reaches this relay through a trusted reverse proxy.\n';
const writeJson = (stdout, payload) => stdout.write(`${JSON.stringify(payload)}\n`);

export const runPushRelayCli = async (argv, dependencies = {}) => {
  const processLike = dependencies.process ?? process;
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const version = dependencies.version ?? '0.0.0';
  let parsed;
  try { parsed = parsePushRelayArgs(argv ?? processLike.argv?.slice(2) ?? []); } catch (error) {
    const json = (argv ?? processLike.argv?.slice(2) ?? []).includes('--json');
    if (json) writeJson(stdout, { status: 'error', error: error.message }); else stderr.write(`${error.message}\n`);
    processLike.exitCode = 1; return 1;
  }
  const json = parsed.json;
  const respond = (payload, error = false, essential = false) => {
    if (json) writeJson(stdout, payload);
    else if (payload.message && (essential || !parsed.quiet || error)) (error ? stderr : stdout).write(`${payload.message}\n`);
  };
  if (parsed.help) { respond(json ? { status: 'ok', help: helpText.trim() } : { message: helpText.trim() }, false, true); return 0; }
  if (parsed.version) { respond(json ? { status: 'ok', version } : { message: version }, false, true); return 0; }
  let config;
  try { config = buildPushRelayConfig(parsed, processLike.env ?? {}); } catch (error) { respond({ status: 'error', error: error.message, message: error.message }, true); processLike.exitCode = 1; return 1; }
  try {
    const relay = await (dependencies.start ?? startPushRelayServer)(config);
    const port = relay.address?.()?.port ?? config.port;
    const url = formatPushRelayUrl(config.host, port);
    respond(json ? { status: 'ok', url, host: config.host, port } : { message: `Push relay listening at ${url}` });
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
        if (json) writeJson(stderr, { status: 'error', error: 'Push relay stop failed' }); else stderr.write('Push relay stop failed\n');
        processLike.exit?.(1);
      }
    };
    processLike.on?.('SIGINT', stop); processLike.on?.('SIGTERM', stop);
    return 0;
  } catch (error) { respond({ status: 'error', error: error.message, message: error.message }, true); processLike.exitCode = 1; return 1; }
};
