import { describe, expect, test } from 'vitest';

import { loadLynxGitStatus, partitionLynxGitChangeEntries } from './changesSurface';

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
    expect(result.ahead).toBe(0);
    expect(result.behind).toBe(0);
    expect(result.tracking).toBeNull();
  });

  test('parses Cap ahead/behind/tracking for pull-if-behind', async () => {
    const runtimeFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        branch: 'main',
        tracking: 'origin/main',
        ahead: 2,
        behind: 1,
        stagedFiles: [],
      }),
    });
    const result = await loadLynxGitStatus(runtimeFetch, '/repo');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.ahead).toBe(2);
    expect(result.behind).toBe(1);
    expect(result.tracking).toBe('origin/main');
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

import {
  commitAndPushLynxGitChanges,
  generateLynxCommitMessage,
  parseLynxGitSyncCounts,
  revertLynxGitFile,
  revertLynxGitFiles,
} from './changesSurface';

describe('revertLynxGitFile / revertLynxGitFiles', () => {
  test('revert posts Cap /api/git/revert with path', async () => {
    const calls: Array<{ path: string; body: string | undefined }> = [];
    const runtimeFetch = async (path: string, init?: { body?: string }) => {
      calls.push({ path, body: init?.body });
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    };
    const result = await revertLynxGitFile(runtimeFetch, '/repo', 'a.ts', { scope: 'working' });
    expect(result).toEqual({ status: 'ok' });
    expect(calls[0]?.path).toContain('/api/git/revert?');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ path: 'a.ts', scope: 'working' });
  });

  test('bulk revert walks unique paths; first failure stops', async () => {
    const paths: string[] = [];
    const runtimeFetch = async (path: string, init?: { body?: string }) => {
      const body = init?.body ? JSON.parse(init.body) as { path?: string } : {};
      paths.push(String(body.path));
      if (body.path === 'b.ts') {
        return { ok: false, status: 500, json: async () => ({ error: 'revert failed' }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    };
    const ok = await revertLynxGitFiles(runtimeFetch, '/repo', ['a.ts', ' a.ts ', 'c.ts']);
    expect(ok).toEqual({ status: 'ok' });
    expect(paths).toEqual(['a.ts', 'c.ts']);

    const failed = await revertLynxGitFiles(runtimeFetch, '/repo', ['a.ts', 'b.ts', 'c.ts']);
    expect(failed.status).toBe('failed');
  });

  test('empty path / no-runtime / no-directory never fake-success', async () => {
    expect(await revertLynxGitFile(null, '/repo', 'a.ts')).toEqual({ status: 'no-runtime' });
    const runtimeFetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
    expect(await revertLynxGitFile(runtimeFetch, ' ', 'a.ts')).toEqual({ status: 'no-directory' });
    const empty = await revertLynxGitFile(runtimeFetch, '/repo', '  ');
    expect(empty.status).toBe('failed');
    expect(await revertLynxGitFiles(runtimeFetch, '/repo', [' ', ''])).toMatchObject({ status: 'failed' });
  });
});

describe('generateLynxCommitMessage', () => {
  test('posts Cap /api/small-model/generate purpose commit + parses subject', async () => {
    const calls: Array<{ path: string; body: string | undefined }> = [];
    const runtimeFetch = async (path: string, init?: { body?: string }) => {
      calls.push({ path, body: init?.body });
      if (path.includes('/api/git/diff')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ diff: '@@ -1 +1 @@\n-old\n+new\n' }),
        };
      }
      if (path === '/api/small-model/generate') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            text: '{"subject":"fix: widget","highlights":["a","b"]}',
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const result = await generateLynxCommitMessage(runtimeFetch, '/repo', ['a.ts']);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.message).toEqual({ subject: 'fix: widget', highlights: ['a', 'b'] });
    const generate = calls.find((c) => c.path === '/api/small-model/generate');
    expect(generate).toBeTruthy();
    expect(JSON.parse(generate!.body!)).toMatchObject({
      purpose: 'commit',
      directory: '/repo',
    });
    expect(calls.some((c) => c.path.includes('/api/git/diff'))).toBe(true);
  });

  test('empty files / HTTP failure / no-runtime never fake-success', async () => {
    expect(await generateLynxCommitMessage(null, '/repo', ['a.ts'])).toEqual({ status: 'no-runtime' });
    const runtimeFetch = async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: 'unavailable' }),
    });
    expect(await generateLynxCommitMessage(runtimeFetch, ' ', ['a.ts'])).toEqual({ status: 'no-directory' });
    const empty = await generateLynxCommitMessage(runtimeFetch, '/repo', ['  ']);
    expect(empty.status).toBe('failed');
    const failed = await generateLynxCommitMessage(runtimeFetch, '/repo', ['a.ts']);
    expect(failed.status).toBe('failed');
  });
});

describe('parseLynxGitSyncCounts', () => {
  test('reads Cap ahead/behind/tracking; invalid → 0 / null', () => {
    expect(parseLynxGitSyncCounts({
      ahead: 3,
      behind: '2',
      tracking: 'origin/feat',
    })).toEqual({ ahead: 3, behind: 2, tracking: 'origin/feat' });
    expect(parseLynxGitSyncCounts({})).toEqual({ ahead: 0, behind: 0, tracking: null });
  });
});

describe('commitAndPushLynxGitChanges', () => {
  test('Cap pull-if-behind: commit → fetch → pull(rebase) → push when behind', async () => {
    const calls: Array<{ path: string; body?: string }> = [];
    let statusRound = 0;
    const runtimeFetch = async (path: string, init?: { body?: string }) => {
      calls.push({ path, body: init?.body });
      if (path.includes('/api/git/commit')) {
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      }
      if (path.includes('/api/git/fetch')) {
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      }
      if (path.includes('/api/git/status')) {
        statusRound += 1;
        // after fetch: behind; after pull: ahead only
        const payload = statusRound === 1
          ? { branch: 'main', tracking: 'origin/main', ahead: 1, behind: 2, stagedFiles: [] }
          : { branch: 'main', tracking: 'origin/main', ahead: 1, behind: 0, stagedFiles: [] };
        return { ok: true, status: 200, json: async () => payload };
      }
      if (path.includes('/api/git/pull')) {
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      }
      if (path.includes('/api/git/push')) {
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      }
      return { ok: false, status: 500, json: async () => ({}) };
    };
    expect(await commitAndPushLynxGitChanges(runtimeFetch, '/repo', 'feat: x')).toEqual({ status: 'ok' });
    const kinds = calls.map((c) => {
      if (c.path.includes('/commit')) return 'commit';
      if (c.path.includes('/fetch')) return 'fetch';
      if (c.path.includes('/status')) return 'status';
      if (c.path.includes('/pull')) return 'pull';
      if (c.path.includes('/push')) return 'push';
      return c.path;
    });
    expect(kinds).toEqual(['commit', 'fetch', 'status', 'pull', 'status', 'push']);
    const pull = calls.find((c) => c.path.includes('/api/git/pull'));
    expect(JSON.parse(pull!.body!)).toMatchObject({
      remote: 'origin',
      branch: 'main',
      rebase: true,
    });
  });

  test('skips pull when not behind; still pushes when ahead', async () => {
    const kinds: string[] = [];
    const runtimeFetch = async (path: string) => {
      if (path.includes('/api/git/commit')) { kinds.push('commit'); return { ok: true, status: 200, json: async () => ({}) }; }
      if (path.includes('/api/git/fetch')) { kinds.push('fetch'); return { ok: true, status: 200, json: async () => ({}) }; }
      if (path.includes('/api/git/status')) {
        kinds.push('status');
        return {
          ok: true,
          status: 200,
          json: async () => ({ branch: 'main', tracking: 'origin/main', ahead: 1, behind: 0, stagedFiles: [] }),
        };
      }
      if (path.includes('/api/git/pull')) { kinds.push('pull'); return { ok: true, status: 200, json: async () => ({}) }; }
      if (path.includes('/api/git/push')) { kinds.push('push'); return { ok: true, status: 200, json: async () => ({}) }; }
      return { ok: false, status: 500, json: async () => ({}) };
    };
    expect(await commitAndPushLynxGitChanges(runtimeFetch, '/repo', 'feat: x')).toEqual({ status: 'ok' });
    // Cap always re-reads status before the ahead check (even when pull skipped).
    expect(kinds).toEqual(['commit', 'fetch', 'status', 'status', 'push']);
  });

  test('stops on commit failure; does not fetch/pull/push', async () => {
    const kinds: string[] = [];
    const runtimeFetch = async (path: string) => {
      if (path.includes('/api/git/commit')) {
        kinds.push('commit');
        return { ok: false, status: 500, json: async () => ({ error: 'no' }) };
      }
      kinds.push(path);
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const failed = await commitAndPushLynxGitChanges(runtimeFetch, '/repo', 'feat: x');
    expect(failed.status).toBe('failed');
    expect(kinds).toEqual(['commit']);
  });

  test('pull failure stops before push (no silent skip)', async () => {
    const kinds: string[] = [];
    let statusRound = 0;
    const runtimeFetch = async (path: string) => {
      if (path.includes('/api/git/commit')) { kinds.push('commit'); return { ok: true, status: 200, json: async () => ({}) }; }
      if (path.includes('/api/git/fetch')) { kinds.push('fetch'); return { ok: true, status: 200, json: async () => ({}) }; }
      if (path.includes('/api/git/status')) {
        kinds.push('status');
        statusRound += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({ branch: 'main', tracking: 'origin/main', ahead: 1, behind: 1, stagedFiles: [] }),
        };
      }
      if (path.includes('/api/git/pull')) {
        kinds.push('pull');
        return { ok: false, status: 500, json: async () => ({ error: 'conflict' }) };
      }
      if (path.includes('/api/git/push')) { kinds.push('push'); return { ok: true, status: 200, json: async () => ({}) }; }
      return { ok: false, status: 500, json: async () => ({}) };
    };
    const failed = await commitAndPushLynxGitChanges(runtimeFetch, '/repo', 'feat: x');
    expect(failed.status).toBe('failed');
    expect(kinds).toEqual(['commit', 'fetch', 'status', 'pull']);
  });
});


describe('partitionLynxGitChangeEntries', () => {
  test('Cap ChangesPanel staged vs unstaged groups', () => {
    expect(partitionLynxGitChangeEntries([])).toEqual({ staged: [], unstaged: [] });
    const entries = [
      { path: 'a.ts', status: 'staged', staged: true },
      { path: 'b.ts', status: 'modified', staged: false },
      { path: 'c.ts', status: 'untracked', staged: false },
    ];
    expect(partitionLynxGitChangeEntries(entries)).toEqual({
      staged: [entries[0]],
      unstaged: [entries[1], entries[2]],
    });
  });
});
