import { buildPushRelayConfig, ENV_PREFIX } from './config.js';
import { createPushRelayHandler } from './handler.js';

const APNS_ENV_PREFIX = `${ENV_PREFIX}APNS_`;

const hasPushApnsEnv = (env) => {
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!key.startsWith(APNS_ENV_PREFIX)) continue;
    if (typeof value === 'string' && value.trim().length > 0) return true;
  }
  return false;
};

export const createCombinedPushMount = (env = process.env, deps = {}) => {
  if (!hasPushApnsEnv(env)) return null;
  const config = buildPushRelayConfig({}, env);
  // Combined mode ignores OPENCHAMBER_PUSH_RELAY_HOST / OPENCHAMBER_PUSH_RELAY_PORT;
  // Push HTTP is mounted on the Layer 1 listener at /v1/push/* instead of opening its own port.
  const handler = createPushRelayHandler({
    databasePath: config.databasePath,
    trustProxy: config.trustProxy,
    limits: config.limits,
    apns: config.apns,
    apnsProvider: deps.apnsProvider,
    clock: deps.clock,
    claimHealthEndpoints: false,
  });
  return {
    requestHandler: handler.handleRequest,
    start: () => handler.activate(),
    stop: () => handler.deactivate(),
    getSnapshot: handler.getSnapshot,
  };
};
