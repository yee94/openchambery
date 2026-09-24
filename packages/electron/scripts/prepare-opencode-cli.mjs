import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTargetArchitecture } from './target-architecture.mjs';
import {
  PINNED_OPENCODE2_VERSION,
  bundledOpenCode2BinaryName,
  npmPackageForOpenCode2,
  parseOpenCode2VersionOutput,
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
  return parseOpenCode2VersionOutput(result.stdout) || null;
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

// 读取 npm registry 配置，优先用户/项目 .npmrc 指定的镜像。
const resolveNpmRegistry = () => {
  const candidates = [
    process.env.NPM_CONFIG_REGISTRY,
    path.join(process.cwd(), '.npmrc'),
    path.join(electronRoot, '.npmrc'),
    path.join(os.homedir(), '.npmrc'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (!candidate.endsWith('.npmrc')) {
        if (/^https?:\/\//.test(candidate)) return candidate.replace(/\/+$/, '');
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

const downloadNpmTarball = async (packageName, version, destination) => {
  const registry = resolveNpmRegistry();
  // scoped 包的 metadata URL 需要编码 `/`
  const encodedName = encodeURIComponent(packageName);
  const response = await fetch(`${registry}/${encodedName}/${version}`);
  if (!response.ok) {
    throw new Error(`Failed to resolve ${packageName}@${version} on ${registry}: ${response.status} ${response.statusText}`);
  }
  const metadata = await response.json();
  const tarball = metadata?.dist?.tarball;
  if (typeof tarball !== 'string' || !/^https?:\/\//.test(tarball)) {
    throw new Error(`No tarball found for ${packageName}@${version} on ${registry}`);
  }
  // dist.tarball 由 registry 返回，跟随 registry 本身（镜像场景无需改写）。
  await download(tarball, destination);
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
  if (archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tgz')) {
    // Git Bash GNU tar treats "D:..." as a remote host. --force-local keeps the drive path local.
    const args = process.platform === 'win32'
      ? ['--force-local', '-xzf', archivePath, '-C', destination]
      : ['-xzf', archivePath, '-C', destination];
    run('tar', args);
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
  const binaryName = bundledOpenCode2BinaryName(process.platform);
  const outputBinary = outputBinaryPath(binaryName);
  const existingVersion = readBinaryVersion(outputBinary);
  if (existingVersion === version) {
    console.log(`[electron] bundled opencode2 already prepared: ${outputBinary} (${version})`);
    return;
  }

  const cacheDir = path.join(cacheRoot, version, `${process.platform}-${targetArchitecture.opencode}`);
  const archivePath = path.join(cacheDir, 'opencode2-cli.tgz');
  // opencode2 v2 只发 npm 平台包（@opencode/cli-<os>-<arch>[-baseline]），
  // 上游没有对应的 GitHub release 二进制。
  const packageName = npmPackageForOpenCode2(process.platform, targetArchitecture);
  if (!fs.existsSync(archivePath)) {
    console.log(`[electron] downloading opencode2 ${version}: ${packageName}`);
    await downloadNpmTarball(packageName, version, archivePath);
  } else {
    console.log(`[electron] using cached opencode2 archive: ${archivePath}`);
  }

  const extractDir = path.join(cacheDir, 'extract');
  extractArchive(archivePath, extractDir);
  // Official 2.x platform tarballs and staged resources both use `bin/opencode`.
  const extractedBinary = findBinary(extractDir, binaryName);
  if (!extractedBinary) {
    throw new Error(`Archive ${archivePath} did not contain ${binaryName} or opencode`);
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
