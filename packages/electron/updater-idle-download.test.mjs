import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createIdleUpdateDownloadScheduler,
  isSystemIdleForUpdateDownload,
} from './updater-idle-download.mjs';

test('idle and locked are download-safe; active/unknown are not', () => {
  assert.equal(isSystemIdleForUpdateDownload('idle'), true);
  assert.equal(isSystemIdleForUpdateDownload('locked'), true);
  assert.equal(isSystemIdleForUpdateDownload('active'), false);
  assert.equal(isSystemIdleForUpdateDownload('unknown'), false);
});

test('waits until the system is idle before downloading', async () => {
  const states = ['active', 'active', 'idle'];
  let downloadCalls = 0;
  const pending = { value: true };
  const timers = new Map();
  let nextTimerId = 1;

  const setTimeoutFn = (fn) => {
    const id = nextTimerId;
    nextTimerId += 1;
    timers.set(id, fn);
    return id;
  };
  const clearTimeoutFn = (id) => {
    timers.delete(id);
  };
  const flush = async () => {
    const fns = [...timers.values()];
    timers.clear();
    for (const fn of fns) fn();
    await Promise.resolve();
  };

  const scheduler = createIdleUpdateDownloadScheduler({
    getIdleState: () => states.shift() || 'idle',
    downloadUpdate: async () => {
      downloadCalls += 1;
      pending.value = false;
    },
    isPendingDownload: () => pending.value,
    pollIntervalMs: 1,
    setTimeoutFn,
    clearTimeoutFn,
  });

  scheduler.schedule();
  await flush();
  assert.equal(downloadCalls, 0);
  await flush();
  assert.equal(downloadCalls, 0);
  await flush();
  assert.equal(downloadCalls, 1);
});

test('stop cancels a pending idle poll', async () => {
  let downloadCalls = 0;
  const timers = new Map();
  let nextTimerId = 1;
  const setTimeoutFn = (fn) => {
    const id = nextTimerId;
    nextTimerId += 1;
    timers.set(id, fn);
    return id;
  };
  const clearTimeoutFn = (id) => {
    timers.delete(id);
  };

  const scheduler = createIdleUpdateDownloadScheduler({
    getIdleState: () => 'idle',
    downloadUpdate: async () => {
      downloadCalls += 1;
    },
    isPendingDownload: () => true,
    setTimeoutFn,
    clearTimeoutFn,
  });

  scheduler.schedule();
  assert.equal(timers.size, 1);
  scheduler.stop();
  assert.equal(timers.size, 0);
  assert.equal(downloadCalls, 0);
});

test('failed idle download retries while still pending', async () => {
  let downloadCalls = 0;
  const pending = { value: true };
  const timers = new Map();
  let nextTimerId = 1;
  const setTimeoutFn = (fn) => {
    const id = nextTimerId;
    nextTimerId += 1;
    timers.set(id, fn);
    return id;
  };
  const clearTimeoutFn = (id) => {
    timers.delete(id);
  };
  const flush = async () => {
    const fns = [...timers.values()];
    timers.clear();
    for (const fn of fns) fn();
    await Promise.resolve();
    await Promise.resolve();
  };

  const scheduler = createIdleUpdateDownloadScheduler({
    getIdleState: () => 'idle',
    downloadUpdate: async () => {
      downloadCalls += 1;
      if (downloadCalls === 1) throw new Error('network blip');
      pending.value = false;
    },
    isPendingDownload: () => pending.value,
    pollIntervalMs: 1,
    setTimeoutFn,
    clearTimeoutFn,
    log: { warn() {} },
  });

  scheduler.schedule();
  await flush();
  assert.equal(downloadCalls, 1);
  await flush();
  assert.equal(downloadCalls, 2);
});
