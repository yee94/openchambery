import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {
  ElectronSshManager,
  attachProcessStderrTail,
  buildManagedServeEnvPrefix,
  createEphemeralUiPassword,
  formatMasterExitError,
  parseSshCommand,
} from './ssh-manager.mjs';
import { EventEmitter } from 'node:events';

const servers = [];
const tempDirs = [];

const listen = async (server) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
  return `http://127.0.0.1:${address.port}`;
};

const readBody = async (req) => {
  let body = '';
  for await (const chunk of req) body += chunk.toString();
  return body;
};

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    await new Promise((resolve) => server.close(() => resolve()));
  }
  while (tempDirs.length > 0) {
    await fsp.rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('parseSshCommand host:port destination', () => {
  test('rewrites scp-style user@host:port to destination + -p', () => {
    expect(parseSshCommand('ssh root@host:36000')).toEqual({
      destination: 'root@host',
      args: ['-p', '36000'],
    });
    expect(parseSshCommand('ssh host:22')).toEqual({
      destination: 'host',
      args: ['-p', '22'],
    });
    expect(parseSshCommand('ssh root@dev.example.com:36000')).toEqual({
      destination: 'root@dev.example.com',
      args: ['-p', '36000'],
    });
  });

  test('keeps explicit -p form and rejects host:port combined with -p', () => {
    expect(parseSshCommand('ssh root@host -p 36000')).toEqual({
      destination: 'root@host',
      args: ['-p', '36000'],
    });
    expect(parseSshCommand('ssh -p 36000 root@host')).toEqual({
      destination: 'root@host',
      args: ['-p', '36000'],
    });
    expect(() => parseSshCommand('ssh -p 36000 root@host:36000')).toThrow(/one form only/i);
    expect(() => parseSshCommand('ssh -p36000 root@host:36000')).toThrow(/one form only/i);
    expect(() => parseSshCommand('ssh root@host:36000 -p 36000')).toThrow(/one form only/i);
  });

  test('does not split bare IPv6 destinations', () => {
    expect(parseSshCommand('ssh root@2001:db8::1')).toEqual({
      destination: 'root@2001:db8::1',
      args: [],
    });
    expect(parseSshCommand('ssh root@::1')).toEqual({
      destination: 'root@::1',
      args: [],
    });
    // Bracketed IPv6 with port is left alone (use -p instead).
    expect(parseSshCommand('ssh root@[::1]:22')).toEqual({
      destination: 'root@[::1]:22',
      args: [],
    });
  });
});

describe('master stderr diagnostics', () => {
  test('formatMasterExitError includes stderr tail when present', () => {
    expect(formatMasterExitError('')).toBe('SSH master process exited before ready');
    expect(formatMasterExitError('   ')).toBe('SSH master process exited before ready');
    expect(formatMasterExitError('ssh: Could not resolve hostname host:36000')).toBe(
      'SSH master process exited before ready: ssh: Could not resolve hostname host:36000',
    );
  });

  test('attachProcessStderrTail captures a short tail from stderr data events', async () => {
    const child = { stderr: new EventEmitter() };
    const tail = attachProcessStderrTail(child, { maxChars: 80, maxLines: 3 });
    child.stderr.emit('data', Buffer.from('line-one\n'));
    child.stderr.emit('data', Buffer.from('line-two\n'));
    child.stderr.emit('data', Buffer.from('Could not resolve hostname bad.host:36000\n'));
    // Allow listeners to run.
    await Promise.resolve();
    const text = tail.getTail();
    expect(text).toContain('Could not resolve hostname bad.host:36000');
    expect(text.length).toBeLessThanOrEqual(80);
  });
});

describe('ElectronSshManager', () => {
  test('stores a client token for forwarded OpenChamber hosts when UI password is configured', async () => {
    let loginPayload = null;
    const server = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/auth/session') {
        loginPayload = JSON.parse(await readBody(req));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ authenticated: true, clientToken: 'ssh-client-token' }));
        return;
      }
      res.writeHead(404).end();
    });
    const localUrl = await listen(server);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-ssh-manager-test-'));
    tempDirs.push(tempDir);
    const settingsFilePath = path.join(tempDir, 'settings.json');
    const manager = new ElectronSshManager({
      settingsFilePath,
      appVersion: '0.0.0-test',
      emit: () => undefined,
    });

    const token = await manager.issueClientToken(localUrl, 'ui-secret');
    await manager.updateHostRuntime('ssh-1', 'SSH Host', localUrl, token);

    const settings = JSON.parse(fs.readFileSync(settingsFilePath, 'utf8'));
    expect(loginPayload).toMatchObject({
      password: 'ui-secret',
      trustDevice: true,
      issueClientToken: true,
    });
    expect(settings.desktopHosts).toEqual([{ id: 'ssh-1', label: 'SSH Host', url: localUrl, apiUrl: localUrl, clientToken: 'ssh-client-token' }]);
  });

  test('refuses to mint an SSH host token without a UI password', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-ssh-manager-test-'));
    tempDirs.push(tempDir);
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(tempDir, 'settings.json'),
      appVersion: '0.0.0-test',
      emit: () => undefined,
    });
    await expect(manager.issueClientToken('http://127.0.0.1:9', null)).rejects.toThrow(/UI password is required/i);
  });

  test('managed serve env always injects a UI password', () => {
    const password = createEphemeralUiPassword();
    expect(password).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(buildManagedServeEnvPrefix(password)).toBe(
      `OPENCHAMBER_RUNTIME=ssh-remote OPENCHAMBER_UI_PASSWORD='${password}'`,
    );
    expect(() => buildManagedServeEnvPrefix('')).toThrow(/requires a UI password/i);
  });

  test('mintSshHostToken issues and stores a token using the in-memory session password', async () => {
    let loginPayload = null;
    const server = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/auth/session') {
        loginPayload = JSON.parse(await readBody(req));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ authenticated: true, clientToken: 'minted-ssh-token' }));
        return;
      }
      res.writeHead(404).end();
    });
    const localUrl = await listen(server);
    const localPort = Number(new URL(localUrl).port);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-ssh-manager-test-'));
    tempDirs.push(tempDir);
    const settingsFilePath = path.join(tempDir, 'settings.json');
    const manager = new ElectronSshManager({
      settingsFilePath,
      appVersion: '0.0.0-test',
      emit: () => undefined,
    });
    manager.sessions.set('ssh-1', {
      localPort,
      uiPassword: 'ephemeral-secret',
      instance: { id: 'ssh-1', nickname: 'SSH Host' },
    });
    manager.statuses.set('ssh-1', { id: 'ssh-1', phase: 'ready' });

    const token = await manager.mintSshHostToken('ssh-1');
    expect(token).toBe('minted-ssh-token');
    expect(loginPayload).toMatchObject({
      password: 'ephemeral-secret',
      issueClientToken: true,
    });
    const settings = JSON.parse(fs.readFileSync(settingsFilePath, 'utf8'));
    expect(settings.desktopHosts).toEqual([{
      id: 'ssh-1',
      label: 'SSH Host',
      url: `http://127.0.0.1:${localPort}`,
      apiUrl: `http://127.0.0.1:${localPort}`,
      clientToken: 'minted-ssh-token',
    }]);
  });

  test('getRoutingTable includes only ready sessions with a finite localPort', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-ssh-manager-test-'));
    tempDirs.push(tempDir);
    const settingsFilePath = path.join(tempDir, 'settings.json');
    const manager = new ElectronSshManager({
      settingsFilePath,
      appVersion: '0.0.0-test',
      emit: () => undefined,
    });

    manager.sessions.set('ready-1', { localPort: 41234 });
    manager.statuses.set('ready-1', { id: 'ready-1', phase: 'ready' });

    manager.sessions.set('degraded-1', { localPort: 41235 });
    manager.statuses.set('degraded-1', { id: 'degraded-1', phase: 'degraded' });

    manager.sessions.set('ready-bad-port', { localPort: Number.NaN });
    manager.statuses.set('ready-bad-port', { id: 'ready-bad-port', phase: 'ready' });

    manager.sessions.set('connecting-1', { localPort: 41236 });
    manager.statuses.set('connecting-1', { id: 'connecting-1', phase: 'connecting' });

    expect(manager.getRoutingTable()).toEqual([{ id: 'ready-1', localPort: 41234 }]);
  });

  test('sanitizeInstance preserves lanForward enabled + sticky localPort', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-ssh-manager-test-'));
    tempDirs.push(tempDir);
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(tempDir, 'settings.json'),
      appVersion: '0.0.0-test',
      emit: () => undefined,
    });

    const sanitized = manager.sanitizeInstance({
      id: 'ssh-lan',
      sshCommand: 'ssh user@host.example',
      lanForward: { enabled: true, localPort: 45000 },
    });
    expect(sanitized.lanForward).toEqual({ enabled: true, localPort: 45000 });

    const off = manager.sanitizeInstance({
      id: 'ssh-lan-off',
      sshCommand: 'ssh user@host.example',
      lanForward: { enabled: false, localPort: 45001 },
    });
    expect(off.lanForward).toEqual({ enabled: false, localPort: 45001 });

    const absent = manager.sanitizeInstance({
      id: 'ssh-plain',
      sshCommand: 'ssh user@host.example',
    });
    expect(absent.lanForward).toBeUndefined();
  });

  test('rebuildLanForwardIfConfigured spawns 0.0.0.0 forward when enabled with a saved port', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-ssh-manager-test-'));
    tempDirs.push(tempDir);
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(tempDir, 'settings.json'),
      appVersion: '0.0.0-test',
      emit: () => undefined,
    });

    /** @type {unknown[]} */
    const forwards = [];
    manager.spawnExtraForward = async (_parsed, _controlPath, forward) => {
      forwards.push(forward);
    };

    await manager.rebuildLanForwardIfConfigured('ssh-1', {
      instance: { lanForward: { enabled: true, localPort: 45000 } },
      parsed: { destination: 'host' },
      controlPath: '/tmp/cp',
      remotePort: 3100,
    });

    expect(forwards).toEqual([{
      id: 'lan-forward',
      type: 'local',
      localHost: '0.0.0.0',
      localPort: 45000,
      remoteHost: '127.0.0.1',
      remotePort: 3100,
    }]);

    // disabled or missing port → no spawn
    await manager.rebuildLanForwardIfConfigured('ssh-1', {
      instance: { lanForward: { enabled: false, localPort: 45000 } },
      parsed: {},
      controlPath: '/tmp/cp',
      remotePort: 3100,
    });
    await manager.rebuildLanForwardIfConfigured('ssh-1', {
      instance: { lanForward: { enabled: true } },
      parsed: {},
      controlPath: '/tmp/cp',
      remotePort: 3100,
    });
    expect(forwards).toHaveLength(1);
  });

  test('ensureLanForward is idempotent with a sticky port and throws when not ready', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-ssh-manager-test-'));
    tempDirs.push(tempDir);
    const settingsFilePath = path.join(tempDir, 'settings.json');
    fs.writeFileSync(settingsFilePath, JSON.stringify({
      desktopSshInstances: [{
        id: 'ssh-1',
        sshCommand: 'ssh user@host.example',
        lanForward: { enabled: true, localPort: 45000 },
      }],
    }));
    const manager = new ElectronSshManager({
      settingsFilePath,
      appVersion: '0.0.0-test',
      emit: () => undefined,
    });

    /** @type {unknown[]} */
    const forwards = [];
    manager.spawnExtraForward = async (_parsed, _controlPath, forward) => {
      forwards.push(forward);
    };

    await expect(manager.ensureLanForward('ssh-1')).rejects.toThrow(/not ready/i);

    manager.sessions.set('ssh-1', {
      instance: { id: 'ssh-1', lanForward: { enabled: true, localPort: 45000 } },
      parsed: { destination: 'host' },
      controlPath: '/tmp/cp',
      localPort: 41000,
      remotePort: 3200,
    });
    manager.statuses.set('ssh-1', { id: 'ssh-1', phase: 'ready' });

    const first = await manager.ensureLanForward('ssh-1');
    const second = await manager.ensureLanForward('ssh-1');
    expect(first).toEqual({ localPort: 45000 });
    expect(second).toEqual({ localPort: 45000 });
    expect(forwards).toHaveLength(2);
    expect(forwards[0]).toMatchObject({
      localHost: '0.0.0.0',
      localPort: 45000,
      remoteHost: '127.0.0.1',
      remotePort: 3200,
      type: 'local',
    });
    expect(forwards[1]).toEqual(forwards[0]);
  });

  test('ensureLanForward allocates and persists a sticky LAN port when missing', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-ssh-manager-test-'));
    tempDirs.push(tempDir);
    const settingsFilePath = path.join(tempDir, 'settings.json');
    fs.writeFileSync(settingsFilePath, JSON.stringify({
      desktopSshInstances: [{
        id: 'ssh-1',
        sshCommand: 'ssh user@host.example',
        lanForward: { enabled: true },
      }],
    }));
    const manager = new ElectronSshManager({
      settingsFilePath,
      appVersion: '0.0.0-test',
      emit: () => undefined,
    });

    /** @type {unknown[]} */
    const forwards = [];
    manager.spawnExtraForward = async (_parsed, _controlPath, forward) => {
      forwards.push(forward);
    };

    manager.sessions.set('ssh-1', {
      instance: { id: 'ssh-1', lanForward: { enabled: true } },
      parsed: { destination: 'host' },
      controlPath: '/tmp/cp',
      localPort: 41000,
      remotePort: 3300,
    });
    manager.statuses.set('ssh-1', { id: 'ssh-1', phase: 'ready' });

    const result = await manager.ensureLanForward('ssh-1');
    expect(Number.isFinite(result.localPort) && result.localPort > 0).toBe(true);
    expect(result.localPort).not.toBe(41000);
    expect(forwards[0]).toMatchObject({
      localHost: '0.0.0.0',
      localPort: result.localPort,
      remotePort: 3300,
    });

    const settings = JSON.parse(fs.readFileSync(settingsFilePath, 'utf8'));
    expect(settings.desktopSshInstances[0].lanForward).toEqual({
      enabled: true,
      localPort: result.localPort,
    });
    // In-memory session stays aligned with the sticky port for reconnect rebuild.
    expect(manager.sessions.get('ssh-1').instance.lanForward).toEqual({
      enabled: true,
      localPort: result.localPort,
    });

    // Round-trip: reload settings via sanitize path keeps the port.
    const reloaded = manager.sanitizeInstance(settings.desktopSshInstances[0]);
    expect(reloaded.lanForward).toEqual({ enabled: true, localPort: result.localPort });
  });
});
