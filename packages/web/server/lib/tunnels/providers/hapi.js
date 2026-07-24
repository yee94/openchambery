import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

import { findExecutableOnPath } from '../executable-search.js';
import {
  TUNNEL_INTENT_EPHEMERAL_PUBLIC,
  TUNNEL_MODE_QUICK,
  TUNNEL_PROVIDER_HAPI,
  TunnelServiceError,
} from '../types.js';

const START_TIMEOUT_MS = 30_000;
const DEFAULT_AUTH_KEY = 'hapi';

export const hapiTunnelProviderCapabilities = {
  provider: TUNNEL_PROVIDER_HAPI,
  defaults: {
    mode: TUNNEL_MODE_QUICK,
    optionDefaults: {},
  },
  modes: [
    {
      key: TUNNEL_MODE_QUICK,
      label: 'HAPI Tunnel',
      intent: TUNNEL_INTENT_EPHEMERAL_PUBLIC,
      requires: ['hostname'],
      supports: ['sessionTTL'],
      stability: 'beta',
    },
  ],
};

const isExecutableFile = (candidate, platform = process.platform) => {
  if (!candidate) return false;
  try {
    const stats = fs.statSync(candidate);
    if (!stats.isFile()) return false;
    if (platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const hapiRuntimeCandidates = ({ home = os.homedir(), platform = process.platform } = {}) => {
  const runtimeRoot = path.join(home, '.hapi', 'runtime');
  let versions = [];
  try {
    versions = fs.readdirSync(runtimeRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  } catch {
    return [];
  }
  const binaryName = platform === 'win32' ? 'tunwg.exe' : 'tunwg';
  return versions.map((version) => path.join(runtimeRoot, version, 'tools', 'tunwg', binaryName));
};

export const resolveTunwgBinary = ({ env = process.env, platform = process.platform, home = os.homedir() } = {}) => {
  const explicit = [
    env.OPENCHAMBER_TUNWG_PATH,
    env.HAPI_TUNWG_PATH,
  ].find((value) => typeof value === 'string' && value.trim().length > 0);
  if (explicit && isExecutableFile(explicit.trim(), platform)) return explicit.trim();

  const onPath = findExecutableOnPath(platform === 'win32' ? 'tunwg' : 'tunwg', { env, platform });
  if (onPath) return onPath;

  return hapiRuntimeCandidates({ home, platform }).find((candidate) => isExecutableFile(candidate, platform)) ?? null;
};

const startTunwg = async ({ binaryPath, originUrl, apiDomain, authKey, keyPath, forceRelay, baseEnv }) => {
  await fs.promises.mkdir(keyPath, { recursive: true, mode: 0o700 });
  const env = {
    ...baseEnv,
    TUNWG_API: apiDomain,
    TUNWG_AUTH: authKey || DEFAULT_AUTH_KEY,
    TUNWG_PATH: keyPath,
    ...(forceRelay ? { TUNWG_RELAY: 'true' } : {}),
  };
  const child = spawn(binaryPath, ['--json', `--forward=${originUrl}`], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let publicUrl = null;
  let stdoutBuffer = '';
  let stderrBuffer = '';
  let settled = false;

  const controller = {
    mode: TUNNEL_MODE_QUICK,
    apiDomain,
    getPublicUrl: () => publicUrl,
    stop: () => {
      if (!child.killed) child.kill();
    },
  };

  return await new Promise((resolve, reject) => {
    let timeout = null;
    const finishError = (message) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (!child.killed) child.kill();
      reject(new TunnelServiceError('startup_failed', message));
    };

    const consumeLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const event = JSON.parse(trimmed);
        if (event?.event === 'ready' && typeof event.url === 'string' && event.url.trim()) {
          publicUrl = event.url.trim().replace(/\/+$/, '');
          if (!settled) {
            settled = true;
            if (timeout) clearTimeout(timeout);
            resolve(controller);
          }
        }
      } catch {
        // tunwg may emit diagnostics alongside JSON events.
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) consumeLine(line);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderrBuffer = `${stderrBuffer}${chunk}`.slice(-4096);
    });
    child.once('error', (error) => finishError(error?.message || 'Failed to start tunwg'));
    child.once('exit', (code) => {
      if (!settled) {
        const detail = stderrBuffer.trim().split('\n').filter(Boolean).at(-1);
        finishError(detail || `tunwg exited with code ${code ?? 'unknown'}`);
      }
    });

    timeout = setTimeout(() => finishError('Timed out waiting for the HAPI tunnel URL'), START_TIMEOUT_MS);
  });
};

export function createHapiTunnelProvider({ dataDir, env = process.env } = {}) {
  const providerRoot = path.join(dataDir || path.join(os.homedir(), '.local', 'share', 'openchamber'), 'hapi-tunnel');
  const keyPath = path.join(providerRoot, 'tunwg');
  const configPath = path.join(providerRoot, 'config.json');

  const readPersistedHostname = async () => {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
      return typeof parsed?.hostname === 'string' && parsed.hostname.trim()
        ? parsed.hostname.trim().toLowerCase()
        : null;
    } catch {
      return null;
    }
  };

  const persistHostname = async (hostname) => {
    await fs.promises.mkdir(providerRoot, { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(configPath, JSON.stringify({ hostname }, null, 2), { mode: 0o600 });
  };

  return {
    id: TUNNEL_PROVIDER_HAPI,
    capabilities: hapiTunnelProviderCapabilities,
    checkAvailability: async () => {
      const binaryPath = resolveTunwgBinary({ env });
      return binaryPath
        ? { available: true, path: binaryPath, dependency: 'tunwg', message: null }
        : {
            available: false,
            dependency: 'tunwg',
            message: 'tunwg was not found. Install HAPI or set OPENCHAMBER_TUNWG_PATH.',
          };
    },
    start: async (request, context = {}) => {
      if (request.mode !== TUNNEL_MODE_QUICK) {
        throw new TunnelServiceError('mode_unsupported', `HAPI only supports '${TUNNEL_MODE_QUICK}' mode`);
      }
      if (!request.hostname) {
        throw new TunnelServiceError('validation_error', 'HAPI gateway hostname is required');
      }
      if (!context.originUrl) {
        throw new TunnelServiceError('startup_failed', 'OpenChamber local port is unavailable');
      }
      const binaryPath = resolveTunwgBinary({ env });
      if (!binaryPath) {
        throw new TunnelServiceError('missing_dependency', 'tunwg was not found. Install HAPI or set OPENCHAMBER_TUNWG_PATH.');
      }
      const controller = await startTunwg({
        binaryPath,
        originUrl: context.originUrl,
        apiDomain: request.hostname,
        authKey: env.OPENCHAMBER_HAPI_RELAY_AUTH || env.HAPI_RELAY_AUTH || DEFAULT_AUTH_KEY,
        keyPath,
        forceRelay: env.OPENCHAMBER_HAPI_FORCE_TCP === 'true'
          || env.OPENCHAMBER_HAPI_FORCE_TCP === '1'
          || env.HAPI_RELAY_FORCE_TCP === 'true'
          || env.HAPI_RELAY_FORCE_TCP === '1',
        baseEnv: env,
      });
      await persistHostname(request.hostname);
      return controller;
    },
    stop: (controller) => controller?.stop?.(),
    resolvePublicUrl: (controller) => controller?.getPublicUrl?.() ?? null,
    matchesRequest: (controller, request) => controller?.apiDomain === request.hostname,
    getMetadata: () => ({ channel: 'hapi' }),
    readPersistedHostname,
  };
}
