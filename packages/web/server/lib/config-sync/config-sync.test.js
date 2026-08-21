import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  OPENCODE_CONFIG_SYNC_BACKUP_DIR,
  OPENCODE_CONFIG_SYNC_BACKUP_GENERATIONS,
  SYNC_DIRECTION_PULL,
  SYNC_DIRECTION_PUSH,
  assertPlanDirection,
  assertTargetCapability,
  buildDefaultSyncSelections,
  buildRemoteSyncFinalizeScript,
  buildRemoteSyncPrepareScript,
  createSshSyncTarget,
  filterPlanBySelections,
  planOpenCodeConfigSync,
  planOpenCodeConfigSyncFromInventory,
  prepareLocalSyncDestination,
} from './index.js';

const tempDirs = [];

const makeTempDir = async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'oc-config-sync-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  while (tempDirs.length > 0) {
    await fsp.rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('config-sync contract', () => {
  it('requires direction on plans and accepts push/pull', () => {
    expect(assertPlanDirection({ direction: SYNC_DIRECTION_PUSH })).toBe('push');
    expect(assertPlanDirection({ direction: SYNC_DIRECTION_PULL })).toBe('pull');
    expect(() => assertPlanDirection({})).toThrow(/direction/);
  });

  it('gates SSH targets by capability derived from managed mode', () => {
    const managed = createSshSyncTarget('abc', { remoteOpenchamber: { mode: 'managed' } });
    expect(managed.id).toBe('ssh:abc');
    expect(managed.capabilities.posixShell).toBe(true);
    assertTargetCapability(managed, 'posixShell');

    const plain = createSshSyncTarget('abc', { remoteOpenchamber: { mode: 'external' } });
    expect(plain.capabilities.posixShell).toBe(false);
    expect(() => assertTargetCapability(plain, 'posixShell')).toThrow(/posixShell/);
  });

  it('plans from an arbitrary directory snapshot with direction (source/target decoupling)', async () => {
    const home = await makeTempDir();
    const configDir = path.join(home, '.config', 'opencode');
    await fsp.mkdir(configDir, { recursive: true });
    await fsp.writeFile(path.join(configDir, 'opencode.jsonc'), '{}\n');

    const pushPlan = planOpenCodeConfigSync(home, {
      direction: SYNC_DIRECTION_PUSH,
      syncRunId: 'dry-push',
      sourceTargetId: 'snapshot:a',
      targetId: 'ssh:remote',
    });
    expect(pushPlan.direction).toBe('push');
    expect(pushPlan.syncRunId).toBe('dry-push');
    expect(pushPlan.sourceTargetId).toBe('snapshot:a');
    expect(pushPlan.targetId).toBe('ssh:remote');
    expect(pushPlan.files.map((entry) => entry.path)).toContain('opencode.jsonc');

    // Same snapshot as a pull source — contract accepts reverse direction without shape change.
    const pullPlan = planOpenCodeConfigSync(home, {
      direction: SYNC_DIRECTION_PULL,
      syncRunId: 'dry-pull',
      sourceTargetId: 'ssh:remote',
      targetId: 'local',
    });
    expect(pullPlan.direction).toBe('pull');
    expect(pullPlan.files.map((entry) => entry.path)).toEqual(pushPlan.files.map((entry) => entry.path));
  });

  it('filters plans by whitelist selections and builds pull plans from inventory', async () => {
    const home = await makeTempDir();
    const configDir = path.join(home, '.config', 'opencode');
    await fsp.mkdir(path.join(configDir, 'skills'), { recursive: true });
    await fsp.writeFile(path.join(configDir, 'opencode.jsonc'), '{}\n');
    await fsp.writeFile(path.join(configDir, 'AGENTS.md'), 'hi\n');
    await fsp.writeFile(path.join(configDir, 'skills', 'a.md'), 'a\n');

    const full = planOpenCodeConfigSync(home, { direction: SYNC_DIRECTION_PUSH, includeAuthFile: false });
    const selections = buildDefaultSyncSelections({ includeAuthFile: false });
    selections.fileGroups = selections.fileGroups.map((_, index) => index === 0);
    selections.singleFiles = selections.singleFiles.map(() => false);
    selections.directories = selections.directories.map((__, index) => index === 2); // skills
    selections.agentsRoot = false;

    const filtered = filterPlanBySelections(full, selections);
    expect(filtered.files.map((entry) => entry.path)).toEqual(['opencode.jsonc']);
    expect(filtered.directories.map((entry) => entry.path)).toEqual(['skills']);
    expect(filtered.agentsRoot).toBeNull();
    expect(filtered.authFile).toBeNull();

    const inventoryPlan = planOpenCodeConfigSyncFromInventory({
      files: [{ path: 'opencode.jsonc', bytes: 3 }],
      directories: [{ path: 'skills', fileCount: 1, bytes: 2 }],
      agentsRoot: null,
      authFile: { bytes: 9 },
    }, {
      direction: SYNC_DIRECTION_PULL,
      selections: { ...selections, authFile: true },
      includeAuthFile: true,
    });
    expect(inventoryPlan.direction).toBe('pull');
    expect(inventoryPlan.authFile).toEqual({ bytes: 9 });
    expect(inventoryPlan.files.map((entry) => entry.path)).toEqual(['opencode.jsonc']);
  });
});

describe('local pull destination backups', () => {
  it('creates generational local backups and preserves failed-run scenes until pruned', async () => {
    const home = await makeTempDir();
    const configDir = path.join(home, '.config', 'opencode');
    await fsp.mkdir(configDir, { recursive: true });
    await fsp.writeFile(path.join(configDir, 'opencode.jsonc'), '{}\n');
    const plan = {
      files: [{ path: 'opencode.jsonc', bytes: 3 }],
      directories: [],
      deletes: ['config.json', 'opencode.json'],
      agentsRoot: null,
      authFile: null,
    };

    await prepareLocalSyncDestination(home, plan, { syncRunId: 'pull-01', generations: 2 });
    expect(fs.existsSync(path.join(configDir, OPENCODE_CONFIG_SYNC_BACKUP_DIR, 'pull-01', 'opencode.jsonc'))).toBe(true);
    await fsp.writeFile(path.join(configDir, 'opencode.jsonc'), '{v2}\n');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await prepareLocalSyncDestination(home, plan, { syncRunId: 'pull-02', generations: 2 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await prepareLocalSyncDestination(home, plan, { syncRunId: 'pull-03', generations: 2 });

    const remaining = fs.readdirSync(path.join(configDir, OPENCODE_CONFIG_SYNC_BACKUP_DIR)).sort();
    expect(remaining).toHaveLength(2);
    expect(remaining).not.toContain('pull-01');
  });
});

describe('generational prepare backups', () => {
  it('keeps N generations and preserves older failed-run dirs until pruned', async () => {
    const home = await makeTempDir();
    const configDir = path.join(home, '.config', 'opencode');
    await fsp.mkdir(configDir, { recursive: true });
    await fsp.writeFile(path.join(configDir, 'opencode.jsonc'), '{}\n');

    const plan = planOpenCodeConfigSync(home, { direction: SYNC_DIRECTION_PUSH });
    const generations = OPENCODE_CONFIG_SYNC_BACKUP_GENERATIONS;

    for (let index = 0; index < generations + 2; index += 1) {
      // Stagger mtimes so ls -1t ordering is stable across platforms.
      await new Promise((resolve) => setTimeout(resolve, 15));
      const syncRunId = `run-${String(index).padStart(2, '0')}`;
      const script = buildRemoteSyncPrepareScript(plan, { syncRunId, generations });
      execFileSync('sh', ['-c', script], { env: { ...process.env, HOME: home } });
      // Simulate a failed run leaving its backup scene in place (no wipe of root).
      const runBackup = path.join(configDir, OPENCODE_CONFIG_SYNC_BACKUP_DIR, syncRunId);
      expect(fs.existsSync(runBackup)).toBe(true);
      expect(fs.existsSync(path.join(runBackup, 'opencode.jsonc'))).toBe(true);
    }

    const backupRoot = path.join(configDir, OPENCODE_CONFIG_SYNC_BACKUP_DIR);
    const remaining = fs.readdirSync(backupRoot).sort();
    expect(remaining).toHaveLength(generations);
    expect(remaining).toEqual(
      Array.from({ length: generations }, (_, index) => `run-${String(index + 2).padStart(2, '0')}`),
    );
    // Earliest runs pruned; a mid-generation failed scene that remained until prune is gone only after exceeding N.
    expect(remaining).not.toContain('run-00');
    expect(remaining).not.toContain('run-01');
  });

  it('finalize confirms the run backup directory', async () => {
    const home = await makeTempDir();
    const configDir = path.join(home, '.config', 'opencode');
    await fsp.mkdir(path.join(configDir, OPENCODE_CONFIG_SYNC_BACKUP_DIR, 'fin-1'), { recursive: true });
    const ok = execFileSync('sh', ['-c', buildRemoteSyncFinalizeScript({ syncRunId: 'fin-1' })], {
      env: { ...process.env, HOME: home },
    });
    expect(ok.toString()).toContain('SYNC_DONE');

    expect(() => execFileSync('sh', ['-c', buildRemoteSyncFinalizeScript({ syncRunId: 'missing' })], {
      env: { ...process.env, HOME: home },
    })).toThrow();
  });
});
