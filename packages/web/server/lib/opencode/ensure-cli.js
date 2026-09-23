import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PINNED_OPENCODE2_VERSION,
  isAcceptableOpenCode2HealthVersion,
  isOpenCode2VersionAtLeast,
  npmPackageForOpenCode2,
  openCodeBinaryName,
  parseOpenCode2VersionOutput,
} from './opencode2-pin.js';

const INSTALL_FETCH_TIMEOUT_MS = 30_000;

export function isOpenCode2AutoInstallEnabled(env = process.env) {
  const value = typeof env.OPENCHAMBER_OPENCODE2_AUTO_INSTALL === 'string'
    ? env.OPENCHAMBER_OPENCODE2_AUTO_INSTALL.trim().toLowerCase()
    : '';
  return value !== '0' && value !== 'false' && value !== 'no';
}

export function resolveOpenChamberDataDir(env = process.env, homedir = os.homedir) {
  if (typeof env.OPENCHAMBER_DATA_DIR === 'string' && env.OPENCHAMBER_DATA_DIR.trim()) {
    return path.resolve(env.OPENCHAMBER_DATA_DIR.trim());
  }
  const home = typeof homedir === 'function' ? homedir() : homedir;
  return path.join(home, '.config', 'openchamber');
}

export function installedOpenCode2BinaryPath(version = PINNED_OPENCODE2_VERSION, options = {}) {
  const dataDir = options.dataDir || resolveOpenChamberDataDir(options.env, options.homedir);
  return path.join(dataDir, 'opencode-cli', version, openCodeBinaryName(options.platform));
}

export function readOpenCode2BinaryVersion(binaryPath, options = {}) {
  if (typeof binaryPath !== 'string' || !binaryPath.trim()) return '';
  const run = typeof options.spawnSync === 'function' ? options.spawnSync : spawnSync;
  try {
    const result = run(binaryPath, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 8_000,
      windowsHide: true,
    });
    if (result.status !== 0) return '';
    return parseOpenCode2VersionOutput(`${result.stdout || ''}\n${result.stderr || ''}`);
  } catch {
    return '';
  }
}

const resolveNpmRegistry = (options = {}) => {
  const env = options.env || process.env;
  const electronRoot = options.electronRoot;
  const candidates = [
    env.NPM_CONFIG_REGISTRY,
    options.cwd ? path.join(options.cwd, '.npmrc') : null,
    electronRoot ? path.join(electronRoot, '.npmrc') : null,
    path.join(os.homedir(), '.npmrc'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (!String(candidate).endsWith('.npmrc')) {
        if (/^https?:\/\//.test(candidate)) return String(candidate).replace(/\/+$/, '');
        continue;
      }
      if (!fs.existsSync(candidate)) continue;
      const match = fs.readFileSync(candidate, 'utf8').match(/^\s*registry\s*=\s*(\S+)\s*$/m);
      if (match) return match[1].replace(/\/+$/, '');
    } catch {
      // Ignore unreadable npmrc candidates and fall back to the default registry.
    }
  }
  return 'https://registry.npmjs.org';
};

const downloadBuffer = async (url, fetchImpl, timeoutMs) => {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
};

const extractArchive = (archivePath, destination, run) => {
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  if (archivePath.endsWith('.zip')) {
    if (process.platform === 'win32') {
      run('powershell.exe', [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `Expand-Archive -LiteralPath ${JSON.stringify(archivePath)} -DestinationPath ${JSON.stringify(destination)} -Force`,
      ]);
      return;
    }
    run('unzip', ['-q', archivePath, '-d', destination]);
    return;
  }
  if (archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tgz')) {
    run('tar', ['-xzf', archivePath, '-C', destination]);
    return;
  }
  throw new Error(`Unsupported opencode2 CLI archive: ${archivePath}`);
};

const findBinary = (root, binaryName) => {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === binaryName.toLowerCase()) {
      return fullPath;
    }
    if (entry.isDirectory()) {
      const found = findBinary(fullPath, binaryName);
      if (found) return found;
    }
  }
  return null;
};

export async function installPinnedOpenCode2Cli(options = {}) {
  const version = options.version || PINNED_OPENCODE2_VERSION;
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const dataDir = options.dataDir || resolveOpenChamberDataDir(options.env, options.homedir);
  const binaryName = openCodeBinaryName(platform);
  const outputBinary = installedOpenCode2BinaryPath(version, { dataDir, platform });
  const run = typeof options.spawnSync === 'function' ? options.spawnSync : spawnSync;
  const fetchImpl = typeof options.fetch === 'function' ? options.fetch : fetch;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : INSTALL_FETCH_TIMEOUT_MS;

  const cacheDir = path.join(dataDir, 'opencode-cli', '.cache', version, `${platform}-${arch}`);
  const archivePath = path.join(cacheDir, 'opencode2-cli.tgz');
  const packageName = npmPackageForOpenCode2(platform, arch);

  if (!fs.existsSync(archivePath)) {
    const registry = resolveNpmRegistry(options);
    const metadataResponse = await fetchImpl(`${registry}/${encodeURIComponent(packageName)}/${version}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!metadataResponse.ok) {
      throw new Error(
        `Failed to resolve ${packageName}@${version} on ${registry}: ${metadataResponse.status} ${metadataResponse.statusText}`,
      );
    }
    const metadata = await metadataResponse.json();
    const tarball = metadata?.dist?.tarball;
    if (typeof tarball !== 'string' || !/^https?:\/\//.test(tarball)) {
      throw new Error(`No tarball found for ${packageName}@${version} on ${registry}`);
    }
    const bytes = await downloadBuffer(tarball, fetchImpl, timeoutMs);
    fs.mkdirSync(path.dirname(archivePath), { recursive: true });
    const temp = `${archivePath}.tmp`;
    fs.writeFileSync(temp, bytes);
    fs.renameSync(temp, archivePath);
  }

  const extractDir = options.extractDir || path.join(cacheDir, 'extract');
  if (typeof options.extract === 'function') {
    await options.extract(archivePath, extractDir);
  } else {
    extractArchive(archivePath, extractDir, (command, args) => {
      const result = run(command, args, {
        encoding: 'utf8',
        stdio: 'pipe',
        windowsHide: true,
      });
      if (result.status !== 0) {
        const stderr = result.stderr ? `\n${result.stderr.trim()}` : '';
        const stdout = result.stdout ? `\n${result.stdout.trim()}` : '';
        throw new Error(`Command failed: ${command} ${args.join(' ')}${stderr}${stdout}`);
      }
      return result;
    });
  }

  const extractedBinary = findBinary(extractDir, binaryName);
  if (!extractedBinary) {
    throw new Error(`Archive ${archivePath} did not contain ${binaryName} or opencode`);
  }

  fs.mkdirSync(path.dirname(outputBinary), { recursive: true });
  fs.copyFileSync(extractedBinary, outputBinary);
  if (platform !== 'win32') {
    fs.chmodSync(outputBinary, 0o755);
  }

  const preparedVersion = readOpenCode2BinaryVersion(outputBinary, options);
  if (preparedVersion !== version) {
    throw new Error(`Installed opencode2 version mismatch: expected ${version}, got ${preparedVersion || 'unknown'}`);
  }
  return outputBinary;
}

/**
 * Reuse any discovered acceptable 2.x CLI. Install the pin only when nothing
 * usable is already installed (global PATH, explicit override, or cache).
 */
export async function ensurePinnedOpenCode2Cli(input = {}) {
  const pin = input.pin || PINNED_OPENCODE2_VERSION;
  const discoveredPath = typeof input.discoveredPath === 'string' ? input.discoveredPath.trim() : '';
  const autoInstall = input.autoInstall ?? isOpenCode2AutoInstallEnabled(input.env);
  const readVersion = typeof input.readVersion === 'function'
    ? input.readVersion
    : (binaryPath) => readOpenCode2BinaryVersion(binaryPath, input);
  const install = typeof input.install === 'function' ? input.install : installPinnedOpenCode2Cli;

  if (discoveredPath) {
    const version = readVersion(discoveredPath);
    if (isAcceptableOpenCode2HealthVersion(version)) {
      return { path: discoveredPath, version, source: 'discovered', installed: false };
    }
  }

  const cached = installedOpenCode2BinaryPath(pin, input);
  const cachedVersion = readVersion(cached);
  if (cachedVersion === pin || isOpenCode2VersionAtLeast(cachedVersion, pin)) {
    return { path: cached, version: cachedVersion, source: 'installed', installed: false };
  }

  if (!autoInstall) {
    const error = new Error(
      `Unable to locate opencode ${pin}. Set OPENCODE_BINARY or install @opencode/cli@${pin}.`,
    );
    error.code = 'OPENCODE_CLI_MISSING';
    throw error;
  }

  const installedPath = await install({ ...input, version: pin });
  const version = readVersion(installedPath) || pin;
  return { path: installedPath, version, source: 'installed', installed: true };
}
