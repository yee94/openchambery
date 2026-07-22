import { afterEach, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isModuleCliExecution } from '../bin/cli-entry.js';
import { buildRelayConfig, parseRelayServerArgs, runRelayServerCli } from '../src/cli.js';

const baseEnv = { ...process.env };
const packageManifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
afterEach(() => { process.env = { ...baseEnv }; });

it('gives flags precedence over relay environment configuration', () => {
  const parsed = parseRelayServerArgs(['--host', '0.0.0.0', '--port', '9000', '--path', '/relay', '--trust-proxy']);
  expect(parsed).toMatchObject({ host: '0.0.0.0', port: '9000', path: '/relay', trustProxy: true });
  expect(buildRelayConfig(parsed, { OPENCHAMBER_RELAY_SERVER_HOST: '127.0.0.2', OPENCHAMBER_RELAY_SERVER_PORT: '8000' })).toMatchObject({ host: '0.0.0.0', port: 9000, path: '/relay', trustProxy: true });
});

it('validates every exposed limit and URL input', () => {
  const limits = ['MAX_HOSTS', 'MAX_SOCKETS', 'MAX_CONNECTIONS', 'MAX_CLIENTS_PER_HOST', 'MAX_CLIENTS_PER_IP', 'MAX_PENDING_CLIENTS', 'MAX_RAW_SOCKETS', 'MAX_RAW_SOCKETS_PER_IP', 'GRACE_MS', 'TIMESTAMP_SKEW_MS', 'REPLAY_MS', 'MAX_REPLAY_ENTRIES', 'MAX_FRAME_BYTES', 'MAX_QUEUED_BYTES_PER_CONNECTION', 'MAX_GLOBAL_QUEUED_BYTES', 'MAX_ADMISSIONS_PER_IP', 'HEARTBEAT_MS', 'HANDSHAKE_MS', 'CLOSE_DEADLINE_MS'];
  for (const key of limits) expect(() => buildRelayConfig({}, { [`OPENCHAMBER_RELAY_SERVER_${key}`]: '0' })).toThrow(`Invalid OPENCHAMBER_RELAY_SERVER_${key}`);
  expect(() => buildRelayConfig({ path: 'ws' }, {})).toThrow('Invalid --path');
  expect(() => buildRelayConfig({ publicUrl: 'https://relay.test/ws' }, {})).toThrow('Invalid --public-url');
  expect(() => buildRelayConfig({}, { OPENCHAMBER_RELAY_SERVER_REPLAY_MS: '10', OPENCHAMBER_RELAY_SERVER_TIMESTAMP_SKEW_MS: '10' })).toThrow('Invalid OPENCHAMBER_RELAY_SERVER_REPLAY_MS');
  for (const args of [['--unknown'], ['--port'], ['--port', '0'], ['--port', '65536'], ['--path', '/ws?secret=value'], ['--public-url', 'http://relay.test/ws']]) expect(() => buildRelayConfig(parseRelayServerArgs(args), {})).toThrow();
});

it('uses defaults for blank relay environment values and validates host and public URL relationships', () => {
  const emptyKeys = ['HOST', 'PORT', 'PATH', 'PUBLIC_URL', 'TRUST_PROXY', 'MAX_URL_BYTES', 'MAX_FIELD_BYTES', 'MAX_HOSTS', 'MAX_SOCKETS', 'MAX_CONNECTIONS', 'MAX_CLIENTS_PER_HOST', 'MAX_CLIENTS_PER_IP', 'MAX_PENDING_CLIENTS', 'PENDING_MS', 'MAX_RAW_SOCKETS', 'MAX_RAW_SOCKETS_PER_IP', 'GRACE_MS', 'TIMESTAMP_SKEW_MS', 'REPLAY_MS', 'MAX_REPLAY_ENTRIES', 'MAX_FRAME_BYTES', 'MAX_QUEUED_BYTES_PER_CONNECTION', 'MAX_GLOBAL_QUEUED_BYTES', 'MAX_BUFFERED_AMOUNT', 'MAX_CONTROL_QUEUE_ENTRIES', 'MAX_CONTROL_QUEUED_BYTES', 'PUMP_RETRY_MS', 'HEARTBEAT_MS', 'HANDSHAKE_MS', 'CLOSE_DEADLINE_MS', 'ADMISSION_WINDOW_MS', 'MAX_ADMISSIONS_PER_IP', 'MAX_ADMISSION_ENTRIES', 'ID_ATTEMPTS'];
  const emptyEnv = Object.fromEntries(emptyKeys.map((key) => [`OPENCHAMBER_RELAY_SERVER_${key}`, ' \t ' ]));
  expect(buildRelayConfig({}, emptyEnv)).toMatchObject({ host: '127.0.0.1', port: 8787, path: '/ws', publicUrl: undefined, trustProxy: false, limits: {} });
  expect(() => buildRelayConfig({ host: 'relay.test/path' }, {})).toThrow('Invalid --host');
  expect(() => buildRelayConfig({ publicUrl: 'wss://relay.test/other' }, {})).toThrow('Invalid --public-url');
  expect(buildRelayConfig({ path: '/relay', publicUrl: 'wss://relay.test/relay' }, {})).toMatchObject({ path: '/relay', publicUrl: 'wss://relay.test/relay' });
  expect(buildRelayConfig({ host: '::1', publicUrl: 'ws://[::1]:8787/ws' }, {})).toMatchObject({ host: '::1', publicUrl: 'ws://[::1]:8787/ws' });
});

it('recognizes the compiled relay executable by its published bin name', () => {
  expect(isModuleCliExecution('/tmp/openchamber-relay', import.meta.url, (value) => value, 'openchamber-relay')).toBe(true);
  expect(isModuleCliExecution('/tmp/relay-server', import.meta.url, (value) => value, 'openchamber-relay')).toBe(false);
});

it('runs compiled relay help and version from the published bin name', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-relay-'));
  const executable = path.join(directory, 'openchamber-relay');
  try {
    const entry = fileURLToPath(new URL('../bin/openchamber-relay.js', import.meta.url));
    expect(spawnSync(process.execPath, ['build', '--compile', entry, '--outfile', executable], { encoding: 'utf8' }).status).toBe(0);
    expect(spawnSync(executable, ['--help'], { encoding: 'utf8' })).toMatchObject({ status: 0, stdout: expect.stringContaining('Usage: openchamber-relay') });
    expect(spawnSync(executable, ['--version'], { encoding: 'utf8' })).toMatchObject({ status: 0, stdout: expect.stringMatching(new RegExp(`^${packageManifest.version.replaceAll('.', '\\.')}\\s*$`)) });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it('publishes the relay executable as an independent package contract', () => {
  expect(packageManifest.bin).toEqual({ 'openchamber-relay': './bin/openchamber-relay.js' });
});

it('keeps JSON output JSON-only and cleans signal listeners', async () => {
  const output = []; const errors = []; const signals = new Map(); const events = []; let stopped = 0;
  const processLike = { argv: [], env: {}, exitCode: 0, on(signal, listener) { signals.set(signal, listener); }, off(signal, listener) { if (signals.get(signal) === listener) signals.delete(signal); }, exit(code) { events.push(`exit:${code}`); } };
  const code = await runRelayServerCli(['--json'], {
    process: processLike,
    stdout: { write: (value) => output.push(value) }, stderr: { write: (value) => errors.push(value) },
    start: async () => ({ wsUrl: 'ws://127.0.0.1:1/ws', stop: async () => { stopped += 1; events.push('stop:complete'); } }), version: '1.2.3',
  });
  expect(code).toBe(0); expect(errors).toEqual([]); expect(() => JSON.parse(output.join(''))).not.toThrow();
  const terminate = signals.get('SIGTERM'); const interrupt = signals.get('SIGINT');
  await terminate(); await interrupt();
  expect(stopped).toBe(1); expect(signals.size).toBe(0); expect(events).toEqual(['stop:complete', 'exit:0']);
});

it('renders help and version as one JSON object and reports errors deterministically', async () => {
  for (const args of [['--json', '--help'], ['--json', '--version'], ['--json', '--unknown']]) {
    const output = []; const errors = [];
    const code = await runRelayServerCli(args, { process: { env: {}, exitCode: 0, on() {}, off() {} }, stdout: { write: (value) => output.push(value) }, stderr: { write: (value) => errors.push(value) }, version: '1.2.3' });
    expect(() => JSON.parse(output.join(''))).not.toThrow(); expect(errors).toEqual([]);
    expect(code).toBe(args.includes('--unknown') ? 1 : 0);
  }
});

it('renders help and version in quiet mode and reports a signal stop failure safely', async () => {
  for (const args of [['--quiet', '--help'], ['--quiet', '--version']]) {
    const output = [];
    await runRelayServerCli(args, { process: { env: {}, exitCode: 0, on() {}, off() {} }, stdout: { write: (value) => output.push(value) }, stderr: { write() {} }, version: '1.2.3' });
    expect(output.join()).toContain(args.includes('--help') ? 'Usage:' : '1.2.3');
  }
  const errors = []; const signals = new Map(); const exits = [];
  const processLike = { env: {}, exitCode: 0, on(signal, listener) { signals.set(signal, listener); }, off(signal, listener) { if (signals.get(signal) === listener) signals.delete(signal); }, exit(code) { exits.push(code); } };
  await runRelayServerCli(['--json'], { process: processLike, stdout: { write() {} }, stderr: { write: (value) => errors.push(value) }, start: async () => ({ wsUrl: 'ws://127.0.0.1:1/ws', stop: async () => { throw new Error('failure'); } }) });
  await signals.get('SIGTERM')();
  expect(processLike.exitCode).toBe(1); expect(exits).toEqual([1]); expect(signals.size).toBe(0); expect(() => JSON.parse(errors.join(''))).not.toThrow();
});
