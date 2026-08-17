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
export function isLegacyOpenCodeCliBasename(candidate: string): boolean {
  if (typeof candidate !== 'string' || candidate.trim().length === 0) {
    return false;
  }
  if (isKnownOpenCodeDesktopAppPath(candidate)) {
    return false;
  }
  const name = path.basename(candidate.trim()).toLowerCase();
  return name === 'opencode' || name === 'opencode.exe' || name === 'opencode.cmd';
}

export function createLegacyOpenCodeBinaryError(candidate: string): Error & { code: string } {
  const error = new Error(
    `Basename opencode is reserved for 1.x (${candidate}); rename or symlink to opencode2.`
  ) as Error & { code: string };
  error.code = 'OPENCODE_BINARY_INVALID';
  return error;
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
      return path.join(trimmed, process.platform === 'win32' ? 'opencode2.exe' : 'opencode2');
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
    if (isLegacyOpenCodeCliBasename(candidate)) {
      throw createLegacyOpenCodeBinaryError(candidate);
    }
    if (isExecutable(candidate) && !isKnownOpenCodeDesktopAppPath(candidate)) {
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
  const unixFallbacks = [
    path.join(home, '.opencode', 'bin', 'opencode2'),
    path.join(home, '.bun', 'bin', 'opencode2'),
    path.join(home, '.local', 'bin', 'opencode2'),
    path.join(home, 'bin', 'opencode2'),
    '/opt/homebrew/bin/opencode2',
    '/usr/local/bin/opencode2',
    '/home/linuxbrew/.linuxbrew/bin/opencode2',
    '/usr/bin/opencode2',
    '/bin/opencode2',
  ];

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
    const fromPath = findExecutableInPath('opencode2');
    if (fromPath && !isKnownOpenCodeDesktopAppPath(fromPath) && !isLegacyOpenCodeCliBasename(fromPath)) {
      cachedDetectedOpencodeCliPath = fromPath;
      return fromPath;
    }
  }

  const fallbacks = process.platform === 'win32' ? winFallbacks : unixFallbacks;
  for (const candidate of fallbacks) {
    if (isExecutable(candidate) && !isKnownOpenCodeDesktopAppPath(candidate) && !isLegacyOpenCodeCliBasename(candidate)) {
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

export const OPENCODE_HEALTH_PATH = '/api/health';
export const OPENCODE_HEALTH_FALLBACK_PATH = '/global/health';

export type OpenCodeHealthResult = {
  healthy: boolean;
  version: string | null;
  path: string;
};

// v2 health lives at /api/health; /global/health remains a probe fallback
// for older sidecars. Both require Basic auth (username `opencode`).
// Never log the password — only the caller may record URL path and status.
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
      if (body?.healthy !== true) {
        continue;
      }
      const version = typeof body.version === 'string' && body.version.trim().length > 0
        ? body.version.trim().replace(/^v/, '')
        : null;
      return { healthy: true, version, path: healthPath };
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
