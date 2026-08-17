import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clearDetectedOpencodeCliPathCache,
  createLegacyOpenCodeBinaryError,
  fetchOpenCodeHealth,
  isLegacyOpenCodeCliBasename,
  parseOpenCodeListeningLine,
  resolveDetectedOpencodeCliPath,
} from './opencode-sidecar.ts';

const originalFetch = globalThis.fetch;
const originalOpencodeBinary = process.env.OPENCODE_BINARY;
const originalOpencodePath = process.env.OPENCODE_PATH;
const originalOpenchamberOpencodePath = process.env.OPENCHAMBER_OPENCODE_PATH;
const originalOpenchamberOpencodeBin = process.env.OPENCHAMBER_OPENCODE_BIN;
const originalPath = process.env.PATH;
const tempDirs = [];

const createTempDir = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

const writeExecutable = (filePath) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '#!/bin/sh\nexit 0\n');
  if (process.platform !== 'win32') {
    fs.chmodSync(filePath, 0o755);
  }
};

const unusedSpawnSync = () => ({ status: 1, stdout: '', stderr: '' });

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearDetectedOpencodeCliPathCache();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (typeof originalOpencodeBinary === 'string') {
    process.env.OPENCODE_BINARY = originalOpencodeBinary;
  } else {
    delete process.env.OPENCODE_BINARY;
  }
  if (typeof originalOpencodePath === 'string') {
    process.env.OPENCODE_PATH = originalOpencodePath;
  } else {
    delete process.env.OPENCODE_PATH;
  }
  if (typeof originalOpenchamberOpencodePath === 'string') {
    process.env.OPENCHAMBER_OPENCODE_PATH = originalOpenchamberOpencodePath;
  } else {
    delete process.env.OPENCHAMBER_OPENCODE_PATH;
  }
  if (typeof originalOpenchamberOpencodeBin === 'string') {
    process.env.OPENCHAMBER_OPENCODE_BIN = originalOpenchamberOpencodeBin;
  } else {
    delete process.env.OPENCHAMBER_OPENCODE_BIN;
  }
  if (typeof originalPath === 'string') {
    process.env.PATH = originalPath;
  } else {
    delete process.env.PATH;
  }
});

describe('parseOpenCodeListeningLine', () => {
  test('parses a v2 server listening line without the opencode prefix', () => {
    expect(parseOpenCodeListeningLine('server listening on http://127.0.0.1:45678')).toEqual({
      kind: 'url',
      url: 'http://127.0.0.1:45678',
    });
  });

  test('parses a legacy opencode server listening line', () => {
    expect(parseOpenCodeListeningLine('opencode server listening on http://127.0.0.1:4096')).toEqual({
      kind: 'url',
      url: 'http://127.0.0.1:4096',
    });
  });

  test('rejects a listening line that has no url', () => {
    expect(parseOpenCodeListeningLine('server listening without a url')).toEqual({
      kind: 'invalid',
      line: 'server listening without a url',
    });
  });
});

describe('fetchOpenCodeHealth', () => {
  test('probes /api/health with Basic auth before falling back to /global/health', async () => {
    const calls = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, authorization: headers.get('Authorization') ?? undefined });
      if (url.endsWith('/api/health')) {
        return new Response(JSON.stringify({ healthy: true, version: '0.0.0-next' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    };

    const result = await fetchOpenCodeHealth('http://127.0.0.1:45678', {
      Authorization: 'Basic b3BlbmNvZGU6c2VjcmV0',
    });

    expect(result).toEqual({
      healthy: true,
      version: '0.0.0-next',
      path: '/api/health',
    });
    expect(calls[0]?.url).toBe('http://127.0.0.1:45678/api/health');
    expect(calls[0]?.authorization).toMatch(/^Basic /);
    expect(calls.some((call) => call.url.includes('secret'))).toBe(false);
  });

  test('falls back to /global/health when /api/health is unavailable', async () => {
    const calls = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      calls.push(url);
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toMatch(/^Basic /);
      if (url.endsWith('/global/health')) {
        return new Response(JSON.stringify({ healthy: true, version: '1.15.0' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    };

    const result = await fetchOpenCodeHealth('http://127.0.0.1:45678/', {
      Authorization: 'Basic b3BlbmNvZGU6c2VjcmV0',
    });

    expect(calls).toEqual([
      'http://127.0.0.1:45678/api/health',
      'http://127.0.0.1:45678/global/health',
    ]);
    expect(result).toEqual({
      healthy: true,
      version: '1.15.0',
      path: '/global/health',
    });
  });
});

describe('legacy OpenCode CLI basename', () => {
  test('fails closed for opencode / opencode.exe / opencode.cmd and names opencode2', () => {
    const names = ['opencode', 'opencode.exe', 'opencode.cmd'];
    for (const name of names) {
      const candidate = path.join('/usr/local/bin', name);
      expect(isLegacyOpenCodeCliBasename(candidate)).toBe(true);
      const error = createLegacyOpenCodeBinaryError(candidate);
      expect(error.code).toBe('OPENCODE_BINARY_INVALID');
      expect(error.message).toMatch(/reserved for 1\.x/);
      expect(error.message).toMatch(/opencode2/);
    }
  });
});

describe('resolveDetectedOpencodeCliPath', () => {
  test('does not treat a PATH 1.x opencode binary as a resolved CLI', () => {
    const pathDir = createTempDir('openchamber-vscode-path-opencode-1x-');
    const pathBinary = path.join(pathDir, process.platform === 'win32' ? 'opencode.exe' : 'opencode');
    writeExecutable(pathBinary);
    process.env.PATH = pathDir;
    delete process.env.OPENCODE_BINARY;
    delete process.env.OPENCODE_PATH;
    delete process.env.OPENCHAMBER_OPENCODE_PATH;
    delete process.env.OPENCHAMBER_OPENCODE_BIN;
    const emptyHome = createTempDir('openchamber-vscode-empty-home-1x-');

    expect(resolveDetectedOpencodeCliPath({
      homedir: () => emptyHome,
      spawnSync: unusedSpawnSync,
    })).toBeNull();
  });

  test('discovers opencode2 from PATH and ignores a sibling 1.x opencode', () => {
    const pathDir = createTempDir('openchamber-vscode-path-opencode2-');
    const legacy = path.join(pathDir, process.platform === 'win32' ? 'opencode.exe' : 'opencode');
    const binary = path.join(pathDir, process.platform === 'win32' ? 'opencode2.exe' : 'opencode2');
    writeExecutable(legacy);
    writeExecutable(binary);
    process.env.PATH = pathDir;
    delete process.env.OPENCODE_BINARY;
    delete process.env.OPENCODE_PATH;
    delete process.env.OPENCHAMBER_OPENCODE_PATH;
    delete process.env.OPENCHAMBER_OPENCODE_BIN;
    const emptyHome = createTempDir('openchamber-vscode-empty-home-path2-');

    expect(resolveDetectedOpencodeCliPath({
      homedir: () => emptyHome,
      spawnSync: unusedSpawnSync,
    })).toBe(binary);
  });

  test('discovers opencode2 from a home-directory install location', () => {
    const home = createTempDir('openchamber-vscode-home-opencode2-');
    const binary = path.join(home, '.bun', 'bin', process.platform === 'win32' ? 'opencode2.exe' : 'opencode2');
    writeExecutable(binary);
    process.env.PATH = createTempDir('openchamber-vscode-empty-path-home-');
    delete process.env.OPENCODE_BINARY;
    delete process.env.OPENCODE_PATH;
    delete process.env.OPENCHAMBER_OPENCODE_PATH;
    delete process.env.OPENCHAMBER_OPENCODE_BIN;

    expect(resolveDetectedOpencodeCliPath({
      homedir: () => home,
      spawnSync: unusedSpawnSync,
    })).toBe(binary);
  });

  test('rejects an explicit OPENCODE_BINARY whose basename is 1.x opencode', () => {
    const dir = createTempDir('openchamber-vscode-env-opencode-1x-');
    const binary = path.join(dir, process.platform === 'win32' ? 'opencode.exe' : 'opencode');
    writeExecutable(binary);
    process.env.OPENCODE_BINARY = binary;

    expect(() => resolveDetectedOpencodeCliPath()).toThrow(
      expect.objectContaining({
        code: 'OPENCODE_BINARY_INVALID',
        message: expect.stringMatching(/opencode2/),
      }),
    );
  });
});
