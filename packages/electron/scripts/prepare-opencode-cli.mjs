import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTargetArchitecture } from './target-architecture.mjs';
import {
  PINNED_OPENCODE2_VERSION,
  artifactForOpenCode2,
} from './opencode2-bundle-contract.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronRoot = path.resolve(__dirname, '..');
const outputDir = path.join(electronRoot, 'resources', 'opencode-cli');
const cacheRoot = path.join(electronRoot, '.cache', 'opencode-cli');

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
    windowsHide: true,
    ...options,
  });
  if (result.status !== 0) {
    const stderr = result.stderr ? `\n${result.stderr.trim()}` : '';
    const stdout = result.stdout ? `\n${result.stdout.trim()}` : '';
    throw new Error(`Command failed: ${command} ${args.join(' ')}${stderr}${stdout}`);
  }
  return result;
};

const readPinnedOpenCode2Version = () => {
  const version = process.env.OPENCHAMBER_OPENCODE2_VERSION || process.env.OPENCHAMBER_OPENCODE_CLI_VERSION || PINNED_OPENCODE2_VERSION;
  const trimmed = typeof version === 'string' ? version.trim() : '';
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(trimmed)) {
    throw new Error(`opencode2 must be pinned to an exact version for desktop CLI bundling, got: ${trimmed || '(missing)'}`);
  }
  return trimmed;
};

const outputBinaryPath = (binaryName) => path.join(outputDir, binaryName);

const readBinaryVersion = (binaryPath) => {
  if (!fs.existsSync(binaryPath)) return null;
  const result = spawnSync(binaryPath, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15000,
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  return (result.stdout || '').trim().split(/\s+/)[0] || null;
};

const ensureExecutable = (filePath) => {
  if (process.platform !== 'win32') {
    fs.chmodSync(filePath, 0o755);
  }
};

const download = async (url, destination) => {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  const temp = `${destination}.tmp`;
  fs.writeFileSync(temp, Buffer.from(await response.arrayBuffer()));
  fs.renameSync(temp, destination);
};

const extractArchive = (archivePath, destination) => {
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
  if (archivePath.endsWith('.tar.gz')) {
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

const main = async () => {
  const version = readPinnedOpenCode2Version();
  const targetArchitecture = resolveTargetArchitecture();
  const artifact = artifactForOpenCode2(process.platform, targetArchitecture);
  const outputBinary = outputBinaryPath(artifact.binary);
  const existingVersion = readBinaryVersion(outputBinary);
  if (existingVersion === version) {
    console.log(`[electron] bundled opencode2 already prepared: ${outputBinary} (${version})`);
    return;
  }

  const cacheDir = path.join(cacheRoot, version, `${process.platform}-${targetArchitecture.opencode}`);
  const archivePath = path.join(cacheDir, artifact.name);
  const url = `https://github.com/anomalyco/opencode/releases/download/v${version}/${artifact.name}`;
  if (!fs.existsSync(archivePath)) {
    console.log(`[electron] downloading opencode2 ${version}: ${artifact.name}`);
    await download(url, archivePath);
  } else {
    console.log(`[electron] using cached opencode2 archive: ${archivePath}`);
  }

  const extractDir = path.join(cacheDir, 'extract');
  extractArchive(archivePath, extractDir);
  const extractedBinary = findBinary(extractDir, artifact.binary);
  if (!extractedBinary) {
    throw new Error(`Archive ${archivePath} did not contain ${artifact.binary}`);
  }

  fs.mkdirSync(outputDir, { recursive: true });
  for (const entry of fs.readdirSync(outputDir)) {
    if (entry === '.gitkeep') continue;
    fs.rmSync(path.join(outputDir, entry), { recursive: true, force: true });
  }
  fs.copyFileSync(extractedBinary, outputBinary);
  ensureExecutable(outputBinary);

  const preparedVersion = readBinaryVersion(outputBinary);
  if (preparedVersion !== version) {
    throw new Error(`Prepared opencode2 version mismatch: expected ${version}, got ${preparedVersion || 'unknown'}`);
  }

  console.log(`[electron] prepared opencode2 ${version}: ${outputBinary}`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
