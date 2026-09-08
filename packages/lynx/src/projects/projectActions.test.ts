import { describe, expect, test } from 'vitest';

import {
  closeLynxProject,
  createLynxWorktree,
  deleteLynxRemoteBranch,
  deleteLynxWorktree,
  discoverLynxProjectIcon,
  fetchLynxWorktreeOrder,
  inferLynxProjectIsGit,
  loadLynxProjectMeta,
  normalizeLynxWorktreeBranchName,
  probeLynxGitRepository,
  removeLynxProjectIcon,
  setLynxWorktreeOrder,
  syncLynxProjectSessions,
  updateLynxProjectLabel,
  updateLynxProjectMeta,
} from './projectActions';

describe('Lynx project / worktree actions', () => {
  test('sync posts Cap session-index/sync directories', async () => {
    const calls: Array<{ path: string; method?: string; body?: string }> = [];
    const runtimeFetch = async (path: string, init?: { method?: string; body?: string }) => {
      calls.push({ path, method: init?.method, body: init?.body });
      return {
        ok: true,
        status: 200,
        json: async () => ({ available: true, directories: [], revision: 1, sync: {
          active: false, completed: 1, total: 1, pendingDirectories: [], completedDirectories: ['/repo'], failedDirectories: [],
        }, pinnedSessionIds: [] }),
      };
    };
    const result = await syncLynxProjectSessions(runtimeFetch, ['/repo', '/repo-wt', '/repo']);
    expect(result.status).toBe('ok');
    expect(calls[0]).toMatchObject({ path: '/api/openchamber/session-index/sync', method: 'POST' });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ directories: ['/repo', '/repo-wt'] });
  });

  test('sync unsupported / no-runtime are honest', async () => {
    expect(await syncLynxProjectSessions(null, ['/repo'])).toEqual({ status: 'no-runtime' });
    const unsupported = await syncLynxProjectSessions(async () => ({
      ok: false,
      status: 501,
      json: async () => ({}),
    }), ['/repo']);
    expect(unsupported.status).toBe('unsupported');
  });

  test('probe git check hits Cap /api/git/check', async () => {
    const runtimeFetch = async (path: string) => {
      expect(path).toBe('/api/git/check?directory=%2Frepo');
      return { ok: true, status: 200, json: async () => ({ isGitRepository: true }) };
    };
    expect(await probeLynxGitRepository(runtimeFetch, '/repo')).toEqual({
      status: 'ok',
      isGitRepository: true,
    });
    expect(await probeLynxGitRepository(async () => ({
      ok: false,
      status: 501,
      json: async () => ({}),
    }), '/repo')).toMatchObject({ status: 'unavailable' });
  });

  test('update/close project use settings projects[]', async () => {
    let projects: Array<Record<string, unknown>> = [
      { id: 'proj_1', path: '/repo', name: 'Old', label: 'Old' },
    ];
    const runtimeFetch = async (path: string, init?: { method?: string; body?: string }) => {
      if (path.includes('/api/config/settings') && (!init?.method || init.method === 'GET')) {
        return { ok: true, status: 200, json: async () => ({ projects }) };
      }
      if (path.includes('/api/config/settings') && init?.method === 'PUT') {
        const body = JSON.parse(init.body || '{}') as { projects?: Array<Record<string, unknown>> };
        projects = body.projects ?? projects;
        return { ok: true, status: 200, json: async () => ({ projects }) };
      }
      return { ok: false, status: 500, json: async () => ({}) };
    };
    expect(await updateLynxProjectLabel(runtimeFetch, {
      projectId: 'proj_1',
      path: '/repo',
      label: 'New',
    })).toEqual({ status: 'ok' });
    expect(projects[0]?.label).toBe('New');
    expect(await closeLynxProject(runtimeFetch, { projectId: 'proj_1', path: '/repo' }))
      .toEqual({ status: 'ok' });
    expect(projects).toEqual([]);
  });

  test('create/delete worktree hit Cap /api/git/worktrees', async () => {
    const calls: Array<{ path: string; method?: string; body?: string }> = [];
    const runtimeFetch = async (path: string, init?: { method?: string; body?: string }) => {
      calls.push({ path, method: init?.method, body: init?.body });
      if (init?.method === 'POST') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ path: '/repo-wt', branch: 'feature', name: 'feature' }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    };
    expect(await createLynxWorktree(runtimeFetch, {
      projectDirectory: '/repo',
      branchName: 'feature',
    })).toEqual({
      status: 'ok',
      path: '/repo-wt',
      branch: 'feature',
      name: 'feature',
    });
    expect(calls[0]?.path).toContain('/api/git/worktrees?directory=%2Frepo');
    expect(await deleteLynxWorktree(runtimeFetch, {
      projectDirectory: '/repo',
      worktreeDirectory: '/repo-wt',
    })).toEqual({ status: 'ok' });
    expect(JSON.parse(calls[1]!.body!)).toEqual({
      directory: '/repo-wt',
      deleteLocalBranch: false,
    });
    expect(await deleteLynxWorktree(runtimeFetch, {
      projectDirectory: '/repo',
      worktreeDirectory: '/repo-wt',
      deleteLocalBranch: true,
    })).toEqual({ status: 'ok' });
    expect(JSON.parse(calls[2]!.body!)).toEqual({
      directory: '/repo-wt',
      deleteLocalBranch: true,
    });
    expect(await createLynxWorktree(async () => ({
      ok: false,
      status: 501,
      json: async () => ({}),
    }), { projectDirectory: '/repo', branchName: 'x' })).toMatchObject({ status: 'unavailable' });
  });

  test('normalizeLynxWorktreeBranchName strips refs/heads/', () => {
    expect(normalizeLynxWorktreeBranchName('refs/heads/feature')).toBe('feature');
    expect(normalizeLynxWorktreeBranchName('  feature  ')).toBe('feature');
    expect(normalizeLynxWorktreeBranchName(null)).toBe('');
  });

  test('deleteLynxRemoteBranch hits Cap DELETE /api/git/remote-branches', async () => {
    const calls: Array<{ path: string; method?: string; body?: string }> = [];
    const runtimeFetch = async (path: string, init?: { method?: string; body?: string }) => {
      calls.push({ path, method: init?.method, body: init?.body });
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    };
    expect(await deleteLynxRemoteBranch(runtimeFetch, {
      projectDirectory: '/repo',
      branch: 'refs/heads/feature',
      remote: 'origin',
    })).toEqual({ status: 'ok' });
    expect(calls[0]).toMatchObject({
      path: '/api/git/remote-branches?directory=%2Frepo',
      method: 'DELETE',
    });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ branch: 'feature', remote: 'origin' });

    expect(await deleteLynxRemoteBranch(null, {
      projectDirectory: '/repo',
      branch: 'feature',
    })).toEqual({ status: 'no-runtime' });
    expect(await deleteLynxRemoteBranch(async () => ({
      ok: false,
      status: 501,
      json: async () => ({}),
    }), { projectDirectory: '/repo', branch: 'feature' })).toMatchObject({ status: 'unavailable' });
    expect(await deleteLynxRemoteBranch(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'push denied' }),
    }), { projectDirectory: '/repo', branch: 'feature' })).toEqual({
      status: 'failed',
      error: 'push denied',
      httpStatus: 500,
    });
  });

  test('deleteLynxWorktree optionally deletes remote branch after worktree remove', async () => {
    const calls: Array<{ path: string; method?: string; body?: string }> = [];
    const runtimeFetch = async (path: string, init?: { method?: string; body?: string }) => {
      calls.push({ path, method: init?.method, body: init?.body });
      if (path.includes('/remote-branches')) {
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    };
    expect(await deleteLynxWorktree(runtimeFetch, {
      projectDirectory: '/repo',
      worktreeDirectory: '/repo-wt',
      deleteLocalBranch: true,
      deleteRemoteBranch: true,
      branch: 'feature',
    })).toEqual({ status: 'ok' });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.path).toContain('/api/git/worktrees?directory=%2Frepo');
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      directory: '/repo-wt',
      deleteLocalBranch: true,
    });
    expect(calls[1]?.path).toContain('/api/git/remote-branches?directory=%2Frepo');
    expect(JSON.parse(calls[1]!.body!)).toEqual({ branch: 'feature' });

    // Without remote toggle — worktree only
    calls.length = 0;
    expect(await deleteLynxWorktree(runtimeFetch, {
      projectDirectory: '/repo',
      worktreeDirectory: '/repo-wt',
      deleteRemoteBranch: false,
      branch: 'feature',
    })).toEqual({ status: 'ok' });
    expect(calls).toHaveLength(1);

    // Remote failure after worktree ok — honest failed + worktreeRemoved
    const failingRemote = async (path: string, init?: { method?: string; body?: string }) => {
      if (path.includes('/remote-branches')) {
        return { ok: false, status: 500, json: async () => ({ error: 'remote gone' }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    };
    expect(await deleteLynxWorktree(failingRemote, {
      projectDirectory: '/repo',
      worktreeDirectory: '/repo-wt',
      deleteRemoteBranch: true,
      branch: 'feature',
    })).toEqual({
      status: 'failed',
      error: 'worktree removed but remote branch delete failed: remote gone',
      httpStatus: 500,
      worktreeRemoved: true,
    });
  });

  test('inferLynxProjectIsGit uses worktree groups', () => {
    expect(inferLynxProjectIsGit({
      worktrees: [{ kind: 'main', branch: 'main' }],
    })).toBe(true);
    expect(inferLynxProjectIsGit({
      worktrees: [{ kind: 'main' }],
    })).toBe(false);
    expect(inferLynxProjectIsGit({
      worktrees: [{ kind: 'worktree' }],
    })).toBe(true);
  });

  test('updateLynxProjectMeta persists Cap label/icon/color fields', async () => {
    let projects: Array<Record<string, unknown>> = [
      { id: 'proj_1', path: '/repo', name: 'Old', label: 'Old', icon: null, color: null },
    ];
    const runtimeFetch = async (path: string, init?: { method?: string; body?: string }) => {
      if (path.includes('/api/config/settings') && (!init?.method || init.method === 'GET')) {
        return { ok: true, status: 200, json: async () => ({ projects }) };
      }
      if (path.includes('/api/config/settings') && init?.method === 'PUT') {
        const body = JSON.parse(init.body || '{}') as { projects?: Array<Record<string, unknown>> };
        projects = body.projects ?? projects;
        return { ok: true, status: 200, json: async () => ({ projects }) };
      }
      return { ok: false, status: 500, json: async () => ({}) };
    };
    expect(await updateLynxProjectMeta(runtimeFetch, {
      projectId: 'proj_1',
      path: '/repo',
      label: 'New',
      icon: 'rocket',
      color: 'keyword',
    })).toEqual({ status: 'ok' });
    expect(projects[0]).toMatchObject({
      label: 'New',
      name: 'New',
      icon: 'rocket',
      color: 'keyword',
    });
    expect(await loadLynxProjectMeta(runtimeFetch, {
      projectId: 'proj_1',
      path: '/repo',
    })).toMatchObject({
      status: 'ok',
      meta: { label: 'New', icon: 'rocket', color: 'keyword' },
    });
    expect(await updateLynxProjectMeta(runtimeFetch, {
      projectId: 'missing',
      path: '/missing',
      label: 'X',
    })).toMatchObject({ status: 'unavailable' });
  });

  test('discover/remove project icon hit Cap /api/projects/:id/icon routes', async () => {
    const calls: Array<{ path: string; method?: string }> = [];
    const projects = [{ id: 'path_abc', path: '/repo', name: 'Repo', label: 'Repo' }];
    const runtimeFetch = async (path: string, init?: { method?: string; body?: string }) => {
      calls.push({ path, method: init?.method });
      if (path.includes('/api/config/settings')) {
        return { ok: true, status: 200, json: async () => ({ projects }) };
      }
      if (path.includes('/icon/discover')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            skipped: false,
            settings: {
              projects: [{
                ...projects[0],
                iconImage: { mime: 'image/png', updatedAt: 1, source: 'auto' },
              }],
            },
          }),
        };
      }
      if (path.endsWith('/icon') && init?.method === 'DELETE') {
        return { ok: true, status: 200, json: async () => ({ settings: { projects } }) };
      }
      return { ok: false, status: 500, json: async () => ({}) };
    };
    expect(await discoverLynxProjectIcon(runtimeFetch, {
      projectId: '/repo',
      path: '/repo',
    })).toMatchObject({ status: 'ok', skipped: false });
    expect(calls.some((call) => call.path.includes('/api/projects/path_abc/icon/discover'))).toBe(true);
    expect(await removeLynxProjectIcon(runtimeFetch, {
      projectId: '/repo',
      path: '/repo',
    })).toEqual({ status: 'ok', settingsProjects: projects });
    const unavailableFetch = async (path: string, init?: { method?: string }) => {
      if (path.includes('/api/config/settings')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ projects: [{ id: 'path_abc', path: '/repo', name: 'Repo', label: 'Repo' }] }),
        };
      }
      return { ok: false, status: 501, json: async () => ({}) };
    };
    expect(await discoverLynxProjectIcon(unavailableFetch, {
      projectId: '/repo',
      path: '/repo',
    })).toMatchObject({ status: 'unavailable' });
  });

  test('worktree order GET/PUT use Cap message-queue route', async () => {
    const calls: Array<{ path: string; method?: string; body?: string }> = [];
    const runtimeFetch = async (path: string, init?: { method?: string; body?: string }) => {
      calls.push({ path, method: init?.method, body: init?.body });
      if (init?.method === 'PUT') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            revision: 3,
            worktreeOrder: {
              projectDirectory: '/repo',
              orderedPaths: ['/repo/wt-b', '/repo/wt-a'],
              revision: 3,
            },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          projectDirectory: '/repo',
          orderedPaths: ['/repo/wt-a', '/repo/wt-b'],
          revision: 2,
        }),
      };
    };
    expect(await fetchLynxWorktreeOrder(runtimeFetch, '/repo')).toEqual({
      status: 'ok',
      orderedPaths: ['/repo/wt-a', '/repo/wt-b'],
      revision: 2,
    });
    expect(calls[0]?.path).toContain('/api/openchamber/message-queue/worktrees/order');
    expect(await setLynxWorktreeOrder(runtimeFetch, {
      projectDirectory: '/repo',
      orderedPaths: ['/repo/wt-b', '/repo/wt-a'],
      expectedRevision: 2,
      requestID: 'req-1',
    })).toEqual({
      status: 'ok',
      orderedPaths: ['/repo/wt-b', '/repo/wt-a'],
      revision: 3,
    });
    expect(JSON.parse(calls[1]!.body!)).toMatchObject({
      requestID: 'req-1',
      projectDirectory: '/repo',
      expectedRevision: 2,
    });
    expect(await setLynxWorktreeOrder(async () => ({
      ok: false,
      status: 501,
      json: async () => ({}),
    }), { projectDirectory: '/repo', orderedPaths: ['/a'] })).toMatchObject({ status: 'unavailable' });
  });

});
