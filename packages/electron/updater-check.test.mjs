import assert from 'node:assert/strict';
import test from 'node:test';

import { checkForDesktopUpdate } from './updater-check.mjs';

const compareVersions = (left, right) => left.localeCompare(right, undefined, { numeric: true });

test('signals failed checks without replacing an existing pending update', async () => {
  const pendingUpdate = { version: '2.0.0', electronUpdate: { id: 'existing' } };
  await assert.rejects(
    checkForDesktopUpdate({
      autoUpdater: { checkForUpdates: async () => { throw new Error('feed unavailable'); } },
      currentVersion: '1.0.0',
      pendingUpdate,
      compareVersions,
    }),
    /Unable to check for updates: feed unavailable.*network connection/,
  );
  assert.deepEqual(pendingUpdate, { version: '2.0.0', electronUpdate: { id: 'existing' } });
});

test('treats missing update feed (404) as no update available', async () => {
  const result = await checkForDesktopUpdate({
    autoUpdater: {
      checkForUpdates: async () => {
        throw new Error('HttpError: 404 Not Found "https://github.com/.../latest-linux.yml"');
      },
    },
    currentVersion: '1.15.0',
    pendingUpdate: { version: '1.16.0' },
    compareVersions,
  });
  assert.equal(result.available, false);
  assert.equal(result.pendingUpdate, null);
  assert.equal(result.nextVersion, '1.15.0');
});

test('authoritative no-update result clears pending update', async () => {
  const result = await checkForDesktopUpdate({
    autoUpdater: { checkForUpdates: async () => ({ updateInfo: { version: '1.0.0' } }) },
    currentVersion: '1.0.0',
    pendingUpdate: { version: '2.0.0' },
    compareVersions,
  });
  assert.equal(result.available, false);
  assert.equal(result.pendingUpdate, null);
});

test('preserves downloaded flag when the same version is still pending', async () => {
  const result = await checkForDesktopUpdate({
    autoUpdater: { checkForUpdates: async () => ({ updateInfo: { version: '2.0.0' }, id: 'fresh' }) },
    currentVersion: '1.0.0',
    pendingUpdate: { version: '2.0.0', downloaded: true, electronUpdate: { id: 'old' } },
    compareVersions,
  });
  assert.equal(result.available, true);
  assert.equal(result.pendingUpdate?.downloaded, true);
  assert.equal(result.pendingUpdate?.electronUpdate?.id, 'fresh');
});

test('does not carry downloaded across a different pending version', async () => {
  const result = await checkForDesktopUpdate({
    autoUpdater: { checkForUpdates: async () => ({ updateInfo: { version: '3.0.0' } }) },
    currentVersion: '1.0.0',
    pendingUpdate: { version: '2.0.0', downloaded: true },
    compareVersions,
  });
  assert.equal(result.pendingUpdate?.version, '3.0.0');
  assert.equal(result.pendingUpdate?.downloaded, false);
});
