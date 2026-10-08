import { describe, expect, it } from 'vitest';

import { createSettingsNormalizationRuntime } from './settings-normalization-runtime.js';

const createTestRuntime = (overrides = {}) => {
  const defaults = {
    os: { homedir: () => '/home/testuser' },
    path: {
      resolve: (...args) => args[args.length - 1],
      sep: '/',
      dirname: (p) => p.split('/').slice(0, -1).join('/') || '/',
    },
    processLike: { platform: 'linux', env: {} },
    realpathSync: (p) => p,
    tunnelSessionTtlDefaultMs: 86400000,
    tunnelSessionTtlMinMs: 3600000,
    tunnelSessionTtlMaxMs: 604800000,
  };

  return createSettingsNormalizationRuntime({ ...defaults, ...overrides });
};

describe('settings normalization runtime - symlink resolution', () => {
  describe('normalizePathForPersistence', () => {
    it('uses native realpath to recover filesystem casing instead of preserving the input spelling', () => {
      const realpathSync = Object.assign((p) => p, {
        native: (p) => p.replace('/code/', '/Code/'),
      });
      const runtime = createTestRuntime({ realpathSync, processLike: { platform: 'darwin' } });

      expect(runtime.normalizePathForPersistence('/workspace/code/project')).toBe('/workspace/Code/project');
      const result = runtime.normalizeSettingsPaths({
        projects: [{ id: 'project', path: '/workspace/code/project' }],
        lastDirectory: '/workspace/code/project',
        pinnedDirectories: ['/workspace/code/project'],
      });
      expect(result.changed).toBe(true);
      expect(result.settings.projects[0].path).toBe('/workspace/Code/project');
      expect(result.settings.lastDirectory).toBe('/workspace/Code/project');
      expect(result.settings.pinnedDirectories).toEqual(['/workspace/Code/project']);
      expect(runtime.normalizeSettingsPaths(result.settings).changed).toBe(false);
    });

    it('preserves distinct directory casing when native realpath reports distinct locations', () => {
      const runtime = createTestRuntime({ realpathSync: Object.assign((p) => p, { native: (p) => p }) });
      expect(runtime.sanitizeProjects([
        { id: 'lower', path: '/workspace/code/project' },
        { id: 'upper', path: '/workspace/Code/project' },
      ])).toHaveLength(2);
    });

    it('keeps unavailable paths when native realpath fails', () => {
      const runtime = createTestRuntime({
        realpathSync: Object.assign(() => '/incorrect-fallback', {
          native: () => { throw new Error('EACCES'); },
        }),
      });
      expect(runtime.normalizePathForPersistence('/unavailable/project')).toBe('/unavailable/project');
    });

    it('resolves symlinks via realpathSync', () => {
      const runtime = createTestRuntime({
        realpathSync: (p) =>
          p === '/home/user/workplace' ? '/workplace/user' : p,
      });

      const result = runtime.normalizePathForPersistence('/home/user/workplace');
      expect(result).toBe('/workplace/user');
    });

    it('falls back to original path when realpathSync throws', () => {
      const runtime = createTestRuntime({
        realpathSync: () => {
          throw new Error('ENOENT');
        },
      });

      const result = runtime.normalizePathForPersistence('/nonexistent/path');
      expect(result).toBe('/nonexistent/path');
    });

    it('passes through when realpathSync is not provided', () => {
      const runtime = createTestRuntime({ realpathSync: undefined });

      const result = runtime.normalizePathForPersistence('/some/path');
      expect(result).toBe('/some/path');
    });

    it('preserves lowercase colon-prefixed paths on non-Windows platforms', () => {
      const runtime = createTestRuntime({ realpathSync: undefined });

      expect(runtime.normalizePathForPersistence('c:project')).toBe('c:project');
    });

    it('uppercases Windows drive letter before and after realpath resolution', () => {
      const runtime = createTestRuntime({
        processLike: { platform: 'win32', env: {} },
        realpathSync: (p) => {
          // Simulate safeRealpathSync returning a lowercase drive letter
          if (p === 'C:\\Users\\me\\project') return 'c:\\real\\project';
          return p;
        },
      });

      const result = runtime.normalizePathForPersistence('c:\\Users\\me\\project');
      // Drive letter uppercased on input AND after realpath
      expect(result).toBe('C:\\real\\project');
    });
  });

  describe('sanitizeProjects', () => {
    it('resolves symlinks in project paths', () => {
      const runtime = createTestRuntime({
        realpathSync: (p) =>
          p === '/home/user/workplace/MyProject'
            ? '/workplace/user/MyProject'
            : p,
      });

      const projects = [
        { id: 'proj1', path: '/home/user/workplace/MyProject', label: 'MyProject', color: 'primary', addedAt: 1000, lastOpenedAt: 1000 },
      ];

      const result = runtime.sanitizeProjects(projects);
      expect(result[0].path).toBe('/workplace/user/MyProject');
    });

    it('falls back to path.resolve when realpathSync throws', () => {
      const runtime = createTestRuntime({
        realpathSync: () => { throw new Error('ENOENT'); },
        path: { resolve: (p) => '/resolved' + p, sep: '/', dirname: (p) => p.split('/').slice(0, -1).join('/') || '/' },
      });

      const projects = [
        { id: 'proj1', path: '/missing/path', label: 'Missing', color: 'primary', addedAt: 1000, lastOpenedAt: 1000 },
      ];

      const result = runtime.sanitizeProjects(projects);
      expect(result[0].path).toBe('/resolved/missing/path');
    });

    it('deduplicates projects that resolve to the same realpath', () => {
      const runtime = createTestRuntime({
        realpathSync: (p) => p.startsWith('/symlink') ? '/real/project' : p,
        path: { resolve: (p) => p, sep: '/', dirname: (p) => p.split('/').slice(0, -1).join('/') || '/' },
      });

      const projects = [
        { id: 'proj1', path: '/symlink/a', label: 'A', color: 'primary', addedAt: 1000, lastOpenedAt: 1000 },
        { id: 'proj2', path: '/symlink/b', label: 'B', color: 'keyword', addedAt: 2000, lastOpenedAt: 2000 },
      ];

      const result = runtime.sanitizeProjects(projects);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('proj1');
    });
  });

  describe('normalizeSettingsPaths', () => {
    it('resolves symlinks in lastDirectory', () => {
      const runtime = createTestRuntime({
        realpathSync: (p) =>
          p === '/home/user/workplace/LyraRefactoring'
            ? '/workplace/user/LyraRefactoring'
            : p,
      });

      const result = runtime.normalizeSettingsPaths({
        lastDirectory: '/home/user/workplace/LyraRefactoring',
      });

      expect(result.changed).toBe(true);
      expect(result.settings.lastDirectory).toBe('/workplace/user/LyraRefactoring');
    });

    it('does not flag as changed when path is already canonical', () => {
      const runtime = createTestRuntime();

      const result = runtime.normalizeSettingsPaths({
        lastDirectory: '/real/path',
      });

      expect(result.changed).toBe(false);
    });
  });
});
