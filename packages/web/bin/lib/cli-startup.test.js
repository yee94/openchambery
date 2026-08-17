import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  assertOpenCode2Binary,
  collectStartupEnv,
  createLegacyOpenCodeBinaryError,
  isLegacyOpenCodeCliBasename,
  readConfiguredOpenCodeBinary,
  resolveOpenCode2BinaryForStartup,
} from './cli-startup.js';

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
  const dataDir = createTempDir('openchamber-startup-data-');
  process.env.OPENCHAMBER_DATA_DIR = dataDir;
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
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

describe('legacy OpenCode CLI basename', () => {
  it('fails closed for opencode / opencode.exe / opencode.cmd and names opencode2', () => {
    const names = ['opencode', 'opencode.exe', 'opencode.cmd'];
    for (const name of names) {
      const candidate = path.join('/usr/local/bin', name);
      expect(isLegacyOpenCodeCliBasename(candidate)).toBe(true);
      const error = createLegacyOpenCodeBinaryError(candidate);
      expect(error.code).toBe('OPENCODE_BINARY_INVALID');
      expect(error.message).toMatch(/reserved for 1\.x/);
      expect(error.message).toMatch(/opencode2 is missing/);
    }
  });

  it('does not treat opencode2 as a 1.x basename', () => {
    expect(isLegacyOpenCodeCliBasename('/usr/local/bin/opencode2')).toBe(false);
    expect(isLegacyOpenCodeCliBasename('/usr/local/bin/opencode2.exe')).toBe(false);
  });
});

describe('assertOpenCode2Binary', () => {
  it('rejects OPENCODE_BINARY whose basename is 1.x opencode', () => {
    const dir = createTempDir('openchamber-startup-1x-');
    const binary = path.join(dir, process.platform === 'win32' ? 'opencode.exe' : 'opencode');
    writeVersionBinary(binary, '0.0.0-next-17444');
    try {
      expect(() => assertOpenCode2Binary(binary)).toThrow(
        expect.objectContaining({
          code: 'OPENCODE_BINARY_INVALID',
          message: expect.stringMatching(/reserved for 1\.x.*opencode2/s),
        })
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an opencode2 path that reports a 1.x version', () => {
    const dir = createTempDir('openchamber-startup-1x-version-');
    const binary = path.join(dir, process.platform === 'win32' ? 'opencode2.cmd' : 'opencode2');
    writeVersionBinary(binary, '1.18.4');
    try {
      expect(() => assertOpenCode2Binary(binary)).toThrow(
        expect.objectContaining({
          code: 'OPENCODE_BINARY_INVALID',
          message: expect.stringMatching(/1\.x.*opencode2 is missing/s),
        })
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts an executable opencode2 that reports a v2 version', () => {
    const dir = createTempDir('openchamber-startup-v2-');
    const binary = path.join(dir, process.platform === 'win32' ? 'opencode2.cmd' : 'opencode2');
    writeVersionBinary(binary, '0.0.0-next-17444');
    try {
      expect(assertOpenCode2Binary(binary)).toBe(binary);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('collectStartupEnv OpenCode binary', () => {
  it('persists PATH opencode2 and ignores a sibling 1.x opencode', async () => {
    await withIsolatedOpenCodeEnv(async () => {
      const pathDir = createTempDir('openchamber-startup-path-');
      const legacy = path.join(pathDir, process.platform === 'win32' ? 'opencode.exe' : 'opencode');
      const binary = path.join(pathDir, process.platform === 'win32' ? 'opencode2.cmd' : 'opencode2');
      writeVersionBinary(legacy, '1.18.4');
      writeVersionBinary(binary, '0.0.0-next-17444');
      process.env.PATH = pathDir;
      delete process.env.OPENCODE_BINARY;

      try {
        const env = collectStartupEnv();
        expect(env.OPENCODE_BINARY).toBe(binary);
      } finally {
        fs.rmSync(pathDir, { recursive: true, force: true });
      }
    });
  });

  it('fails closed when OPENCODE_BINARY is a 1.x basename', async () => {
    await withIsolatedOpenCodeEnv(async () => {
      const dir = createTempDir('openchamber-startup-env-1x-');
      const binary = path.join(dir, process.platform === 'win32' ? 'opencode.exe' : 'opencode');
      writeVersionBinary(binary, '1.18.4');
      process.env.OPENCODE_BINARY = binary;
      process.env.PATH = createTempDir('openchamber-startup-empty-path-');
      try {
        expect(() => collectStartupEnv()).toThrow(
          expect.objectContaining({
            code: 'OPENCODE_BINARY_INVALID',
            message: expect.stringMatching(/opencode2 is missing/),
          })
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('fails closed when settings.opencodeBinary is a 1.x basename', async () => {
    await withIsolatedOpenCodeEnv(async ({ dataDir }) => {
      const dir = createTempDir('openchamber-startup-settings-1x-');
      const binary = path.join(dir, process.platform === 'win32' ? 'opencode.exe' : 'opencode');
      writeVersionBinary(binary, '1.18.4');
      fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ opencodeBinary: binary }));
      delete process.env.OPENCODE_BINARY;
      process.env.PATH = createTempDir('openchamber-startup-empty-path-settings-');
      try {
        expect(readConfiguredOpenCodeBinary()).toBe(binary);
        expect(() => resolveOpenCode2BinaryForStartup()).toThrow(
          expect.objectContaining({
            code: 'OPENCODE_BINARY_INVALID',
            message: expect.stringMatching(/reserved for 1\.x.*opencode2/s),
          })
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('does not persist OPENCODE_BINARY when opencode2 is missing', async () => {
    await withIsolatedOpenCodeEnv(async () => {
      delete process.env.OPENCODE_BINARY;
      process.env.PATH = createTempDir('openchamber-startup-missing-');
      const env = collectStartupEnv();
      expect(env.OPENCODE_BINARY).toBeUndefined();
    });
  });
});
