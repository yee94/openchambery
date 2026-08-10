/**
 * Sanitize the environment for `electron:dev` children.
 *
 * OpenChamber Desktop injects OPENCHAMBER_* / OPENCODE_* into the agent shell
 * while the production app is running. If electron:dev inherits those values,
 * the HMR API process boots with the production UI password, dist dir, and
 * runtime flags — then every authenticated request returns 401 and the UI
 * looks blank/stuck.
 *
 * Dev should behave like preview isolation: its own userData (handled in
 * main.mjs) and a clean process env for the HMR API + Electron child.
 */

/** Env keys that must never leak from a running production/preview app into dev. */
export const ELECTRON_DEV_STRIPPED_ENV_KEYS = Object.freeze([
  'OPENCHAMBER_UI_PASSWORD',
  'OPENCHAMBER_DIST_DIR',
  'OPENCHAMBER_RUNTIME',
  'OPENCHAMBER_HOST',
  'OPENCHAMBER_DESKTOP_LAN_ACCESS_ACTIVE',
  'OPENCHAMBER_DESKTOP_LAN_ACCESS_BLOCKED_REASON',
  'OPENCHAMBER_DESKTOP_NOTIFY',
  'OPENCHAMBER_OPENCODE_CWD',
  'OPENCHAMBER_DATA_DIR',
  'OPENCHAMBER_MANAGED_PROCESS_REGISTRY',
  'OPENCHAMBER_SESSION_INDEX_DB_PATH',
  'OPENCHAMBER_MESSAGE_QUEUE_DB_PATH',
  'OPENCHAMBER_DESKTOP_PROFILE',
  'OPENCHAMBER_SCHEDULED_TASK_BRIDGE_ORIGIN',
  'OPENCHAMBER_SCHEDULED_TASK_BRIDGE_PATH',
  'OPENCHAMBER_SCHEDULED_TASK_BRIDGE_TOKEN',
  'OPENCHAMBER_SCHEDULED_TASK_TOKEN_HEADER',
  'OPENCODE_SERVER_PASSWORD',
  'OPENCODE_CONFIG_CONTENT',
  'OPENCODE_PID',
  'OPENCODE',
]);

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [source]
 * @param {Record<string, string | undefined>} [overrides]
 * @returns {Record<string, string | undefined>}
 */
export const buildElectronDevChildEnv = (source = process.env, overrides = {}) => {
  const env = { ...source };
  for (const key of ELECTRON_DEV_STRIPPED_ENV_KEYS) {
    delete env[key];
  }
  // Prefer an explicit override, otherwise force a clean loopback host so a
  // production LAN bind does not pin the HMR API to 0.0.0.0 with a password.
  if (!Object.prototype.hasOwnProperty.call(overrides, 'OPENCHAMBER_HOST') && !env.OPENCHAMBER_HOST) {
    env.OPENCHAMBER_HOST = '127.0.0.1';
  }
  return {
    ...env,
    ...overrides,
  };
};
