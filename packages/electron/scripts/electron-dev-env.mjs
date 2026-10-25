/**
 * Sanitize the environment for `electron:dev` children.
 *
 * Yuri Desktop injects YURI_* / OPENCODE_* into the agent shell
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
  'YURI_UI_PASSWORD',
  'YURI_DIST_DIR',
  'YURI_RUNTIME',
  'YURI_HOST',
  'YURI_DESKTOP_LAN_ACCESS_ACTIVE',
  'YURI_DESKTOP_LAN_ACCESS_BLOCKED_REASON',
  'YURI_DESKTOP_NOTIFY',
  'YURI_OPENCODE_CWD',
  'YURI_DATA_DIR',
  'YURI_MANAGED_PROCESS_REGISTRY',
  'YURI_SESSION_INDEX_DB_PATH',
  'YURI_MESSAGE_QUEUE_DB_PATH',
  'YURI_DESKTOP_PROFILE',
  'YURI_SCHEDULED_TASK_BRIDGE_ORIGIN',
  'YURI_SCHEDULED_TASK_BRIDGE_PATH',
  'YURI_SCHEDULED_TASK_BRIDGE_TOKEN',
  'YURI_SCHEDULED_TASK_TOKEN_HEADER',
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
  if (!Object.prototype.hasOwnProperty.call(overrides, 'YURI_HOST') && !env.YURI_HOST) {
    env.YURI_HOST = '127.0.0.1';
  }
  return {
    ...env,
    ...overrides,
  };
};
