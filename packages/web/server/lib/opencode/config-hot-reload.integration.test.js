import { test, expect } from 'vitest';
import { OpenCode } from '@opencode/client';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Opt-in, isolated real V2 server. No user config, credentials, model calls,
// shared service registration, or npm plugin installs are used.
test.skipIf(!process.env.OPENCHAMBER_TEST_OPENCODE_BINARY)('V2 applies credentials, global config and plugin changes in the same process', async () => {
  const temporary = path.join(os.tmpdir(), 'opencode');
  await fs.mkdir(temporary, { recursive: true });
  const root = await fs.mkdtemp(path.join(temporary, 'config-hot-reload-'));
  const config = path.join(root, 'config', 'opencode');
  const directory = path.join(root, 'project');
  await fs.mkdir(config, { recursive: true });
  await fs.mkdir(directory, { recursive: true });
  const password = randomBytes(24).toString('hex');
  const child = spawn(process.env.OPENCHAMBER_TEST_OPENCODE_BINARY, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
    cwd: directory,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      TMPDIR: temporary,
      XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_DATA_HOME: path.join(root, 'data'),
      XDG_STATE_HOME: path.join(root, 'state'),
      XDG_CACHE_HOME: path.join(root, 'cache'),
      OPENCODE_CONFIG_DIR: config,
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_DISABLE_MODELS_FETCH: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let spawnError;
  child.on('error', (error) => { spawnError = error; });
  child.stdout.on('data', (data) => { output = (output + data).slice(-8192); });
  child.stderr.on('data', () => undefined);
  const closed = once(child, 'close').catch(() => undefined);
  const until = async (read, accepts, label) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`Isolated OpenCode exited during ${label}`);
      const value = await read();
      if (accepts(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
  const write = async (info) => {
    const file = path.join(config, 'opencode.json');
    await fs.writeFile(`${file}.tmp`, JSON.stringify(info));
    await fs.rename(`${file}.tmp`, file);
  };
  try {
    const origin = await until(
      async () => output.match(/(?:server listening on|opencode server listening on) (http:\/\/[^\s]+)/)?.[1],
      Boolean, 'listener',
    );
    const client = OpenCode.make({
      baseUrl: origin,
      headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` },
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15_000) }),
    });
    const location = { directory };
    await client.command.list({ location });
    const pid = child.pid;
    const commands = { 'hot-reload-probe': { template: 'Do not execute anything.', description: 'one' } };
    await write({ commands });
    await until(() => client.command.list({ location }), (result) => result.data.some((entry) => entry.name === 'hot-reload-probe'), 'global command create');
    await write({ commands: { 'hot-reload-probe': { ...commands['hot-reload-probe'], description: 'two' } } });
    await until(() => client.command.list({ location }), (result) => result.data.some((entry) => entry.name === 'hot-reload-probe' && entry.description === 'two'), 'command update');

    await write({ commands, plugins: ['*', '-opencode.config.command'] });
    await until(() => client.command.list({ location }), (result) => !result.data.some((entry) => entry.name === 'hot-reload-probe'), 'plugin disable');
    await write({ commands });
    await until(() => client.command.list({ location }), (result) => result.data.some((entry) => entry.name === 'hot-reload-probe'), 'plugin re-enable');

    await client.integration.connect.key({ integrationID: 'anthropic', key: 'isolated-test-placeholder', location });
    const integration = await until(() => client.integration.get({ integrationID: 'anthropic', location }),
      (result) => result.data.connections.some((connection) => connection.type === 'credential'), 'credential connection');
    for (const connection of integration.data.connections) {
      if (connection.type === 'credential') await client.credential.remove({ credentialID: connection.id });
    }
    await until(() => client.integration.get({ integrationID: 'anthropic', location }),
      (result) => result.data.connections.length === 0, 'credential removal');
    await write({ commands, mcp: { servers: { 'hot-reload-mcp': { type: 'local', command: ['unused-test-command'], disabled: true } } } });
    await until(() => client.mcp.list({ location }), (result) => result.data.some((server) => server.name === 'hot-reload-mcp'), 'MCP config add');
    await write({});
    await until(() => client.mcp.list({ location }), (result) => !result.data.some((server) => server.name === 'hot-reload-mcp'), 'MCP config removal');
    await until(() => client.command.list({ location }), (result) => !result.data.some((entry) => entry.name === 'hot-reload-probe'), 'command removal');
    expect(child.pid).toBe(pid);
    expect(child.exitCode).toBeNull();
  } finally {
    child.kill('SIGTERM');
    const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
    await closed;
    clearTimeout(kill);
    await fs.rm(root, { recursive: true, force: true });
  }
}, 120_000);
