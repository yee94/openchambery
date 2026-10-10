import { afterEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DesktopOta } from './desktop-ota.mjs';
import { createAssetZip } from '../web/server/lib/zip-assets.js';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function fixture(version = '2.1.1-beta.2', nativeVersion = '2.1.0') {
  const root = await mkdtemp(path.join(tmpdir(), 'desktop-ota-'));
  roots.push(root);
  const assets = path.join(root, 'assets');
  await mkdir(assets);
  await writeFile(path.join(assets, 'index.html'), '<html>new UI</html>');
  await writeFile(path.join(assets, 'desktop-ota.json'), JSON.stringify({ releaseVersion: version, shellFingerprint: 'a'.repeat(64) }));
  const zip = path.join(root, 'bundle.zip');
  createAssetZip(assets, zip);
  const bytes = await readFile(zip);
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const bundleId = checksum.slice(0, 16);
  const decision = { status: 'ok', primaryAction: 'apply_ota', nextCheckInSec: 3600,
    native: { state: 'current' }, ota: { state: 'available', bundle: {
      bundleId, releaseVersion: version, url: `https://updates.example.com/ota/bundles/${bundleId}.zip`,
      checksum, size: bytes.length, minShellApiVersion: 1, minShellReleaseVersion: '2.1.0',
    } } };
  const fetchImpl = vi.fn(async (url) => String(url).includes('/check') ? Response.json(decision) : new Response(bytes));
  const options = { directory: path.join(root, 'ota'), builtinDirectory: path.join(root, 'builtin'), nativeVersion,
    origin: 'https://updates.example.com', fetchImpl };
  const ota = new DesktopOta(options);
  await ota.initialize();
  return { root, ota, options, fetchImpl, decision, bytes };
}

describe('desktop OTA lifecycle', () => {
  test('downloads once, keeps the current UI until restart, confirms the new version and retains it', async () => {
    const f = await fixture();
    await f.ota.check('beta');
    await Promise.all([f.ota.download(), f.ota.download()]);
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    expect(f.ota.version).toBe('2.1.0');
    expect((await f.ota.check('beta')).downloaded).toBe(true);
    const restarted = new DesktopOta(f.options);
    await restarted.initialize();
    expect(restarted.version).toBe('2.1.1-beta.2');
    expect(restarted.assetDirectory).not.toBe(f.options.builtinDirectory);
    await restarted.ready(restarted.version);
    const again = new DesktopOta(f.options);
    await again.initialize();
    expect(again.version).toBe(restarted.version);
  });

  test('unconfirmed startup rolls back, remembers the bad bundle and cannot loop', async () => {
    const f = await fixture();
    await f.ota.check('beta');
    await f.ota.download();
    const failedBoot = new DesktopOta(f.options);
    await failedBoot.initialize();
    const recovery = new DesktopOta(f.options);
    await recovery.initialize();
    expect(recovery.assetDirectory).toBe(f.options.builtinDirectory);
    await expect(recovery.check('beta')).rejects.toThrow('previously failed');
  });

  test('a fresh shell install discards old queued assets and keeps channel preference', async () => {
    const f = await fixture();
    await f.ota.check('beta');
    await f.ota.download();
    const upgrade = new DesktopOta({ ...f.options, nativeVersion: '2.2.0' });
    await upgrade.initialize();
    expect(upgrade.version).toBe('2.2.0');
    expect(upgrade.state.queued).toBeNull();
    expect(upgrade.state.channel).toBe('beta');
  });

  test('failed second OTA restores the previous confirmed OTA, not just builtin', async () => {
    const first = await fixture();
    await first.ota.check('beta');
    await first.ota.download();
    const next = await fixture('2.1.2-beta.1');
    const options = { ...first.options, fetchImpl: next.fetchImpl };
    const goodBoot = new DesktopOta(options);
    await goodBoot.initialize();
    await goodBoot.ready(goodBoot.version);
    await goodBoot.check('beta');
    await goodBoot.download();
    const badBoot = new DesktopOta(options);
    await badBoot.initialize();
    expect(badBoot.version).toBe('2.1.2-beta.1');
    const recovered = new DesktopOta(options);
    await recovered.initialize();
    expect(recovered.version).toBe('2.1.1-beta.2');
  });

  test('background-only launch keeps queued resources for a foreground restart', async () => {
    const f = await fixture();
    await f.ota.check('beta');
    await f.ota.download();
    const background = new DesktopOta(f.options);
    await background.initialize({ activateQueued: false });
    expect(background.version).toBe('2.1.0');
    await background.assertPending();
    const foreground = new DesktopOta(f.options);
    await foreground.initialize();
    expect(foreground.version).toBe('2.1.1-beta.2');
  });

  test('channel switch clears the queued update even when the next check fails', async () => {
    const f = await fixture();
    await f.ota.check('beta');
    await f.ota.download();
    f.fetchImpl.mockResolvedValueOnce(new Response('', { status: 503 }));
    await expect(f.ota.check('stable')).rejects.toThrow('503');
    expect(f.ota.state.queued).toBeNull();
    await expect(f.ota.assertPending()).rejects.toThrow('No downloaded');
    await expect(f.ota.download()).rejects.toThrow('No pending');
  });

  test('bad checksum cannot queue or replace the current UI', async () => {
    const f = await fixture();
    f.decision.ota.bundle.checksum = '0'.repeat(64);
    await f.ota.check('beta');
    await expect(f.ota.download()).rejects.toThrow('checksum');
    expect(f.ota.state.queued).toBeNull();
    expect(f.ota.assetDirectory).toBe(f.options.builtinDirectory);
  });

  test('rejects cross-major, shell-incompatible and foreign-origin decisions in main', async () => {
    const f = await fixture();
    const original = structuredClone(f.decision.ota.bundle);
    for (const override of [{ releaseVersion: '3.0.0' }, { minShellReleaseVersion: '2.2.0' }, { url: 'https://other.example.com/a.zip' }]) {
      f.decision.ota.bundle = { ...original, ...override };
      await expect(f.ota.check('beta')).rejects.toThrow();
    }
  });

  test('only explicit beta-to-stable rollback permits downgrade', async () => {
    const f = await fixture('2.1.0', '2.1.2-beta.1');
    await expect(f.ota.check('stable')).rejects.toThrow('downgrade');
    f.decision.isChannelRollback = true;
    expect((await f.ota.check('stable')).isChannelRollback).toBe(true);
    await f.ota.download();
    const restart = new DesktopOta(f.options);
    await restart.initialize();
    expect(restart.version).toBe('2.1.0');
    await expect(f.ota.check('beta')).rejects.toThrow('downgrade');
  });

  test('network failure preserves a previously downloaded candidate on the same channel', async () => {
    const f = await fixture();
    await f.ota.check('beta');
    await f.ota.download();
    f.fetchImpl.mockRejectedValueOnce(new Error('offline'));
    await expect(f.ota.check('beta')).rejects.toThrow('offline');
    await f.ota.assertPending();
  });

  test('failed queue persistence leaves no in-memory pending restart', async () => {
    const f = await fixture();
    await f.ota.check('beta');
    vi.spyOn(f.ota, 'persist').mockRejectedValueOnce(new Error('disk full'));
    await expect(f.ota.download()).rejects.toThrow('disk full');
    expect(f.ota.state.queued).toBeNull();
    await expect(f.ota.assertPending()).rejects.toThrow('No downloaded');
  });
});
