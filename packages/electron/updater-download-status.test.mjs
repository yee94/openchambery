import assert from 'node:assert/strict';
import test from 'node:test';

import { getUpdateDownloadSnapshot } from './updater-download-status.mjs';

test('exposes in-flight idle download progress for foreground promotion', () => {
  const snapshot = getUpdateDownloadSnapshot({
    pendingUpdate: { version: '1.16.106', downloaded: false },
    downloadInFlight: true,
    progress: { downloaded: 12_000_000, total: 48_000_000 },
  });

  assert.deepEqual(snapshot, {
    downloading: true,
    downloaded: false,
    progress: { downloaded: 12_000_000, total: 48_000_000 },
  });
});

test('omits progress once the package is ready to restart', () => {
  const snapshot = getUpdateDownloadSnapshot({
    pendingUpdate: { version: '1.16.106', downloaded: true },
    downloadInFlight: false,
    progress: { downloaded: 48_000_000, total: 48_000_000 },
  });

  assert.deepEqual(snapshot, {
    downloading: false,
    downloaded: true,
    progress: null,
  });
});

test('treats missing progress totals as indeterminate while downloading', () => {
  const snapshot = getUpdateDownloadSnapshot({
    pendingUpdate: { version: '1.16.106', downloaded: false },
    downloadInFlight: true,
    progress: { downloaded: 0 },
  });

  assert.deepEqual(snapshot, {
    downloading: true,
    downloaded: false,
    progress: { downloaded: 0 },
  });
});
