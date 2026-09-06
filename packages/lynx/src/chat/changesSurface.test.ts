import { describe, expect, test } from 'vitest';

import { loadLynxGitStatus } from './changesSurface';

describe('loadLynxGitStatus', () => {
  test('no-runtime / no-directory are not empty ok', async () => {
    expect(await loadLynxGitStatus(null, '/repo')).toEqual({ status: 'no-runtime' });
    const runtimeFetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
    expect(await loadLynxGitStatus(runtimeFetch, '  ')).toEqual({ status: 'no-directory' });
  });

  test('HTTP failure ≠ empty changes', async () => {
    const runtimeFetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
    const result = await loadLynxGitStatus(runtimeFetch, '/repo');
    expect(result.status).toBe('failed');
  });

  test('parses Cap git status payload', async () => {
    const runtimeFetch = async (path: string) => {
      expect(path).toContain('/api/git/status?');
      expect(path).toContain('directory=%2Frepo');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          branch: 'main',
          stagedFiles: ['a.ts'],
          unstagedFiles: [{ path: 'b.ts', status: 'modified' }],
          untrackedFiles: ['c.ts'],
        }),
      };
    };
    const result = await loadLynxGitStatus(runtimeFetch, '/repo');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.branch).toBe('main');
    expect(result.entries).toEqual([
      { path: 'a.ts', status: 'staged', staged: true },
      { path: 'b.ts', status: 'modified', staged: false },
      { path: 'c.ts', status: 'untracked', staged: false },
    ]);
  });
});
