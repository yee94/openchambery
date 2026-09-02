import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {
  ElectronSshManager,
  attachProcessStderrTail,
  buildManagedServeCommand,
  buildManagedServeEnvPrefix,
  buildRelayHostFlag,
  buildRemoteManagedNodeSelectionFunctions,
  buildRemoteManagedRuntimePrefix,
  buildRemoteNativeBindingRepairScript,
  classifyManagedSshBootstrapError,
  summarizeManagedSshBootstrapError,
  buildRemoteSyncPrepareScript,
  buildRemoteSyncProbeScript,
  createEphemeralUiPassword,
  formatMasterExitError,
  instanceWantsRelayHost,
  parseRelayDescriptorFromStatus,
  parseRemoteManagedNodeVersion,
  parseSshCommand,
  parseVersionToken,
  remoteHelpMentionsRelayHost,
  planOpenCodeConfigSync,
  remoteRuntimeCanHostRelay,
  selectPreferredRemoteManagedNode,
} from './ssh-manager.mjs';
import { EventEmitter } from 'node:events';

const servers = [];
const tempDirs = [];

const makeTempDir = async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'openchamber-ssh-'));
  tempDirs.push(dir);
  return dir;
};

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
    expect(parseSshCommand('ssh root@yeewang.devcloud.woa.com:36000')).toEqual({
      destination: 'root@yeewang.devcloud.woa.com',
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
      clientKind: 'desktop-local',
      dedupeKey: 'desktop-local',
    });
    expect(settings.desktopHosts).toEqual([{ id: 'ssh-1', label: 'SSH Host', url: localUrl, apiUrl: localUrl, clientToken: 'ssh-client-token' }]);
  });

  test('cookie fallback still mints a desktop-local SSH operator token', async () => {
    let createPayload = null;
    const server = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/auth/session') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': 'oc_session=ssh-session; Path=/; HttpOnly',
        });
        res.end(JSON.stringify({ authenticated: true }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/client-auth/clients') {
        createPayload = JSON.parse(await readBody(req));
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ token: 'ssh-fallback-token' }));
        return;
      }
      res.writeHead(404).end();
    });
    const localUrl = await listen(server);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-ssh-manager-test-'));
    tempDirs.push(tempDir);
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(tempDir, 'settings.json'),
      appVersion: '0.0.0-test',
      emit: () => undefined,
    });

    const token = await manager.issueClientToken(localUrl, 'ui-secret');
    expect(token).toBe('ssh-fallback-token');
    expect(createPayload).toMatchObject({
      label: 'OpenChamber Desktop SSH',
      clientKind: 'desktop-local',
      dedupeKey: 'desktop-local',
    });
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

  test('managed remote runtime selects Node 22+ and keeps PATH setup session-scoped', () => {
    const script = buildRemoteManagedRuntimePrefix();
    expect(script).toContain('/codev/opt/nodejs/*/bin/node');
    expect(script).toContain('[ "$major" -ge 22 ]');
    expect(script).toContain('major % 2');
    expect(script).toContain('$HOME/.bun/bin');
    expect(script).toContain('$HOME/.opencode/bin');
    expect(script).toContain('.local/share/mise/installs/node');
    expect(script).not.toContain('.profile');
    expect(script).not.toContain('.bashrc');
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
      clientKind: 'desktop-local',
      dedupeKey: 'desktop-local',
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

describe('selectPreferredRemoteManagedNode', () => {
  test('ignores Node below 22', () => {
    expect(parseRemoteManagedNodeVersion('20.20.2')).toBeNull();
    expect(selectPreferredRemoteManagedNode([
      { bin: '/usr/bin/node', version: '20.20.2', hasNpm: true },
    ])).toBeNull();
  });

  test('prefers even LTS over a higher odd major', () => {
    const selected = selectPreferredRemoteManagedNode([
      { bin: '/fnm/23/node', version: '23.11.1', hasNpm: true },
      { bin: '/codev/22.19.0/node', version: '22.19.0', hasNpm: true },
    ]);
    expect(selected?.bin).toBe('/codev/22.19.0/node');
    expect(selected?.version).toBe('22.19.0');
  });

  test('among even LTS majors picks the highest version', () => {
    const selected = selectPreferredRemoteManagedNode([
      { bin: '/codev/22.11.0/node', version: '22.11.0', hasNpm: true },
      { bin: '/codev/22.19.0/node', version: '22.19.0', hasNpm: true },
      { bin: '/fnm/24.5.0/node', version: '24.5.0', hasNpm: true },
    ]);
    expect(selected?.bin).toBe('/fnm/24.5.0/node');
  });

  test('prefers a sibling npm over a newer even major without npm', () => {
    const selected = selectPreferredRemoteManagedNode([
      { bin: '/fnm/24.5.0/node', version: '24.5.0', hasNpm: false },
      { bin: '/codev/22.19.0/node', version: '22.19.0', hasNpm: true },
    ]);
    expect(selected?.bin).toBe('/codev/22.19.0/node');
  });

  test('falls back to an odd major when it is the only supported runtime', () => {
    const selected = selectPreferredRemoteManagedNode([
      { bin: '/fnm/23.11.1/node', version: '23.11.1', hasNpm: true },
      { bin: '/usr/bin/node', version: '20.20.2', hasNpm: true },
    ]);
    expect(selected?.bin).toBe('/fnm/23.11.1/node');
  });

  test('DevCloud-shaped candidate set prefers even 22.19 over login fnm 23 and system 20', () => {
    const selected = selectPreferredRemoteManagedNode([
      { bin: '/usr/bin/node', version: '20.20.2', hasNpm: true },
      { bin: '/codev/opt/nodejs/22.19.0/bin/node', version: '22.19.0', hasNpm: true },
      { bin: '/fnm/23.11.1/node', version: '23.11.1', hasNpm: true },
    ]);
    expect(selected?.bin).toBe('/codev/opt/nodejs/22.19.0/bin/node');
    expect(remoteRuntimeCanHostRelay({ runtime: 'web' })).toBe(false);
    expect(remoteRuntimeCanHostRelay({ runtime: 'ssh-remote' })).toBe(true);
  });
});

describe('buildRemoteManagedNodeSelectionFunctions', () => {
  const writeFakeNode = async (dir, version, { withNpm = true } = {}) => {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      path.join(dir, 'node'),
      `#!/bin/sh\nif [ "$1" = "-p" ]; then printf '%s\\n' '${version}'; exit 0; fi\nexit 0\n`,
      { mode: 0o755 },
    );
    if (withNpm) {
      await fsp.writeFile(path.join(dir, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
  };

  const selectWithFixtures = async (fixtures) => {
    const root = await makeTempDir();
    const lines = [buildRemoteManagedNodeSelectionFunctions()];
    for (const fixture of fixtures) {
      const dir = path.join(root, fixture.name);
      await writeFakeNode(dir, fixture.version, { withNpm: fixture.withNpm !== false });
      lines.push(`consider_node ${JSON.stringify(path.join(dir, 'node'))}`);
    }
    lines.push('printf "%s\\n" "$best_node_bin"');
    const { execFileSync } = await import('node:child_process');
    return execFileSync('sh', ['-c', lines.join('\n')], { encoding: 'utf8' }).trim();
  };

  test('shell selection prefers even LTS 22.19 over odd 23.11', async () => {
    const selected = await selectWithFixtures([
      { name: 'odd23', version: '23.11.1' },
      { name: 'even22', version: '22.19.0' },
    ]);
    expect(selected.endsWith(`${path.sep}even22${path.sep}node`)).toBe(true);
  });

  test('shell selection prefers sibling npm over a newer even major without npm', async () => {
    const selected = await selectWithFixtures([
      { name: 'even24', version: '24.5.0', withNpm: false },
      { name: 'even22', version: '22.19.0', withNpm: true },
    ]);
    expect(selected.endsWith(`${path.sep}even22${path.sep}node`)).toBe(true);
  });

  test('shell selection keeps the only odd runtime when no even LTS exists', async () => {
    const selected = await selectWithFixtures([
      { name: 'odd23', version: '23.11.1' },
    ]);
    expect(selected.endsWith(`${path.sep}odd23${path.sep}node`)).toBe(true);
  });
});

describe('managed SSH relay host defaults', () => {
  test('relay host is on by default and can be opted out', () => {
    expect(instanceWantsRelayHost({})).toBe(true);
    expect(instanceWantsRelayHost({ remoteOpenchamber: {} })).toBe(true);
    expect(instanceWantsRelayHost({ remoteOpenchamber: { relayHost: true } })).toBe(true);
    expect(instanceWantsRelayHost({ remoteOpenchamber: { relayHost: false } })).toBe(false);
  });

  test('sanitizeInstance persists relayHost=true by default', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-ssh-manager-test-'));
    tempDirs.push(tempDir);
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(tempDir, 'settings.json'),
      appVersion: '0.0.0-test',
      emit: () => undefined,
    });
    expect(manager.sanitizeInstance({
      id: 'ssh-1',
      sshCommand: 'ssh user@host.example',
    }).remoteOpenchamber.relayHost).toBe(true);
    expect(manager.sanitizeInstance({
      id: 'ssh-2',
      sshCommand: 'ssh user@host.example',
      remoteOpenchamber: { relayHost: false },
    }).remoteOpenchamber.relayHost).toBe(false);
  });

  test('remoteRuntimeCanHostRelay accepts ssh-remote and desktop only', () => {
    expect(remoteRuntimeCanHostRelay({ runtime: 'ssh-remote' })).toBe(true);
    expect(remoteRuntimeCanHostRelay({ runtime: 'desktop' })).toBe(true);
    expect(remoteRuntimeCanHostRelay({ runtime: 'web' })).toBe(false);
    expect(remoteRuntimeCanHostRelay({})).toBe(false);
  });

  test('parseRelayDescriptorFromStatus requires a host-capable public descriptor', () => {
    const jwk = { kty: 'EC', crv: 'P-256', x: 'abc', y: 'def' };
    expect(parseRelayDescriptorFromStatus({
      hostAllowed: true,
      relayUrl: 'wss://relay.example/ws',
      serverId: 'srv-1',
      hostEncPubJwk: jwk,
    })).toEqual({
      relayUrl: 'wss://relay.example/ws',
      serverId: 'srv-1',
      hostEncPubJwk: jwk,
    });
    expect(parseRelayDescriptorFromStatus({
      hostAllowed: false,
      relayUrl: 'wss://relay.example/ws',
      serverId: 'srv-1',
      hostEncPubJwk: jwk,
    })).toBeNull();
  });

  test('buildRelayHostFlag defaults to flag-only and pins a stored ws/wss URL', () => {
    expect(buildRelayHostFlag({})).toBe('--relay-host');
    expect(buildRelayHostFlag({ relayUrl: 'wss://relay.example/ws' })).toBe(
      "--relay-host 'wss://relay.example/ws'",
    );
    expect(buildRelayHostFlag({
      remoteOpenchamber: { relayUrl: 'ws://127.0.0.1:8787/ws' },
    })).toBe("--relay-host 'ws://127.0.0.1:8787/ws'");
    expect(buildRelayHostFlag({ relayUrl: 'https://not-a-relay.example' })).toBe('--relay-host');
  });

  test('create → sanitize → serve command is ssh-remote + --relay-host by default', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-ssh-manager-test-'));
    tempDirs.push(tempDir);
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(tempDir, 'settings.json'),
      appVersion: '0.0.0-test',
      emit: () => undefined,
    });
    const created = {
      id: 'ssh-devcloud',
      sshCommand: 'ssh root@host.example -p 36000',
      remoteOpenchamber: { mode: 'managed', keepRunning: true },
    };
    const instance = manager.sanitizeInstance(created);
    expect(instance.remoteOpenchamber.relayHost).toBe(true);
    const command = buildManagedServeCommand(instance, 18765, 'ui-secret');
    expect(command).toContain("OPENCHAMBER_RUNTIME=ssh-remote");
    expect(command).toContain("OPENCHAMBER_UI_PASSWORD='ui-secret'");
    expect(command).toContain('openchamber serve --hostname 127.0.0.1 --port 18765 --relay-host');
    expect(command).not.toMatch(/--relay-host '/);

    const optedOut = manager.sanitizeInstance({
      ...created,
      id: 'ssh-devcloud-off',
      remoteOpenchamber: { relayHost: false },
    });
    expect(buildManagedServeCommand(optedOut, 18765, 'ui-secret')).toBe(
      "OPENCHAMBER_RUNTIME=ssh-remote OPENCHAMBER_UI_PASSWORD='ui-secret' openchamber serve --hostname 127.0.0.1 --port 18765",
    );
    expect(buildManagedServeCommand(instance, 18765, 'ui-secret', { relayHostSupported: false })).toBe(
      "OPENCHAMBER_RUNTIME=ssh-remote OPENCHAMBER_UI_PASSWORD='ui-secret' openchamber serve --hostname 127.0.0.1 --port 18765",
    );
    expect(remoteHelpMentionsRelayHost('  --relay-host [url]      serve: enable the private relay host')).toBe(true);
    expect(remoteHelpMentionsRelayHost('  --relay                 connect-url: also include the relay')).toBe(false);
  });

  test('updateHostRuntime attaches a relay descriptor and preserves it when omitted', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-ssh-manager-test-'));
    tempDirs.push(tempDir);
    const settingsFilePath = path.join(tempDir, 'settings.json');
    const manager = new ElectronSshManager({
      settingsFilePath,
      appVersion: '0.0.0-test',
      emit: () => undefined,
    });
    const relay = {
      relayUrl: 'wss://relay.example/ws',
      serverId: 'srv-1',
      hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'abc', y: 'def' },
    };
    await manager.updateHostRuntime('ssh-1', 'SSH Host', 'http://127.0.0.1:18765', 'tok-1', relay);
    expect(JSON.parse(fs.readFileSync(settingsFilePath, 'utf8')).desktopHosts[0].relay).toEqual(relay);
    await manager.updateHostRuntime('ssh-1', 'SSH Host renamed', 'http://127.0.0.1:18766', 'tok-2');
    const after = JSON.parse(fs.readFileSync(settingsFilePath, 'utf8')).desktopHosts[0];
    expect(after.relay).toEqual(relay);
    expect(after.clientToken).toBe('tok-2');
  });
});

describe('parseVersionToken', () => {
  test('accepts stable and prerelease CLI versions', () => {
    expect(parseVersionToken('1.18.4')).toBe('1.18.4');
    expect(parseVersionToken('v1.18.4')).toBe('1.18.4');
    expect(parseVersionToken('1.18.4-beta.4')).toBe('1.18.4-beta.4');
    expect(parseVersionToken('v1.18.4-beta.4')).toBe('1.18.4-beta.4');
    expect(parseVersionToken('1.18.4-beta.4+build.7')).toBe('1.18.4-beta.4+build.7');
    expect(parseVersionToken('openchamber 1.18.4-beta.4')).toBe('1.18.4-beta.4');
  });

  test('keeps two-part numeric versions and ignores non-versions', () => {
    expect(parseVersionToken('1.18')).toBe('1.18');
    expect(parseVersionToken('not-a-version')).toBeNull();
    expect(parseVersionToken('')).toBeNull();
  });
});

describe('classifyManagedSshBootstrapError', () => {
  test('maps native binding dumps and missing Node to stable codes', () => {
    expect(classifyManagedSshBootstrapError(
      'Managed SSH remote requires Node.js 22+; no supported Node runtime was found on the remote host',
    )).toBe('nodeRuntimeMissing');
    expect(classifyManagedSshBootstrapError('gyp ERR! ENOENT node_gyp_bins')).toBe('nativeBinding');
    expect(classifyManagedSshBootstrapError(
      'OpenChamber installation completed but the executable is unavailable',
    )).toBe('openchamberCliMissing');
    expect(classifyManagedSshBootstrapError(
      'Failed to install OpenChamber because the remote could not reach the npm registry',
    )).toBe('openchamberRegistry');
    expect(classifyManagedSshBootstrapError('Failed to install OpenChamber on remote host')).toBe('openchamberInstall');
    expect(classifyManagedSshBootstrapError('Error: Unknown option: --relay-host')).toBe('openchamberCliIncompatible');
    expect(classifyManagedSshBootstrapError('Permission denied (publickey)')).toBe('sshAuth');
  });

  test('summarizes long node-gyp dumps for desktop status.detail', () => {
    const dump = [
      'gyp ERR! UNCAUGHT EXCEPTION',
      "Error: ENOENT: no such file or directory, lstat '/root/.../better-sqlite3/build/node_gyp_bins'",
    ].join('\n');
    expect(summarizeManagedSshBootstrapError(dump)).toBe(
      'failed to prepare better-sqlite3 for the selected remote Node runtime',
    );
    expect(summarizeManagedSshBootstrapError(
      'OpenChamber installation completed but the executable is unavailable',
    )).toBe('OpenChamber installation completed but the executable is unavailable');
    expect(summarizeManagedSshBootstrapError('npm ERR! code ENOTFOUND registry.npmjs.org')).toBe(
      'Failed to install OpenChamber because the remote could not reach the npm registry',
    );
  });
});

describe('buildRemoteNativeBindingRepairScript', () => {
  test('probes first, then cleans node-gyp leftovers, retries, and reinstalls', () => {
    const script = buildRemoteNativeBindingRepairScript({
      packageName: '@openchambery/web',
      version: '1.18.3-beta.14',
    });
    expect(script.indexOf('probe_sqlite')).toBeLessThan(script.indexOf('rebuild_sqlite'));
    expect(script).toContain("require.resolve('better-sqlite3/package.json')");
    expect(script).toContain('rm -rf "$sqlite_dir/build"');
    expect(script).toContain('mkdir -p "$sqlite_dir/build/node_gyp_bins"');
    expect(script).toContain('npm rebuild --foreground-scripts');
    expect(script).toContain("npm install -g '@openchambery/web@1.18.3-beta.14' --force");
    expect(script).toContain('/usr/bin/python3.11');
    expect(script).toContain('/opt/rh/gcc-toolset-12');
    expect(script).toContain('failed to prepare better-sqlite3');
  });

  test('omits npm reinstall when package version is unknown', () => {
    const script = buildRemoteNativeBindingRepairScript();
    expect(script).toContain('npm rebuild --foreground-scripts');
    expect(script).not.toContain('npm install -g');
  });
});

describe('planOpenCodeConfigSync', () => {
  const makeHomeWithConfig = async () => {
    const home = await makeTempDir();
    const configDir = path.join(home, '.config', 'opencode');
    await fsp.mkdir(configDir, { recursive: true });
    return { home, configDir };
  };

  test('picks opencode.jsonc winner and deletes sibling config names', async () => {
    const { home, configDir } = await makeHomeWithConfig();
    await fsp.writeFile(path.join(configDir, 'opencode.jsonc'), '{}\n');
    const plan = planOpenCodeConfigSync(home);
    expect(plan.direction).toBe('push');
    expect(plan.files.map((entry) => entry.path)).toContain('opencode.jsonc');
    expect(plan.files.some((entry) => entry.path === 'opencode.json')).toBe(false);
    expect(plan.deletes).toEqual(expect.arrayContaining(['config.json', 'opencode.json']));
    expect(plan.deletes).not.toContain('opencode.jsonc');
    expect(plan.agentsRoot).toBeNull();
  });

  test('prefers earlier group member when both json and jsonc exist', async () => {
    const { home, configDir } = await makeHomeWithConfig();
    await fsp.writeFile(path.join(configDir, 'opencode.json'), '{}\n');
    await fsp.writeFile(path.join(configDir, 'opencode.jsonc'), '{}\n');
    const plan = planOpenCodeConfigSync(home);
    expect(plan.files.find((entry) => entry.path.startsWith('opencode.'))?.path).toBe('opencode.json');
    expect(plan.deletes).toContain('opencode.jsonc');
    expect(plan.deletes).not.toContain('opencode.json');
  });

  test('skills nested files counted; skills/node_modules excluded from counts', async () => {
    const { home, configDir } = await makeHomeWithConfig();
    const skills = path.join(configDir, 'skills');
    await fsp.mkdir(path.join(skills, 'nested'), { recursive: true });
    await fsp.writeFile(path.join(skills, 'nested', 'a.md'), 'a\n');
    await fsp.mkdir(path.join(skills, 'node_modules'), { recursive: true });
    await fsp.writeFile(path.join(skills, 'node_modules', 'x.js'), 'x\n');

    const plugins = path.join(configDir, 'plugins');
    await fsp.mkdir(path.join(plugins, 'deep', 'node_modules'), { recursive: true });
    await fsp.writeFile(path.join(plugins, 'keep.js'), 'keep\n');
    await fsp.writeFile(path.join(plugins, 'deep', 'node_modules', 'x.js'), 'x\n');

    const plan = planOpenCodeConfigSync(home);
    const skillsEntry = plan.directories.find((entry) => entry.path === 'skills');
    const pluginsEntry = plan.directories.find((entry) => entry.path === 'plugins');
    expect(skillsEntry?.fileCount).toBe(1);
    expect(pluginsEntry?.fileCount).toBe(1);
    expect(plan.deletes).toEqual(expect.arrayContaining(['skills', 'skill', 'plugins']));
  });

  test('dereferences symlinked agents dir and deletes legacy agent sibling', async () => {
    const { home, configDir } = await makeHomeWithConfig();
    const target = await makeTempDir();
    await fsp.writeFile(path.join(target, 'coder.md'), 'coder\n');
    await fsp.symlink(target, path.join(configDir, 'agents'), 'dir');

    const plan = planOpenCodeConfigSync(home);
    const agents = plan.directories.find((entry) => entry.path === 'agents');
    expect(agents).toBeTruthy();
    expect(agents.fileCount).toBeGreaterThan(0);
    expect(plan.deletes).toEqual(expect.arrayContaining(['agents', 'agent']));
  });

  test('missing local dirs are untouched (no directories entry, no deletes)', async () => {
    const { home, configDir } = await makeHomeWithConfig();
    await fsp.writeFile(path.join(configDir, 'AGENTS.md'), 'hi\n');
    const plan = planOpenCodeConfigSync(home);
    expect(plan.directories.some((entry) => entry.path === 'snippet')).toBe(false);
    expect(plan.deletes).not.toContain('snippet');
    expect(plan.files.some((entry) => entry.path === 'AGENTS.md')).toBe(true);
    expect(plan.agentsRoot).toBeNull();
  });

  test('skips *.backup files inside walked dirs', async () => {
    const { home, configDir } = await makeHomeWithConfig();
    const commands = path.join(configDir, 'commands');
    await fsp.mkdir(commands, { recursive: true });
    await fsp.writeFile(path.join(commands, 'ok.md'), 'ok\n');
    await fsp.writeFile(path.join(commands, 'old.md.backup'), 'old\n');
    const plan = planOpenCodeConfigSync(home);
    const entry = plan.directories.find((item) => item.path === 'commands');
    expect(entry?.fileCount).toBe(1);
    expect(plan.deletes).toEqual(expect.arrayContaining(['commands', 'command']));
  });

  test('group with no local member stays untouched', async () => {
    const { home, configDir } = await makeHomeWithConfig();
    await fsp.writeFile(path.join(configDir, 'AGENTS.md'), 'hi\n');
    const plan = planOpenCodeConfigSync(home);
    expect(plan.files.some((entry) => entry.path.includes('oh-my-opencode-slim'))).toBe(false);
    expect(plan.deletes.some((item) => item.includes('oh-my-opencode-slim'))).toBe(false);
  });

  test('missing ~/.agents yields agentsRoot null without changing deletes', async () => {
    const { home, configDir } = await makeHomeWithConfig();
    await fsp.writeFile(path.join(configDir, 'opencode.jsonc'), '{}\n');
    const plan = planOpenCodeConfigSync(home);
    expect(plan.agentsRoot).toBeNull();
    expect(plan.deletes).toEqual(expect.arrayContaining(['config.json', 'opencode.json']));
  });

  test('walks ~/.agents excluding node_modules and *.backup', async () => {
    const { home, configDir } = await makeHomeWithConfig();
    await fsp.writeFile(path.join(configDir, 'AGENTS.md'), 'hi\n');
    const agents = path.join(home, '.agents');
    await fsp.mkdir(path.join(agents, 'skills', 'foo'), { recursive: true });
    await fsp.writeFile(path.join(agents, 'skills', 'foo', 'SKILL.md'), 'skill\n');
    await fsp.mkdir(path.join(agents, 'junk', 'node_modules'), { recursive: true });
    await fsp.writeFile(path.join(agents, 'junk', 'node_modules', 'x.js'), 'x\n');
    await fsp.writeFile(path.join(agents, 'old.backup'), 'old\n');

    const plan = planOpenCodeConfigSync(home);
    expect(plan.agentsRoot).toEqual({ fileCount: 1, bytes: expect.any(Number) });
    expect(plan.agentsRoot.bytes).toBeGreaterThan(0);
    expect(plan.totalBytes).toBeGreaterThan(plan.agentsRoot.bytes - 1);
    expect(plan.totalBytes).toBeGreaterThanOrEqual(
      plan.files.reduce((sum, entry) => sum + entry.bytes, 0) + plan.agentsRoot.bytes,
    );
  });

  test('dereferences symlinked dirs inside ~/.agents', async () => {
    const { home } = await makeHomeWithConfig();
    const target = await makeTempDir();
    await fsp.writeFile(path.join(target, 'nested.md'), 'nested\n');
    const agents = path.join(home, '.agents');
    await fsp.mkdir(agents, { recursive: true });
    await fsp.symlink(target, path.join(agents, 'linked'), 'dir');

    const plan = planOpenCodeConfigSync(home);
    expect(plan.agentsRoot).toBeTruthy();
    expect(plan.agentsRoot.fileCount).toBeGreaterThan(0);
  });

  test('missing auth.json yields authFile null', async () => {
    const { home, configDir } = await makeHomeWithConfig();
    await fsp.writeFile(path.join(configDir, 'AGENTS.md'), 'hi\n');
    const plan = planOpenCodeConfigSync(home);
    expect(plan.authFile).toBeNull();
  });

  test('includes ~/.local/share/opencode/auth.json bytes when includeAuthFile is true', async () => {
    const { home, configDir } = await makeHomeWithConfig();
    await fsp.writeFile(path.join(configDir, 'AGENTS.md'), 'hi\n');
    const shareDir = path.join(home, '.local', 'share', 'opencode');
    await fsp.mkdir(shareDir, { recursive: true });
    await fsp.writeFile(path.join(shareDir, 'auth.json'), '{"token":"x"}\n');
    // Sibling session DB must never be walked/counted.
    await fsp.writeFile(path.join(shareDir, 'session.db'), 'db\n');

    // Default inventory (includeAuthFile unset) still discovers auth.json.
    const plan = planOpenCodeConfigSync(home);
    expect(plan.authFile).toEqual({ bytes: expect.any(Number) });
    expect(plan.authFile.bytes).toBeGreaterThan(0);
    expect(plan.totalBytes).toBeGreaterThanOrEqual(
      plan.files.reduce((sum, entry) => sum + entry.bytes, 0) + plan.authFile.bytes,
    );

    // Opt-out via includeAuthFile: false skips auth.json.
    const skipped = planOpenCodeConfigSync(home, { includeAuthFile: false });
    expect(skipped.authFile).toBeNull();
  });

  test('dereferences symlinked auth.json', async () => {
    const { home } = await makeHomeWithConfig();
    const target = await makeTempDir();
    const realAuth = path.join(target, 'real-auth.json');
    await fsp.writeFile(realAuth, '{"ok":true}\n');
    const shareDir = path.join(home, '.local', 'share', 'opencode');
    await fsp.mkdir(shareDir, { recursive: true });
    await fsp.symlink(realAuth, path.join(shareDir, 'auth.json'));

    const plan = planOpenCodeConfigSync(home, { includeAuthFile: true });
    expect(plan.authFile).toBeTruthy();
    expect(plan.authFile.bytes).toBeGreaterThan(0);
  });
});

describe('buildRemoteSyncPrepareScript', () => {
  test('quotes paths with spaces and emits generational backup/delete/SYNC_READY lines', () => {
    const script = buildRemoteSyncPrepareScript({
      files: [{ path: 'my file.jsonc', bytes: 1 }],
      directories: [{ path: 'commands', fileCount: 1, bytes: 1 }],
      agentsRoot: null,
      authFile: null,
      deletes: ['opencode.json', 'commands', 'command'],
      totalBytes: 2,
    }, { syncRunId: 'run-a' });
    expect(script).toContain('SYNC_READY');
    expect(script).toContain("RUN_BK=\"$BK\"/'run-a'");
    expect(script).toContain("cp -a \"$CFG\"/'my file.jsonc' \"$RUN_BK\"/'my file.jsonc'");
    expect(script).toContain("cp -a \"$CFG\"/'commands' \"$RUN_BK\"/'commands'");
    expect(script).toContain("rm -f -- \"$CFG\"/'opencode.json'");
    expect(script).toContain("rm -rf -- \"$CFG\"/'command'");
    expect(script).toContain("rm -rf -- \"$CFG\"/'commands'");
    expect(script).not.toMatch(/\$CFG\/my file/);
    // Generational: never wipe the entire backup root at prepare start.
    expect(script).not.toContain('rm -rf -- "$BK"\n');
    expect(script).not.toContain('.openchamber.sync-backup-agents');
    expect(script).not.toContain('rm -rf -- "$HOME/.agents"');
    expect(script).not.toContain('.openchamber.sync-backup-auth');
    expect(script).not.toContain('auth.json');
  });

  test('with agentsRoot backs up and removes $HOME/.agents outside the tree', () => {
    const script = buildRemoteSyncPrepareScript({
      files: [],
      directories: [],
      agentsRoot: { fileCount: 1, bytes: 4 },
      authFile: null,
      deletes: [],
      totalBytes: 4,
    }, { syncRunId: 'run-agents' });
    expect(script).toContain('SYNC_READY');
    expect(script).toContain('AGENTS_BK="$HOME/.openchamber.sync-backup-agents"');
    expect(script).toContain("AGENTS_RUN_BK=\"$AGENTS_BK\"/'run-agents'");
    expect(script).toContain('cp -a "$HOME/.agents" "$AGENTS_RUN_BK/agents"');
    expect(script).toContain('rm -rf -- "$HOME/.agents"');
    expect(script).not.toContain('rm -rf -- "$AGENTS_BK"\n');
  });

  test('with authFile backs up auth.json outside share dir without deleting it', () => {
    const script = buildRemoteSyncPrepareScript({
      files: [],
      directories: [],
      agentsRoot: null,
      authFile: { bytes: 12 },
      deletes: [],
      totalBytes: 12,
    }, { syncRunId: 'run-auth' });
    expect(script).toContain('SYNC_READY');
    expect(script).toContain('AUTH_BK="$HOME/.openchamber.sync-backup-auth"');
    expect(script).toContain("AUTH_RUN_BK=\"$AUTH_BK\"/'run-auth'");
    expect(script).toContain(
      'cp -a "$HOME/.local/share/opencode/auth.json" "$AUTH_RUN_BK/auth.json"',
    );
    expect(script).not.toContain('rm -rf -- "$HOME/.local/share/opencode"');
    expect(script).not.toContain('rm -f -- "$HOME/.local/share/opencode/auth.json"');
    expect(script).not.toContain('rm -rf -- "$AUTH_BK"\n');
  });
});

describe('buildRemoteSyncProbeScript', () => {
  test('exits 0 when every probed path is missing (regression: false tail must not fail sh -lc)', async () => {
    const script = buildRemoteSyncProbeScript(['opencode.jsonc', 'skills']);
    expect(script).toContain('exit 0');
    const os = await import('node:os');
    const fsMod = await import('node:fs');
    const { execFileSync } = await import('node:child_process');
    const tempHome = fsMod.mkdtempSync(path.join(os.tmpdir(), 'openchamber-probe-home-'));
    try {
      // execFileSync throws on non-zero exit — that throw is the regression guard.
      const stdout = execFileSync('sh', ['-c', script], { env: { ...process.env, HOME: tempHome } });
      expect(stdout.toString()).toBe('');
    } finally {
      fsMod.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test('prints existing paths and the agents-root marker, still exiting 0', async () => {
    const os = await import('node:os');
    const fsMod = await import('node:fs');
    const { execFileSync } = await import('node:child_process');
    const tempHome = fsMod.mkdtempSync(path.join(os.tmpdir(), 'openchamber-probe-home-'));
    try {
      fsMod.mkdirSync(path.join(tempHome, '.config', 'opencode'), { recursive: true });
      fsMod.writeFileSync(path.join(tempHome, '.config', 'opencode', 'opencode.jsonc'), '{}');
      fsMod.mkdirSync(path.join(tempHome, '.agents'), { recursive: true });
      const script = buildRemoteSyncProbeScript(['opencode.jsonc', 'skills']);
      const stdout = execFileSync('sh', ['-c', script], { env: { ...process.env, HOME: tempHome } });
      const lines = stdout.toString().split('\n').filter(Boolean);
      expect(lines).toEqual(['opencode.jsonc', '__AGENTS_ROOT__']);
    } finally {
      fsMod.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test('prints __AUTH_FILE__ when auth.json exists and still exits 0', async () => {
    const os = await import('node:os');
    const fsMod = await import('node:fs');
    const { execFileSync } = await import('node:child_process');
    const tempHome = fsMod.mkdtempSync(path.join(os.tmpdir(), 'openchamber-probe-home-'));
    try {
      fsMod.mkdirSync(path.join(tempHome, '.local', 'share', 'opencode'), { recursive: true });
      fsMod.writeFileSync(path.join(tempHome, '.local', 'share', 'opencode', 'auth.json'), '{}');
      const script = buildRemoteSyncProbeScript([]);
      const stdout = execFileSync('sh', ['-c', script], { env: { ...process.env, HOME: tempHome } });
      const lines = stdout.toString().split('\n').filter(Boolean);
      expect(lines).toEqual(['__AUTH_FILE__']);
    } finally {
      fsMod.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe('runExclusiveForTarget sync response shape', () => {
  test('keeps the plan field in preview/apply responses (regression: stripping it broke the UI preview parser)', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-ssh-manager-test-'));
    tempDirs.push(tempDir);
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(tempDir, 'settings.json'),
      appVersion: '0.0.0-test',
      emit: () => undefined,
    });

    const plan = {
      direction: 'push',
      files: [{ path: 'opencode.jsonc', bytes: 10 }],
      directories: [],
      agentsRoot: null,
      authFile: null,
      deletes: [],
      totalBytes: 10,
    };
    const result = await manager.runExclusiveForTarget('ssh:resp-shape', 'preview', async () => ({
      plan,
      remoteExisting: ['opencode.jsonc'],
      remoteAgentsRootExists: false,
      remoteAuthFileExists: false,
    }));

    // The renderer's parseConfigSyncPreview requires value.plan to be a valid
    // plan object; stripping it made every SSH/direct preview resolve to null
    // ("config sync unavailable in this window").
    expect(result.plan).toEqual(plan);
    expect(result.remoteExisting).toEqual(['opencode.jsonc']);
    expect(typeof result.syncRunId).toBe('string');
    expect(result.syncRunId).not.toBe('');
  });
});
