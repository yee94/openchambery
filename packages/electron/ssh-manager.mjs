import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  OPENCODE_AGENTS_ROOT_PROBE_MARKER,
  OPENCODE_AGENTS_SYNC_BACKUP_DIR,
  OPENCODE_AUTH_FILE_PROBE_MARKER,
  OPENCODE_AUTH_SYNC_BACKUP_DIR,
  OPENCODE_CONFIG_SYNC_ALLOWLIST,
  OPENCODE_CONFIG_SYNC_BACKUP_DIR,
  SYNC_DIRECTION_PULL,
  SYNC_DIRECTION_PUSH,
  applyConfigSyncPlan,
  assertTargetCapability,
  buildRemoteAgentsTarScript,
  buildRemoteAuthTarScript,
  buildRemoteConfigTarScript,
  buildRemoteSyncFinalizeScript,
  buildRemoteSyncInventoryScript,
  buildRemoteSyncPrepareScript as buildRemoteSyncPrepareScriptShared,
  buildRemoteSyncProbeScript,
  createSshSyncTarget,
  extractTarGzBuffer,
  finalizeLocalSyncDestination,
  normalizeSyncSelections,
  planOpenCodeConfigSync,
  planOpenCodeConfigSyncFromInventory,
  prepareLocalSyncDestination,
  probePathsForPlan,
  shellQuote,
} from '@openchambery/web/server/lib/config-sync/index.js';

import { createSettingsStore } from './settings-store.mjs';
import {
  createSyncRunStore,
  summarizeSyncPlan,
  syncTargetIdForSshInstance,
} from './sync-run-store.mjs';

export {
  OPENCODE_CONFIG_SYNC_ALLOWLIST,
  OPENCODE_CONFIG_SYNC_BACKUP_DIR,
  OPENCODE_AGENTS_SYNC_BACKUP_DIR,
  OPENCODE_AUTH_SYNC_BACKUP_DIR,
  OPENCODE_AUTH_FILE_PROBE_MARKER,
  planOpenCodeConfigSync,
  buildRemoteSyncProbeScript,
};

/**
 * Desktop re-export: prepare scripts require syncRunId for generational backups.
 * Tests that omit options get a stable fixture id so legacy call shapes still work.
 * @param {object} plan
 * @param {{ syncRunId?: string, generations?: number }} [options]
 */
export const buildRemoteSyncPrepareScript = (plan, options = {}) => buildRemoteSyncPrepareScriptShared(plan, {
  syncRunId: options.syncRunId || 'test-sync-run',
  ...(Number.isFinite(options.generations) ? { generations: options.generations } : {}),
});

const OPENCHAMBER_NPM_PACKAGE = '@openchambery/web';
const OPENCODE_NPM_PACKAGE = 'opencode-ai';
export const REMOTE_NODE_MIN_MAJOR = 22;
const REMOTE_NODE_CANDIDATE_GLOBS = [
  '/codev/opt/nodejs/*/bin/node',
  '/opt/codev/nodejs/*/bin/node',
  '"$HOME"/.nvm/versions/node/*/bin/node',
  '"$HOME"/.fnm/node-versions/*/installation/bin/node',
  '"$HOME"/.local/share/fnm/node-versions/*/installation/bin/node',
  '"$HOME"/.asdf/installs/nodejs/*/bin/node',
  '"$HOME"/.local/share/mise/installs/node/*/bin/node',
  '"$HOME"/.volta/bin/node',
  '/usr/local/n/versions/node/*/bin/node',
];
const LOCAL_HOST_ID = 'local';
// This desktop starts the managed remote, so the operator token is the same
// trusted kind as the in-process local shell. A regular 'desktop' token cannot
// create pairing sessions or additional clients (403: Client tokens cannot
// create remote clients).
const SSH_DESKTOP_CLIENT_KIND = 'desktop-local';
const SSH_DESKTOP_CLIENT_DEDUPE_KEY = 'desktop-local';
const SSH_DESKTOP_CLIENT_LABEL = 'OpenChamber Desktop SSH';
const DEFAULT_CONNECTION_TIMEOUT_SEC = 60;
const DEFAULT_LOCAL_BIND_HOST = '127.0.0.1';
const DEFAULT_CONTROL_PERSIST_SEC = 300;
const DEFAULT_READY_TIMEOUT_SEC = 30;
const DEFAULT_RECONNECT_MAX_ATTEMPTS = 5;
const MAX_LOG_LINES_PER_INSTANCE = 1200;

const MONITOR_INITIAL_POLL_MS = 2000;
const MONITOR_STEADY_POLL_MS = 10000;
const MONITOR_STABILIZE_TICKS = 5;
const SSH_STATUS_EVENT = 'openchamber:ssh-instance-status';
const WINDOWS_HIDDEN_SPAWN_OPTIONS = process.platform === 'win32' ? { windowsHide: true } : {};

const nowMillis = () => Date.now();

/** One-time UI password for an SSH-started remote OpenChamber. Memory-only. */
export const createEphemeralUiPassword = () => crypto.randomBytes(24).toString('base64url');

export const buildManagedServeEnvPrefix = (uiPassword) => {
  const password = typeof uiPassword === 'string' ? uiPassword.trim() : '';
  if (!password) {
    throw new Error('Managed SSH OpenChamber requires a UI password');
  }
  return `OPENCHAMBER_RUNTIME=ssh-remote OPENCHAMBER_UI_PASSWORD=${shellQuote(password)}`;
};

export const MANAGED_SSH_BOOTSTRAP_ERROR_CODES = [
  'nodeRuntimeMissing',
  'packageManagerMissing',
  'nativeBinding',
  'openchamberCliMissing',
  'openchamberRegistry',
  'openchamberInstall',
  'openchamberCliIncompatible',
  'opencodeInstall',
  'serverStart',
  'sshAuth',
  'sshUnreachable',
  'timeout',
  'unknown',
];

/** `--relay-host` with no value uses the remote's default/stored URL. */
export const buildRelayHostFlag = (instance) => {
  const candidates = [
    instance?.relayUrl,
    instance?.remoteOpenchamber?.relayUrl,
  ];
  for (const candidate of candidates) {
    const url = typeof candidate === 'string' ? candidate.trim() : '';
    if (!url) continue;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') continue;
      if (parsed.username || parsed.password) continue;
      return `--relay-host ${shellQuote(url)}`;
    } catch {
      // ignore invalid stored URL; fall through to flag-only
    }
  }
  return '--relay-host';
};

/** Managed remotes host private relay unless the instance explicitly opts out. */
export const instanceWantsRelayHost = (instance) => instance?.remoteOpenchamber?.relayHost !== false;

/** Managed remotes must be ssh-remote (or a leftover desktop) to host private relay. */
export const remoteRuntimeCanHostRelay = (info) => {
  const runtime = typeof info?.runtime === 'string' ? info.runtime.trim() : '';
  return runtime === 'ssh-remote' || runtime === 'desktop';
};

/** Public relay descriptor from `/api/openchamber/relay/status` (no private key). */
export const parseRelayDescriptorFromStatus = (payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (payload.hostAllowed !== true) return null;
  const relayUrl = typeof payload.relayUrl === 'string' ? payload.relayUrl.trim() : '';
  const serverId = typeof payload.serverId === 'string' ? payload.serverId.trim() : '';
  const jwk = payload.hostEncPubJwk;
  if (!relayUrl || !serverId || !jwk || typeof jwk !== 'object' || Array.isArray(jwk)) return null;
  if (typeof jwk.kty !== 'string' || typeof jwk.crv !== 'string' || typeof jwk.x !== 'string') return null;
  try {
    const parsed = new URL(relayUrl);
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return null;
    if (parsed.username || parsed.password) return null;
  } catch {
    return null;
  }
  return { relayUrl, serverId, hostEncPubJwk: jwk };
};

/** Published CLIs before SSH relay-host do not list `--relay-host` in help. */
export const remoteHelpMentionsRelayHost = (raw) => /--relay-host\b/.test(String(raw || ''));

/**
 * Exact remote command managed SSH uses to start OpenChamber.
 * Default instances include `--relay-host` when the remote CLI advertises it;
 * `relayHost: false` or an older CLI omits it.
 * @param {{ relayHostSupported?: boolean }} [options]
 */
export const buildManagedServeCommand = (instance, desiredPort, uiPassword, options = {}) => {
  const envPrefix = buildManagedServeEnvPrefix(uiPassword);
  const relayHostSupported = options.relayHostSupported !== false;
  const relayHostFlag = instanceWantsRelayHost(instance) && relayHostSupported
    ? buildRelayHostFlag(instance)
    : '';
  return [
    envPrefix,
    'openchamber serve --hostname 127.0.0.1 --port',
    String(desiredPort),
    relayHostFlag,
  ].filter(Boolean).join(' ');
};

/**
 * Classify a managed SSH bootstrap failure so the desktop client can show
 * actionable guidance instead of a raw npm/gyp dump.
 * @param {unknown} raw
 * @returns {(typeof MANAGED_SSH_BOOTSTRAP_ERROR_CODES)[number]}
 */
export const classifyManagedSshBootstrapError = (raw) => {
  const text = String(raw || '');
  if (/requires Node\.js \d+|no supported Node runtime/i.test(text)) return 'nodeRuntimeMissing';
  if (/neither bun nor npm/i.test(text)) return 'packageManagerMissing';
  if (/better-sqlite3|node_gyp_bins|gyp ERR|failed to prepare better-sqlite3/i.test(text)) return 'nativeBinding';
  if (/OpenChamber installation completed but the executable is unavailable/i.test(text)) {
    return 'openchamberCliMissing';
  }
  if (/could not reach the npm registry|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|CERT_HAS_EXPIRED|UNABLE_TO_GET_ISSUER_CERT|self-signed certificate|registry\.npmjs|npm error code E404|npm ERR! code E404|getaddrinfo/i.test(text)) {
    return 'openchamberRegistry';
  }
  if (/Failed to install OpenChamber/i.test(text)) {
    return 'openchamberInstall';
  }
  if (/Unknown option:\s*--relay-host|does not advertise --relay-host|does not support --relay-host/i.test(text)) {
    return 'openchamberCliIncompatible';
  }
  if (/Unknown option:/i.test(text)) return 'openchamberCliIncompatible';
  if (/Failed to install OpenCode|OpenCode CLI/i.test(text)) return 'opencodeInstall';
  if (/failed to become reachable|Managed OpenChamber server failed/i.test(text)) return 'serverStart';
  if (/Permission denied|Authentication failed|publickey|keyboard-interactive/i.test(text)) return 'sshAuth';
  if (/Could not resolve hostname|Connection refused|Connection timed out|ControlMaster connection timed out|SSH master process exited|Network is unreachable/i.test(text)) {
    return 'sshUnreachable';
  }
  if (/Timed out waiting for SSH|Timed out waiting for forwarded/i.test(text)) return 'timeout';
  return 'unknown';
};

const SHORT_BOOTSTRAP_ERROR_DETAIL = {
  nodeRuntimeMissing: 'Managed SSH remote requires Node.js 22+; no supported Node runtime was found on the remote host',
  packageManagerMissing: 'Remote host has neither bun nor npm available to install OpenChamber',
  nativeBinding: 'failed to prepare better-sqlite3 for the selected remote Node runtime',
  openchamberCliMissing: 'OpenChamber installation completed but the executable is unavailable',
  openchamberRegistry: 'Failed to install OpenChamber because the remote could not reach the npm registry',
  openchamberInstall: 'Failed to install OpenChamber on remote host',
  openchamberCliIncompatible: 'Remote OpenChamber CLI does not support --relay-host',
  opencodeInstall: 'Failed to install OpenCode CLI on remote host',
  serverStart: 'Managed OpenChamber server failed to become reachable',
  sshAuth: 'SSH authentication failed',
  sshUnreachable: 'Could not reach the SSH host',
  timeout: 'Timed out waiting for SSH connection',
};

/**
 * Keep status.detail short enough for the desktop UI. Full stderr stays in logs.
 * @param {unknown} raw
 */
export const summarizeManagedSshBootstrapError = (raw) => {
  const text = String(raw || '').trim();
  const code = classifyManagedSshBootstrapError(text);
  if (code !== 'unknown' && SHORT_BOOTSTRAP_ERROR_DETAIL[code]) {
    return SHORT_BOOTSTRAP_ERROR_DETAIL[code];
  }
  const firstLine = text.split(/\r?\n/).find((line) => line.trim()) || 'Remote instance failed to start';
  return firstLine.length > 280 ? `${firstLine.slice(0, 277)}...` : firstLine;
};

/**
 * Parse a remote Node version for managed SSH selection.
 * Odd majors (23, 25) are accepted only when no even LTS (22, 24, …) exists.
 * @param {unknown} raw
 * @returns {{ version: string, major: number, even: boolean } | null}
 */
export const parseRemoteManagedNodeVersion = (raw) => {
  const version = String(raw || '').trim().replace(/^v/i, '');
  const major = Number.parseInt(version.split('.')[0], 10);
  if (!Number.isInteger(major) || major < REMOTE_NODE_MIN_MAJOR) return null;
  return { version, major, even: major % 2 === 0 };
};

const compareRemoteNodeSemver = (left, right) => {
  const leftParts = String(left).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = String(right).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (rightParts[index] || 0) - (leftParts[index] || 0);
    if (delta !== 0) return delta;
  }
  return 0;
};

/**
 * Whether `next` should replace `current` as the managed SSH Node runtime.
 * Policy: even LTS major beats odd; sibling `npm` beats a lone `node`; then highest semver.
 * @param {{ even: boolean, hasNpm?: boolean, version: string } | null} current
 * @param {{ even: boolean, hasNpm?: boolean, version: string } | null} next
 */
export const isPreferredRemoteManagedNode = (current, next) => {
  if (!next) return false;
  if (!current) return true;
  if (next.even !== current.even) return next.even;
  if (Boolean(next.hasNpm) !== Boolean(current.hasNpm)) return Boolean(next.hasNpm);
  return compareRemoteNodeSemver(current.version, next.version) > 0;
};

/**
 * @param {Array<{ bin?: string, version: string, hasNpm?: boolean }>} candidates
 */
export const selectPreferredRemoteManagedNode = (candidates) => {
  let best = null;
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const parsed = parseRemoteManagedNodeVersion(candidate?.version);
    if (!parsed) continue;
    const next = { ...candidate, ...parsed };
    if (isPreferredRemoteManagedNode(best, next)) best = next;
  }
  return best;
};

/**
 * Shell helpers that pick one Node for every managed SSH command.
 * Kept session-scoped: never edits remote shell startup files.
 */
export const buildRemoteManagedNodeSelectionFunctions = () => `
prepend_path() { [ -d "$1" ] || return 0; case ":$PATH:" in *":$1:"*) ;; *) PATH="$1:$PATH" ;; esac; }
best_node_bin=""
best_node_version=""
best_node_even=""
best_node_has_npm=""
consider_node() {
  candidate="$1"
  [ -x "$candidate" ] || return 0
  version="$("$candidate" -p 'process.versions.node' 2>/dev/null || true)"
  major="\${version%%.*}"
  case "$major" in ''|*[!0-9]*) return 0 ;; esac
  [ "$major" -ge ${REMOTE_NODE_MIN_MAJOR} ] || return 0
  even=0
  [ "$((major % 2))" -eq 0 ] && even=1
  has_npm=0
  [ -x "$(dirname "$candidate")/npm" ] && has_npm=1
  if [ -z "$best_node_version" ]; then
    best_node_bin="$candidate"
    best_node_version="$version"
    best_node_even="$even"
    best_node_has_npm="$has_npm"
    return 0
  fi
  if [ "$even" -eq 1 ] && [ "$best_node_even" -eq 0 ]; then
    best_node_bin="$candidate"
    best_node_version="$version"
    best_node_even="$even"
    best_node_has_npm="$has_npm"
    return 0
  fi
  if [ "$even" -eq 0 ] && [ "$best_node_even" -eq 1 ]; then
    return 0
  fi
  if [ "$has_npm" -eq 1 ] && [ "$best_node_has_npm" -eq 0 ]; then
    best_node_bin="$candidate"
    best_node_version="$version"
    best_node_even="$even"
    best_node_has_npm="$has_npm"
    return 0
  fi
  if [ "$has_npm" -eq 0 ] && [ "$best_node_has_npm" -eq 1 ]; then
    return 0
  fi
  if [ "$(printf '%s\\n%s\\n' "$best_node_version" "$version" | sort -V | tail -n 1)" = "$version" ] \\
    && [ "$version" != "$best_node_version" ]; then
    best_node_bin="$candidate"
    best_node_version="$version"
    best_node_even="$even"
    best_node_has_npm="$has_npm"
  fi
}
`;

/**
 * Sets a PATH for one remote command only. It never edits shell startup files.
 * A fresh DevCloud host can ship several Node versions while its login PATH
 * still selects Node 18; prefer the highest even LTS (22/24) with a sibling npm.
 */
export const buildRemoteManagedRuntimePrefix = () => `
${buildRemoteManagedNodeSelectionFunctions()}
prepend_path "$HOME/.bun/bin"
prepend_path "$HOME/.opencode/bin"
prepend_path "$HOME/.local/bin"
prepend_path "$HOME/.npm/node_modules/bin"
if command -v node >/dev/null 2>&1; then consider_node "$(command -v node)"; fi
for candidate in ${REMOTE_NODE_CANDIDATE_GLOBS.join(' ')}; do consider_node "$candidate"; done
if [ -n "$best_node_bin" ]; then prepend_path "$(dirname "$best_node_bin")"; fi
if command -v npm >/dev/null 2>&1; then npm_prefix="$(npm prefix -g 2>/dev/null || true)"; [ -n "$npm_prefix" ] && prepend_path "$npm_prefix/bin"; fi
export PATH
`;

/**
 * Repair better-sqlite3 for the Node already selected on PATH.
 * Resolve the package via Node (nested or bun-hoisted), probe first, then
 * clean + rebuild, retry once, then npm reinstall.
 * @param {{ packageName?: string, version?: string }} [options]
 */
export const buildRemoteNativeBindingRepairScript = (options = {}) => {
  const packageName = typeof options.packageName === 'string' ? options.packageName.trim() : '';
  const version = typeof options.version === 'string' ? options.version.trim() : '';
  const reinstallSpec = packageName && version ? `${packageName}@${version}` : '';
  const quotedSpec = reinstallSpec ? shellQuote(reinstallSpec) : '';
  return `
openchamber_bin="$(command -v openchamber)"
if [ -z "$openchamber_bin" ]; then
  echo "openchamber CLI is not on PATH after managed install" >&2
  exit 1
fi

locate_openchamber() {
  openchamber_bin="$(command -v openchamber)"
  [ -n "$openchamber_bin" ] || return 1
  openchamber_entry="$(node -e "process.stdout.write(require('fs').realpathSync(process.argv[1]))" "$openchamber_bin")"
  openchamber_root="$(CDPATH= cd -- "$(dirname "$openchamber_entry")/.." && pwd)"
}

resolve_sqlite_dir() {
  sqlite_dir="$(cd "$openchamber_root" && node -e "try { process.stdout.write(require('path').dirname(require.resolve('better-sqlite3/package.json'))) } catch { process.exit(1) }" 2>/dev/null || true)"
  if [ -z "$sqlite_dir" ] || [ ! -d "$sqlite_dir" ]; then
    sqlite_dir="$openchamber_root/node_modules/better-sqlite3"
  fi
}

locate_openchamber
resolve_sqlite_dir

probe_sqlite() {
  (cd "$openchamber_root" && node -e "const Database=require('better-sqlite3'); const db=new Database(':memory:'); db.close()") >/dev/null 2>&1
}

prepare_native_toolchain() {
  if [ -z "$PYTHON" ]; then
    for py in /usr/bin/python3.13 /usr/bin/python3.12 /usr/bin/python3.11 /usr/bin/python3.10 /usr/bin/python3.9 /usr/bin/python3.8 /usr/bin/python3 /usr/local/bin/python3; do
      if [ -x "$py" ]; then export PYTHON="$py"; break; fi
    done
  fi
  if [ -z "$PYTHON" ] && command -v python3 >/dev/null 2>&1; then
    export PYTHON="$(command -v python3)"
  fi
  if [ -n "$PYTHON" ]; then export npm_config_python="$PYTHON"; fi
  for toolset in /opt/rh/gcc-toolset-14 /opt/rh/gcc-toolset-13 /opt/rh/gcc-toolset-12; do
    if [ -x "$toolset/root/usr/bin/gcc" ] && [ -x "$toolset/root/usr/bin/g++" ]; then
      export CC="$toolset/root/usr/bin/gcc"
      export CXX="$toolset/root/usr/bin/g++"
      break
    fi
  done
}

rebuild_sqlite() {
  resolve_sqlite_dir
  [ -d "$sqlite_dir" ] || return 1
  rm -rf "$sqlite_dir/build"
  mkdir -p "$sqlite_dir/build/node_gyp_bins"
  (cd "$sqlite_dir" && npm rebuild --foreground-scripts)
}

if probe_sqlite; then exit 0; fi
if ! command -v npm >/dev/null 2>&1; then
  echo "better-sqlite3 binding is unusable and npm is unavailable to rebuild it" >&2
  exit 1
fi
prepare_native_toolchain
rebuild_sqlite || true
if probe_sqlite; then exit 0; fi
rebuild_sqlite || true
if probe_sqlite; then exit 0; fi
${quotedSpec ? `npm install -g ${quotedSpec} --force || true
locate_openchamber
resolve_sqlite_dir
if probe_sqlite; then exit 0; fi
rebuild_sqlite || true
if probe_sqlite; then exit 0; fi` : ''}
echo "failed to prepare better-sqlite3 for Node $(node -p 'process.versions.node' 2>/dev/null || echo unknown)" >&2
exit 1
`;
};

const hasGlobWildcard = (value) => /[*?]/.test(value);

const expandSshIncludeToken = (token, baseDir) => {
  const trimmed = String(token || '').trim();
  if (!trimmed) return [];

  const expandedHome = trimmed.startsWith('~/')
    ? path.join(os.homedir(), trimmed.slice(2))
    : (trimmed === '~' ? os.homedir() : trimmed);
  const resolved = path.isAbsolute(expandedHome)
    ? expandedHome
    : path.resolve(baseDir, expandedHome);

  if (!hasGlobWildcard(resolved)) {
    return fs.existsSync(resolved) ? [resolved] : [];
  }

  const dir = path.dirname(resolved);
  const namePattern = path.basename(resolved);
  if (hasGlobWildcard(dir) || !fs.existsSync(dir)) {
    return [];
  }

  const matcher = new RegExp(`^${namePattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')}$`);

  try {
    return fs.readdirSync(dir)
      .filter((name) => matcher.test(name))
      .map((name) => path.join(dir, name))
      .filter((candidate) => fs.existsSync(candidate))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
};

export class SyncInProgressError extends Error {
  constructor(targetId, syncRunId) {
    super(`Config sync already in progress for ${targetId}`);
    this.name = 'SyncInProgressError';
    this.code = 'sync_in_progress';
    this.targetId = targetId;
    this.syncRunId = typeof syncRunId === 'string' ? syncRunId : undefined;
  }
}

const defaultTrue = () => true;

const sanitizeBindHost = (raw) => {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return DEFAULT_LOCAL_BIND_HOST;
  return ['127.0.0.1', 'localhost', '0.0.0.0'].includes(trimmed) ? trimmed : DEFAULT_LOCAL_BIND_HOST;
};

const splitShellWords = (input) => {
  const tokens = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  const chars = [...String(input)];

  for (let index = 0; index < chars.length; index += 1) {
    const ch = chars[index];
    if (ch === '\\' && !inSingle) {
      index += 1;
      if (index < chars.length) current += chars[index];
      continue;
    }
    if (ch === '\'' && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (/\s/.test(ch) && !inSingle && !inDouble) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }

  if (inSingle || inDouble) {
    throw new Error('Unclosed quote in SSH command');
  }
  if (current) tokens.push(current);
  return tokens;
};

const isDisallowedPrimaryFlag = (token) => {
  return ['-M', '-S', '-O', '-N', '-t', '-T', '-f', '-G', '-W', '-v', '-V', '-q', '-n', '-s', '-e', '-E', '-g'].includes(token);
};

const hasDisallowedOOption = (value) => {
  const lower = String(value).trim().toLowerCase();
  return ['controlmaster', 'controlpath', 'controlpersist', 'batchmode', 'proxycommand'].some((prefix) => lower.startsWith(prefix));
};

/**
 * scp-style user@host:port → { destination, port }. Strict: exactly one colon,
 * right side pure digits, no brackets (IPv6 / [::1]:22 left alone for -p).
 * @param {string} destination
 * @returns {{ destination: string, port: string } | null}
 */
export const splitScpStyleHostPort = (destination) => {
  if (typeof destination !== 'string') return null;
  const value = destination.trim();
  if (!value || value.includes('[') || value.includes(']')) return null;
  const parts = value.split(':');
  if (parts.length !== 2) return null;
  const hostPart = parts[0];
  const portPart = parts[1];
  if (!hostPart || !/^\d+$/.test(portPart)) return null;
  return { destination: hostPart, port: portPart };
};

/** True when args already carry an explicit -p / -P port flag (token or glued). */
export const argsHaveExplicitPortFlag = (args) => {
  if (!Array.isArray(args)) return false;
  for (const token of args) {
    if (typeof token !== 'string') continue;
    if (token === '-p' || token === '-P') return true;
    if ((token.startsWith('-p') || token.startsWith('-P')) && token.length > 2 && /^\d+$/.test(token.slice(2))) {
      return true;
    }
  }
  return false;
};

export const parseSshCommand = (raw) => {
  const tokens = splitShellWords(raw);
  if (tokens.length === 0) {
    throw new Error('SSH command is empty');
  }

  if (tokens[0] === 'ssh') {
    tokens.shift();
  }

  if (tokens.length === 0) {
    throw new Error('SSH command must include destination');
  }

  const allowedFlags = new Set(['-4', '-6', '-A', '-a', '-C', '-K', '-k', '-X', '-x', '-Y', '-y']);
  const allowedWithValues = ['-B', '-b', '-c', '-D', '-F', '-I', '-i', '-J', '-l', '-m', '-o', '-P', '-p', '-R'];

  const args = [];
  let destination = null;
  for (let index = 0; index < tokens.length;) {
    const token = tokens[index];

    if (!token.startsWith('-')) {
      if (destination) {
        throw new Error(`SSH command has unsupported trailing argument: ${token}`);
      }
      destination = token.trim();
      index += 1;
      continue;
    }

    // Flags may appear before or after the destination (e.g. `ssh host -p 22`).
    if (isDisallowedPrimaryFlag(token)) {
      throw new Error(`SSH option ${token} is not allowed`);
    }

    if (allowedFlags.has(token)) {
      args.push(token);
      index += 1;
      continue;
    }

    let matched = false;
    for (const option of allowedWithValues) {
      if (token === option) {
        const value = tokens[index + 1];
        if (!value) {
          throw new Error(`SSH option ${option} requires a value`);
        }
        if (option === '-o' && hasDisallowedOOption(value)) {
          throw new Error(`SSH option -o ${value} is not allowed`);
        }
        args.push(token, value);
        index += 2;
        matched = true;
        break;
      }

      if (token.startsWith(option) && token.length > option.length) {
        const value = token.slice(option.length);
        if (option === '-o' && hasDisallowedOOption(value)) {
          throw new Error(`SSH option -o ${value} is not allowed`);
        }
        args.push(token);
        index += 1;
        matched = true;
        break;
      }
    }

    if (!matched) {
      throw new Error(`Unsupported SSH option: ${token}`);
    }
  }

  if (!destination) {
    throw new Error('SSH command must include destination');
  }

  // OpenSSH does not accept scp-style user@host:port as a destination; rewrite
  // to destination + -p so DNS does not treat "host:port" as a hostname.
  const scpStyle = splitScpStyleHostPort(destination);
  if (scpStyle) {
    if (argsHaveExplicitPortFlag(args)) {
      throw new Error(
        'SSH command cannot combine host:port destination with an explicit -p flag; use one form only (e.g. user@host:36000 or -p 36000 user@host)',
      );
    }
    destination = scpStyle.destination;
    args.push('-p', scpStyle.port);
  }

  return { destination, args };
};

const MASTER_STDERR_TAIL_MAX_CHARS = 500;
const MASTER_STDERR_TAIL_MAX_LINES = 5;

/**
 * Collect a short, UI-safe tail of a child process stderr stream.
 * @param {import('node:child_process').ChildProcess} child
 * @param {{ maxChars?: number, maxLines?: number }} [options]
 */
export const attachProcessStderrTail = (child, options = {}) => {
  const maxChars = Number.isFinite(options.maxChars) ? options.maxChars : MASTER_STDERR_TAIL_MAX_CHARS;
  const maxLines = Number.isFinite(options.maxLines) ? options.maxLines : MASTER_STDERR_TAIL_MAX_LINES;
  let buffer = '';
  const onData = (chunk) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
    // Drop NULs; keep a bounded rolling buffer (2× so the final tail is complete).
    buffer = `${buffer}${text}`.replace(/\0/g, '');
    const keep = Math.max(maxChars * 2, 1024);
    if (buffer.length > keep) buffer = buffer.slice(-keep);
  };
  if (child?.stderr && typeof child.stderr.on === 'function') {
    child.stderr.on('data', onData);
  }
  return {
    getTail: () => {
      const text = buffer.replace(/\s+/g, ' ').trim();
      if (!text) return '';
      const lines = buffer.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const joined = (lines.length > 0 ? lines.slice(-maxLines) : [text]).join(' ').replace(/\s+/g, ' ').trim();
      if (joined.length <= maxChars) return joined;
      return joined.slice(-maxChars);
    },
  };
};

/** @param {string} [stderrTail] */
export const formatMasterExitError = (stderrTail) => {
  const tail = typeof stderrTail === 'string' ? stderrTail.trim() : '';
  return tail
    ? `SSH master process exited before ready: ${tail}`
    : 'SSH master process exited before ready';
};

const runOutput = async (command, args, options = {}) => {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...WINDOWS_HIDDEN_SPAWN_OPTIONS,
      ...options,
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: typeof code === 'number' ? code : -1, stdout, stderr });
    });
  });
};

const buildSshArgs = (parsed, preDestinationArgs = [], remoteCommand = null) => {
  const args = [...parsed.args, ...preDestinationArgs, parsed.destination];
  if (remoteCommand) args.push(remoteCommand);
  return args;
};

const runRemoteCommand = async (parsed, controlPath, script, timeoutSec = DEFAULT_CONNECTION_TIMEOUT_SEC) => {
  const args = buildSshArgs(parsed, [
    '-o', 'ControlMaster=no',
    '-o', `ControlPath=${controlPath}`,
    '-o', `ConnectTimeout=${timeoutSec}`,
    '-T',
  ], `sh -lc ${shellQuote(script)}`);
  const { code, stdout, stderr } = await runOutput('ssh', args);
  if (code !== 0) {
    throw new Error((stderr || stdout || 'Remote command failed').trim());
  }
  return stdout;
};

/**
 * Like runRemoteCommand, but pipes a Buffer to ssh stdin (e.g. tar stream).
 * @param {ReturnType<typeof parseSshCommand>} parsed
 * @param {string} controlPath
 * @param {string} script
 * @param {Buffer} input
 * @param {number} [timeoutSec]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
const runRemoteCommandWithInput = async (parsed, controlPath, script, input, timeoutSec = DEFAULT_CONNECTION_TIMEOUT_SEC) => {
  const args = buildSshArgs(parsed, [
    '-o', 'ControlMaster=no',
    '-o', `ControlPath=${controlPath}`,
    '-o', `ConnectTimeout=${timeoutSec}`,
    '-T',
  ], `sh -lc ${shellQuote(script)}`);

  return await new Promise((resolve, reject) => {
    const child = spawn('ssh', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...WINDOWS_HIDDEN_SPAWN_OPTIONS,
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.stdin?.on('error', (error) => {
      if (error && (error.code === 'EPIPE' || error.errno === 'EPIPE')) return;
      reject(error);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const exitCode = typeof code === 'number' ? code : -1;
      if (exitCode !== 0) {
        reject(new Error((stderr || stdout || 'Remote command failed').trim()));
        return;
      }
      resolve({ code: exitCode, stdout, stderr });
    });

    try {
      child.stdin?.write(input);
      child.stdin?.end();
    } catch (error) {
      if (error && (error.code === 'EPIPE' || error.errno === 'EPIPE')) {
        // Peer closed early; close handler will surface the exit code.
        return;
      }
      reject(error);
    }
  });
};

/**
 * Capture remote command stdout as a Buffer (for pull tar streams).
 * @param {ReturnType<typeof parseSshCommand>} parsed
 * @param {string} controlPath
 * @param {string} script
 * @param {number} [timeoutSec]
 * @returns {Promise<Buffer>}
 */
const runRemoteCommandBinary = async (parsed, controlPath, script, timeoutSec = DEFAULT_CONNECTION_TIMEOUT_SEC) => {
  const args = buildSshArgs(parsed, [
    '-o', 'ControlMaster=no',
    '-o', `ControlPath=${controlPath}`,
    '-o', `ConnectTimeout=${timeoutSec}`,
    '-T',
  ], `sh -lc ${shellQuote(script)}`);

  return await new Promise((resolve, reject) => {
    const child = spawn('ssh', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...WINDOWS_HIDDEN_SPAWN_OPTIONS,
    });
    /** @type {Buffer[]} */
    const chunks = [];
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error((stderr || 'Remote binary command failed').trim()));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
};

const controlMasterOperation = async (parsed, controlPath, op) => {
  return await runOutput('ssh', buildSshArgs(parsed, [
    '-o', 'ControlMaster=no',
    '-o', `ControlPath=${controlPath}`,
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=3',
    '-O', op,
  ]));
};

const isControlMasterAlive = async (parsed, controlPath) => {
  const { code } = await controlMasterOperation(parsed, controlPath, 'check');
  return code === 0;
};

const stopControlMasterBestEffort = async (parsed, controlPath) => {
  try {
    await controlMasterOperation(parsed, controlPath, 'exit');
  } catch {
  }
};

const askpassScriptContent = () => `#!/bin/bash
PROMPT="$1"

if [[ -n "$OPENCHAMBER_SSH_ASKPASS_VALUE" ]]; then
  if [[ "$PROMPT" == *"assword"* || "$PROMPT" == *"passphrase"* ]]; then
    printf '%s\\n' "$OPENCHAMBER_SSH_ASKPASS_VALUE"
    exit 0
  fi
fi

DEFAULT_ANSWER=""
HIDDEN_INPUT="true"

if [[ "$PROMPT" == *"yes/no"* ]]; then
  DEFAULT_ANSWER="yes"
  HIDDEN_INPUT="false"
fi

if command -v osascript >/dev/null 2>&1; then
  /usr/bin/osascript <<'APPLESCRIPT' "$PROMPT" "$DEFAULT_ANSWER" "$HIDDEN_INPUT"
on run argv
  set promptText to item 1 of argv
  set defaultAnswer to item 2 of argv
  set hiddenInput to item 3 of argv

  try
    if hiddenInput is "true" then
      set response to display dialog promptText default answer defaultAnswer with hidden answer buttons {"Cancel", "OK"} default button "OK"
    else
      set response to display dialog promptText default answer defaultAnswer buttons {"Cancel", "OK"} default button "OK"
    end if
    return text returned of response
  on error
    error number -128
  end try
end run
APPLESCRIPT
  exit $?
fi

printf '%s\\n' "$DEFAULT_ANSWER"
`;

const writeAskpassScript = async (scriptPath) => {
  await fsp.writeFile(scriptPath, askpassScriptContent(), { mode: 0o700 });
  await fsp.chmod(scriptPath, 0o700);
};

const randomPortCandidate = (seed) => {
  let hash = 0;
  const source = `${seed}:${Date.now()}`;
  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash << 5) - hash + source.charCodeAt(index)) | 0;
  }
  const base = 20000;
  const span = 30000;
  return base + Math.abs(hash % span);
};

const pickUnusedLocalPort = async () => {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
    server.on('error', reject);
  });
};

const isLocalPortAvailable = async (bindHost, port) => {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, bindHost, () => {
      server.close(() => resolve(true));
    });
  });
};

const isLocalTunnelReachable = async (localPort) => {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: localPort });
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
};

const waitLocalForwardReady = async (localPort) => {
  const deadline = Date.now() + (DEFAULT_READY_TIMEOUT_SEC * 1000);
  let pollMs = 250;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${localPort}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok || response.status === 401) {
        return;
      }
    } catch {
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    pollMs = Math.min(pollMs * 2, 2000);
  }
  throw new Error('Timed out waiting for forwarded OpenChamber health');
};

/**
 * Parse a version token from CLI output (`openchamber --version`, `opencode --version`).
 * Accepts stable and prerelease/build semver so a matching beta is not treated as missing.
 * @param {unknown} raw
 * @returns {string | null}
 */
export const parseVersionToken = (raw) => {
  for (const token of String(raw).split(/\s+/)) {
    let candidate = token.trim().replace(/^v/i, '');
    candidate = candidate.replace(/[,)]+$/g, '');
    if (!candidate) continue;
    const match = candidate.match(/^(\d+(?:\.\d+)+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
    if (!match) continue;
    const numericParts = match[1].split('.');
    if (numericParts.length >= 2 && numericParts.every((part) => /^\d+$/.test(part))) {
      return candidate;
    }
  }
  return null;
};

const parseProbeStatusLine = (line, prefix) => {
  if (!line || !line.startsWith(prefix)) return null;
  const value = Number.parseInt(line.slice(prefix.length).trim(), 10);
  return Number.isFinite(value) ? value : null;
};

const isAuthHttpStatus = (status) => status === 401 || status === 403;
const isLivenessHttpStatus = (status) => (status >= 200 && status <= 299) || isAuthHttpStatus(status);

export class ElectronSshManager {
  constructor(options) {
    this.settingsFilePath = options.settingsFilePath;
    this.settingsStore = options.settingsStore
      || createSettingsStore({ filePath: options.settingsFilePath });
    this.syncRunStore = options.syncRunStore
      || createSyncRunStore({
        resolveDataDir: () => path.dirname(this.settingsStore.resolveFilePath()),
      });
    this.appVersion = options.appVersion;
    this.opencodeCliVersion = options.opencodeCliVersion;
    this.emit = options.emit;
    this.logs = new Map();
    this.statuses = new Map();
    this.sessions = new Map();
    this.monitorTimers = new Map();
    this.reconnectAttempts = new Map();
    this.connectAttempts = new Map();
    this.connecting = new Map();
    /** @type {Map<string, string>} instanceId → ephemeral UI password (process lifetime, never persisted) */
    this.ephemeralUiPasswords = new Map();
    /** @type {Map<string, { syncRunId: string, promise: Promise<unknown> }>} targetId → in-flight sync */
    this.syncInFlight = new Map();
  }

  readSettingsRoot() {
    return this.settingsStore.readRoot();
  }

  /**
   * Serialized settings read-modify-write via the shared process-local chain.
   * @param {(root: Record<string, unknown>) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void} mutator
   */
  async mutateSettingsRoot(mutator) {
    return this.settingsStore.mutate(mutator);
  }

  appendLogWithLevel(id, level, message) {
    const line = `[${nowMillis()}] [${level}] ${message}`;
    const current = this.logs.get(id) || [];
    current.push(line);
    if (current.length > MAX_LOG_LINES_PER_INSTANCE) {
      current.splice(0, current.length - MAX_LOG_LINES_PER_INSTANCE);
    }
    this.logs.set(id, current);
  }

  appendLog(id, message) {
    this.appendLogWithLevel(id, 'INFO', message);
  }

  appendAttemptSeparator(id, connectAttempt, retryAttempt) {
    const scope = retryAttempt > 0 ? `retry ${retryAttempt}` : 'manual';
    this.appendLogWithLevel(id, 'INFO', `---------------- attempt #${connectAttempt} (${scope}) ----------------`);
  }

  statusSnapshotForInstance(id) {
    return this.statuses.get(id) || {
      id,
      phase: 'idle',
      detail: null,
      localUrl: null,
      localPort: null,
      remotePort: null,
      startedByUs: false,
      retryAttempt: 0,
      requiresUserAction: false,
      updatedAtMs: nowMillis(),
    };
  }

  setStatus(id, phase, detail = null, localUrl = null, localPort = null, remotePort = null, startedByUs = false, retryAttempt = 0, requiresUserAction = false) {
    const level = phase === 'error' ? 'ERROR' : (phase === 'degraded' ? 'WARN' : 'INFO');
    this.appendLogWithLevel(
      id,
      level,
      `phase=${JSON.stringify(phase)} detail=${detail || ''} retry=${retryAttempt} requires_user_action=${requiresUserAction}`,
    );

    const errorCode = phase === 'error' ? classifyManagedSshBootstrapError(detail) : null;
    const status = {
      id,
      phase,
      detail,
      localUrl,
      localPort,
      remotePort,
      startedByUs,
      retryAttempt,
      requiresUserAction,
      ...(errorCode ? { errorCode } : {}),
      updatedAtMs: nowMillis(),
    };
    this.statuses.set(id, status);
    this.emit(SSH_STATUS_EVENT, status);
  }

  clearRetryAttempt(id) {
    this.reconnectAttempts.delete(id);
  }

  nextRetryAttempt(id) {
    const next = (this.reconnectAttempts.get(id) || 0) + 1;
    this.reconnectAttempts.set(id, next);
    return next;
  }

  currentRetryAttempt(id) {
    return this.reconnectAttempts.get(id) || 0;
  }

  nextConnectAttempt(id) {
    const next = (this.connectAttempts.get(id) || 0) + 1;
    this.connectAttempts.set(id, next);
    return next;
  }

  logsForInstance(id, limit = 200) {
    const lines = [...(this.logs.get(id) || [])];
    return limit > 0 && lines.length > limit ? lines.slice(-limit) : lines;
  }

  clearLogsForInstance(id) {
    this.logs.delete(id);
  }

  parseSshConfigCandidates(filePath, source, visited = new Set()) {
    const resolvedPath = path.resolve(filePath);
    if (visited.has(resolvedPath) || !fs.existsSync(resolvedPath)) return [];
    visited.add(resolvedPath);

    const content = fs.readFileSync(resolvedPath, 'utf8');
    const candidates = [];
    const baseDir = path.dirname(resolvedPath);
    for (const line of content.split(/\r?\n/)) {
      const trimmed = (line.split('#')[0] || '').trim();
      if (!trimmed) continue;

      if (/^include(?:\s|$)/i.test(trimmed)) {
        const includeExpr = trimmed.replace(/^include\s+/i, '').trim();
        if (!includeExpr) continue;
        let includeTokens = [];
        try {
          includeTokens = splitShellWords(includeExpr);
        } catch {
          includeTokens = includeExpr.split(/\s+/).filter(Boolean);
        }
        for (const includeToken of includeTokens) {
          const includePaths = expandSshIncludeToken(includeToken, baseDir);
          for (const includePath of includePaths) {
            candidates.push(...this.parseSshConfigCandidates(includePath, source, visited));
          }
        }
        continue;
      }

      if (!/^host(?:\s|$)/i.test(trimmed)) continue;
      const rest = trimmed.replace(/^host\s+/i, '').trim();
      if (!rest) continue;
      for (const token of rest.split(/\s+/)) {
        const host = token.trim();
        if (!host || host.startsWith('!') || host === '*') continue;
        candidates.push({
          host,
          pattern: /[*?]/.test(host),
          source,
          sshCommand: `ssh ${host}`,
        });
      }
    }
    return candidates;
  }

  async importHosts() {
    const candidates = [
      ...this.parseSshConfigCandidates(path.join(os.homedir(), '.ssh', 'config'), 'user'),
      ...this.parseSshConfigCandidates('/etc/ssh/ssh_config', 'global'),
    ];
    const seen = new Set();
    return candidates
      .filter((item) => !seen.has(item.host) && seen.add(item.host))
      .sort((left, right) => left.host.localeCompare(right.host));
  }

  readInstances() {
    const root = this.readSettingsRoot();
    return { instances: Array.isArray(root.desktopSshInstances) ? root.desktopSshInstances : [] };
  }

  async setInstances(config) {
    await this.mutateSettingsRoot((root) => {
      const previousSshIds = new Set(
        (Array.isArray(root.desktopSshInstances) ? root.desktopSshInstances : [])
          .map((entry) => String(entry?.id || '').trim())
          .filter((id) => id && id !== LOCAL_HOST_ID)
      );
      const instances = Array.isArray(config?.instances) ? config.instances.map((instance) => this.sanitizeInstance(instance)) : [];
      root.desktopSshInstances = instances;

      const hosts = Array.isArray(root.desktopHosts) ? root.desktopHosts.filter(Boolean) : [];
      const nextIds = new Set(instances.map((instance) => instance.id));

      const filteredHosts = hosts.filter((entry) => {
        const id = String(entry?.id || '').trim();
        return id && id !== LOCAL_HOST_ID && !(previousSshIds.has(id) && !nextIds.has(id));
      });

      for (const instance of instances) {
        const label = instance.nickname?.trim() || instance.sshParsed?.destination || instance.id;
        const existing = filteredHosts.find((entry) => entry?.id === instance.id);
        if (existing) {
          existing.label = label;
          if (!existing.url || !String(existing.url).trim()) {
            existing.url = 'http://127.0.0.1/';
          }
        } else {
          filteredHosts.push({ id: instance.id, label, url: 'http://127.0.0.1/' });
        }
      }

      root.desktopHosts = filteredHosts;
      if (typeof root.desktopDefaultHostId === 'string' && previousSshIds.has(root.desktopDefaultHostId) && !nextIds.has(root.desktopDefaultHostId)) {
        root.desktopDefaultHostId = LOCAL_HOST_ID;
      }
      return root;
    });
  }

  sanitizeStoredSecret(secret) {
    if (!secret || typeof secret !== 'object') return undefined;
    return {
      enabled: Boolean(secret.enabled),
      store: secret.store === 'settings' ? 'settings' : 'never',
      ...(typeof secret.value === 'string' && secret.value.trim() ? { value: secret.value } : {}),
    };
  }

  sanitizeForward(forward) {
    const id = typeof forward?.id === 'string' ? forward.id.trim() : '';
    if (!id) return null;
    const type = forward?.type === 'remote' || forward?.type === 'dynamic' ? forward.type : 'local';
    const normalized = {
      id,
      enabled: forward?.enabled !== false,
      type,
      ...(forward?.localHost ? { localHost: sanitizeBindHost(forward.localHost) } : {}),
      ...(Number.isFinite(forward?.localPort) ? { localPort: Number(forward.localPort) } : {}),
      ...(forward?.remoteHost ? { remoteHost: String(forward.remoteHost).trim() || '127.0.0.1' } : {}),
      ...(Number.isFinite(forward?.remotePort) ? { remotePort: Number(forward.remotePort) } : {}),
    };

    if (type === 'local' || type === 'remote') {
      if (!normalized.localPort || !normalized.remotePort) return null;
      normalized.remoteHost = normalized.remoteHost || '127.0.0.1';
      normalized.localHost = normalized.localHost || '127.0.0.1';
    }
    if (type === 'dynamic' && !normalized.localPort) {
      return null;
    }
    return normalized;
  }

  sanitizeLanForward(lanForward) {
    if (!lanForward || typeof lanForward !== 'object') return undefined;
    const localPort = Number.isFinite(lanForward.localPort) && Number(lanForward.localPort) > 0
      ? Number(lanForward.localPort)
      : undefined;
    return {
      enabled: lanForward.enabled === true,
      ...(localPort ? { localPort } : {}),
    };
  }

  sanitizeInstance(instance) {
    const id = typeof instance?.id === 'string' ? instance.id.trim() : '';
    const sshCommand = typeof instance?.sshCommand === 'string' ? instance.sshCommand.trim() : '';
    if (!id || id === LOCAL_HOST_ID) {
      throw new Error('SSH instance id is required');
    }
    if (!sshCommand) {
      throw new Error('SSH command is required');
    }

    const parsed = parseSshCommand(sshCommand);
    const seen = new Set();
    const portForwards = Array.isArray(instance?.portForwards)
      ? instance.portForwards
          .map((forward) => this.sanitizeForward(forward))
          .filter((forward) => forward && !seen.has(forward.id) && seen.add(forward.id))
      : [];
    const lanForward = this.sanitizeLanForward(instance?.lanForward);

    return {
      id,
      ...(typeof instance?.nickname === 'string' && instance.nickname.trim() ? { nickname: instance.nickname.trim() } : {}),
      sshCommand,
      sshParsed: parsed,
      connectionTimeoutSec: Number.isFinite(instance?.connectionTimeoutSec) && Number(instance.connectionTimeoutSec) > 0
        ? Number(instance.connectionTimeoutSec)
        : DEFAULT_CONNECTION_TIMEOUT_SEC,
      remoteOpenchamber: {
        mode: instance?.remoteOpenchamber?.mode === 'external' ? 'external' : 'managed',
        keepRunning: instance?.remoteOpenchamber?.keepRunning !== false,
        relayHost: instance?.remoteOpenchamber?.relayHost !== false,
        ...(Number.isFinite(instance?.remoteOpenchamber?.preferredPort) ? { preferredPort: Number(instance.remoteOpenchamber.preferredPort) } : {}),
        installMethod: ['npm', 'bun', 'download_release', 'upload_bundle'].includes(instance?.remoteOpenchamber?.installMethod)
          ? instance.remoteOpenchamber.installMethod
          : 'bun',
        uploadBundleOverSsh: Boolean(instance?.remoteOpenchamber?.uploadBundleOverSsh),
      },
      localForward: {
        bindHost: sanitizeBindHost(instance?.localForward?.bindHost),
        ...(Number.isFinite(instance?.localForward?.preferredLocalPort) ? { preferredLocalPort: Number(instance.localForward.preferredLocalPort) } : {}),
      },
      auth: {
        ...(this.sanitizeStoredSecret(instance?.auth?.sshPassword) ? { sshPassword: this.sanitizeStoredSecret(instance.auth.sshPassword) } : {}),
        ...(this.sanitizeStoredSecret(instance?.auth?.openchamberPassword) ? { openchamberPassword: this.sanitizeStoredSecret(instance.auth.openchamberPassword) } : {}),
      },
      portForwards,
      // Optional LAN bind (0.0.0.0) for direct LAN access to the remote instance.
      // Absent / enabled:false = off. localPort is sticky across reconnects.
      ...(lanForward ? { lanForward } : {}),
    };
  }

  async updateHostUrl(instanceId, label, localUrl) {
    return this.updateHostRuntime(instanceId, label, localUrl, '');
  }

  async updateHostRuntime(instanceId, label, localUrl, clientToken = '', relay = null) {
    await this.mutateSettingsRoot((root) => {
      const hosts = Array.isArray(root.desktopHosts) ? root.desktopHosts : [];
      const existing = hosts.find((entry) => entry?.id === instanceId);
      const token = typeof clientToken === 'string' ? clientToken.trim() : '';
      const nextRelay = parseRelayDescriptorFromStatus(
        relay && typeof relay === 'object'
          ? { hostAllowed: true, relayUrl: relay.relayUrl, serverId: relay.serverId, hostEncPubJwk: relay.hostEncPubJwk }
          : null,
      );
      if (existing) {
        existing.label = label;
        existing.url = localUrl;
        existing.apiUrl = localUrl;
        if (token) existing.clientToken = token;
        if (nextRelay) existing.relay = nextRelay;
      } else {
        hosts.push({
          id: instanceId,
          label,
          url: localUrl,
          apiUrl: localUrl,
          ...(token ? { clientToken: token } : {}),
          ...(nextRelay ? { relay: nextRelay } : {}),
        });
      }
      root.desktopHosts = hosts;
      return root;
    });
  }

  async fetchRemoteRelayDescriptor(localUrl, clientToken) {
    const token = typeof clientToken === 'string' ? clientToken.trim() : '';
    if (!token) return null;
    try {
      const response = await fetch(new URL('/api/openchamber/relay/status', `${localUrl}/`).toString(), {
        method: 'GET',
        signal: AbortSignal.timeout(8_000),
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
      });
      if (!response.ok) return null;
      const payload = await response.json().catch(() => null);
      return parseRelayDescriptorFromStatus(payload);
    } catch {
      return null;
    }
  }

  async issueClientToken(localUrl, openchamberPassword) {
    const password = typeof openchamberPassword === 'string' ? openchamberPassword.trim() : '';
    if (!password) {
      throw new Error('OpenChamber UI password is required to mint a client token');
    }

    const loginResponse = await fetch(new URL('/auth/session', `${localUrl}/`).toString(), {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        password,
        trustDevice: true,
        issueClientToken: true,
        clientLabel: SSH_DESKTOP_CLIENT_LABEL,
        clientKind: SSH_DESKTOP_CLIENT_KIND,
        dedupeKey: SSH_DESKTOP_CLIENT_DEDUPE_KEY,
      }),
    });
    if (!loginResponse.ok) {
      throw new Error(`OpenChamber UI password was rejected by forwarded server (status ${loginResponse.status})`);
    }

    const payload = await loginResponse.json().catch(() => null);
    const token = typeof payload?.clientToken === 'string' ? payload.clientToken.trim() : '';
    if (token) return token;

    const cookie = this.extractCookieHeader(loginResponse);
    if (!cookie) {
      throw new Error('Forwarded OpenChamber did not issue an SSH host token');
    }
    const minted = await this.createClientToken(localUrl, { Cookie: cookie });
    if (!minted) {
      throw new Error('Forwarded OpenChamber did not issue an SSH host token');
    }
    return minted;
  }

  async createClientToken(localUrl, extraHeaders = {}) {
    const tokenResponse = await fetch(new URL('/api/client-auth/clients', `${localUrl}/`).toString(), {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...extraHeaders,
      },
        body: JSON.stringify({
          label: SSH_DESKTOP_CLIENT_LABEL,
          clientKind: SSH_DESKTOP_CLIENT_KIND,
          dedupeKey: SSH_DESKTOP_CLIENT_DEDUPE_KEY,
        }),
    });
    if (!tokenResponse.ok) return '';
    const tokenPayload = await tokenResponse.json().catch(() => null);
    return typeof tokenPayload?.token === 'string' ? tokenPayload.token.trim() : '';
  }

  sessionUiPassword(session, instance) {
    const ephemeral = typeof session?.uiPassword === 'string' ? session.uiPassword.trim() : '';
    if (ephemeral) return ephemeral;
    const remembered = this.ephemeralUiPasswords.get(instance?.id || session?.instance?.id);
    if (typeof remembered === 'string' && remembered.trim()) return remembered.trim();
    return this.configuredOpenChamberPassword(instance || session?.instance);
  }

  /**
   * Mint (or remint) a stored SSH host clientToken for a ready session.
   * Uses the in-memory tunnel password (ephemeral managed password or configured).
   */
  async mintSshHostToken(instanceId) {
    const id = String(instanceId || '').trim();
    if (!id || id === LOCAL_HOST_ID) return '';
    const session = this.sessions.get(id);
    const phase = this.statuses.get(id)?.phase;
    const localPort = Number(session?.localPort);
    if (!session || phase !== 'ready' || !Number.isFinite(localPort) || localPort <= 0) return '';
    const instance = session.instance;
    const password = this.sessionUiPassword(session, instance);
    if (!password) return '';
    const localUrl = `http://127.0.0.1:${localPort}`;
    const label = instance?.nickname?.trim() || instance?.sshParsed?.destination || id;
    const token = await this.issueClientToken(localUrl, password);
    if (!token) return '';
    await this.updateHostRuntime(id, label, localUrl, token);
    return token;
  }

  extractCookieHeader(response) {
    const getSetCookie = typeof response.headers?.getSetCookie === 'function'
      ? response.headers.getSetCookie.bind(response.headers)
      : null;
    const cookies = getSetCookie ? getSetCookie() : [];
    const rawCookies = cookies.length > 0
      ? cookies
      : String(response.headers?.get?.('set-cookie') || '').split(/,(?=\s*[^;,=]+=[^;,]+)/);
    return rawCookies
      .map((cookie) => String(cookie || '').split(';')[0].trim())
      .filter(Boolean)
      .join('; ');
  }

  async persistLocalPort(instanceId, localPort) {
    await this.mutateSettingsRoot((root) => {
      const instances = Array.isArray(root.desktopSshInstances) ? root.desktopSshInstances : [];
      for (const instance of instances) {
        if (instance?.id !== instanceId) continue;
        instance.localForward = instance.localForward && typeof instance.localForward === 'object' ? instance.localForward : {};
        instance.localForward.preferredLocalPort = localPort;
      }
      root.desktopSshInstances = instances;
      return root;
    });
  }

  /**
   * Persist sticky LAN-forward port (and enabled flag) on desktopSshInstances.
   * Serialized via the shared settings store (tmp + rename), same as persistLocalPort.
   */
  async persistLanForward(instanceId, { enabled, localPort } = {}) {
    await this.mutateSettingsRoot((root) => {
      const instances = Array.isArray(root.desktopSshInstances) ? root.desktopSshInstances : [];
      for (const instance of instances) {
        if (instance?.id !== instanceId) continue;
        const previous = instance.lanForward && typeof instance.lanForward === 'object' ? instance.lanForward : {};
        const nextPort = Number.isFinite(localPort) && Number(localPort) > 0
          ? Number(localPort)
          : (Number.isFinite(previous.localPort) && Number(previous.localPort) > 0 ? Number(previous.localPort) : undefined);
        instance.lanForward = {
          enabled: enabled === true || (enabled === undefined && previous.enabled === true),
          ...(nextPort ? { localPort: nextPort } : {}),
        };
      }
      root.desktopSshInstances = instances;
      return root;
    });
  }

  async resolveSshConfig(parsed) {
    const { code, stdout, stderr } = await runOutput('ssh', buildSshArgs(parsed, ['-G']));
    if (code !== 0) {
      throw new Error(stderr.trim() || 'Failed to resolve SSH config');
    }
    const map = new Map();
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [key, ...rest] = trimmed.split(' ');
      if (!key || rest.length === 0) continue;
      map.set(key.toLowerCase(), rest.join(' ').trim());
    }
    return map;
  }

  ensureSessionDir(id) {
    const base = path.join(path.dirname(this.settingsFilePath), 'ssh', id);
    fs.mkdirSync(base, { recursive: true });
    return base;
  }

  controlPathForInstance(id) {
    let hash = 0;
    for (const char of id) {
      hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
    }
    return path.join(os.tmpdir(), `ocssh-${Math.abs(hash).toString(16)}.sock`);
  }

  async spawnMasterProcess(parsed, controlPath, askpassPath, sshPassword) {
    const child = spawn('ssh', buildSshArgs(parsed, [
      '-o', 'ControlMaster=yes',
      '-o', `ControlPath=${controlPath}`,
      '-o', `ControlPersist=${DEFAULT_CONTROL_PERSIST_SEC}`,
      '-N',
    ]), {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...WINDOWS_HIDDEN_SPAWN_OPTIONS,
      env: {
        ...process.env,
        SSH_ASKPASS_REQUIRE: 'force',
        SSH_ASKPASS: askpassPath,
        DISPLAY: '1',
        ...(sshPassword ? { OPENCHAMBER_SSH_ASKPASS_VALUE: sshPassword.trim() } : {}),
      },
    });
    // Capture stderr while waiting for ControlMaster so early exits surface
    // ssh's own diagnostic (e.g. DNS failure) instead of a bare exit message.
    const stderrTail = attachProcessStderrTail(child);
    child.__openchamberStderrTail = stderrTail;
    return child;
  }

  async waitForMasterReady(parsed, controlPath, timeoutSec, master) {
    const deadline = Date.now() + (timeoutSec * 1000);
    let pollMs = 250;
    const readStderrTail = () => {
      const getter = master?.__openchamberStderrTail?.getTail;
      return typeof getter === 'function' ? getter() : '';
    };
    while (Date.now() < deadline) {
      const { code } = await runOutput('ssh', buildSshArgs(parsed, [
        '-o', 'ControlMaster=no',
        '-o', `ControlPath=${controlPath}`,
        '-O', 'check',
      ]));
      if (code === 0) return;

      const exited = master.exitCode;
      if (typeof exited === 'number') {
        throw new Error(formatMasterExitError(readStderrTail()));
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      pollMs = Math.min(pollMs * 2, 2000);
    }
    throw new Error('SSH ControlMaster connection timed out');
  }

  configuredOpenChamberPassword(instance) {
    const secret = instance?.auth?.openchamberPassword;
    return secret?.enabled && typeof secret.value === 'string' && secret.value.trim() ? secret.value.trim() : null;
  }

  async remoteCommandExists(parsed, controlPath, commandName) {
    try {
      const output = await this.runManagedRemoteCommand(parsed, controlPath, `command -v ${commandName} >/dev/null 2>&1 && echo yes || echo no`);
      return output.trim() === 'yes';
    } catch {
      return false;
    }
  }

  async currentRemoteOpenChamberVersion(parsed, controlPath) {
    try {
      const output = await this.runManagedRemoteCommand(parsed, controlPath, 'openchamber --version 2>/dev/null || true');
      return parseVersionToken(output);
    } catch {
      return null;
    }
  }

  async runManagedRemoteCommand(parsed, controlPath, script) {
    return await runRemoteCommand(parsed, controlPath, `${buildRemoteManagedRuntimePrefix()}\n${script}`);
  }

  async ensureManagedNodeRuntime(parsed, controlPath) {
    const output = await this.runManagedRemoteCommand(parsed, controlPath, "node -p 'process.versions.node' 2>/dev/null || true");
    const major = Number.parseInt(output.trim().split('.')[0], 10);
    if (!Number.isInteger(major) || major < REMOTE_NODE_MIN_MAJOR) {
      throw new Error(`Managed SSH remote requires Node.js ${REMOTE_NODE_MIN_MAJOR}+; no supported Node runtime was found on the remote host`);
    }
  }

  async ensureRemoteOpenCodeCli(parsed, controlPath, preferred) {
    const installedVersion = await this.currentRemoteOpenCodeVersion(parsed, controlPath);
    if (installedVersion && (!this.opencodeCliVersion || installedVersion === this.opencodeCliVersion)) return;

    const hasBun = await this.remoteCommandExists(parsed, controlPath, 'bun');
    const hasNpm = await this.remoteCommandExists(parsed, controlPath, 'npm');
    const packageSpec = this.opencodeCliVersion ? `${OPENCODE_NPM_PACKAGE}@${this.opencodeCliVersion}` : OPENCODE_NPM_PACKAGE;
    const commands = [];
    if (preferred === 'npm') {
      if (hasNpm) commands.push(`npm install -g ${packageSpec} --force`);
      if (hasBun) commands.push(`bun add -g ${packageSpec}`);
    } else {
      if (hasBun) commands.push(`bun add -g ${packageSpec}`);
      if (hasNpm) commands.push(`npm install -g ${packageSpec} --force`);
    }
    if (commands.length === 0) {
      throw new Error('Remote host has neither bun nor npm available to install OpenCode CLI');
    }

    let lastError = null;
    for (const command of commands) {
      try {
        await this.runManagedRemoteCommand(parsed, controlPath, command);
        const installed = await this.currentRemoteOpenCodeVersion(parsed, controlPath);
        if (installed && (!this.opencodeCliVersion || installed === this.opencodeCliVersion)) return;
        lastError = new Error('OpenCode CLI installation completed but the expected executable version is unavailable');
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('Failed to install OpenCode CLI on remote host');
  }

  async ensureRemoteOpenChamberNativeBinding(parsed, controlPath) {
    await this.runManagedRemoteCommand(
      parsed,
      controlPath,
      buildRemoteNativeBindingRepairScript({
        packageName: OPENCHAMBER_NPM_PACKAGE,
        version: this.appVersion,
      }),
    );
  }

  async currentRemoteOpenCodeVersion(parsed, controlPath) {
    try {
      const output = await this.runManagedRemoteCommand(parsed, controlPath, 'opencode --version 2>/dev/null || true');
      return parseVersionToken(output);
    } catch {
      return null;
    }
  }

  async installOpenChamberManaged(parsed, controlPath, version, preferred) {
    const hasBun = await this.remoteCommandExists(parsed, controlPath, 'bun');
    const hasNpm = await this.remoteCommandExists(parsed, controlPath, 'npm');
    // npm refuses to overwrite an existing global bin (EEXIST) when a previous
    // install left the bin file behind; --force makes the reinstall idempotent.
    const npmInstall = `npm install -g ${OPENCHAMBER_NPM_PACKAGE}@${version} --force`;
    const commands = [];

    if (preferred === 'bun') {
      if (hasBun) commands.push(`bun add -g ${OPENCHAMBER_NPM_PACKAGE}@${version}`);
      if (hasNpm) commands.push(npmInstall);
    } else if (preferred === 'npm') {
      if (hasNpm) commands.push(npmInstall);
      if (hasBun) commands.push(`bun add -g ${OPENCHAMBER_NPM_PACKAGE}@${version}`);
    } else {
      if (hasBun) commands.push(`bun add -g ${OPENCHAMBER_NPM_PACKAGE}@${version}`);
      if (hasNpm) commands.push(npmInstall);
    }

    if (commands.length === 0) {
      throw new Error('Remote host has neither bun nor npm available');
    }

    let lastError = null;
    for (const command of commands) {
      try {
        await this.runManagedRemoteCommand(parsed, controlPath, command);
        if (await this.currentRemoteOpenChamberVersion(parsed, controlPath)) return;
        lastError = new Error('OpenChamber installation completed but the executable is unavailable');
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('Failed to install OpenChamber on remote host');
  }

  async probeRemoteSystemInfo(parsed, controlPath, port, openchamberPassword) {
    const authPayload = openchamberPassword ? JSON.stringify({ password: openchamberPassword }) : '{}';
    const authEnabled = openchamberPassword ? '1' : '0';
    const script = `AUTH_STATUS=0; INFO_STATUS=0; HEALTH_STATUS=0; BODY_FILE="$(mktemp)"; COOKIE_FILE="$(mktemp)"; cleanup(){ rm -f "$BODY_FILE" "$COOKIE_FILE"; }; trap cleanup EXIT; if command -v curl >/dev/null 2>&1; then if [ "${authEnabled}" = "1" ]; then AUTH_STATUS="$(curl -sS --max-time 3 -o /dev/null -w '%{http_code}' -c "$COOKIE_FILE" -H 'content-type: application/json' --data ${shellQuote(authPayload)} http://127.0.0.1:${port}/auth/session || true)"; if [ "$AUTH_STATUS" = "200" ]; then INFO_STATUS="$(curl -sS --max-time 3 -b "$COOKIE_FILE" -o "$BODY_FILE" -w '%{http_code}' http://127.0.0.1:${port}/api/system/info || true)"; else INFO_STATUS="$(curl -sS --max-time 3 -o "$BODY_FILE" -w '%{http_code}' http://127.0.0.1:${port}/api/system/info || true)"; fi; else INFO_STATUS="$(curl -sS --max-time 3 -o "$BODY_FILE" -w '%{http_code}' http://127.0.0.1:${port}/api/system/info || true)"; fi; HEALTH_STATUS="$(curl -sS --max-time 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:${port}/health || true)"; elif command -v wget >/dev/null 2>&1; then wget -qO "$BODY_FILE" http://127.0.0.1:${port}/api/system/info >/dev/null 2>&1; if [ $? -eq 0 ]; then INFO_STATUS=200; fi; wget -qO- http://127.0.0.1:${port}/health >/dev/null 2>&1; if [ $? -eq 0 ]; then HEALTH_STATUS=200; fi; else exit 127; fi; printf 'INFO_STATUS=%s\\nAUTH_STATUS=%s\\nHEALTH_STATUS=%s\\n' "$INFO_STATUS" "$AUTH_STATUS" "$HEALTH_STATUS"; cat "$BODY_FILE" 2>/dev/null || true`;
    const output = await runRemoteCommand(parsed, controlPath, script);
    const lines = output.split(/\r?\n/);
    const infoStatus = parseProbeStatusLine(lines[0], 'INFO_STATUS=') || 0;
    const authStatus = parseProbeStatusLine(lines[1], 'AUTH_STATUS=') || 0;
    const healthStatus = parseProbeStatusLine(lines[2], 'HEALTH_STATUS=') || 0;
    const body = lines.slice(3).join('\n');

    if (isLivenessHttpStatus(infoStatus)) {
      if (isAuthHttpStatus(infoStatus)) {
        if (openchamberPassword && authStatus !== 200) {
          throw new Error(`Remote OpenChamber requires UI authentication and configured password was rejected (auth status ${authStatus})`);
        }
        if (isLivenessHttpStatus(healthStatus)) return {};
        throw new Error('Remote OpenChamber requires UI authentication on /api/system/info; configure OpenChamber UI password');
      }
    } else if (isLivenessHttpStatus(healthStatus)) {
      return {};
    } else {
      throw new Error(`Remote OpenChamber probe failed (info status ${infoStatus}, health status ${healthStatus})`);
    }

    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }

  async remoteServerRunning(parsed, controlPath, port, openchamberPassword) {
    try {
      await this.probeRemoteSystemInfo(parsed, controlPath, port, openchamberPassword);
      return true;
    } catch {
      return false;
    }
  }

  async startRemoteServerManaged(parsed, controlPath, instance, desiredPort) {
    const uiPassword = this.configuredOpenChamberPassword(instance) || createEphemeralUiPassword();
    let relayHostSupported = true;
    if (instanceWantsRelayHost(instance)) {
      const help = await this.runManagedRemoteCommand(parsed, controlPath, 'openchamber serve --help 2>&1 || true');
      relayHostSupported = remoteHelpMentionsRelayHost(help);
      if (!relayHostSupported) {
        this.appendLogWithLevel(
          instance.id,
          'WARN',
          'Remote OpenChamber CLI does not advertise --relay-host; starting without a private relay host',
        );
      }
    }
    const output = await this.runManagedRemoteCommand(
      parsed,
      controlPath,
      buildManagedServeCommand(instance, desiredPort, uiPassword, { relayHostSupported }),
    );
    const port = output.split(/\s+/).map((token) => Number.parseInt(token, 10)).find((value) => Number.isFinite(value));
    return { port: port || desiredPort, uiPassword };
  }

  buildRelayHostFlag(instance) {
    return buildRelayHostFlag(instance);
  }

  async stopRemoteServerBestEffort(parsed, controlPath, remotePort) {
    try {
      await runRemoteCommand(
        parsed,
        controlPath,
        `if command -v curl >/dev/null 2>&1; then curl -fsS -X POST http://127.0.0.1:${remotePort}/api/system/shutdown >/dev/null 2>&1 || true; elif command -v wget >/dev/null 2>&1; then wget -qO- --method=POST http://127.0.0.1:${remotePort}/api/system/shutdown >/dev/null 2>&1 || true; fi`,
      );
    } catch {
    }
  }

  async spawnMainForward(parsed, controlPath, bindHost, localPort, remotePort) {
    return spawn('ssh', buildSshArgs(parsed, [
      '-o', 'ControlMaster=no',
      '-o', `ControlPath=${controlPath}`,
      '-N',
      '-L', `${bindHost}:${localPort}:127.0.0.1:${remotePort}`,
    ]), {
      stdio: ['ignore', 'ignore', 'pipe'],
      ...WINDOWS_HIDDEN_SPAWN_OPTIONS,
    });
  }

  async spawnExtraForward(parsed, controlPath, forward) {
    const args = [
      '-o', 'ControlMaster=no',
      '-o', `ControlPath=${controlPath}`,
      '-O', 'forward',
    ];
    if (forward.type === 'local') {
      args.push('-L', `${forward.localHost || '127.0.0.1'}:${forward.localPort}:${forward.remoteHost || '127.0.0.1'}:${forward.remotePort}`);
    } else if (forward.type === 'remote') {
      args.push('-R', `${forward.remoteHost || '127.0.0.1'}:${forward.remotePort}:${forward.localHost || '127.0.0.1'}:${forward.localPort}`);
    } else {
      args.push('-D', `${forward.localHost || '127.0.0.1'}:${forward.localPort}`);
    }
    const { code, stdout, stderr } = await runOutput('ssh', buildSshArgs(parsed, args));
    if (code !== 0) {
      throw new Error((stderr || stdout || `Failed to configure extra SSH forward ${forward.id}`).trim());
    }
  }

  /**
   * Ensure a LAN-facing local forward (0.0.0.0:<port> → 127.0.0.1:<remotePort>)
   * on the live ControlMaster. Sticky port is persisted when first allocated.
   * @param {string} id
   * @returns {Promise<{ localPort: number }>}
   */
  async ensureLanForward(id) {
    const trimmed = String(id || '').trim();
    if (!trimmed || trimmed === LOCAL_HOST_ID) {
      throw new Error('SSH instance id is required');
    }
    const session = this.sessions.get(trimmed);
    const phase = this.statuses.get(trimmed)?.phase;
    if (!session || phase !== 'ready') {
      throw new Error('SSH instance is not ready');
    }
    const remotePort = Number(session.remotePort);
    if (!Number.isFinite(remotePort) || remotePort <= 0) {
      throw new Error('SSH instance remote port is unavailable');
    }

    let lanPort = Number(session.instance?.lanForward?.localPort);
    if (!Number.isFinite(lanPort) || lanPort <= 0) {
      const mainPort = Number(session.localPort);
      lanPort = await pickUnusedLocalPort();
      // Avoid colliding with the loopback main forward when the OS reuses a port.
      if (Number.isFinite(mainPort) && lanPort === mainPort) {
        lanPort = await pickUnusedLocalPort();
      }
      await this.persistLanForward(trimmed, { enabled: true, localPort: lanPort });
      session.instance = {
        ...session.instance,
        lanForward: { enabled: true, localPort: lanPort },
      };
      this.appendLogWithLevel(trimmed, 'INFO', `Allocated LAN forward port ${lanPort}`);
    }

    await this.spawnExtraForward(session.parsed, session.controlPath, {
      id: 'lan-forward',
      type: 'local',
      localHost: '0.0.0.0',
      localPort: lanPort,
      remoteHost: '127.0.0.1',
      remotePort,
    });
    this.appendLogWithLevel(trimmed, 'INFO', `LAN forward ready on 0.0.0.0:${lanPort} → 127.0.0.1:${remotePort}`);
    return { localPort: lanPort };
  }

  /**
   * Resolve a ready SSH session that can execute OpenCode config sync.
   * Capability gate (`posixShell`) replaces the former mode==='managed' hard check
   * with equivalent semantics via {@link createSshSyncTarget}.
   * @param {string} id
   */
  resolveManagedReadySession(id) {
    const trimmed = String(id || '').trim();
    if (!trimmed || trimmed === LOCAL_HOST_ID) {
      throw new Error('SSH instance id is required');
    }
    const session = this.sessions.get(trimmed);
    if (!session || this.statuses.get(trimmed)?.phase !== 'ready') {
      throw new Error('SSH instance is not connected');
    }
    const target = createSshSyncTarget(trimmed, session.instance);
    assertTargetCapability(target, 'posixShell');
    return { id: trimmed, session, target };
  }

  /**
   * SSH TargetExecutor: probe/prepare/putTar/finalize over ControlMaster.
   * putTar currently buffers the whole archive (SSH stdin); the payload type
   * still accepts AsyncIterable/Readable for a later streaming relay path.
   * @param {{ parsed: object, controlPath: string, instance?: object }} session
   * @returns {import('@openchambery/web/server/lib/config-sync/contract.js').TargetExecutor}
   */
  createSshTargetExecutor(session) {
    const timeoutSec = session.instance?.connectionTimeoutSec || DEFAULT_CONNECTION_TIMEOUT_SEC;
    const ensureBuffer = async (payload) => {
      if (Buffer.isBuffer(payload)) return payload;
      if (payload instanceof Uint8Array) return Buffer.from(payload);
      // Streaming payloads are accepted by the contract but buffered here for SSH stdin.
      const chunks = [];
      for await (const chunk of payload) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    };

    return {
      async probe(plan) {
        const probeScript = buildRemoteSyncProbeScript(probePathsForPlan(plan));
        const stdout = await runRemoteCommand(session.parsed, session.controlPath, probeScript, timeoutSec);
        const remoteLines = String(stdout || '')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        const remoteAgentsRootExists = remoteLines.includes(OPENCODE_AGENTS_ROOT_PROBE_MARKER);
        const remoteAuthFileExists = remoteLines.includes(OPENCODE_AUTH_FILE_PROBE_MARKER);
        const remoteExisting = remoteLines.filter(
          (line) => line !== OPENCODE_AGENTS_ROOT_PROBE_MARKER && line !== OPENCODE_AUTH_FILE_PROBE_MARKER,
        );
        return { remoteExisting, remoteAgentsRootExists, remoteAuthFileExists };
      },

      async prepare(plan, ctx) {
        const prepareScript = buildRemoteSyncPrepareScriptShared(plan, { syncRunId: ctx.syncRunId });
        const prepareStdout = await runRemoteCommand(
          session.parsed,
          session.controlPath,
          prepareScript,
          timeoutSec,
        );
        if (!String(prepareStdout || '').includes('SYNC_READY')) {
          throw new Error('Remote sync prepare did not report SYNC_READY');
        }
      },

      async putTar({ kind, payload }) {
        const buffer = await ensureBuffer(payload);
        if (kind === 'config') {
          await runRemoteCommandWithInput(
            session.parsed,
            session.controlPath,
            'mkdir -p "$HOME/.config/opencode" && tar -xzf - -C "$HOME/.config/opencode"',
            buffer,
            timeoutSec,
          );
          return;
        }
        if (kind === 'agents') {
          await runRemoteCommandWithInput(
            session.parsed,
            session.controlPath,
            'mkdir -p "$HOME" && tar -xzf - -C "$HOME"',
            buffer,
            timeoutSec,
          );
          return;
        }
        if (kind === 'auth') {
          // Only auth.json — never the rest of ~/.local/share/opencode (session DBs live there).
          await runRemoteCommandWithInput(
            session.parsed,
            session.controlPath,
            'mkdir -p "$HOME/.local/share/opencode" && tar -xzf - -C "$HOME/.local/share/opencode"',
            buffer,
            timeoutSec,
          );
          return;
        }
        throw new Error(`Unsupported putTar kind: ${String(kind)}`);
      },

      async finalize(_plan, ctx) {
        const finalizeScript = buildRemoteSyncFinalizeScript({ syncRunId: ctx.syncRunId });
        const stdout = await runRemoteCommand(
          session.parsed,
          session.controlPath,
          finalizeScript,
          timeoutSec,
        );
        if (!String(stdout || '').includes('SYNC_DONE')) {
          throw new Error('Remote sync finalize did not report SYNC_DONE');
        }
        return { ok: true };
      },
    };
  }

  /**
   * Per-target mutex for preview/apply. Rejects concurrent starts with SyncInProgressError.
   * @template T
   * @param {string} instanceId
   * @param {'preview' | 'apply'} stage
   * @param {(ctx: { syncRunId: string, targetId: string, startedAt: string }) => Promise<T>} work
   * @returns {Promise<T & { syncRunId: string }>}
   */
  /**
   * Per-target mutex used by SSH and direct-host sync.
   * @param {string} targetId namespaced id (`ssh:…` or `host:…`)
   */
  async runExclusiveForTarget(targetId, stage, work) {
    const existing = this.syncInFlight.get(targetId);
    if (existing) {
      throw new SyncInProgressError(targetId, existing.syncRunId);
    }

    const syncRunId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const flight = { syncRunId, promise: null };
    const runPromise = (async () => {
      let summary = summarizeSyncPlan(null);
      let direction = SYNC_DIRECTION_PUSH;
      try {
        const result = await work({ syncRunId, targetId, startedAt });
        summary = summarizeSyncPlan(result?.plan || result);
        if (result?.plan?.direction === 'push' || result?.plan?.direction === 'pull') {
          direction = result.plan.direction;
        } else if (result?.direction === 'push' || result?.direction === 'pull') {
          direction = result.direction;
        }
        await this.syncRunStore.append(targetId, {
          syncRunId,
          targetId,
          stage,
          direction,
          startedAt,
          endedAt: new Date().toISOString(),
          result: 'success',
          summary,
        });
        // Keep `plan` in the IPC response: the renderer preview parser requires
        // it (pull plans come from the remote inventory and exist nowhere else;
        // push previews also rely on it). The run record above already consumed
        // the plan for its summary, so nothing here needs it stripped.
        return { ...result, syncRunId };
      } catch (error) {
        if (!(error instanceof SyncInProgressError)) {
          await this.syncRunStore.append(targetId, {
            syncRunId,
            targetId,
            stage,
            direction,
            startedAt,
            endedAt: new Date().toISOString(),
            result: 'failure',
            summary,
            error: error instanceof Error ? error.message : String(error),
          }).catch(() => {});
        }
        throw error;
      } finally {
        if (this.syncInFlight.get(targetId) === flight) {
          this.syncInFlight.delete(targetId);
        }
      }
    })();
    flight.promise = runPromise;
    this.syncInFlight.set(targetId, flight);
    return runPromise;
  }

  async runExclusiveSync(instanceId, stage, work) {
    return this.runExclusiveForTarget(syncTargetIdForSshInstance(instanceId), stage, work);
  }

  /**
   * @param {unknown} raw
   */
  normalizeSyncOptions(raw = {}) {
    const direction = raw?.direction === SYNC_DIRECTION_PULL ? SYNC_DIRECTION_PULL : SYNC_DIRECTION_PUSH;
    const selections = normalizeSyncSelections(raw?.selections, {
      includeAuthFile: raw?.selections?.authFile === true,
    });
    return { direction, selections };
  }

  /**
   * Recent sync run records for an SSH instance (newest last, capped by store).
   * @param {string} instanceId
   */
  async listSyncRuns(instanceId) {
    const targetId = syncTargetIdForSshInstance(instanceId);
    return this.syncRunStore.readAll(targetId);
  }

  /**
   * Collect remote allowlist inventory for pull planning.
   * @param {{ parsed: object, controlPath: string, instance?: object }} session
   */
  async collectRemoteInventory(session) {
    const timeoutSec = session.instance?.connectionTimeoutSec || DEFAULT_CONNECTION_TIMEOUT_SEC;
    const stdout = await runRemoteCommand(
      session.parsed,
      session.controlPath,
      buildRemoteSyncInventoryScript(),
      timeoutSec,
    );
    const line = String(stdout || '')
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find((entry) => entry.startsWith('SYNC_INVENTORY='));
    if (!line) {
      throw new Error('Remote sync inventory did not report SYNC_INVENTORY');
    }
    const json = line.slice('SYNC_INVENTORY='.length);
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Remote sync inventory payload is malformed');
    }
    return parsed;
  }

  /**
   * Preview OpenCode config sync. Direction switch must re-call this (no cached plan reuse).
   * @param {string} id
   * @param {{ direction?: 'push' | 'pull', selections?: object }} [options]
   */
  async previewOpencodeConfigSync(id, options = {}) {
    return this.runExclusiveSync(id, 'preview', async ({ syncRunId, targetId }) => {
      const { session, target } = this.resolveManagedReadySession(id);
      assertTargetCapability(target, 'tarExtract');
      const { direction, selections } = this.normalizeSyncOptions(options);

      if (direction === SYNC_DIRECTION_PULL) {
        const inventory = await this.collectRemoteInventory(session);
        const plan = planOpenCodeConfigSyncFromInventory(inventory, {
          direction: SYNC_DIRECTION_PULL,
          syncRunId,
          sourceTargetId: targetId,
          targetId: 'local',
          selections,
        });
        const localExisting = [];
        const home = os.homedir();
        const configDir = path.join(home, '.config', 'opencode');
        for (const entry of [...plan.files, ...plan.directories]) {
          try {
            fs.accessSync(path.join(configDir, entry.path));
            localExisting.push(entry.path);
          } catch {
            // absent locally
          }
        }
        let localAgentsRootExists = false;
        try {
          localAgentsRootExists = fs.statSync(path.join(home, '.agents')).isDirectory();
        } catch {
          localAgentsRootExists = false;
        }
        let localAuthFileExists = false;
        try {
          localAuthFileExists = fs.statSync(path.join(home, '.local', 'share', 'opencode', 'auth.json')).isFile();
        } catch {
          localAuthFileExists = false;
        }
        return {
          plan,
          remoteExisting: localExisting,
          remoteAgentsRootExists: localAgentsRootExists,
          remoteAuthFileExists: localAuthFileExists,
        };
      }

      const plan = planOpenCodeConfigSync(os.homedir(), {
        direction: SYNC_DIRECTION_PUSH,
        syncRunId,
        sourceTargetId: 'local',
        targetId,
        selections,
      });
      if (plan.authFile) {
        assertTargetCapability(target, 'authFileWrite');
      }
      const executor = this.createSshTargetExecutor(session);
      const probe = await executor.probe(plan);
      return { plan, ...probe };
    });
  }

  /**
   * Apply OpenCode config sync (push to remote or pull to local).
   * Preview and apply must share the same selections snapshot from the wizard.
   * @param {string} id
   * @param {{ direction?: 'push' | 'pull', selections?: object }} [options]
   */
  async applyOpencodeConfigSync(id, options = {}) {
    return this.runExclusiveSync(id, 'apply', async ({ syncRunId, targetId }) => {
      const { id: trimmed, session, target } = this.resolveManagedReadySession(id);
      assertTargetCapability(target, 'tarExtract');
      const home = os.homedir();
      const { direction, selections } = this.normalizeSyncOptions(options);

      if (direction === SYNC_DIRECTION_PULL) {
        const inventory = await this.collectRemoteInventory(session);
        const plan = planOpenCodeConfigSyncFromInventory(inventory, {
          direction: SYNC_DIRECTION_PULL,
          syncRunId,
          sourceTargetId: targetId,
          targetId: 'local',
          selections,
        });
        this.appendLogWithLevel(trimmed, 'INFO', 'Pulling OpenCode config from remote');
        const hasPayload = plan.files.length > 0 || plan.directories.length > 0 || Boolean(plan.agentsRoot) || Boolean(plan.authFile);
        if (!hasPayload) {
          this.appendLogWithLevel(trimmed, 'INFO', 'OpenCode config sync: nothing to download');
          return {
            ok: true,
            files: plan.files.length,
            directories: plan.directories.length,
            deletes: plan.deletes.length,
            totalBytes: plan.totalBytes,
            agentsRoot: null,
            authFile: null,
            plan,
          };
        }

        const timeoutSec = session.instance?.connectionTimeoutSec || DEFAULT_CONNECTION_TIMEOUT_SEC;
        const configTar = (plan.files.length > 0 || plan.directories.length > 0)
          ? await runRemoteCommandBinary(session.parsed, session.controlPath, buildRemoteConfigTarScript(plan), timeoutSec)
          : null;
        const agentsTar = plan.agentsRoot
          ? await runRemoteCommandBinary(session.parsed, session.controlPath, buildRemoteAgentsTarScript(), timeoutSec)
          : null;
        const authTar = plan.authFile
          ? await runRemoteCommandBinary(session.parsed, session.controlPath, buildRemoteAuthTarScript(), timeoutSec)
          : null;

        await prepareLocalSyncDestination(home, plan, { syncRunId });
        if (configTar && configTar.length > 0) {
          await extractTarGzBuffer(configTar, path.join(home, '.config', 'opencode'));
        }
        if (agentsTar && agentsTar.length > 0) {
          await extractTarGzBuffer(agentsTar, home);
        }
        if (authTar && authTar.length > 0) {
          await fsp.mkdir(path.join(home, '.local', 'share', 'opencode'), { recursive: true });
          await extractTarGzBuffer(authTar, path.join(home, '.local', 'share', 'opencode'));
        }
        await finalizeLocalSyncDestination(home, { syncRunId });
        this.appendLogWithLevel(trimmed, 'INFO', 'OpenCode config pull completed');
        return {
          ok: true,
          files: plan.files.length,
          directories: plan.directories.length,
          deletes: plan.deletes.length,
          totalBytes: plan.totalBytes,
          agentsRoot: plan.agentsRoot ? { fileCount: plan.agentsRoot.fileCount } : null,
          authFile: plan.authFile ? { bytes: plan.authFile.bytes } : null,
          plan,
        };
      }

      const plan = planOpenCodeConfigSync(home, {
        direction: SYNC_DIRECTION_PUSH,
        syncRunId,
        sourceTargetId: 'local',
        targetId,
        selections,
      });
      if (plan.authFile) {
        assertTargetCapability(target, 'authFileWrite');
      }
      this.appendLogWithLevel(trimmed, 'INFO', 'Syncing OpenCode config to remote');
      const hasPayload = plan.files.length > 0 || plan.directories.length > 0 || Boolean(plan.agentsRoot) || Boolean(plan.authFile);
      if (!hasPayload) {
        this.appendLogWithLevel(trimmed, 'INFO', 'OpenCode config sync: nothing to upload');
        return {
          ok: true,
          files: plan.files.length,
          directories: plan.directories.length,
          deletes: plan.deletes.length,
          totalBytes: plan.totalBytes,
          agentsRoot: null,
          authFile: null,
          plan,
        };
      }
      const executor = this.createSshTargetExecutor(session);
      const result = await applyConfigSyncPlan({
        plan,
        executor,
        syncRunId,
        sourceHomedir: home,
      });
      this.appendLogWithLevel(trimmed, 'INFO', 'OpenCode config sync completed');
      return result;
    });
  }

  /** Best-effort rebuild on reconnect; never throws into the main connect path. */
  async rebuildLanForwardIfConfigured(id, session) {
    const lan = session?.instance?.lanForward;
    const lanPort = Number(lan?.localPort);
    if (lan?.enabled !== true || !Number.isFinite(lanPort) || lanPort <= 0) return;
    try {
      await this.spawnExtraForward(session.parsed, session.controlPath, {
        id: 'lan-forward',
        type: 'local',
        localHost: '0.0.0.0',
        localPort: lanPort,
        remoteHost: '127.0.0.1',
        remotePort: session.remotePort,
      });
      this.appendLogWithLevel(id, 'INFO', `LAN forward restored on 0.0.0.0:${lanPort}`);
    } catch (error) {
      this.appendLogWithLevel(
        id,
        'WARN',
        `LAN forward restore failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async ensureRemoteServer(instance, parsed, controlPath) {
    if (instance.remoteOpenchamber.mode === 'external') {
      if (!instance.remoteOpenchamber.preferredPort) {
        throw new Error('External mode requires a preferred remote OpenChamber port');
      }
      const port = instance.remoteOpenchamber.preferredPort;
      const uiPassword = this.configuredOpenChamberPassword(instance);
      this.setStatus(instance.id, 'server_detecting', 'Probing external OpenChamber server', null, null, port, false, 0, false);
      await this.probeRemoteSystemInfo(parsed, controlPath, port, uiPassword);
      return { remotePort: port, startedByUs: false, uiPassword };
    }

    this.setStatus(instance.id, 'remote_probe', 'Checking remote OpenChamber installation');
    await this.ensureManagedNodeRuntime(parsed, controlPath);
    const installedVersion = await this.currentRemoteOpenChamberVersion(parsed, controlPath);
    if (!installedVersion) {
      this.setStatus(instance.id, 'installing', 'Installing OpenChamber on remote host');
      await this.installOpenChamberManaged(parsed, controlPath, this.appVersion, instance.remoteOpenchamber.installMethod);
    } else if (installedVersion !== this.appVersion) {
      this.setStatus(instance.id, 'updating', `Updating remote OpenChamber from ${installedVersion} to ${this.appVersion}`);
      await this.installOpenChamberManaged(parsed, controlPath, this.appVersion, instance.remoteOpenchamber.installMethod);
    }
    await this.ensureRemoteOpenChamberNativeBinding(parsed, controlPath);
    await this.ensureRemoteOpenCodeCli(parsed, controlPath, instance.remoteOpenchamber.installMethod);

    this.setStatus(instance.id, 'server_detecting', 'Detecting managed OpenChamber server');
    let remotePort = instance.remoteOpenchamber.preferredPort || null;
    let startedByUs = false;
    let uiPassword = this.configuredOpenChamberPassword(instance)
      || this.ephemeralUiPasswords.get(instance.id)
      || null;
    let runningInfo = null;
    if (remotePort) {
      try {
        runningInfo = await this.probeRemoteSystemInfo(parsed, controlPath, remotePort, uiPassword);
      } catch {
        remotePort = null;
        runningInfo = null;
      }
    }
    // Default relay-host SSH remotes cannot reuse a leftover `web` serve.
    if (remotePort && instanceWantsRelayHost(instance) && !remoteRuntimeCanHostRelay(runningInfo)) {
      this.setStatus(instance.id, 'server_starting', 'Restarting remote OpenChamber as a relay host');
      await this.stopRemoteServerBestEffort(parsed, controlPath, remotePort);
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        if (!(await this.remoteServerRunning(parsed, controlPath, remotePort, uiPassword))) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      remotePort = null;
    }
    if (!remotePort) {
      this.setStatus(instance.id, 'server_starting', 'Starting managed OpenChamber server');
      const desiredPort = instance.remoteOpenchamber.preferredPort || randomPortCandidate(instance.id);
      const started = await this.startRemoteServerManaged(parsed, controlPath, instance, desiredPort);
      remotePort = started.port;
      uiPassword = started.uiPassword;
      startedByUs = true;
      this.ephemeralUiPasswords.set(instance.id, uiPassword);
    }
    if (!(await this.remoteServerRunning(parsed, controlPath, remotePort, uiPassword))) {
      throw new Error('Managed OpenChamber server failed to become reachable');
    }
    return { remotePort, startedByUs, uiPassword };
  }

  async disconnectInternal(id, reportIdle) {
    const timer = this.monitorTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.monitorTimers.delete(id);
    }

    const session = this.sessions.get(id);
    this.sessions.delete(id);
    const keepRemoteRunning = Boolean(
      session?.startedByUs
      && session?.instance?.remoteOpenchamber?.mode === 'managed'
      && session.instance.remoteOpenchamber.keepRunning,
    );
    if (!keepRemoteRunning) {
      this.ephemeralUiPasswords.delete(id);
    }

    if (session) {
      if (session.startedByUs && session.instance.remoteOpenchamber.mode === 'managed' && !session.instance.remoteOpenchamber.keepRunning) {
        await this.stopRemoteServerBestEffort(session.parsed, session.controlPath, session.remotePort);
      }
      await stopControlMasterBestEffort(session.parsed, session.controlPath);
      for (const child of [session.mainForward, session.master]) {
        try {
          child.kill('SIGTERM');
        } catch {
        }
      }
      try {
        await fsp.rm(session.controlPath, { force: true });
      } catch {
      }
      try {
        await fsp.rm(path.join(session.sessionDir, 'askpass.sh'), { force: true });
      } catch {
      }
    }

    this.clearRetryAttempt(id);
    if (reportIdle) {
      this.setStatus(id, 'idle', null, null, null, null, false, 0, false);
    }
  }

  async connectBlocking(instance) {
    const id = instance.id;
    this.setStatus(id, 'config_resolved', 'Resolving SSH command');
    const parsed = instance.sshParsed || parseSshCommand(instance.sshCommand);
    await this.resolveSshConfig(parsed);

    this.setStatus(id, 'auth_check', 'Checking SSH connectivity');
    const sessionDir = this.ensureSessionDir(id);
    const controlPath = this.controlPathForInstance(id);
    try { await fsp.rm(controlPath, { force: true }); } catch {}
    const askpassPath = path.join(sessionDir, 'askpass.sh');
    await writeAskpassScript(askpassPath);

    this.setStatus(id, 'master_connecting', 'Establishing SSH ControlMaster');
    const sshPassword = instance.auth?.sshPassword?.enabled ? instance.auth.sshPassword.value : null;
    const master = await this.spawnMasterProcess(parsed, controlPath, askpassPath, sshPassword);
    await this.waitForMasterReady(parsed, controlPath, instance.connectionTimeoutSec || DEFAULT_CONNECTION_TIMEOUT_SEC, master);

    this.setStatus(id, 'remote_probe', 'Probing remote platform');
    const remoteOs = (await runRemoteCommand(parsed, controlPath, 'uname -s', instance.connectionTimeoutSec || DEFAULT_CONNECTION_TIMEOUT_SEC)).trim().toLowerCase();
    if (!['linux', 'darwin'].includes(remoteOs)) {
      master.kill('SIGTERM');
      throw new Error(`Unsupported remote OS: ${remoteOs}`);
    }

    const { remotePort, startedByUs, uiPassword } = await this.ensureRemoteServer(instance, parsed, controlPath);
    this.setStatus(id, 'forwarding', 'Setting up port forwards', null, null, remotePort, startedByUs, 0, false);

    const bindHost = sanitizeBindHost(instance.localForward?.bindHost);
    let localPort = Number(instance.localForward?.preferredLocalPort) || 0;
    if (!localPort) {
      localPort = await pickUnusedLocalPort();
    }
    if (!(await isLocalPortAvailable(bindHost, localPort))) {
      localPort = await pickUnusedLocalPort();
    }

    const mainForward = await this.spawnMainForward(parsed, controlPath, bindHost, localPort, remotePort);
    let mainForwardDetached = false;
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (typeof mainForward.exitCode === 'number') {
      if (mainForward.exitCode === 0) {
        mainForwardDetached = true;
        this.appendLogWithLevel(id, 'INFO', 'Main tunnel helper exited after ControlMaster handoff');
      } else {
        master.kill('SIGTERM');
        throw new Error(`Failed to start main port forward (status: ${mainForward.exitCode})`);
      }
    }

    const extraErrors = [];
    for (const forward of instance.portForwards.filter((item) => item.enabled)) {
      try {
        await this.spawnExtraForward(parsed, controlPath, forward);
        if (forward.type === 'local' && forward.localPort) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          if (!(await isLocalTunnelReachable(forward.localPort))) {
            extraErrors.push(`${forward.id}: local listener 127.0.0.1:${forward.localPort} is not reachable`);
          }
        }
      } catch (error) {
        extraErrors.push(`${forward.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    await waitLocalForwardReady(localPort);

    const localUrl = `http://127.0.0.1:${localPort}`;
    const label = instance.nickname?.trim() || parsed.destination || id;
    if (!uiPassword) {
      throw new Error('OpenChamber UI password is required to mint a client token');
    }
    const clientToken = await this.issueClientToken(localUrl, uiPassword);
    const relay = instanceWantsRelayHost(instance)
      ? await this.fetchRemoteRelayDescriptor(localUrl, clientToken)
      : null;
    await this.updateHostRuntime(id, label, localUrl, clientToken, relay);
    if (instance.localForward?.preferredLocalPort !== localPort) {
      await this.persistLocalPort(id, localPort);
    }

    const session = {
      instance,
      parsed,
      sessionDir,
      controlPath,
      localPort,
      remotePort,
      startedByUs,
      ...(typeof uiPassword === 'string' && uiPassword.trim() ? { uiPassword: uiPassword.trim() } : {}),
      master,
      masterDetached: false,
      mainForward,
      mainForwardDetached,
    };
    this.sessions.set(id, session);

    this.clearRetryAttempt(id);
    this.setStatus(
      id,
      'ready',
      extraErrors.length === 0 ? 'SSH instance is ready' : `SSH instance is ready with forward warnings: ${extraErrors.join('; ')}`,
      localUrl,
      localPort,
      remotePort,
      startedByUs,
      0,
      false,
    );
    // Sticky LAN forward: rebuild only when explicitly enabled with a saved port.
    // Failure must not block the main ready path (same class as extra portForwards).
    await this.rebuildLanForwardIfConfigured(id, session);
    this.spawnMonitor(id);
  }

  spawnMonitor(id) {
    const existing = this.monitorTimers.get(id);
    if (existing) clearTimeout(existing);
    let healthyTicks = 0;
    const tick = async () => {
      const session = this.sessions.get(id);
      if (!session) {
        this.monitorTimers.delete(id);
        return;
      }

      let droppedReason = null;
      let detachedNotice = null;

      if (!session.mainForwardDetached) {
        if (typeof session.mainForward.exitCode === 'number') {
          if (session.mainForward.exitCode === 0) {
            session.mainForwardDetached = true;
            detachedNotice = 'Main tunnel helper exited after ControlMaster handoff';
          } else {
            droppedReason = `Main SSH forward exited (${session.mainForward.exitCode})`;
          }
        }
      }

      if (!droppedReason) {
        if (session.mainForwardDetached) {
          // Fast path: cheap TCP probe before expensive SSH subprocess
          if (await isLocalTunnelReachable(session.localPort)) {
            // Tunnel alive — skip SSH check
          } else if (!await isControlMasterAlive(session.parsed, session.controlPath)) {
            droppedReason = 'SSH ControlMaster is not reachable';
          } else {
            detachedNotice = 'Local tunnel unreachable but ControlMaster is alive';
          }
        }
      }

      if (detachedNotice) {
        this.appendLogWithLevel(id, 'INFO', detachedNotice);
      }
      if (!droppedReason) {
        healthyTicks++;
        const pollMs = healthyTicks >= MONITOR_STABILIZE_TICKS ? MONITOR_STEADY_POLL_MS : MONITOR_INITIAL_POLL_MS;
        this.monitorTimers.set(id, setTimeout(tick, pollMs));
        return;
      }

      this.appendLogWithLevel(id, 'WARN', droppedReason);
      await this.disconnectInternal(id, false);
      const attempt = this.nextRetryAttempt(id);
      if (attempt > DEFAULT_RECONNECT_MAX_ATTEMPTS) {
        this.setStatus(id, 'error', `${droppedReason}. Retry limit reached`, null, null, null, false, attempt, true);
        return;
      }

      this.setStatus(id, 'degraded', `${droppedReason}. Reconnecting`, null, null, null, false, attempt, false);
      const delayMs = Math.min((2 ** Math.max(attempt - 1, 0)) * 1000 + (nowMillis() % 700) + 100, 30000);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      try {
        await this.connect(id);
      } catch (error) {
        const raw = error instanceof Error ? error.message : String(error);
        this.appendLogWithLevel(id, 'ERROR', raw);
        this.setStatus(id, 'error', summarizeManagedSshBootstrapError(raw), null, null, null, false, attempt, true);
      }
    };
    this.monitorTimers.set(id, setTimeout(tick, MONITOR_INITIAL_POLL_MS));
  }

  async connect(id) {
    const trimmed = String(id || '').trim();
    if (!trimmed || trimmed === LOCAL_HOST_ID) {
      throw new Error('SSH instance id is required');
    }

    if (this.connecting.has(trimmed)) {
      this.appendLogWithLevel(trimmed, 'INFO', 'Connection already in progress');
      return this.connecting.get(trimmed);
    }

    const instance = this.readInstances().instances.find((entry) => entry?.id === trimmed);
    if (!instance) {
      throw new Error('SSH instance not found');
    }

    const retryAttempt = this.currentRetryAttempt(trimmed);
    const connectAttempt = this.nextConnectAttempt(trimmed);
    this.appendAttemptSeparator(trimmed, connectAttempt, retryAttempt);
    this.appendLog(trimmed, 'Starting SSH connection');
    await this.disconnectInternal(trimmed, false);

    const task = this.connectBlocking(this.sanitizeInstance(instance))
      .catch(async (error) => {
        const raw = error instanceof Error ? error.message : String(error);
        this.appendLogWithLevel(trimmed, 'ERROR', raw);
        const detail = summarizeManagedSshBootstrapError(raw);
        this.setStatus(trimmed, 'error', detail, null, null, null, false, 0, true);
        await this.disconnectInternal(trimmed, false);
        throw new Error(detail);
      })
      .finally(() => {
        this.connecting.delete(trimmed);
      });
    this.connecting.set(trimmed, task);
    return task;
  }

  async disconnect(id) {
    const trimmed = String(id || '').trim();
    if (!trimmed || trimmed === LOCAL_HOST_ID) {
      throw new Error('SSH instance id is required');
    }
    await this.disconnectInternal(trimmed, true);
  }

  async statusesWithDefaults(id) {
    if (id) {
      return [this.statusSnapshotForInstance(id)];
    }
    return this.readInstances().instances
      .map((instance) => this.statusSnapshotForInstance(instance.id))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  /**
   * Live SSH local-forward ports for relay target routing.
   * Only ready sessions with a finite localPort are included (memory-authoritative).
   * @returns {{ id: string, localPort: number }[]}
   */
  getRoutingTable() {
    const table = [];
    for (const [id, session] of this.sessions) {
      if (this.statuses.get(id)?.phase !== 'ready') continue;
      const localPort = Number(session?.localPort);
      if (!Number.isFinite(localPort)) continue;
      table.push({ id, localPort });
    }
    return table;
  }

  async shutdownAll() {
    const ids = [...new Set([...this.sessions.keys(), ...this.connecting.keys(), ...this.monitorTimers.keys()])];
    for (const id of ids) {
      await this.disconnectInternal(id, false);
    }
    this.ephemeralUiPasswords.clear();
  }
}
