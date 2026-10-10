import { test, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DesktopInstaller } from './desktop-installer.mjs';
import { writeInstallerFeed } from './scripts/write-installer-feed.mjs';

function fixture(version = '2.1.0-beta.1') {
  const updater = Object.assign(new EventEmitter(), {
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(async () => ({ updateInfo: { version }, isUpdateAvailable: true })),
    downloadUpdate: vi.fn(async () => ['installer']),
    quitAndInstall: vi.fn(),
  });
  return { updater, installer: new DesktopInstaller(updater) };
}

test('pins a full installer to the shared beta decision and installs only after download', async () => {
  const { updater, installer } = fixture();
  expect(updater.autoDownload).toBe(false);
  expect(updater.autoInstallOnAppQuit).toBe(false);
  await installer.check('2.1.0-beta.1', { channel: 'beta' });
  expect(updater.setFeedURL.mock.calls[0][0]).toMatchObject({ channel: 'full', url: 'https://github.com/yee94/openchamber/releases/download/v2.1.0-beta.1/' });
  expect(() => installer.install()).toThrow('No downloaded installer');
  await installer.download();
  expect(await installer.check('2.1.0-beta.1', { channel: 'beta' })).toEqual({ downloaded: true });
  installer.install();
  expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  installer.clear();
  expect(() => installer.install()).toThrow();
});

test('stable selection rejects beta and mismatched feed versions before downloading', async () => {
  const { updater, installer } = fixture();
  await expect(installer.check('2.1.0-beta.1', { channel: 'stable' })).rejects.toThrow('channel');
  expect(updater.setFeedURL).not.toHaveBeenCalled();
  await expect(installer.check('2.1.0', { channel: 'stable' })).rejects.toThrow('does not match');
  await expect(installer.download()).rejects.toThrow('No installer');
  expect(updater.downloadUpdate).not.toHaveBeenCalled();
});

test('failed downloads remain retryable and channel changes cannot race an active download', async () => {
  const { updater, installer } = fixture();
  await installer.check('2.1.0-beta.1', { channel: 'beta' });
  let reject;
  updater.downloadUpdate.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  const downloading = installer.download();
  await expect(installer.check('2.1.0', { channel: 'stable' })).rejects.toThrow('in progress');
  reject(new Error('offline'));
  await expect(downloading).rejects.toThrow('offline');
  expect(installer.downloaded).toBe(false);
  await installer.download();
  expect(installer.downloaded).toBe(true);
});

test.each([
  ['darwin', 'arm64', 'mac-arm64.zip', 'full-mac.yml'],
  ['win32', 'x64', 'win-x64.exe', 'full.yml'],
  ['linux', 'x64', 'linux-x86_64.AppImage', 'full-linux.yml'],
  ['linux', 'arm64', 'linux-arm64.AppImage', 'full-linux-arm64.yml'],
])('writes checksum-verified %s/%s installer metadata', async (platform, arch, suffix, manifest) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'installer-feed-'));
  try {
    const name = `OpenChamber-2.1.0-beta.1-${suffix}`;
    await writeFile(path.join(directory, name), 'full installer bytes');
    await writeInstallerFeed({ directory, version: '2.1.0-beta.1', platform, arch });
    const feed = JSON.parse(await readFile(path.join(directory, manifest), 'utf8'));
    expect(feed.files).toEqual([{ url: name, size: 20, sha512: createHash('sha512').update('full installer bytes').digest('base64') }]);
    expect(feed.version).toBe('2.1.0-beta.1');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
