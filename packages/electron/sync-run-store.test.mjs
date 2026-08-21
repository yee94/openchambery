import { afterEach, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  SYNC_RUN_HISTORY_LIMIT,
  createSyncRunStore,
  summarizeSyncPlan,
  syncRunFileNameForTargetId,
  syncTargetIdForSshInstance,
} from './sync-run-store.mjs';
import {
  ElectronSshManager,
  SyncInProgressError,
} from './ssh-manager.mjs';
import { createSettingsStore } from './settings-store.mjs';

const tempDirs = [];

const makeTempDir = async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'openchamber-sync-run-'));
  tempDirs.push(dir);
  return dir;
};

const writeJson = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
};

afterEach(async () => {
  while (tempDirs.length > 0) {
    await fsp.rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('sync-run-store helpers', () => {
  test('namespaces SSH instance ids as ssh:<id>', () => {
    expect(syncTargetIdForSshInstance('abc')).toBe('ssh:abc');
    expect(() => syncTargetIdForSshInstance('')).toThrow(/instance id/i);
  });

  test('encodes targetId for Windows-safe filenames', () => {
    expect(syncRunFileNameForTargetId('ssh:abc')).toBe(`${encodeURIComponent('ssh:abc')}.jsonl`);
  });

  test('summarizeSyncPlan reads plan arrays and apply numeric counts', () => {
    expect(summarizeSyncPlan({
      files: [{ path: 'a' }, { path: 'b' }],
      directories: [{ path: 'd' }],
      deletes: ['x'],
      totalBytes: 12,
    })).toEqual({ files: 2, directories: 1, deletes: 1, totalBytes: 12 });

    expect(summarizeSyncPlan({
      files: 3,
      directories: 1,
      deletes: 2,
      totalBytes: 9,
    })).toEqual({ files: 3, directories: 1, deletes: 2, totalBytes: 9 });
  });
});

describe('createSyncRunStore', () => {
  test('appends records, truncates to 20, and isolates targets by file', async () => {
    const tempDir = await makeTempDir();
    const store = createSyncRunStore({ dataDir: tempDir });
    const targetA = 'ssh:a';
    const targetB = 'ssh:b';

    for (let index = 0; index < SYNC_RUN_HISTORY_LIMIT + 5; index += 1) {
      await store.append(targetA, {
        syncRunId: `a-${index}`,
        targetId: targetA,
        result: 'success',
        summary: { files: index, directories: 0, deletes: 0, totalBytes: index },
      });
    }
    await store.append(targetB, {
      syncRunId: 'b-0',
      targetId: targetB,
      result: 'failure',
      error: 'nope',
      summary: { files: 0, directories: 0, deletes: 0, totalBytes: 0 },
    });

    const recordsA = await store.readAll(targetA);
    const recordsB = await store.readAll(targetB);
    expect(recordsA).toHaveLength(SYNC_RUN_HISTORY_LIMIT);
    expect(recordsA[0].syncRunId).toBe('a-5');
    expect(recordsA.at(-1).syncRunId).toBe(`a-${SYNC_RUN_HISTORY_LIMIT + 4}`);
    expect(recordsB).toHaveLength(1);
    expect(recordsB[0]).toMatchObject({ syncRunId: 'b-0', result: 'failure', error: 'nope' });

    const fileA = store.resolveFilePath(targetA);
    const fileB = store.resolveFilePath(targetB);
    expect(path.dirname(fileA)).toBe(path.join(tempDir, 'sync-runs'));
    expect(fileA).not.toBe(fileB);
  });
});

describe('ElectronSshManager sync mutex and run records', () => {
  test('rejects concurrent sync on the same target with SyncInProgressError', async () => {
    const tempDir = await makeTempDir();
    const settingsFilePath = path.join(tempDir, 'settings.json');
    const settingsStore = createSettingsStore({ filePath: settingsFilePath });
    const manager = new ElectronSshManager({
      settingsFilePath,
      settingsStore,
      appVersion: '0.0.0-test',
      emit: () => undefined,
    });

    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let markStarted;
    const started = new Promise((resolve) => {
      markStarted = resolve;
    });

    const first = manager.runExclusiveSync('ssh-1', 'preview', async () => {
      markStarted();
      await gate;
      return { plan: { direction: 'push', files: [], directories: [], deletes: [], totalBytes: 0 } };
    });

    await started;
    await expect(manager.runExclusiveSync('ssh-1', 'apply', async () => ({ ok: true }))).rejects.toMatchObject({
      name: 'SyncInProgressError',
      code: 'sync_in_progress',
      targetId: 'ssh:ssh-1',
    });
    await expect(manager.runExclusiveSync('ssh-1', 'apply', async () => ({ ok: true }))).rejects.toBeInstanceOf(SyncInProgressError);

    release();
    const result = await first;
    expect(result.syncRunId).toMatch(/^[0-9a-f-]{36}$/i);

    const records = await manager.syncRunStore.readAll('ssh:ssh-1');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      result: 'success',
      stage: 'preview',
      targetId: 'ssh:ssh-1',
      direction: 'push',
    });
  });

  test('records failures without writing settings.json', async () => {
    const tempDir = await makeTempDir();
    const settingsFilePath = path.join(tempDir, 'settings.json');
    writeJson(settingsFilePath, { desktopHosts: [{ id: 'keep' }] });
    const settingsStore = createSettingsStore({ filePath: settingsFilePath });
    const manager = new ElectronSshManager({
      settingsFilePath,
      settingsStore,
      appVersion: '0.0.0-test',
      emit: () => undefined,
    });

    await expect(manager.runExclusiveSync('ssh-fail', 'apply', async () => {
      throw new Error('remote exploded');
    })).rejects.toThrow(/remote exploded/);

    const records = await manager.syncRunStore.readAll('ssh:ssh-fail');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      result: 'failure',
      error: 'remote exploded',
      stage: 'apply',
    });

    const settings = JSON.parse(await fsp.readFile(settingsFilePath, 'utf8'));
    expect(settings).toEqual({ desktopHosts: [{ id: 'keep' }] });
    expect(settings.syncRuns).toBeUndefined();
  });
});
