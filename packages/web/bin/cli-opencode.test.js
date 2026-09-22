import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { checkOpenCodeCLI } from './cli.js';

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeVersionBinary(filePath, version) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (process.platform === 'win32') {
    fs.writeFileSync(filePath, `@echo off\r\necho ${version}\r\n`);
    return;
  }
  fs.writeFileSync(filePath, `#!${process.execPath}\nconsole.log(${JSON.stringify(version)});\n`);
  fs.chmodSync(filePath, 0o755);
}

async function withIsolatedOpenCodeEnv(fn) {
  const previousBinary = process.env.OPENCODE_BINARY;
  const previousPath = process.env.PATH;
  const previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
  const previousAutoInstall = process.env.OPENCHAMBER_OPENCODE2_AUTO_INSTALL;
  const dataDir = createTempDir('openchamber-cli-opencode-data-');
  process.env.OPENCHAMBER_DATA_DIR = dataDir;
  process.env.OPENCHAMBER_OPENCODE2_AUTO_INSTALL = '0';
  try {
    return await fn({ dataDir });
  } finally {
    if (typeof previousBinary === 'string') {
      process.env.OPENCODE_BINARY = previousBinary;
    } else {
      delete process.env.OPENCODE_BINARY;
    }
    if (typeof previousPath === 'string') {
      process.env.PATH = previousPath;
    } else {
      delete process.env.PATH;
    }
    if (typeof previousDataDir === 'string') {
      process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
    } else {
      delete process.env.OPENCHAMBER_DATA_DIR;
    }
    if (typeof previousAutoInstall === 'string') {
      process.env.OPENCHAMBER_OPENCODE2_AUTO_INSTALL = previousAutoInstall;
    } else {
      delete process.env.OPENCHAMBER_OPENCODE2_AUTO_INSTALL;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

describe('checkOpenCodeCLI v2 gate', () => {
  it('uses the same binary validation for TTY, non-TTY, --quiet, and --json notice styles', async () => {
    await withIsolatedOpenCodeEnv(async () => {
      const dir = createTempDir('openchamber-cli-mode-parity-');
      const binary = path.join(dir, process.platform === 'win32' ? 'opencode.exe' : 'opencode');
      writeVersionBinary(binary, '1.18.4');
      process.env.OPENCODE_BINARY = binary;
      const pathDir = createTempDir('openchamber-cli-mode-path-');
      writeVersionBinary(path.join(pathDir, process.platform === 'win32' ? 'opencode2.cmd' : 'opencode2'), '2.0.12');
      process.env.PATH = pathDir;

      const notices = [];
      const modes = [
        { json: true, quiet: false },
        { json: false, quiet: true },
        { json: false, quiet: false },
      ];
      try {
        for (const mode of modes) {
          await expect(checkOpenCodeCLI((notice) => notices.push({ mode, notice }))).rejects.toMatchObject({
            code: 'OPENCODE_BINARY_INVALID',
            message: expect.stringMatching(/1\.x.*OpenCode v2/s),
          });
        }
        expect(notices).toEqual([]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(pathDir, { recursive: true, force: true });
      }
    });
  });

  it('fails closed for opencode / opencode.exe / opencode.cmd and does not fall back to PATH', async () => {
    await withIsolatedOpenCodeEnv(async () => {
      const names = process.platform === 'win32'
        ? ['opencode.exe', 'opencode.cmd']
        : ['opencode', 'opencode.exe', 'opencode.cmd'];
      const pathDir = createTempDir('openchamber-cli-legacy-path-');
      const v2 = path.join(pathDir, process.platform === 'win32' ? 'opencode2.cmd' : 'opencode2');
      writeVersionBinary(v2, '2.0.12');
      process.env.PATH = pathDir;

      try {
        for (const name of names) {
          const dir = createTempDir(`openchamber-cli-legacy-${name}-`);
          const binary = path.join(dir, name);
          writeVersionBinary(binary, '1.18.4');
          process.env.OPENCODE_BINARY = binary;
          try {
            await expect(checkOpenCodeCLI()).rejects.toMatchObject({
              code: 'OPENCODE_BINARY_INVALID',
              message: expect.stringMatching(/1\.x.*OpenCode v2/s),
            });
            expect(process.env.OPENCODE_BINARY).toBe(binary);
          } finally {
            fs.rmSync(dir, { recursive: true, force: true });
          }
        }
      } finally {
        fs.rmSync(pathDir, { recursive: true, force: true });
      }
    });
  });

  it('discovers opencode2 from PATH and ignores a sibling 1.x opencode', async () => {
    await withIsolatedOpenCodeEnv(async () => {
      const pathDir = createTempDir('openchamber-cli-path-opencode2-');
      const legacy = path.join(pathDir, process.platform === 'win32' ? 'opencode.exe' : 'opencode');
      const binary = path.join(pathDir, process.platform === 'win32' ? 'opencode2.cmd' : 'opencode2');
      writeVersionBinary(legacy, '1.18.4');
      writeVersionBinary(binary, '2.0.12');
      process.env.PATH = pathDir;
      delete process.env.OPENCODE_BINARY;

      try {
        await expect(checkOpenCodeCLI()).resolves.toBe(binary);
        expect(process.env.OPENCODE_BINARY).toBe(binary);
      } finally {
        fs.rmSync(pathDir, { recursive: true, force: true });
      }
    });
  });

  it('fails closed when settings.opencodeBinary is a 1.x basename', async () => {
    await withIsolatedOpenCodeEnv(async ({ dataDir }) => {
      const dir = createTempDir('openchamber-cli-settings-1x-');
      const binary = path.join(dir, process.platform === 'win32' ? 'opencode.exe' : 'opencode');
      writeVersionBinary(binary, '1.18.4');
      fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ opencodeBinary: binary }));
      delete process.env.OPENCODE_BINARY;
      const pathDir = createTempDir('openchamber-cli-settings-path-');
      writeVersionBinary(path.join(pathDir, process.platform === 'win32' ? 'opencode2.cmd' : 'opencode2'), '2.0.12');
      process.env.PATH = pathDir;
      try {
        await expect(checkOpenCodeCLI()).rejects.toMatchObject({
          code: 'OPENCODE_BINARY_INVALID',
          message: expect.stringMatching(/1\.x.*OpenCode v2/s),
        });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(pathDir, { recursive: true, force: true });
      }
    });
  });

  it('accepts a configured opencode2 path after the v2 version gate', async () => {
    await withIsolatedOpenCodeEnv(async ({ dataDir }) => {
      const dir = createTempDir('openchamber-cli-settings-v2-');
      const binary = path.join(dir, process.platform === 'win32' ? 'opencode2.cmd' : 'opencode2');
      writeVersionBinary(binary, '2.0.12');
      fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ opencodeBinary: binary }));
      delete process.env.OPENCODE_BINARY;
      process.env.PATH = createTempDir('openchamber-cli-settings-empty-');
      try {
        await expect(checkOpenCodeCLI()).resolves.toBe(binary);
        expect(process.env.OPENCODE_BINARY).toBe(binary);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('names opencode2 when PATH lookup finds nothing', async () => {
    await withIsolatedOpenCodeEnv(async () => {
      delete process.env.OPENCODE_BINARY;
      process.env.PATH = createTempDir('openchamber-cli-missing-');
      await expect(checkOpenCodeCLI()).rejects.toThrow(/opencode/);
    });
  });

  it('installs pinned opencode2 when PATH has no usable binary', async () => {
    await withIsolatedOpenCodeEnv(async ({ dataDir }) => {
      delete process.env.OPENCODE_BINARY;
      process.env.PATH = createTempDir('openchamber-cli-install-missing-');
      const installed = path.join(dataDir, 'opencode-cli', '2.0.12', process.platform === 'win32' ? 'opencode2.exe' : 'opencode2');
      writeVersionBinary(installed, '2.0.12');
      const notices = [];
      await expect(checkOpenCodeCLI((notice) => notices.push(notice), {
        ensurePinnedOpenCode2Cli: async () => ({
          path: installed,
          version: '2.0.12',
          source: 'installed',
          installed: true,
        }),
      })).resolves.toBe(installed);
      expect(process.env.OPENCODE_BINARY).toBe(installed);
      expect(notices).toEqual([
        expect.objectContaining({ code: 'OPENCODE_CLI_INSTALLED' }),
      ]);
    });
  });
});
