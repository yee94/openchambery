import { describe, expect, it } from 'vitest';
import crypto from 'crypto';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { createProjectIdFromPath } from '../projects/project-id.js';
import { createSettingsRuntime } from './settings-runtime.js';

const createRuntime = async () => {
  const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-settings-runtime-'));
  const settingsFilePath = path.join(tempRoot, 'settings.json');
  const runtime = createSettingsRuntime({
    fsPromises,
    path,
    crypto,
    SETTINGS_FILE_PATH: settingsFilePath,
    sanitizeProjects: (projects) => Array.isArray(projects) ? projects : [],
    sanitizeSettingsUpdate: (settings) => settings,
    mergePersistedSettings: (_current, changes) => changes,
    normalizeSettingsPaths: (settings) => ({ settings, changed: false }),
    normalizeStringArray: (values) => Array.isArray(values) ? values.filter((value) => typeof value === 'string') : [],
    formatSettingsResponse: (settings) => settings,
    resolveDirectoryCandidate: (value) => value,
  });

  return {
    runtime,
    settingsFilePath,
    tempRoot,
    cleanup: async () => {
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    },
  };
};

describe('settings runtime', () => {
  it('only remaps project plan paths within the migrated storage directory', async () => {
    const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime();
    try {
      const projectPath = path.join(tempRoot, 'project');
      const oldProjectId = 'legacy-project-id';
      const newProjectId = createProjectIdFromPath(projectPath);
      const projectsRoot = path.join(path.dirname(settingsFilePath), 'projects');
      const oldStorageDir = path.join(projectsRoot, oldProjectId);
      const newStorageDir = path.join(projectsRoot, newProjectId);
      const siblingStorageDir = `${oldStorageDir}-sibling`;

      await fsPromises.mkdir(projectPath, { recursive: true });
      await fsPromises.mkdir(projectsRoot, { recursive: true });
      await fsPromises.writeFile(
        settingsFilePath,
        JSON.stringify({
          projects: [{ id: oldProjectId, path: projectPath, addedAt: 1, lastOpenedAt: 1 }],
          activeProjectId: oldProjectId,
        }, null, 2),
        'utf8',
      );
      await fsPromises.writeFile(
        path.join(projectsRoot, `${oldProjectId}.json`),
        JSON.stringify({
          projectPlanFiles: [
            { id: 'inside', path: path.join(oldStorageDir, 'plans', 'inside.md') },
            { id: 'sibling', path: path.join(siblingStorageDir, 'plans', 'outside.md') },
          ],
        }, null, 2),
        'utf8',
      );

      await runtime.readSettingsFromDiskMigrated();

      const migratedConfig = JSON.parse(await fsPromises.readFile(path.join(projectsRoot, `${newProjectId}.json`), 'utf8'));
      expect(migratedConfig.projectPlanFiles).toEqual([
        { id: 'inside', path: path.join(newStorageDir, 'plans', 'inside.md') },
        { id: 'sibling', path: path.join(siblingStorageDir, 'plans', 'outside.md') },
      ]);
    } finally {
      await cleanup();
    }
  });

  it('upgrades legacy compact-chat defaults once and writes the migration marker', async () => {
    const { runtime, settingsFilePath, cleanup } = await createRuntime();
    try {
      await fsPromises.writeFile(
        settingsFilePath,
        JSON.stringify({
          chatRenderMode: 'live',
          activityRenderMode: 'summary',
          showTurnChangedFiles: false,
          theme: 'dark',
        }, null, 2),
        'utf8',
      );

      const first = await runtime.readSettingsFromDiskMigrated();
      expect(first.chatRenderMode).toBe('sorted');
      expect(first.activityRenderMode).toBe('collapsed');
      expect(first.showTurnChangedFiles).toBe(true);
      expect(first.compactChatDefaultsMigrationVersion).toBe(1);
      expect(first.theme).toBe('dark');

      const onDisk = JSON.parse(await fsPromises.readFile(settingsFilePath, 'utf8'));
      expect(onDisk.chatRenderMode).toBe('sorted');
      expect(onDisk.activityRenderMode).toBe('collapsed');
      expect(onDisk.showTurnChangedFiles).toBe(true);
      expect(onDisk.compactChatDefaultsMigrationVersion).toBe(1);

      // Second read is idempotent — no re-upgrade of user-chosen legacy values after marker.
      await fsPromises.writeFile(
        settingsFilePath,
        JSON.stringify({
          chatRenderMode: 'live',
          activityRenderMode: 'summary',
          showTurnChangedFiles: false,
          compactChatDefaultsMigrationVersion: 1,
        }, null, 2),
        'utf8',
      );
      const second = await runtime.readSettingsFromDiskMigrated();
      expect(second.chatRenderMode).toBe('live');
      expect(second.activityRenderMode).toBe('summary');
      expect(second.showTurnChangedFiles).toBe(false);
      expect(second.compactChatDefaultsMigrationVersion).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it('upgrades absent compact-chat fields when marker is missing', async () => {
    const { runtime, settingsFilePath, cleanup } = await createRuntime();
    try {
      await fsPromises.writeFile(
        settingsFilePath,
        JSON.stringify({ theme: 'light' }, null, 2),
        'utf8',
      );

      const settings = await runtime.readSettingsFromDiskMigrated();
      expect(settings.chatRenderMode).toBe('sorted');
      expect(settings.activityRenderMode).toBe('collapsed');
      expect(settings.showTurnChangedFiles).toBe(true);
      expect(settings.compactChatDefaultsMigrationVersion).toBe(1);

      const onDisk = JSON.parse(await fsPromises.readFile(settingsFilePath, 'utf8'));
      expect(onDisk.chatRenderMode).toBe('sorted');
      expect(onDisk.activityRenderMode).toBe('collapsed');
      expect(onDisk.showTurnChangedFiles).toBe(true);
      expect(onDisk.compactChatDefaultsMigrationVersion).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it('runs compact-chat defaults migration on persistSettings before first write', async () => {
    const { runtime, settingsFilePath, cleanup } = await createRuntime();
    try {
      // No settings file yet — first persist must still establish marker + defaults.
      const response = await runtime.persistSettings({ theme: 'dark' });
      expect(response.theme).toBe('dark');
      expect(response.chatRenderMode).toBe('sorted');
      expect(response.activityRenderMode).toBe('collapsed');
      expect(response.showTurnChangedFiles).toBe(true);
      expect(response.compactChatDefaultsMigrationVersion).toBe(1);

      const onDisk = JSON.parse(await fsPromises.readFile(settingsFilePath, 'utf8'));
      expect(onDisk.chatRenderMode).toBe('sorted');
      expect(onDisk.activityRenderMode).toBe('collapsed');
      expect(onDisk.showTurnChangedFiles).toBe(true);
      expect(onDisk.compactChatDefaultsMigrationVersion).toBe(1);

      // After marker, user may set live / summary / false and values are retained.
      const afterUserChoice = await runtime.persistSettings({
        chatRenderMode: 'live',
        activityRenderMode: 'summary',
        showTurnChangedFiles: false,
        compactChatDefaultsMigrationVersion: 1,
      });
      expect(afterUserChoice.chatRenderMode).toBe('live');
      expect(afterUserChoice.activityRenderMode).toBe('summary');
      expect(afterUserChoice.showTurnChangedFiles).toBe(false);
      expect(afterUserChoice.compactChatDefaultsMigrationVersion).toBe(1);

      const onDiskAfter = JSON.parse(await fsPromises.readFile(settingsFilePath, 'utf8'));
      expect(onDiskAfter.chatRenderMode).toBe('live');
      expect(onDiskAfter.activityRenderMode).toBe('summary');
      expect(onDiskAfter.showTurnChangedFiles).toBe(false);
      expect(onDiskAfter.compactChatDefaultsMigrationVersion).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it.skipIf(process.platform !== 'win32')('falls back when Windows blocks atomic settings replacement', async () => {
    const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-settings-runtime-'));
    const settingsFilePath = path.join(tempRoot, 'settings.json');
    const wrappedFs = {
      ...fsPromises,
      rename: async () => {
        const error = new Error('operation not permitted');
        error.code = 'EPERM';
        throw error;
      },
    };
    const runtime = createSettingsRuntime({
      fsPromises: wrappedFs,
      path,
      crypto,
      SETTINGS_FILE_PATH: settingsFilePath,
      sanitizeProjects: (projects) => Array.isArray(projects) ? projects : [],
      sanitizeSettingsUpdate: (settings) => settings,
      mergePersistedSettings: (_current, changes) => changes,
      normalizeSettingsPaths: (settings) => ({ settings, changed: false }),
      normalizeStringArray: (values) => Array.isArray(values) ? values.filter((value) => typeof value === 'string') : [],
      formatSettingsResponse: (settings) => settings,
      resolveDirectoryCandidate: (value) => value,
    });

    try {
      await runtime.writeSettingsToDisk({ theme: 'dark' });

      await expect(fsPromises.readFile(settingsFilePath, 'utf8')).resolves.toBe(JSON.stringify({ theme: 'dark' }, null, 2));
    } finally {
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
