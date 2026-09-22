import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createOpenCodeEnvRuntime } from './env-runtime.js';

const originalOpencodeBinary = process.env.OPENCODE_BINARY;
const originalComSpec = process.env.ComSpec;
const originalPath = process.env.PATH;
const originalLocalAppData = process.env.LOCALAPPDATA;
const originalSystemRoot = process.env.SystemRoot;
const originalBundledOpencodeCliDir = process.env.OPENCHAMBER_BUNDLED_OPENCODE_CLI_DIR;
const originalOpenChamberDataDir = process.env.OPENCHAMBER_DATA_DIR;
const originalResourcesPath = process.resourcesPath;
const originalWslBinary = process.env.WSL_BINARY;
const originalOpenChamberWslBinary = process.env.OPENCHAMBER_WSL_BINARY;
const originalPlatform = process.platform;
const tempDirs = [];
const itIf = (condition) => condition ? it : it.skip;

const createTempDir = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

const writeVersionBinary = (filePath, version) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (process.platform === 'win32') {
    fs.writeFileSync(filePath, `@echo off\r\necho ${version}\r\n`);
    return;
  }
  fs.writeFileSync(filePath, `#!${process.execPath}\nconsole.log(${JSON.stringify(version)});\n`);
  fs.chmodSync(filePath, 0o755);
};

const setPlatform = (platform) => {
  Object.defineProperty(process, 'platform', {
    value: platform,
  });
};

afterEach(() => {
  Object.defineProperty(process, 'platform', {
    value: originalPlatform,
  });

  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (typeof originalOpencodeBinary === 'string') {
    process.env.OPENCODE_BINARY = originalOpencodeBinary;
  } else {
    delete process.env.OPENCODE_BINARY;
  }

  if (typeof originalComSpec === 'string') {
    process.env.ComSpec = originalComSpec;
  } else {
    delete process.env.ComSpec;
  }

  if (typeof originalPath === 'string') {
    process.env.PATH = originalPath;
  } else {
    delete process.env.PATH;
  }

  if (typeof originalSystemRoot === 'string') {
    process.env.SystemRoot = originalSystemRoot;
  } else {
    delete process.env.SystemRoot;
  }

  if (typeof originalLocalAppData === 'string') {
    process.env.LOCALAPPDATA = originalLocalAppData;
  } else {
    delete process.env.LOCALAPPDATA;
  }

  if (typeof originalBundledOpencodeCliDir === 'string') {
    process.env.OPENCHAMBER_BUNDLED_OPENCODE_CLI_DIR = originalBundledOpencodeCliDir;
  } else {
    delete process.env.OPENCHAMBER_BUNDLED_OPENCODE_CLI_DIR;
  }

  if (typeof originalOpenChamberDataDir === 'string') {
    process.env.OPENCHAMBER_DATA_DIR = originalOpenChamberDataDir;
  } else {
    delete process.env.OPENCHAMBER_DATA_DIR;
  }

  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    value: originalResourcesPath,
  });

  if (typeof originalWslBinary === 'string') {
    process.env.WSL_BINARY = originalWslBinary;
  } else {
    delete process.env.WSL_BINARY;
  }

  if (typeof originalOpenChamberWslBinary === 'string') {
    process.env.OPENCHAMBER_WSL_BINARY = originalOpenChamberWslBinary;
  } else {
    delete process.env.OPENCHAMBER_WSL_BINARY;
  }
});

const createRuntime = (settings, options = {}) => {
  const state = {
    cachedLoginShellEnvSnapshot: null,
    resolvedOpencodeBinary: null,
    resolvedOpencodeBinarySource: null,
    useWslForOpencode: false,
    resolvedWslBinary: null,
    resolvedWslOpencodePath: null,
    resolvedWslDistro: null,
    resolvedNodeBinary: null,
    resolvedBunBinary: null,
    managedOpenCodeShellEnvSnapshot: null,
  };

  const runtime = createOpenCodeEnvRuntime({
    state,
    normalizeDirectoryPath: (value) => value,
    readSettingsFromDiskMigrated: async () => settings,
    spawnSync: options.spawnSync,
    homedir: options.homedir,
    ensurePinnedOpenCode2Cli: options.ensurePinnedOpenCode2Cli,
  });

  return { runtime, state };
};

describe('OpenCode env runtime', () => {
  it('throws a specific error for a missing configured OpenCode binary in strict mode', async () => {
    const { runtime } = createRuntime({ opencodeBinary: '/missing/opencode2' });

    await expect(runtime.applyOpencodeBinaryFromSettings({ strict: true })).rejects.toMatchObject({
      code: 'OPENCODE_BINARY_INVALID',
      message: expect.stringContaining('Configured OpenCode binary not found: /missing/opencode2'),
    });
  });

  it('throws a specific error for a configured directory without an executable CLI in strict mode', async () => {
    const dir = createTempDir('openchamber-opencode-dir-');
    const { runtime } = createRuntime({ opencodeBinary: dir });

    await expect(runtime.applyOpencodeBinaryFromSettings({ strict: true })).rejects.toMatchObject({
      code: 'OPENCODE_BINARY_INVALID',
      message: expect.stringContaining('Configured OpenCode binary directory does not contain an executable'),
    });
  });

  it('applies a valid configured executable OpenCode binary', async () => {
    const dir = createTempDir('openchamber-opencode-bin-');
    const binary = path.join(dir, 'opencode2');
    fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(binary, 0o755);
    const { runtime, state } = createRuntime({ opencodeBinary: binary });

    await expect(runtime.applyOpencodeBinaryFromSettings({ strict: true })).resolves.toBe(binary);
    expect(process.env.OPENCODE_BINARY).toBe(binary);
    expect(state.resolvedOpencodeBinary).toBe(binary);
    expect(state.resolvedOpencodeBinarySource).toBe('settings');
  });

  it('skips a configured 1.x opencode version instead of aborting startup', async () => {
    const dir = createTempDir('openchamber-opencode-1x-');
    const binary = path.join(dir, 'opencode');
    writeVersionBinary(binary, '1.18.4');
    const { runtime } = createRuntime({ opencodeBinary: binary });

    await expect(runtime.applyOpencodeBinaryFromSettings({ strict: true })).resolves.toBeNull();
    expect(process.env.OPENCODE_BINARY).not.toBe(binary);
  });

  it('skips an explicit OPENCODE_BINARY that reports a 1.x version', () => {
    const dir = createTempDir('openchamber-env-opencode-1x-');
    const binary = path.join(dir, process.platform === 'win32' ? 'opencode.exe' : 'opencode');
    writeVersionBinary(binary, '1.18.4');
    process.env.OPENCODE_BINARY = binary;
    const { runtime } = createRuntime({});

    expect(runtime.resolveOpencodeCliPath()).not.toBe(binary);
  });

  it('discovers opencode from a home-directory install location', () => {
    const home = createTempDir('openchamber-home-opencode-');
    const binary = path.join(home, '.bun', 'bin', 'opencode');
    writeVersionBinary(binary, '2.0.12');
    process.env.PATH = createTempDir('openchamber-empty-path-home-');
    delete process.env.OPENCODE_BINARY;
    delete process.env.OPENCHAMBER_BUNDLED_OPENCODE_CLI_DIR;
    const { runtime, state } = createRuntime({}, {
      spawnSync: () => ({ status: 1, stdout: '', stderr: '' }),
      homedir: () => home,
    });

    expect(runtime.resolveOpencodeCliPath()).toBe(binary);
    expect(state.resolvedOpencodeBinarySource).toBe('fallback');
  });

  it('does not treat a PATH 1.x opencode binary as a resolved CLI', () => {
    const pathDir = createTempDir('openchamber-path-opencode-1x-');
    const pathBinary = path.join(pathDir, process.platform === 'win32' ? 'opencode.exe' : 'opencode');
    fs.writeFileSync(pathBinary, '#!/bin/sh\nexit 0\n');
    if (process.platform !== 'win32') {
      fs.chmodSync(pathBinary, 0o755);
    }
    process.env.PATH = pathDir;
    delete process.env.OPENCODE_BINARY;
    delete process.env.OPENCHAMBER_BUNDLED_OPENCODE_CLI_DIR;
    const emptyHome = createTempDir('openchamber-empty-home-1x-');
    const { runtime, state } = createRuntime({}, {
      spawnSync: () => ({ status: 1, stdout: '', stderr: '' }),
      homedir: () => emptyHome,
    });

    expect(runtime.resolveOpencodeCliPath()).toBeNull();
    expect(state.resolvedOpencodeBinarySource).toBeNull();
  });

  it('prefers a user-installed OpenCode from PATH over the bundled CLI', () => {
    const bundledDir = createTempDir('openchamber-bundled-opencode-');
    const bundledBinary = path.join(bundledDir, process.platform === 'win32' ? 'opencode2.exe' : 'opencode2');
    const pathDir = createTempDir('openchamber-path-opencode-');
    const pathBinary = path.join(pathDir, process.platform === 'win32' ? 'opencode.exe' : 'opencode');
    fs.writeFileSync(bundledBinary, '#!/bin/sh\nexit 0\n');
    writeVersionBinary(pathBinary, '2.0.12');
    if (process.platform !== 'win32') {
      fs.chmodSync(bundledBinary, 0o755);
    }
    process.env.OPENCHAMBER_BUNDLED_OPENCODE_CLI_DIR = bundledDir;
    process.env.PATH = pathDir;
    delete process.env.OPENCODE_BINARY;
    const { runtime, state } = createRuntime({});

    expect(runtime.resolveOpencodeCliPath()).toBe(pathBinary);
    expect(state.resolvedOpencodeBinarySource).toBe('path');
  });

  it('keeps explicit OpenCode binary ahead of bundled CLI', () => {
    const bundledDir = createTempDir('openchamber-bundled-opencode-');
    const bundledBinary = path.join(bundledDir, process.platform === 'win32' ? 'opencode2.exe' : 'opencode2');
    const explicitDir = createTempDir('openchamber-explicit-opencode-');
    const explicitBinary = path.join(explicitDir, process.platform === 'win32' ? 'opencode2.exe' : 'opencode2');
    fs.writeFileSync(bundledBinary, '#!/bin/sh\nexit 0\n');
    writeVersionBinary(explicitBinary, '2.0.12');
    if (process.platform !== 'win32') {
      fs.chmodSync(bundledBinary, 0o755);
    }
    process.env.OPENCHAMBER_BUNDLED_OPENCODE_CLI_DIR = bundledDir;
    process.env.OPENCODE_BINARY = explicitBinary;
    const { runtime, state } = createRuntime({});

    expect(runtime.resolveOpencodeCliPath()).toBe(explicitBinary);
    expect(state.resolvedOpencodeBinarySource).toBe('env');
  });

  it('does not use a bundled OpenCode CLI from Electron resourcesPath', () => {
    const resourcesPath = createTempDir('openchamber-resources-');
    const bundledDir = path.join(resourcesPath, 'opencode-cli');
    const bundledBinary = path.join(bundledDir, process.platform === 'win32' ? 'opencode2.exe' : 'opencode2');
    fs.mkdirSync(bundledDir, { recursive: true });
    fs.writeFileSync(bundledBinary, '#!/bin/sh\nexit 0\n');
    if (process.platform !== 'win32') {
      fs.chmodSync(bundledBinary, 0o755);
    }
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: resourcesPath,
    });
    process.env.PATH = createTempDir('openchamber-empty-path-');
    process.env.OPENCHAMBER_BUNDLED_OPENCODE_CLI_DIR = bundledDir;
    delete process.env.OPENCODE_BINARY;
    const emptyHome = createTempDir('openchamber-empty-home-');
    const { runtime, state } = createRuntime({}, {
      spawnSync: () => ({ status: 1, stdout: '', stderr: '' }),
      homedir: () => emptyHome,
    });

    expect(runtime.resolveOpencodeCliPath()).toBeNull();
    expect(state.resolvedOpencodeBinarySource).toBeNull();
  });

  it('discovers a previously installed pin from the OpenChamber data dir', () => {
    const dataDir = createTempDir('openchamber-installed-cli-');
    const installedDir = path.join(dataDir, 'opencode-cli', '2.0.12');
    const installedBinary = path.join(installedDir, process.platform === 'win32' ? 'opencode.exe' : 'opencode');
    fs.mkdirSync(installedDir, { recursive: true });
    fs.writeFileSync(installedBinary, '#!/bin/sh\nexit 0\n');
    if (process.platform !== 'win32') {
      fs.chmodSync(installedBinary, 0o755);
    }
    process.env.OPENCHAMBER_DATA_DIR = dataDir;
    process.env.PATH = createTempDir('openchamber-empty-path-installed-');
    delete process.env.OPENCODE_BINARY;
    delete process.env.OPENCHAMBER_BUNDLED_OPENCODE_CLI_DIR;
    const emptyHome = createTempDir('openchamber-empty-home-installed-');
    const { runtime, state } = createRuntime({}, {
      spawnSync: () => ({ status: 1, stdout: '', stderr: '' }),
      homedir: () => emptyHome,
    });

    expect(runtime.resolveOpencodeCliPath()).toBe(installedBinary);
    expect(state.resolvedOpencodeBinarySource).toBe('installed');
  });

  it('installs the pinned CLI when discovery finds nothing', async () => {
    const installed = path.join(createTempDir('openchamber-ensure-install-'), process.platform === 'win32' ? 'opencode2.exe' : 'opencode2');
    fs.writeFileSync(installed, '#!/bin/sh\nexit 0\n');
    if (process.platform !== 'win32') {
      fs.chmodSync(installed, 0o755);
    }
    process.env.PATH = createTempDir('openchamber-empty-path-ensure-');
    delete process.env.OPENCODE_BINARY;
    delete process.env.OPENCHAMBER_BUNDLED_OPENCODE_CLI_DIR;
    const emptyHome = createTempDir('openchamber-empty-home-ensure-');
    const { runtime, state } = createRuntime({}, {
      spawnSync: () => ({ status: 1, stdout: '', stderr: '' }),
      homedir: () => emptyHome,
      ensurePinnedOpenCode2Cli: async () => ({
        path: installed,
        version: '2.0.12',
        source: 'installed',
        installed: true,
      }),
    });

    await expect(runtime.ensurePinnedOpenCode2CliEnv()).resolves.toBe(installed);
    expect(state.resolvedOpencodeBinary).toBe(installed);
    expect(state.resolvedOpencodeBinarySource).toBe('installed');
    expect(process.env.OPENCODE_BINARY).toBe(installed);
  });

  it('falls back to a bundled 2.x CLI only after pin install fails', async () => {
    const bundledDir = createTempDir('openchamber-bundled-fallback-');
    const bundledName = process.platform === 'win32' ? 'opencode2.exe' : 'opencode2';
    const bundledBinary = path.join(bundledDir, bundledName);
    writeVersionBinary(bundledBinary, '2.0.12');
    process.env.OPENCHAMBER_BUNDLED_OPENCODE_CLI_DIR = bundledDir;
    process.env.PATH = createTempDir('openchamber-empty-path-bundled-fallback-');
    process.env.OPENCHAMBER_DATA_DIR = createTempDir('openchamber-empty-data-bundled-fallback-');
    delete process.env.OPENCODE_BINARY;
    const emptyHome = createTempDir('openchamber-empty-home-bundled-fallback-');
    const missingError = Object.assign(new Error('OpenCode CLI missing'), { code: 'OPENCODE_CLI_MISSING' });
    const { runtime, state } = createRuntime({}, {
      spawnSync: () => ({ status: 1, stdout: '', stderr: '' }),
      homedir: () => emptyHome,
      ensurePinnedOpenCode2Cli: async () => {
        throw missingError;
      },
    });

    await expect(runtime.ensurePinnedOpenCode2CliEnv()).resolves.toBe(bundledBinary);
    expect(state.resolvedOpencodeBinary).toBe(bundledBinary);
    expect(state.resolvedOpencodeBinarySource).toBe('bundled');
    expect(process.env.OPENCODE_BINARY).toBe(bundledBinary);
  });

  it('falls back to bundled opencode name when pin install fails', async () => {
    const bundledDir = createTempDir('openchamber-bundled-opencode-name-');
    const bundledName = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
    const bundledBinary = path.join(bundledDir, bundledName);
    writeVersionBinary(bundledBinary, '2.0.12');
    process.env.OPENCHAMBER_BUNDLED_OPENCODE_CLI_DIR = bundledDir;
    process.env.PATH = createTempDir('openchamber-empty-path-bundled-opencode-');
    process.env.OPENCHAMBER_DATA_DIR = createTempDir('openchamber-empty-data-bundled-opencode-');
    delete process.env.OPENCODE_BINARY;
    const emptyHome = createTempDir('openchamber-empty-home-bundled-opencode-');
    const missingError = Object.assign(new Error('OpenCode CLI missing'), { code: 'OPENCODE_CLI_MISSING' });
    const { runtime, state } = createRuntime({}, {
      spawnSync: () => ({ status: 1, stdout: '', stderr: '' }),
      homedir: () => emptyHome,
      ensurePinnedOpenCode2Cli: async () => {
        throw missingError;
      },
    });

    await expect(runtime.ensurePinnedOpenCode2CliEnv()).resolves.toBe(bundledBinary);
    expect(state.resolvedOpencodeBinarySource).toBe('bundled');
    expect(process.env.OPENCODE_BINARY).toBe(bundledBinary);
  });

  it('does not adopt a bundled 1.x CLI after pin install fails', async () => {
    const bundledDir = createTempDir('openchamber-bundled-1x-');
    const bundledName = process.platform === 'win32' ? 'opencode2.exe' : 'opencode2';
    const bundledBinary = path.join(bundledDir, bundledName);
    writeVersionBinary(bundledBinary, '1.18.4');
    process.env.OPENCHAMBER_BUNDLED_OPENCODE_CLI_DIR = bundledDir;
    process.env.PATH = createTempDir('openchamber-empty-path-bundled-1x-');
    process.env.OPENCHAMBER_DATA_DIR = createTempDir('openchamber-empty-data-bundled-1x-');
    delete process.env.OPENCODE_BINARY;
    const emptyHome = createTempDir('openchamber-empty-home-bundled-1x-');
    const missingError = Object.assign(new Error('OpenCode CLI missing'), { code: 'OPENCODE_CLI_MISSING' });
    const { runtime, state } = createRuntime({}, {
      spawnSync: () => ({ status: 1, stdout: '', stderr: '' }),
      homedir: () => emptyHome,
      ensurePinnedOpenCode2Cli: async () => {
        throw missingError;
      },
    });

    await expect(runtime.ensurePinnedOpenCode2CliEnv()).rejects.toMatchObject({
      code: 'OPENCODE_CLI_MISSING',
    });
    expect(state.resolvedOpencodeBinary).toBeNull();
    expect(state.resolvedOpencodeBinarySource).toBeNull();
    expect(process.env.OPENCODE_BINARY).toBeUndefined();
  });

  itIf(process.platform === 'darwin')('rejects known macOS OpenCode app bundle executable paths', async () => {
    const { runtime } = createRuntime({ opencodeBinary: '/Applications/OpenCode.app/Contents/MacOS/OpenCode' });

    await expect(runtime.applyOpencodeBinaryFromSettings({ strict: true })).rejects.toMatchObject({
      code: 'OPENCODE_BINARY_INVALID',
      message: expect.stringContaining('macOS desktop app bundle'),
    });
  });

  it('rejects known Windows OpenCode desktop app install paths', async () => {
    setPlatform('win32');
    const localAppData = createTempDir('openchamber-localappdata-');
    const desktopBinary = path.join(localAppData, 'Programs', 'OpenCode', 'OpenCode.exe');
    fs.mkdirSync(path.dirname(desktopBinary), { recursive: true });
    fs.writeFileSync(desktopBinary, '');
    process.env.LOCALAPPDATA = localAppData;
    const { runtime } = createRuntime({ opencodeBinary: desktopBinary });

    await expect(runtime.applyOpencodeBinaryFromSettings({ strict: true })).rejects.toMatchObject({
      code: 'OPENCODE_BINARY_INVALID',
      message: expect.stringContaining('Windows desktop app install'),
    });
  });

  it('does not auto-detect the Windows OpenCode desktop app as a CLI', () => {
    setPlatform('win32');
    const localAppData = createTempDir('openchamber-localappdata-');
    const desktopBinary = path.join(localAppData, 'Programs', 'OpenCode', 'OpenCode.exe');
    fs.mkdirSync(path.dirname(desktopBinary), { recursive: true });
    fs.writeFileSync(desktopBinary, '');
    process.env.LOCALAPPDATA = localAppData;
    process.env.PATH = createTempDir('openchamber-empty-path-');
    process.env.SystemRoot = createTempDir('openchamber-empty-systemroot-');
    delete process.env.OPENCODE_BINARY;
    const { runtime } = createRuntime({}, {
      spawnSync: () => ({ status: 1, stdout: '', stderr: '' }),
    });

    expect(runtime.resolveOpencodeCliPath()).toBeNull();
  });

  it('skips Windows OpenCode desktop app entries returned by where.exe', () => {
    setPlatform('win32');
    const localAppData = createTempDir('openchamber-localappdata-');
    const desktopBinary = path.join(localAppData, 'Programs', 'OpenCode', 'OpenCode.exe');
    const cliBinary = path.join(createTempDir('openchamber-cli-'), 'opencode.exe');
    fs.mkdirSync(path.dirname(desktopBinary), { recursive: true });
    fs.writeFileSync(desktopBinary, '');
    fs.writeFileSync(cliBinary, `#!${process.execPath}\nconsole.log('2.0.12');\n`);
    fs.chmodSync(cliBinary, 0o755);
    process.env.LOCALAPPDATA = localAppData;
    process.env.PATH = createTempDir('openchamber-empty-path-');
    process.env.SystemRoot = createTempDir('openchamber-empty-systemroot-');
    delete process.env.OPENCODE_BINARY;
    const { runtime, state } = createRuntime({}, {
      spawnSync: () => ({ status: 0, stdout: `${desktopBinary}\r\n${cliBinary}\r\n`, stderr: '' }),
    });

    expect(runtime.resolveOpencodeCliPath()).toBe(cliBinary);
    expect(state.resolvedOpencodeBinarySource).toBe('where');
  });

  it('rejects WSL settings in strict mode', async () => {
    setPlatform('win32');
    const dir = createTempDir('openchamber-no-wsl-');
    process.env.PATH = dir;
    process.env.SystemRoot = dir;
    process.env.WSL_BINARY = path.join(dir, 'missing-wsl.exe');
    process.env.OPENCHAMBER_WSL_BINARY = path.join(dir, 'missing-openchamber-wsl.exe');
    const { runtime } = createRuntime({ opencodeBinary: 'wsl:/usr/local/bin/opencode' });

    await expect(runtime.applyOpencodeBinaryFromSettings({ strict: true })).rejects.toMatchObject({
      message: expect.stringContaining('uses WSL'),
    });
  });

  it('does not auto-detect OpenCode from WSL fallback paths', () => {
    setPlatform('win32');
    const dir = createTempDir('openchamber-wsl-opencode-');
    const wslBinary = path.join(dir, 'wsl.exe');
    fs.writeFileSync(wslBinary, '');
    process.env.PATH = dir;
    process.env.SystemRoot = dir;
    process.env.WSL_BINARY = wslBinary;
    delete process.env.OPENCODE_BINARY;

    const calls = [];
    const spawnSyncMock = (command, args) => {
      calls.push({ command, args });
      if (command === 'where') {
        return { status: 1, stdout: '', stderr: '' };
      }
      if (command === wslBinary) {
        return { status: 0, stdout: '/home/alice/.opencode/bin/opencode\n', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: '' };
    };
    const { runtime, state } = createRuntime({}, { spawnSync: spawnSyncMock });

    expect(runtime.resolveOpencodeCliPath()).toBeNull();
    expect(state.useWslForOpencode).toBe(false);
    expect(state.resolvedWslBinary).toBeNull();
    expect(state.resolvedWslOpencodePath).toBeNull();
    expect(state.resolvedOpencodeBinarySource).toBeNull();

    const wslCall = calls.find((call) => call.command === wslBinary);
    expect(wslCall).toBeUndefined();
  });

  it('launches Windows cmd shims through cmd call without embedded quotes', () => {
    setPlatform('win32');
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe';
    const dir = createTempDir('openchamber-opencode-cmd-');
    const shim = path.join(dir, 'opencode.cmd');
    fs.writeFileSync(shim, '@echo off\r\nexit /b 0\r\n');
    const { runtime } = createRuntime({});

    expect(runtime.resolveManagedOpenCodeLaunchSpec(shim)).toEqual({
      binary: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'call', shim],
      wrapperType: 'cmd-wrapper',
    });
  });

  it('resolves npm OpenCode cmd shims to the packaged Windows executable', () => {
    setPlatform('win32');
    const npmDir = createTempDir('openchamber-opencode-npm-');
    const shim = path.join(npmDir, 'opencode.cmd');
    const nativeBinary = path.join(npmDir, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
    fs.mkdirSync(path.dirname(nativeBinary), { recursive: true });
    fs.writeFileSync(nativeBinary, '');
    fs.writeFileSync(shim, '@ECHO off\r\n"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe" %*\r\n');
    const { runtime } = createRuntime({});

    expect(runtime.resolveManagedOpenCodeLaunchSpec(shim)).toEqual({
      binary: nativeBinary,
      args: [],
      wrapperType: 'native-wrapper',
    });
  });
});
