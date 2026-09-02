import { afterEach, expect, it } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isModuleCliExecution } from '../bin/cli-entry.js';
import { buildPushRelayConfig, parsePushRelayArgs, runPushRelayCli } from '../src/push/cli.js';

const baseEnv = { ...process.env };
const packageManifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const dummyP8 = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const apnsEnv = (extra = {}) => ({
  OPENCHAMBER_PUSH_RELAY_APNS_KEY_ID: 'KEYID12345',
  OPENCHAMBER_PUSH_RELAY_APNS_TEAM_ID: 'TEAMID1234',
  OPENCHAMBER_PUSH_RELAY_APNS_P8: dummyP8,
  ...extra,
});

afterEach(() => { process.env = { ...baseEnv }; });

it('gives flags precedence over push relay environment configuration', () => {
  const parsed = parsePushRelayArgs(['--host', '0.0.0.0', '--port', '9001', '--trust-proxy']);
  expect(parsed).toMatchObject({ host: '0.0.0.0', port: '9001', trustProxy: true });
  expect(buildPushRelayConfig(parsed, apnsEnv({ OPENCHAMBER_PUSH_RELAY_HOST: '127.0.0.2', OPENCHAMBER_PUSH_RELAY_PORT: '8000' }))).toMatchObject({ host: '0.0.0.0', port: 9001, trustProxy: true });
});

it('validates listen, replay, and APNs inputs without leaking secrets', () => {
  expect(() => buildPushRelayConfig({}, apnsEnv({ OPENCHAMBER_PUSH_RELAY_PORT: '0' }))).toThrow('Invalid OPENCHAMBER_PUSH_RELAY_PORT');
  expect(() => buildPushRelayConfig({}, apnsEnv({ OPENCHAMBER_PUSH_RELAY_REPLAY_MS: '10', OPENCHAMBER_PUSH_RELAY_TIMESTAMP_SKEW_MS: '10' }))).toThrow('Invalid OPENCHAMBER_PUSH_RELAY_REPLAY_MS');
  expect(() => buildPushRelayConfig({ host: 'relay.test/path' }, apnsEnv())).toThrow('Invalid --host');
  const missing = (() => { try { buildPushRelayConfig({}, {}); } catch (error) { return error.message; } })();
  expect(missing).toMatch(/^Invalid OPENCHAMBER_PUSH_RELAY_APNS_/);
  expect(missing).not.toContain(dummyP8);
  expect(missing.toLowerCase()).not.toContain('begin private');
  const config = buildPushRelayConfig({}, apnsEnv({ OPENCHAMBER_PUSH_RELAY_APNS_BUNDLE_ID: 'com.example.app' }));
  expect(config.apns.bundleId).toBe('com.example.app');
  expect(config.port).toBe(8788);
  expect(config.host).toBe('127.0.0.1');
  expect(config.databasePath).toBe('./data/push-relay.sqlite');
});

it('defaults APNs bundle ID to the current product id and prefers env override', () => {
  expect(buildPushRelayConfig({}, apnsEnv()).apns.bundleId).toBe('com.yee94.openchamber');
  expect(buildPushRelayConfig({}, apnsEnv({ OPENCHAMBER_PUSH_RELAY_APNS_BUNDLE_ID: 'com.example.app' })).apns.bundleId).toBe('com.example.app');
});

it('reads P8 from path once and treats blank env values as unset', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'push-relay-p8-'));
  const p8Path = path.join(directory, 'key.p8');
  try {
    fs.writeFileSync(p8Path, dummyP8);
    const emptyKeys = ['HOST', 'PORT', 'TRUST_PROXY', 'DATABASE_PATH', 'TIMESTAMP_SKEW_MS', 'REPLAY_MS', 'MAX_REPLAY_ENTRIES', 'REGISTER_LIMIT_PER_MINUTE', 'SEND_LIMIT_PER_MINUTE', 'SERVER_SEND_LIMIT_PER_MINUTE', 'MAX_TOKENS', 'MAX_IN_FLIGHT'];
    const emptyEnv = Object.fromEntries(emptyKeys.map((key) => [`OPENCHAMBER_PUSH_RELAY_${key}`, ' \t ']));
    const config = buildPushRelayConfig({}, {
      ...emptyEnv,
      OPENCHAMBER_PUSH_RELAY_APNS_KEY_ID: 'KEYID12345',
      OPENCHAMBER_PUSH_RELAY_APNS_TEAM_ID: 'TEAMID1234',
      OPENCHAMBER_PUSH_RELAY_APNS_P8_PATH: p8Path,
    });
    expect(config).toMatchObject({ host: '127.0.0.1', port: 8788, trustProxy: false, databasePath: './data/push-relay.sqlite' });
    expect(config.apns.p8).toContain('BEGIN');
    expect(JSON.stringify({ host: config.host, port: config.port })).not.toContain('BEGIN');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it('recognizes the compiled push relay executable by its published bin name', () => {
  expect(isModuleCliExecution('/tmp/openchamber-push-relay', import.meta.url, (value) => value, 'openchamber-push-relay')).toBe(true);
  expect(isModuleCliExecution('/tmp/openchamber-relay', import.meta.url, (value) => value, 'openchamber-push-relay')).toBe(false);
});

it('publishes the push relay executable alongside the layer-1 bin', () => {
  expect(packageManifest.bin['openchamber-push-relay']).toBe('./bin/openchamber-push-relay.js');
  expect(packageManifest.bin['openchamber-relay']).toBe('./bin/openchamber-relay.js');
  expect(packageManifest.exports['./push']).toMatchObject({ import: './src/push/index.js' });
  expect(packageManifest.version).toBe('1.19.0-beta.39');
  expect(packageManifest.engines.node).toBe('>=22.13.0');
});

it('keeps JSON output JSON-only and cleans signal listeners', async () => {
  const output = []; const errors = []; const signals = new Map(); const events = []; let stopped = 0;
  const processLike = { argv: [], env: apnsEnv(), exitCode: 0, on(signal, listener) { signals.set(signal, listener); }, off(signal, listener) { if (signals.get(signal) === listener) signals.delete(signal); }, exit(code) { events.push(`exit:${code}`); } };
  const code = await runPushRelayCli(['--json'], {
    process: processLike,
    stdout: { write: (value) => output.push(value) }, stderr: { write: (value) => errors.push(value) },
    start: async () => ({ address: () => ({ port: 8788 }), stop: async () => { stopped += 1; events.push('stop:complete'); } }), version: '1.2.3',
  });
  expect(code).toBe(0); expect(errors).toEqual([]); expect(() => JSON.parse(output.join(''))).not.toThrow();
  const payload = JSON.parse(output.join(''));
  expect(payload).toMatchObject({ status: 'ok', host: '127.0.0.1', port: 8788 });
  expect(JSON.stringify(payload).toLowerCase()).not.toContain('begin');
  const terminate = signals.get('SIGTERM'); const interrupt = signals.get('SIGINT');
  await terminate(); await interrupt();
  expect(stopped).toBe(1); expect(signals.size).toBe(0); expect(events).toEqual(['stop:complete', 'exit:0']);
});

it('renders help and version as one JSON object and reports errors deterministically', async () => {
  for (const args of [['--json', '--help'], ['--json', '--version'], ['--json', '--unknown']]) {
    const output = []; const errors = [];
    const code = await runPushRelayCli(args, { process: { env: {}, exitCode: 0, on() {}, off() {} }, stdout: { write: (value) => output.push(value) }, stderr: { write: (value) => errors.push(value) }, version: '1.2.3' });
    expect(() => JSON.parse(output.join(''))).not.toThrow(); expect(errors).toEqual([]);
    expect(code).toBe(args.includes('--unknown') ? 1 : 0);
  }
});

it('renders help and version in quiet mode and reports a signal stop failure safely', async () => {
  for (const args of [['--quiet', '--help'], ['--quiet', '--version']]) {
    const output = [];
    await runPushRelayCli(args, { process: { env: {}, exitCode: 0, on() {}, off() {} }, stdout: { write: (value) => output.push(value) }, stderr: { write() {} }, version: '1.2.3' });
    expect(output.join()).toContain(args.includes('--help') ? 'Usage: openchamber-push-relay' : '1.2.3');
  }
  const errors = []; const signals = new Map(); const exits = [];
  const processLike = { env: apnsEnv(), exitCode: 0, on(signal, listener) { signals.set(signal, listener); }, off(signal, listener) { if (signals.get(signal) === listener) signals.delete(signal); }, exit(code) { exits.push(code); } };
  await runPushRelayCli(['--json'], { process: processLike, stdout: { write() {} }, stderr: { write: (value) => errors.push(value) }, start: async () => ({ address: () => ({ port: 1 }), stop: async () => { throw new Error('failure'); } }) });
  await signals.get('SIGTERM')();
  expect(processLike.exitCode).toBe(1); expect(exits).toEqual([1]); expect(signals.size).toBe(0); expect(() => JSON.parse(errors.join(''))).not.toThrow();
  expect(errors.join().toLowerCase()).not.toContain('begin');
});
