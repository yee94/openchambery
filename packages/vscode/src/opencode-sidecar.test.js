import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clearDetectedOpencodeCliPathCache,
  createLegacyOpenCodeBinaryError,
  evaluateSidecarExecutionAdmission,
  evaluateV1MigrationGate,
  fetchOpenCodeHealth,
  fetchV1MigrationGate,
  isLegacyOpenCodeCliBasename,
  parseOpenCodeListeningLine,
  resolveDetectedOpencodeCliPath,
  RUNTIME_CONTRACT_MIN_VERIFIED,
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

const writeVersionBinary = (filePath, version) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `#!${process.execPath}\nconsole.log(${JSON.stringify(version)});\n`);
  fs.chmodSync(filePath, 0o755);
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

describe('evaluateSidecarExecutionAdmission (ticket 11)', () => {
  test('admits verified serve for core execution', () => {
    const result = evaluateSidecarExecutionAdmission({
      serveVersion: '2.0.12',
      reachable: true,
      healthOk: true,
      migrationAdmitTranscript: true,
    });
    expect(result.executionAllowed).toBe(true);
    expect(result.phase).toBe('ready');
    expect(result.versionBand).toBe('verified');
    expect(result.minVerifiedVersion).toBe(RUNTIME_CONTRACT_MIN_VERIFIED);
  });

  test('admits newer 2.x and blocks below-min', () => {
    const newer = evaluateSidecarExecutionAdmission({
      serveVersion: '2.0.15',
      reachable: true,
      healthOk: true,
      migrationAdmitTranscript: true,
    });
    expect(newer.phase).toBe('ready');
    expect(newer.executionAllowed).toBe(true);
    expect(newer.protocolCompatible).toBe(true);

    const older = evaluateSidecarExecutionAdmission({
      serveVersion: '2.0.5',
      reachable: true,
      healthOk: true,
      migrationAdmitTranscript: true,
    });
    expect(older.phase).toBe('incompatible');
    expect(older.executionAllowed).toBe(false);
  });
});

describe('fetchOpenCodeHealth', () => {
  test('probes /api/info with Basic auth before falling back to /global/health', async () => {
    const calls = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, authorization: headers.get('Authorization') ?? undefined });
      if (url.endsWith('/api/info')) {
        return new Response(JSON.stringify({ version: '2.0.12', pid: 1, urls: [], paths: { tmp: '/tmp' } }), {
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
      version: '2.0.12',
      path: '/api/info',
    });
    expect(calls[0]?.url).toBe('http://127.0.0.1:45678/api/info');
    expect(calls[0]?.authorization).toMatch(/^Basic /);
    expect(calls.some((call) => call.url.includes('secret'))).toBe(false);
  });

  test('falls back to /global/health when /api/info is unavailable', async () => {
    const calls = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      calls.push(url);
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toMatch(/^Basic /);
      if (url.endsWith('/global/health')) {
        return new Response(JSON.stringify({ healthy: true, version: '2.0.12' }), {
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
      'http://127.0.0.1:45678/api/info',
      'http://127.0.0.1:45678/global/health',
    ]);
    expect(result).toEqual({
      healthy: true,
      version: '2.0.12',
      path: '/global/health',
    });
  });

  test('rejects healthy 1.x version bodies instead of admitting the sidecar', async () => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/api/info') || url.endsWith('/global/health')) {
        return new Response(JSON.stringify({ healthy: true, version: '1.15.0' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    };

    const result = await fetchOpenCodeHealth('http://127.0.0.1:45678', {
      Authorization: 'Basic b3BlbmNvZGU6c2VjcmV0',
    });
    expect(result).toBeNull();
  });

  test('rejects healthy bodies with a missing version', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ healthy: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    expect(await fetchOpenCodeHealth('http://127.0.0.1:45678')).toBeNull();
  });
});

describe('V1 migration gate (VS Code)', () => {
  test('required/running/error block and completed/absent admit', () => {
    expect(evaluateV1MigrationGate({ status: 'required' }).admitTranscript).toBe(false);
    expect(evaluateV1MigrationGate({ status: 'running' }).admitTranscript).toBe(false);
    expect(evaluateV1MigrationGate({ status: 'error', error: 'x' }).admitTranscript).toBe(false);
    expect(evaluateV1MigrationGate({ status: 'completed' }).admitTranscript).toBe(true);
    expect(evaluateV1MigrationGate({ httpStatus: 404 }).admitTranscript).toBe(true);
  });

  test('fetchV1MigrationGate polls GET only', async () => {
    const calls = [];
    globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), method: init?.method });
      return new Response(JSON.stringify({ status: 'completed' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const gate = await fetchV1MigrationGate('http://127.0.0.1:45678', {
      Authorization: 'Basic b3BlbmNvZGU6c2VjcmV0',
    });
    expect(gate.admitTranscript).toBe(true);
    expect(calls[0].url).toContain('/api/experimental/migration/v1');
    expect(calls[0].method).toBe('GET');
  });
});

describe('legacy OpenCode CLI basename', () => {
  test('does not reject the official v2 binary name opencode', () => {
    expect(isLegacyOpenCodeCliBasename('/usr/local/bin/opencode')).toBe(false);
    expect(createLegacyOpenCodeBinaryError('/usr/local/bin/opencode').message).toMatch(/OpenCode v2/);
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

  test('discovers official opencode from PATH and ignores the opencode2 alias', () => {
    const pathDir = createTempDir('openchamber-vscode-path-opencode2-');
    const legacy = path.join(pathDir, process.platform === 'win32' ? 'opencode2.exe' : 'opencode2');
    const binary = path.join(pathDir, process.platform === 'win32' ? 'opencode.exe' : 'opencode');
    writeVersionBinary(legacy, '2.0.15');
    writeVersionBinary(binary, '2.0.12');
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

  test('discovers opencode from a home-directory install location', () => {
    const home = createTempDir('openchamber-vscode-home-opencode2-');
    const binary = path.join(home, '.bun', 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode');
    writeVersionBinary(binary, '2.0.12');
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
    writeVersionBinary(binary, '1.18.4');
    process.env.OPENCODE_BINARY = binary;

    expect(() => resolveDetectedOpencodeCliPath()).toThrow(
      expect.objectContaining({
        code: 'OPENCODE_BINARY_INVALID',
        message: expect.stringMatching(/1\.x.*OpenCode v2/s),
      }),
    );
  });
});
