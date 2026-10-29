import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHostUpdateRuntime, writeUpdateState } from './runtime.js';
import { discoverCliRelease, compareVersions } from './releases.js';

let directory;
let stateFile;
let adapter;
let clock;
const release = () => ({ version: '2.1.1', kind: 'ota', rollback: false, releaseNotes: 'Fixes', artifact: { checksum: 'a' } });
const runtime = (currentVersion = '2.1.0') => createHostUpdateRuntime({ adapter, stateFile: () => stateFile, currentVersion, getServerId: async () => 'host-a', now: () => clock });
const request = (snapshot) => ({ version: snapshot.update.version, channel: snapshot.channel, planId: snapshot.update.planId });
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'host-update-'));
  stateFile = path.join(directory, 'state.json');
  clock = Date.now();
  adapter = { host: 'electron', supported: true, inspect: vi.fn(async () => release()), execute: vi.fn(async () => {}) };
});
afterEach(async () => { vi.useRealTimers(); await rm(directory, { recursive: true, force: true }); });

it('checks without mutating the selected channel and shares bounded discovery across repeated reads', async () => {
  const host = runtime();
  const plan = await host.get('beta');
  expect(plan).toMatchObject({ serverId: 'host-a', channel: 'beta', update: { version: '2.1.1', kind: 'ota', releaseNotes: 'Fixes' }, operation: null });
  expect(plan.update.artifact).toBeUndefined();
  for (let i = 0; i < 50; i++) expect((await host.get('beta')).update.planId).toBe(plan.update.planId);
  expect(adapter.inspect).toHaveBeenCalledTimes(1);
  await expect(readFile(stateFile)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await host.get()).channel).toBe('stable');
});

it('atomically accepts one exact plan, returns it on retries and rejects conflicting versions/channels', async () => {
  vi.useFakeTimers();
  const host = runtime();
  const plan = await host.get('stable');
  const submissions = await Promise.all(Array.from({ length: 10 }, () => host.start(request(plan))));
  expect(new Set(submissions.map((operation) => operation.id)).size).toBe(1);
  const active = await host.get('beta');
  expect(active.operation.status).toBe('checking');
  expect(active.update).toBeNull();
  await expect(host.start({ ...request(plan), channel: 'beta' })).rejects.toMatchObject({ status: 409, code: 'update_in_progress' });
  expect(adapter.inspect).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(501);
  expect(adapter.execute).toHaveBeenCalledTimes(1);
});

it('rejects tampering, changed artifacts and plans issued by another Host', async () => {
  const a = runtime();
  const plan = await a.get();
  await expect(a.start({ ...request(plan), version: '9.9.9' })).rejects.toMatchObject({ status: 409 });
  await expect(runtime().start(request(plan))).rejects.toMatchObject({ code: 'update_plan_expired' });
  adapter.inspect.mockResolvedValue({ ...release(), artifact: { checksum: 'changed' } });
  await expect(a.start(request(plan))).rejects.toMatchObject({ code: 'update_plan_changed' });
  expect(adapter.execute).not.toHaveBeenCalled();
});

it('rejects expired plans and invalid channels without executing', async () => {
  const host = runtime();
  const plan = await host.get();
  clock += 10 * 60_000 + 1;
  await expect(host.start(request(plan))).rejects.toMatchObject({ code: 'update_plan_expired' });
  await expect(host.get('nightly')).rejects.toMatchObject({ status: 400 });
  expect(adapter.execute).not.toHaveBeenCalled();
});

it('reports local desktop activity through GET and blocks a conflicting remote start', async () => {
  const host = runtime();
  const plan = await host.get();
  adapter.operation = () => ({ id: 'local', status: 'downloading', progress: 25 });
  expect(await host.get('beta')).toMatchObject({ available: null, operation: { id: 'local', progress: 25 } });
  await expect(host.start(request(plan))).rejects.toMatchObject({ code: 'update_in_progress' });
});

it('does not execute or leave an active task when durable admission cannot be written', async () => {
  const host = runtime();
  const plan = await host.get();
  const blocker = path.join(directory, 'not-a-directory');
  await writeFile(blocker, 'block');
  stateFile = path.join(blocker, 'state.json');
  await expect(host.start(request(plan))).rejects.toThrow();
  expect((await host.get()).operation).toBeNull();
  expect(adapter.execute).not.toHaveBeenCalled();
});

it('persists execution failure and allows a freshly validated retry', async () => {
  const host = runtime();
  const plan = await host.get();
  adapter.execute.mockRejectedValue(new Error('download failed'));
  await host.start(request(plan));
  await new Promise((resolve) => setTimeout(resolve, 650));
  expect((await host.get()).operation).toMatchObject({ status: 'failed', error: 'update_execution_failed' });
  expect(JSON.parse(await readFile(stateFile, 'utf8')).operation.status).toBe('failed');
  vi.useFakeTimers();
  expect((await host.start(request(plan))).status).toBe('checking');
  expect(adapter.inspect).toHaveBeenCalledTimes(3);
});

it('only permits an explicitly confirmed beta-to-stable rollback', async () => {
  vi.useFakeTimers();
  adapter.inspect.mockResolvedValue({ ...release(), version: '2.0.9', rollback: true });
  const host = runtime('2.1.0-beta.2');
  const plan = await host.get('stable');
  await expect(host.start(request(plan))).rejects.toMatchObject({ code: 'update_downgrade_requires_confirmation' });
  expect((await host.start({ ...request(plan), allowDowngrade: true })).channel).toBe('stable');
});

it('exposes check failure separately from an authoritative empty release', async () => {
  adapter.inspect.mockRejectedValue(new Error('offline'));
  expect(await runtime().get()).toMatchObject({ checkFailed: true, checkError: 'update_check_failed', operation: null });
  adapter.inspect.mockResolvedValue(null);
  expect(await runtime().get()).toMatchObject({ update: null, checkError: null });
});

it.each(['2.1.1', '2.1.0'])('verifies durable restarting state against running version %s', async (current) => {
  await writeUpdateState(stateFile, { channel: 'beta', operation: { id: 'op', version: '2.1.1', status: 'restarting' } });
  adapter.inspect.mockResolvedValue(null);
  const result = await runtime(current).get();
  expect(result.operation.status).toBe(current === '2.1.1' ? 'succeeded' : 'failed');
  expect(JSON.parse(await readFile(stateFile, 'utf8')).operation.status).toBe(result.operation.status);
});

it('does not offer an update when the owning adapter is unavailable', async () => {
  adapter.supported = false;
  expect(await runtime().get()).toMatchObject({ supported: false, update: null });
  expect(adapter.inspect).not.toHaveBeenCalled();
});

it('compares beta sequence numbers and never selects beta in the stable channel', async () => {
  expect(compareVersions('2.1.0-beta.10', '2.1.0-beta.2')).toBe(1);
  const fetch = vi.fn(async (url) => String(url).includes('registry') ? Response.json({
    'dist-tags': { latest: '2.1.0', beta: '2.1.1-beta.10' }, versions: {
      '2.1.0': { version: '2.1.0', dist: { integrity: 'sha512-stable' } },
      '2.1.1-beta.10': { version: '2.1.1-beta.10', dist: { integrity: 'sha512-beta' } },
    },
  }) : Response.json({ body: 'Notes' }));
  expect(await discoverCliRelease('stable', '2.0.0', fetch)).toMatchObject({ version: '2.1.0', releaseNotes: 'Notes' });
  expect(await discoverCliRelease('beta', '2.0.0', fetch)).toMatchObject({ version: '2.1.1-beta.10' });
  await expect(discoverCliRelease('stable', '2.0.0', async () => new Response('', { status: 503 }))).rejects.toThrow('registry');
});
