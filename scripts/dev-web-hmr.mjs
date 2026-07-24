#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const useDetachedChildren = process.platform === 'darwin';
const webRoot = path.join(repoRoot, 'packages/web');

function run(label, command, args, env = {}, options = {}) {
  return spawn(command, args, {
    cwd: options.cwd || repoRoot,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    detached: useDetachedChildren,
  }).on('error', (error) => {
    console.error(`[dev:web:hmr] Failed to start ${label}:`, error);
  });
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }

    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve();
    }, timeoutMs);

    child.once('exit', onExit);
  });
}

function signalChild(child, signal) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  try {
    if (useDetachedChildren && process.platform !== 'win32') {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
  }

  try {
    child.kill(signal);
  } catch {
  }
}

async function stopChildTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  signalChild(child, 'SIGINT');
  await waitForExit(child, 2500);

  if (child.exitCode === null && child.signalCode === null) {
    signalChild(child, 'SIGTERM');
    await waitForExit(child, 2500);
  }

  if (child.exitCode === null && child.signalCode === null) {
    signalChild(child, 'SIGKILL');
    await waitForExit(child, 1000);
  }
}

const uiPort = process.env.OPENCHAMBER_HMR_UI_PORT || '5180';
const backendPort = process.env.OPENCHAMBER_HMR_API_PORT || '3902';
const hmrHost = process.env.OPENCHAMBER_HMR_HOST || '127.0.0.1';
// Keep the HMR session index separate from desktop and normal CLI runtimes.
// Settings and authentication continue using the normal development data dir.
const hmrSessionIndexDir = path.resolve(
  process.env.OPENCHAMBER_HMR_DATA_DIR || path.join(repoRoot, 'data', 'hmr'),
);
const hmrSessionIndexDbPath = path.join(hmrSessionIndexDir, 'session-index.sqlite');

function getLanAddresses() {
  const addresses = [];

  for (const networkAddresses of Object.values(os.networkInterfaces())) {
    for (const address of networkAddresses || []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      addresses.push(address.address);
    }
  }

  return addresses;
}

/**
 * Wipe Vite's prebundle cache only when explicitly requested.
 *
 * Why this is NOT the default: every cold start with cache wipe + `vite --force`
 * mints a new optimized-deps browserHash. Open browser tabs still request the
 * previous `chunk-*.js?v=<oldHash>` URLs, Vite answers 504 Outdated Optimize Dep,
 * and dynamic imports (`@openchamber/ui/main`, `renderMobileApp`) fail → white
 * screen. Keeping the cache across restarts is the stable path; force rebuild
 * is opt-in via OPENCHAMBER_VITE_FORCE=1.
 */
function clearViteCache() {
  const cacheDirs = [
    path.join(webRoot, 'node_modules/.vite'),
    path.join(webRoot, 'node_modules/.vite-temp'),
  ];

  for (const cacheDir of cacheDirs) {
    if (!existsSync(cacheDir)) continue;
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

const forceViteOptimize =
  process.env.OPENCHAMBER_VITE_FORCE === '1'
  || process.env.OPENCHAMBER_VITE_FORCE === 'true';

if (forceViteOptimize) {
  console.log('[dev:web:hmr] OPENCHAMBER_VITE_FORCE=1 — clearing Vite dep cache and re-optimizing');
  clearViteCache();
}

mkdirSync(hmrSessionIndexDir, { recursive: true });

const api = run('api', 'bun', ['run', '--cwd', 'packages/web', 'dev:server:watch'], {
  OPENCHAMBER_PORT: backendPort,
  OPENCHAMBER_SESSION_INDEX_DB_PATH: hmrSessionIndexDbPath,
});

const viteArgs = ['x', 'vite', '--host', hmrHost, '--port', uiPort, '--strictPort'];
if (forceViteOptimize) {
  viteArgs.splice(2, 0, '--force');
}

const vite = run(
  'vite',
  'bun',
  viteArgs,
  {
    OPENCHAMBER_PORT: backendPort,
    OPENCHAMBER_DISABLE_PWA_DEV: '1',
  },
  { cwd: webRoot },
);

console.log(`[dev:web:hmr] UI with HMR: http://127.0.0.1:${uiPort}`);
if (hmrHost === '0.0.0.0' || hmrHost === '::') {
  const lanAddresses = getLanAddresses();
  if (lanAddresses.length > 0) {
    for (const address of lanAddresses) {
      console.log(`[dev:web:hmr] LAN/mobile UI: http://${address}:${uiPort}`);
    }
  } else {
    console.log('[dev:web:hmr] LAN/mobile UI: no LAN IPv4 address found');
  }
}
console.log(`[dev:web:hmr] API: http://127.0.0.1:${backendPort}`);
console.log(`[dev:web:hmr] Session index: ${hmrSessionIndexDbPath}`);
console.log('[dev:web:hmr] IMPORTANT: open UI URL above for HMR; backend URL has no HMR');

let shuttingDown = false;

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.all([stopChildTree(api), stopChildTree(vite)]);
  process.exit(exitCode);
}

function onChildExit(label) {
  return (code, signal) => {
    if (shuttingDown) return;

    if (code !== 0 || signal) {
      console.error(`[dev:web:hmr] ${label} exited unexpectedly (code=${code ?? 'null'} signal=${signal ?? 'none'})`);
      shutdown(typeof code === 'number' ? code : 1).catch(() => process.exit(1));
      return;
    }

    shutdown(0).catch(() => process.exit(1));
  };
}

api.on('exit', onChildExit('api'));
vite.on('exit', onChildExit('vite'));

process.on('SIGINT', () => {
  shutdown(130).catch(() => process.exit(130));
});
process.on('SIGTERM', () => {
  shutdown(143).catch(() => process.exit(143));
});
process.on('SIGHUP', () => {
  shutdown(129).catch(() => process.exit(129));
});
