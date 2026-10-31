import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createSettingsRuntime } from '../opencode/settings-runtime.js';
import { createSettingsNormalizationRuntime } from '../opencode/settings-normalization-runtime.js';
import { createProjectDirectoryRuntime } from '../opencode/project-directory-runtime.js';
import { createProjectRegistry } from './registry.js';

const setup = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yuri-registry-'));
  const settingsPath = path.join(directory, 'settings.json');
  const tips = vi.fn();
  let failWrites = false;
  const normalization = createSettingsNormalizationRuntime({ os, path, processLike: process });
  const runtime = createSettingsRuntime({
    fsPromises: { ...fs, rename: (...args) => failWrites ? Promise.reject(new Error('write failed')) : fs.rename(...args) },
    path, crypto, SETTINGS_FILE_PATH: settingsPath, ...normalization,
    sanitizeSettingsUpdate: (patch) => patch,
    mergePersistedSettings: (current, patch) => ({ ...current, ...patch }),
    formatSettingsResponse: (settings) => settings,
    resolveDirectoryCandidate: (value) => value,
    onProjectOrderChanged: tips,
  });
  const { validateDirectoryPath } = createProjectDirectoryRuntime({
    fsPromises: fs, path, normalizeDirectoryPath: normalization.normalizeDirectoryPath,
  });
  const registry = createProjectRegistry({ persistSettings: runtime.persistSettings, validateDirectoryPath });
  const workspace = path.join(directory, 'workspace');
  await fs.mkdir(workspace);
  return { directory, settingsPath, workspace, registry, runtime, tips,
    failWrites: () => { failWrites = true; },
    cleanup: () => fs.rm(directory, { recursive: true, force: true }),
  };
};

describe('shared project registry owner', () => {
  it('registers and deduplicates canonical aliases without deleting files', async () => {
    const app = await setup();
    try {
      const first = await app.registry.register({ path: app.workspace, label: 'App' });
      const alias = path.join(app.directory, 'alias');
      await fs.symlink(app.workspace, alias);
      const second = await app.registry.register({ path: alias });
      expect(first.created).toBe(true);
      expect(second).toMatchObject({ created: false, project: { id: first.project.id, label: 'App' } });
      expect((await app.runtime.readSettingsFromDiskStrict()).projects).toHaveLength(1);
      expect(app.tips).toHaveBeenCalledTimes(1);
      expect((await fs.stat(app.workspace)).isDirectory()).toBe(true);
    } finally { await app.cleanup(); }
  });

  it('serializes concurrent registrations against the latest settings and preserves unrelated/offline projects', async () => {
    const app = await setup();
    try {
      const other = path.join(app.directory, 'other');
      await fs.mkdir(other);
      await fs.writeFile(app.settingsPath, JSON.stringify({
        projects: [{ id: 'offline', path: path.join(app.directory, 'offline'), addedAt: 1, lastOpenedAt: 1 }],
        theme: 'saved', activeProjectId: 'offline', lastDirectory: 'keep-this-selection',
      }));
      const results = await Promise.all([
        app.registry.register({ path: app.workspace }), app.registry.register({ path: other }),
        app.runtime.persistSettings({ theme: 'new-theme' }),
      ]);
      const saved = await app.runtime.readSettingsFromDiskStrict();
      expect(saved.projects.map((project) => project.path)).toEqual(expect.arrayContaining([path.join(app.directory, 'offline'), await fs.realpath(app.workspace), await fs.realpath(other)]));
      expect(saved.projects).toHaveLength(3);
      expect(saved.projects[0].path).toBe(path.join(app.directory, 'offline'));
      expect(saved.theme).toBe('new-theme');
      expect(saved.activeProjectId).not.toBe(results[0].project.id);
      expect(saved.lastDirectory).toBe('keep-this-selection');
      const restarted = createProjectRegistry({ persistSettings: app.runtime.persistSettings,
        validateDirectoryPath: async () => ({ ok: true, directory: await fs.realpath(app.workspace) }) });
      expect((await restarted.register({ path: app.workspace })).created).toBe(false);
    } finally { await app.cleanup(); }
  });

  it('rejects missing/file directories without a write or revision tip', async () => {
    const app = await setup();
    try {
      await fs.writeFile(app.settingsPath, JSON.stringify({ theme: 'saved' }));
      const before = await fs.readFile(app.settingsPath, 'utf8');
      await expect(app.registry.register({ path: path.join(app.directory, 'missing') })).rejects.toMatchObject({ code: 'validation_error' });
      await expect(app.registry.register({ path: app.settingsPath })).rejects.toMatchObject({ code: 'validation_error' });
      expect(await fs.readFile(app.settingsPath, 'utf8')).toBe(before);
      expect(app.tips).not.toHaveBeenCalled();
    } finally { await app.cleanup(); }
  });

  it('preserves the previous committed settings on failed writes, and never overwrites corrupt settings', async () => {
    const app = await setup();
    try {
      await fs.writeFile(app.settingsPath, JSON.stringify({ theme: 'saved' }));
      app.failWrites();
      await expect(app.registry.register({ path: app.workspace })).rejects.toThrow('write failed');
      expect(await app.runtime.readSettingsFromDiskStrict()).toEqual({ theme: 'saved' });
      expect(app.tips).not.toHaveBeenCalled();
      for (const corrupt of ['{broken', '[]', 'null']) {
        await fs.writeFile(app.settingsPath, corrupt);
        await expect(app.registry.register({ path: app.workspace })).rejects.toThrow();
        expect(await fs.readFile(app.settingsPath, 'utf8')).toBe(corrupt);
      }
    } finally { await app.cleanup(); }
  });
});
