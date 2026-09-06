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
    expect(result.diffStats).toEqual({});
  });

  test('parses Cap diffStats for ChangeRow +/- chips', async () => {
    const runtimeFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        branch: 'main',
        files: [],
        stagedFiles: ['a.ts'],
        diffStats: {
          'a.ts': { insertions: 3, deletions: 1 },
          'b.ts': { insertions: 0, deletions: 2 },
        },
      }),
    });
    const result = await loadLynxGitStatus(runtimeFetch, '/repo');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.diffStats).toEqual({
      'a.ts': { insertions: 3, deletions: 1 },
      'b.ts': { insertions: 0, deletions: 2 },
    });
  });
});

import {
  commitLynxGitChanges,
  loadLynxGitFileDiff,
  stageLynxGitFiles,
  syncLynxGit,
  unstageLynxGitFiles,
} from './changesSurface';

describe('loadLynxGitFileDiff', () => {
  test('no-runtime / no-directory are not empty ok', async () => {
    expect(await loadLynxGitFileDiff(null, '/repo', 'a.ts')).toEqual({ status: 'no-runtime' });
    const runtimeFetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
    expect(await loadLynxGitFileDiff(runtimeFetch, ' ', 'a.ts')).toEqual({ status: 'no-directory' });
  });

  test('fetches file-diff and optional unified turn-diff', async () => {
    const calls: string[] = [];
    const runtimeFetch = async (path: string) => {
      calls.push(path);
      if (path.includes('/api/git/file-diff')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ original: 'old', modified: 'new', path: 'a.ts', isBinary: false }),
        };
      }
      if (path.includes('/api/git/diff')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ diff: '@@ -1 +1 @@\n-old\n+new\n' }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const result = await loadLynxGitFileDiff(runtimeFetch, '/repo', 'a.ts', { staged: true });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.original).toBe('old');
    expect(result.modified).toBe('new');
    expect(result.unifiedDiff).toContain('+new');
    expect(calls.some((c) => c.includes('staged=true'))).toBe(true);
  });

  test('HTTP failure ≠ empty diff', async () => {
    const runtimeFetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const result = await loadLynxGitFileDiff(runtimeFetch, '/repo', 'a.ts');
    expect(result.status).toBe('failed');
  });
});

describe('commitLynxGitChanges / syncLynxGit', () => {
  test('commit posts Cap /api/git/commit', async () => {
    const calls: Array<{ path: string; body: string | undefined }> = [];
    const runtimeFetch = async (path: string, init?: { body?: string }) => {
      calls.push({ path, body: init?.body });
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    };
    const result = await commitLynxGitChanges(runtimeFetch, '/repo', 'fix: x');
    expect(result).toEqual({ status: 'ok' });
    expect(calls[0]?.path).toContain('/api/git/commit?');
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ message: 'fix: x' });
  });

  test('sync posts Cap fetch/pull/push', async () => {
    const paths: string[] = [];
    const runtimeFetch = async (path: string) => {
      paths.push(path);
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    };
    expect(await syncLynxGit(runtimeFetch, '/repo', 'fetch')).toEqual({ status: 'ok' });
    expect(await syncLynxGit(runtimeFetch, '/repo', 'pull')).toEqual({ status: 'ok' });
    expect(await syncLynxGit(runtimeFetch, '/repo', 'push')).toEqual({ status: 'ok' });
    expect(paths.some((p) => p.includes('/api/git/fetch'))).toBe(true);
    expect(paths.some((p) => p.includes('/api/git/pull'))).toBe(true);
    expect(paths.some((p) => p.includes('/api/git/push'))).toBe(true);
  });

  test('empty commit message fails without fake-success', async () => {
    const runtimeFetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
    const result = await commitLynxGitChanges(runtimeFetch, '/repo', '  ');
    expect(result.status).toBe('failed');
  });
});

describe('stageLynxGitFiles / unstageLynxGitFiles', () => {
  test('stage posts Cap /api/git/stage with paths', async () => {
    const calls: Array<{ path: string; body: string | undefined }> = [];
    const runtimeFetch = async (path: string, init?: { body?: string }) => {
      calls.push({ path, body: init?.body });
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    };
    const result = await stageLynxGitFiles(runtimeFetch, '/repo', ['a.ts', ' b.ts ']);
    expect(result).toEqual({ status: 'ok' });
    expect(calls[0]?.path).toContain('/api/git/stage?');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ paths: ['a.ts', 'b.ts'] });
  });

  test('unstage posts Cap /api/git/unstage with paths', async () => {
    const calls: Array<{ path: string; body: string | undefined }> = [];
    const runtimeFetch = async (path: string, init?: { body?: string }) => {
      calls.push({ path, body: init?.body });
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    };
    expect(await unstageLynxGitFiles(runtimeFetch, '/repo', ['a.ts'])).toEqual({ status: 'ok' });
    expect(calls[0]?.path).toContain('/api/git/unstage?');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ paths: ['a.ts'] });
  });

  test('empty paths / no-runtime / no-directory never fake-success', async () => {
    expect(await stageLynxGitFiles(null, '/repo', ['a.ts'])).toEqual({ status: 'no-runtime' });
    const runtimeFetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
    expect(await stageLynxGitFiles(runtimeFetch, ' ', ['a.ts'])).toEqual({ status: 'no-directory' });
    const empty = await stageLynxGitFiles(runtimeFetch, '/repo', ['  ']);
    expect(empty.status).toBe('failed');
  });
});
