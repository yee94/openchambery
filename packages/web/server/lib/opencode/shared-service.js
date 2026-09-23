import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Official OpenCode background service (`opencode serve --service`). Every
// official client on this machine — TUI, CLI, Desktop — finds it through one
// registration file and shares its process, database, and config watchers, so
// providers connected or plugins changed elsewhere are live here too.

const SERVICE_START_TIMEOUT_MS = 45_000;

/** Stable-channel registration file (`latest`/`beta`/`next`/`dev` share it). */
export const resolveSharedServiceRegistrationPath = (envLike = process.env, homeDir = os.homedir()) => {
  const stateHome = typeof envLike.XDG_STATE_HOME === 'string' && envLike.XDG_STATE_HOME.trim()
    ? envLike.XDG_STATE_HOME.trim()
    : path.join(homeDir, '.local', 'state');
  return path.join(stateHome, 'opencode', 'service.json');
};

/** `OPENCHAMBER_OPENCODE_SHARED_SERVICE=0` opts back into a private managed `opencode serve`. */
export const isSharedServiceEnabled = (envLike = process.env) => {
  const raw = String(envLike.OPENCHAMBER_OPENCODE_SHARED_SERVICE ?? '').trim().toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'off';
};

/** @returns {{ origin: string, port: number, pid: number | null, password: string | null, version: string | null } | null} */
export const parseSharedServiceRegistration = (text) => {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || typeof value.url !== 'string') return null;
  let url;
  try {
    url = new URL(value.url);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const port = Number.parseInt(url.port, 10);
  if (!Number.isInteger(port) || port <= 0) return null;
  return {
    origin: url.origin,
    port,
    pid: Number.isInteger(value.pid) && value.pid > 0 ? value.pid : null,
    password: typeof value.password === 'string' && value.password.trim() ? value.password.trim() : null,
    version: typeof value.version === 'string' ? value.version : null,
  };
};

export const readSharedServiceRegistration = async ({ file = resolveSharedServiceRegistrationPath(), fsLike = fs } = {}) => {
  const text = await fsLike.readFile(file, 'utf8').catch(() => null);
  return text == null ? null : parseSharedServiceRegistration(text);
};

/**
 * Environment inherited by a service OpenChamber starts. The service outlives
 * OpenChamber and passes its env to every tool, so OpenChamber credentials
 * (`OPENCHAMBER_*`, the managed-serve password) never travel with it; the
 * service owns its own persistent password.
 */
export const buildSharedServiceStartEnv = (baseEnv = {}) => {
  const env = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value !== 'string') continue;
    if (key.startsWith('OPENCHAMBER_')) continue;
    if (key === 'OPENCODE_SERVER_PASSWORD' || key === 'OPENCODE_PASSWORD') continue;
    env[key] = value;
  }
  return env;
};

/**
 * `opencode service start` reuses a healthy compatible service or spawns a
 * detached one, then exits once it is ready. Normal recovery does not replace
 * a healthy service; explicit upgrades use `service restart` with the target.
 */
export const startSharedOpenCodeService = ({
  binary,
  args = [],
  env,
  spawnImpl = spawn,
  timeoutMs = SERVICE_START_TIMEOUT_MS,
  replace = false,
}) => new Promise((resolve, reject) => {
  const action = replace ? 'restart' : 'start';
  const child = spawnImpl(binary, [...args, 'service', action], {
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  let settled = false;
  const finish = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) reject(error);
    else resolve();
  };
  const timer = setTimeout(() => {
    try {
      child.kill('SIGTERM');
    } catch {
    }
    finish(new Error(`Timed out waiting for \`opencode service ${action}\``));
  }, timeoutMs);
  child.stderr?.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-2000);
  });
  child.once('error', (error) => finish(error));
  child.once('exit', (code) => {
    if (code === 0) {
      finish(null);
      return;
    }
    const detail = stderr.trim();
    finish(new Error(`\`opencode service ${action}\` exited with code ${code}${detail ? `: ${detail}` : ''}`));
  });
});

export const isProcessAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
};

export const createSharedOpenCodeService = ({
  envLike = process.env,
  fsLike = fs,
  spawnImpl = spawn,
} = {}) => {
  const file = resolveSharedServiceRegistrationPath(envLike);
  return {
    registrationFile: file,
    buildStartEnv: buildSharedServiceStartEnv,
    start: ({ binary, args, env, replace }) => startSharedOpenCodeService({ binary, args, env, replace, spawnImpl }),
    readRegistration: () => readSharedServiceRegistration({ file, fsLike }),
  };
};
