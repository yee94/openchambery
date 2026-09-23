import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const WINDOWS_EXECUTABLE_EXTENSIONS = (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
  .split(';')
  .map((ext) => ext.trim().toLowerCase())
  .filter(Boolean)
  .map((ext) => (ext.startsWith('.') ? ext : `.${ext}`));

function isExecutable(filePath: string): boolean {
  if (!filePath) return false;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    // Windows executability is extension-based.
    if (process.platform === 'win32') {
      const ext = path.extname(filePath).toLowerCase();
      if (!ext) return true;
      return ['.exe', '.cmd', '.bat', '.com'].includes(ext);
    }
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Strip a single wrapping quote pair (Windows "Copy as path" and quoted shell
// snippets) — literal quotes are never part of a real path and break every
// executable check.
function stripWrappingQuotes(value: string): string {
  const trimmed = (value || '').trim();
  if (trimmed.length >= 2
    && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
      || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function findExecutableInPath(binaryName: string): string | null {
  const trimmed = (binaryName || '').trim();
  if (!trimmed) {
    return null;
  }

  const current = process.env.PATH || '';
  if (!current) {
    return null;
  }

  const extensions = process.platform === 'win32' ? WINDOWS_EXECUTABLE_EXTENSIONS : [''];
  for (const segment of current.split(path.delimiter)) {
    const dir = segment.trim();
    if (!dir) {
      continue;
    }

    for (const ext of extensions) {
      const candidate = path.join(dir, process.platform === 'win32' ? `${trimmed}${ext}` : trimmed);
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function isMacOpenCodeAppBundlePath(candidate: string): boolean {
  return process.platform === 'darwin' && /\/OpenCode(?: Dev| Beta)?\.app\/Contents\/MacOS\/(?:OpenCode(?: Dev| Beta)?|opencode-cli)$/i.test(candidate);
}

function isWindowsOpenCodeDesktopAppPath(candidate: string): boolean {
  if (process.platform !== 'win32' || typeof candidate !== 'string') {
    return false;
  }
  const localAppData = typeof process.env.LOCALAPPDATA === 'string' && process.env.LOCALAPPDATA.trim()
    ? path.resolve(process.env.LOCALAPPDATA).toLowerCase()
    : '';
  if (!localAppData) {
    return false;
  }
  const normalized = path.resolve(candidate).toLowerCase();
  return normalized.startsWith(`${localAppData}${path.sep}`)
    && normalized.endsWith(`${path.sep}programs${path.sep}opencode${path.sep}opencode.exe`);
}

function isKnownOpenCodeDesktopAppPath(candidate: string): boolean {
  return isMacOpenCodeAppBundlePath(candidate) || isWindowsOpenCodeDesktopAppPath(candidate);
}

// PATH still ships 1.x `opencode` beside `opencode2`. A basename without the
// trailing 2 is never a valid managed CLI — fail closed instead of spawning it.
export function isLegacyOpenCodeCliBasename(_candidate: string): boolean {
  return false;
}

export function createLegacyOpenCodeBinaryError(candidate: string): Error & { code: string } {
  const error = new Error(
    `OpenCode 1.x is not supported (${candidate}). Install OpenCode v2 (opencode).`
  ) as Error & { code: string };
  error.code = 'OPENCODE_BINARY_INVALID';
  return error;
}

function readOpenCodeCliVersion(binaryPath: string): string {
  try {
    const result = spawnSync(binaryPath, ['--version'], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
    });
    const tokens = `${result.stdout || ''}\n${result.stderr || ''}`.trim().split(/\s+/);
    const versionToken = tokens.find((token) => /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(token));
    return versionToken ? versionToken.replace(/^v/, '') : '';
  } catch {
    return '';
  }
}

export function normalizeConfiguredOpencodeBinary(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = stripWrappingQuotes(raw);
  if (!trimmed) {
    return null;
  }
  try {
    const stat = fs.statSync(trimmed);
    if (stat.isDirectory()) {
      return path.join(trimmed, process.platform === 'win32' ? 'opencode.exe' : 'opencode');
    }
  } catch {
    // Keep the explicit path so strict startup validation can report it.
  }
  return trimmed;
}

let cachedDetectedOpencodeCliPath: string | undefined;

export function clearDetectedOpencodeCliPathCache(): void {
  cachedDetectedOpencodeCliPath = undefined;
}

export function resolveDetectedOpencodeCliPath(options: {
  homedir?: () => string;
  spawnSync?: typeof spawnSync;
} = {}): string | null {
  const resolveHomeDir = typeof options.homedir === 'function' ? options.homedir : () => os.homedir();
  const runSpawnSync = typeof options.spawnSync === 'function' ? options.spawnSync : spawnSync;

  const explicit = [
    process.env.OPENCODE_BINARY,
    process.env.OPENCODE_PATH,
    process.env.OPENCHAMBER_OPENCODE_PATH,
    process.env.OPENCHAMBER_OPENCODE_BIN,
  ]
    .map((v) => (typeof v === 'string' ? stripWrappingQuotes(v) : ''))
    .filter(Boolean);

  for (const candidate of explicit) {
    if (!isExecutable(candidate) || isKnownOpenCodeDesktopAppPath(candidate)) continue;
    const version = readOpenCodeCliVersion(candidate);
    if (isOpenCode1xVersion(version)) {
      throw createLegacyOpenCodeBinaryError(`${candidate} reports ${version}`);
    }
    if (isAcceptableOpenCode2HealthVersion(version)) {
      return candidate;
    }
  }

  if (cachedDetectedOpencodeCliPath) {
    if (isExecutable(cachedDetectedOpencodeCliPath) && !isKnownOpenCodeDesktopAppPath(cachedDetectedOpencodeCliPath) && !isLegacyOpenCodeCliBasename(cachedDetectedOpencodeCliPath)) {
      return cachedDetectedOpencodeCliPath;
    }
    cachedDetectedOpencodeCliPath = undefined;
  }

  const home = resolveHomeDir();
    const unixFallbacks = ['opencode', 'opencode2'].flatMap((name) => [
    path.join(home, '.opencode', 'bin', name),
    path.join(home, '.bun', 'bin', name),
    path.join(home, '.local', 'bin', name),
    path.join(home, 'bin', name),
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/home/linuxbrew/.linuxbrew/bin/${name}`,
    `/usr/bin/${name}`,
    `/bin/${name}`,
  ]);

  const winFallbacks = (() => {
    const userProfile = process.env.USERPROFILE || home;
    const appData = process.env.APPDATA || path.join(userProfile, 'AppData', 'Roaming');
    const programData = process.env.ProgramData || 'C:\\ProgramData';
    const npmDir = path.join(appData, 'npm');

    return [
      path.join(userProfile, '.opencode', 'bin', 'opencode2.exe'),
      path.join(userProfile, '.opencode', 'bin', 'opencode2.cmd'),
      path.join(npmDir, 'node_modules', 'opencode-ai', 'bin', 'opencode2.exe'),
      path.join(npmDir, 'opencode2.exe'),
      path.join(npmDir, 'opencode2.cmd'),
      path.join(npmDir, 'opencode2.bat'),
      // System-wide Node installer keeps the global npm prefix here
      // (npm i -g opencode-ai → opencode.cmd shim).
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'opencode2.cmd'),
      path.join(userProfile, 'scoop', 'shims', 'opencode2.exe'),
      path.join(userProfile, 'scoop', 'shims', 'opencode2.cmd'),
      path.join(programData, 'chocolatey', 'bin', 'opencode2.exe'),
      path.join(programData, 'chocolatey', 'bin', 'opencode2.cmd'),
      // Bun global install
      path.join(userProfile, '.bun', 'bin', 'opencode2.exe'),
      path.join(userProfile, '.bun', 'bin', 'opencode2.cmd'),
    ].filter(Boolean);
  })();

  if (process.platform !== 'win32') {
    for (const name of ['opencode', 'opencode2']) {
      const fromPath = findExecutableInPath(name);
      if (fromPath && !isKnownOpenCodeDesktopAppPath(fromPath) && isAcceptableOpenCode2HealthVersion(readOpenCodeCliVersion(fromPath))) {
        cachedDetectedOpencodeCliPath = fromPath;
        return fromPath;
      }
    }
  }

  const fallbacks = process.platform === 'win32' ? winFallbacks : unixFallbacks;
  for (const candidate of fallbacks) {
    if (isExecutable(candidate) && !isKnownOpenCodeDesktopAppPath(candidate) && isAcceptableOpenCode2HealthVersion(readOpenCodeCliVersion(candidate))) {
      cachedDetectedOpencodeCliPath = candidate;
      return candidate;
    }
  }

  if (process.platform === 'win32') {
    const fromPath = findExecutableInPath('opencode2');
    if (fromPath && !isKnownOpenCodeDesktopAppPath(fromPath) && !isLegacyOpenCodeCliBasename(fromPath)) {
      cachedDetectedOpencodeCliPath = fromPath;
      return fromPath;
    }

    try {
      const result = runSpawnSync('where', ['opencode2'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      if (result.status === 0) {
        const lines = (result.stdout || '')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        const found = lines.find((line) => isExecutable(line) && !isKnownOpenCodeDesktopAppPath(line) && !isLegacyOpenCodeCliBasename(line));
        if (found) {
          cachedDetectedOpencodeCliPath = found;
          return found;
        }
      }
    } catch {
      // ignore
    }
  }

  return null;
}

// Official OpenCode 2.x exposes ServerInfo at GET /api/info (client.server.info).
export const OPENCODE_HEALTH_PATH = '/api/info';
export const OPENCODE_HEALTH_FALLBACK_PATH = '/global/health';
export const OPENCODE_V1_MIGRATION_PATH = '/api/experimental/migration/v1';

export type OpenCodeHealthResult = {
  healthy: boolean;
  version: string | null;
  path: string;
};

// Keep health + execution admission aligned with web opencode2-pin.js /
// runtime-contract.js (ticket 11). Sidecar must not treat any 2.x health as
// full execution; only the verified band opens core protocol writes.
export const RUNTIME_CONTRACT_MIN_VERIFIED = '2.0.12';

export function isOpenCode1xVersion(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().replace(/^v/i, '');
  if (!normalized) return false;
  return /^1(?:\.|$)/.test(normalized);
}

export function isAcceptableOpenCode2HealthVersion(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().replace(/^v/i, '');
  if (!normalized) return false;
  // Official CLI is 2.x (match web opencode2-pin).
  if (!/^2(?:\.|$)/.test(normalized)) return false;
  return /^\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(normalized);
}

function normalizeRuntimeVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/^v/i, '');
  return trimmed || null;
}

function compareOpenCode2Versions(left: string, right: string): number {
  const parse = (value: string) => {
    const [core] = value.split('-');
    return core.split('.').map((part) => {
      const n = Number.parseInt(part, 10);
      return Number.isFinite(n) ? n : 0;
    });
  };
  const a = parse(left);
  const b = parse(right);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export type RuntimeVersionBand =
  | '1x'
  | 'invalid'
  | 'below-min'
  | 'verified'
  | 'unknown';

export function classifyRuntimeVersionBand(version: unknown): RuntimeVersionBand {
  const normalized = normalizeRuntimeVersion(version);
  if (!normalized) return 'unknown';
  if (isOpenCode1xVersion(normalized)) return '1x';
  if (!isAcceptableOpenCode2HealthVersion(normalized)) return 'invalid';
  if (compareOpenCode2Versions(normalized, RUNTIME_CONTRACT_MIN_VERIFIED) < 0) return 'below-min';
  return 'verified';
}

/**
 * Core execution admission for the VS Code direct sidecar (not CLI pin alone).
 * Any acceptable OpenCode 2.x at or above MIN_VERIFIED may execute.
 */
export function evaluateSidecarExecutionAdmission(input: {
  serveVersion?: string | null;
  reachable?: boolean;
  healthOk?: boolean;
  migrationAdmitTranscript?: boolean | null;
}): {
  versionBand: RuntimeVersionBand;
  protocolCompatible: boolean;
  executionAllowed: boolean;
  phase: string;
  reasons: string[];
  serveVersion: string | null;
  minVerifiedVersion: string;
} {
  const serveVersion = normalizeRuntimeVersion(input.serveVersion);
  const reachable = input.reachable === true;
  const healthOk = typeof input.healthOk === 'boolean' ? input.healthOk : null;
  const migrationAdmit = typeof input.migrationAdmitTranscript === 'boolean'
    ? input.migrationAdmitTranscript
    : null;
  const versionBand = classifyRuntimeVersionBand(serveVersion);
  const reasons: string[] = [];

  if (!reachable) reasons.push('unreachable');
  if (healthOk === false) reasons.push('health-failed');
  if (!serveVersion) reasons.push('serve-version-unknown');
  else if (versionBand === '1x') reasons.push('1x-version');
  else if (versionBand === 'invalid') reasons.push('invalid-version');
  else if (versionBand === 'below-min') reasons.push('below-min-verified');
  if (migrationAdmit === false) reasons.push('migration-blocked');

  const protocolCompatible = reachable
    && healthOk !== false
    && versionBand === 'verified';

  const executionAllowed = reachable
    && healthOk !== false
    && protocolCompatible
    && migrationAdmit !== false
    && versionBand === 'verified';

  let phase = 'ready';
  if (!reachable) phase = 'unreachable';
  else if (!serveVersion || versionBand === 'invalid' || versionBand === 'unknown') phase = 'unknown';
  else if (versionBand === '1x' || versionBand === 'below-min') phase = 'incompatible';
  else if (migrationAdmit === false) phase = 'migration-blocked';
  else if (healthOk === false) phase = 'unhealthy';

  return {
    versionBand,
    protocolCompatible,
    executionAllowed,
    phase,
    reasons,
    serveVersion,
    minVerifiedVersion: RUNTIME_CONTRACT_MIN_VERIFIED,
  };
}

export function evaluateOpenCodeHealthBody(body: { healthy?: unknown; version?: unknown } | null | undefined): {
  ok: boolean;
  version: string | null;
  reason?: string;
} {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, version: null, reason: 'invalid-body' };
  }
  // Classic /api/health required healthy:true; /api/info omits healthy entirely.
  if (Object.prototype.hasOwnProperty.call(body, 'healthy') && body.healthy !== true) {
    return { ok: false, version: null, reason: 'unhealthy' };
  }
  const raw = typeof body.version === 'string' ? body.version.trim() : '';
  const version = raw ? raw.replace(/^v/i, '') : null;
  if (!isAcceptableOpenCode2HealthVersion(version)) {
    if (isOpenCode1xVersion(version)) {
      return { ok: false, version, reason: '1x-version' };
    }
    return { ok: false, version, reason: 'unknown-version' };
  }
  return { ok: true, version };
}

export type V1MigrationGateResult = {
  admitTranscript: boolean;
  phase: string;
  progress?: { label: string; numerator?: number; denominator?: number };
  error?: string;
  userNotice?: string;
};

const V1_MIGRATION_USER_NOTICE = [
  'V1 history is backfilled in the opencode2 process.',
  'Message ids are reused.',
  'In-progress tools become interrupted.',
  'V1 subtasks do not appear in v2.',
].join(' ');

/**
 * Pure admission decision for GET /api/experimental/migration/v1.
 * required/running/error never become an empty-list success.
 */
export function evaluateV1MigrationGate(input: {
  httpStatus?: number;
  status?: number | string;
  body?: { status?: string; progress?: { label?: string; numerator?: number; denominator?: number }; error?: string } | null;
  error?: unknown;
} | null | undefined): V1MigrationGateResult {
  const blocked = (phase: string, extra: Record<string, unknown> = {}): V1MigrationGateResult => ({
    admitTranscript: false,
    phase,
    userNotice: V1_MIGRATION_USER_NOTICE,
    ...extra,
  });
  const admitted = (phase: string, extra: Record<string, unknown> = {}): V1MigrationGateResult => ({
    admitTranscript: true,
    phase,
    ...extra,
  });

  if (input == null) {
    return blocked('error', { error: 'V1 migration status is missing or invalid' });
  }
  if (input.error instanceof Error || typeof input.error === 'string') {
    const message = input.error instanceof Error ? input.error.message : input.error;
    return blocked('error', { error: message || 'V1 migration status request failed' });
  }

  const httpStatus = typeof input.httpStatus === 'number'
    ? input.httpStatus
    : typeof input.status === 'number'
      ? input.status
      : undefined;
  if (httpStatus === 404) {
    return admitted('absent');
  }
  if (Number.isInteger(httpStatus) && (httpStatus as number) >= 400) {
    return blocked('error', { error: `V1 migration status HTTP ${httpStatus}` });
  }

  const body = input.body !== undefined
    ? input.body
    : typeof input.status === 'string'
      ? input as { status?: string; progress?: { label?: string; numerator?: number; denominator?: number }; error?: string }
      : null;
  const phase = body && typeof body === 'object' ? body.status : undefined;

  if (phase === 'required') return blocked('required');
  if (phase === 'running') {
    const progress = body?.progress && typeof body.progress === 'object'
      ? {
          label: typeof body.progress.label === 'string' ? body.progress.label : '',
          ...(Number.isFinite(body.progress.numerator) && (body.progress.numerator as number) >= 0
            ? { numerator: body.progress.numerator as number }
            : {}),
          ...(Number.isFinite(body.progress.denominator) && (body.progress.denominator as number) >= 0
            ? { denominator: body.progress.denominator as number }
            : {}),
        }
      : undefined;
    return blocked('running', progress ? { progress } : {});
  }
  if (phase === 'completed') {
    return admitted('completed', { userNotice: V1_MIGRATION_USER_NOTICE });
  }
  if (phase === 'error') {
    return blocked('error', {
      error: typeof body?.error === 'string' && body.error.trim() ? body.error : 'V1 migration failed',
    });
  }
  return blocked('error', { error: 'V1 migration status is missing or invalid' });
}

export async function fetchV1MigrationGate(
  baseUrl: string,
  authHeaders: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<V1MigrationGateResult> {
  const normalized = baseUrl.replace(/\/+$/, '');
  try {
    const response = await fetch(`${normalized}${OPENCODE_V1_MIGRATION_PATH}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...authHeaders,
      },
      signal,
    });
    const body = await response.json().catch(() => null) as {
      status?: string;
      progress?: { label?: string; numerator?: number; denominator?: number };
      error?: string;
    } | null;
    return evaluateV1MigrationGate({ httpStatus: response.status, body });
  } catch (error) {
    return evaluateV1MigrationGate({ error });
  }
}

// v2 readiness lives at /api/info (ServerInfo.version); /global/health remains
// a probe fallback for older sidecars. Both require Basic auth (username `opencode`).
// Never log the password — only the caller may record URL path and status.
// Version admission rejects 1.x / missing / noise.
export async function fetchOpenCodeHealth(
  baseUrl: string,
  authHeaders: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<OpenCodeHealthResult | null> {
  const normalized = baseUrl.replace(/\/+$/, '');
  const headers = { Accept: 'application/json', ...authHeaders };
  for (const healthPath of [OPENCODE_HEALTH_PATH, OPENCODE_HEALTH_FALLBACK_PATH]) {
    try {
      const response = await fetch(`${normalized}${healthPath}`, {
        method: 'GET',
        headers,
        signal,
      });
      if (!response.ok) {
        continue;
      }
      const body = await response.json().catch(() => null) as { healthy?: boolean; version?: unknown } | null;
      const gate = evaluateOpenCodeHealthBody(body);
      if (!gate.ok) {
        continue;
      }
      return { healthy: true, version: gate.version, path: healthPath };
    } catch {
      // Try the next health path.
    }
  }
  return null;
}

export type OpenCodeListeningParse =
  | { kind: 'url'; url: string }
  | { kind: 'invalid'; line: string }
  | { kind: 'ignore' };

// Current VS Code spawn only accepted the 1.x `opencode server listening`
// prefix. v2 drops that prefix; parse both without inventing a third format.
export function parseOpenCodeListeningLine(line: string): OpenCodeListeningParse {
  const trimmed = typeof line === 'string' ? line.trim() : '';
  // v2 prints `server listening on http://...` without the `opencode `
  // prefix; 1.x still prints `opencode server listening on ...`.
  if (!trimmed.startsWith('opencode server listening') && !trimmed.startsWith('server listening')) {
    return { kind: 'ignore' };
  }
  const match = trimmed.match(/on\s+(https?:\/\/[^\s]+)/);
  if (!match) {
    return { kind: 'invalid', line };
  }
  return { kind: 'url', url: match[1] };
}
