import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ActiveRuntime } from '@/lib/connectionController';
import * as client from '@/lib/openchamberClient';
import { cloneRepository, createDirectory, listFilesystem } from '@/lib/fsApi';
import { createGitWorktree, deleteGitWorktree, listGitWorktrees } from '@/lib/gitWorktreesApi';
import { discoverProjectIcon } from '@/lib/projectIconApi';
import { createProjectIdFromPath } from '@/lib/projectId';
import {
  buildProjectEntry,
  parseProjectsSettingsSlice,
  putProjectsSettings,
} from '@/lib/projectsSettingsApi';
import { parseWorktreeOrder, setWorktreeOrder } from '@/lib/worktreeOrderApi';

const active = {
  clientToken: 'tok',
  transport: { kind: 'direct', url: 'http://127.0.0.1:2606' },
} as ActiveRuntime;

afterEach(() => {
  vi.restoreAllMocks();
});

const mockJson = (status: number, body: unknown) => {
  vi.spyOn(client, 'openchamberFetch').mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
};

describe('createProjectIdFromPath', () => {
  it('matches Cap path_ prefix', () => {
    expect(createProjectIdFromPath('/code/openchamber')).toMatch(/^path_/);
    expect(createProjectIdFromPath('/code/openchamber/')).toBe(
      createProjectIdFromPath('/code/openchamber'),
    );
  });
});

describe('projects settings parse/put', () => {
  it('parses Cap projects slice', () => {
    const slice = parseProjectsSettingsSlice({
      projects: [{ id: 'p1', path: '/code/a', label: 'A', icon: 'code', color: 'primary' }],
      activeProjectId: 'p1',
    });
    expect(slice.projects[0]?.label).toBe('A');
    expect(slice.activeProjectId).toBe('p1');
  });

  it('PUTs /api/config/settings', async () => {
    mockJson(200, {
      projects: [{ id: 'p1', path: '/code/a', label: 'A' }],
      activeProjectId: 'p1',
    });
    const entry = buildProjectEntry('/code/a', { label: 'A', id: 'p1' });
    const saved = await putProjectsSettings(active, { projects: [entry], activeProjectId: 'p1' });
    expect(client.openchamberFetch).toHaveBeenCalledWith(
      active,
      '/api/config/settings',
      expect.objectContaining({ method: 'PUT' }),
    );
    expect(saved.projects[0]?.path).toBe('/code/a');
  });
});

describe('fs APIs', () => {
  it('lists via /api/fs/list', async () => {
    mockJson(200, {
      entries: [{ name: 'src', path: '/code/src', isDirectory: true, isFile: false }],
    });
    const entries = await listFilesystem(active, '/code');
    expect(client.openchamberFetch).toHaveBeenCalledWith(
      active,
      '/api/fs/list?path=%2Fcode',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(entries[0]?.isDirectory).toBe(true);
  });

  it('mkdir via /api/fs/mkdir', async () => {
    mockJson(200, { success: true, path: '/code/new' });
    const result = await createDirectory(active, '/code/new');
    expect(result.path).toBe('/code/new');
  });

  it('clone via /api/fs/clone', async () => {
    mockJson(200, { success: true, path: '/code/repo' });
    const result = await cloneRepository(active, {
      remoteUrl: 'https://example.com/repo.git',
      destinationPath: '/code/repo',
    });
    expect(result.path).toBe('/code/repo');
  });
});

describe('git worktrees APIs', () => {
  it('lists/creates/deletes official /api/git/worktrees', async () => {
    mockJson(200, [{ head: 'h', name: 'n', branch: 'b', path: '/code/wt' }]);
    const listed = await listGitWorktrees(active, '/code');
    expect(listed[0]?.path).toBe('/code/wt');

    mockJson(200, { head: 'h', name: 'feat', branch: 'feat', path: '/code/feat' });
    const created = await createGitWorktree(active, '/code', {
      mode: 'new',
      branchName: 'feat',
      worktreeName: 'feat',
    });
    expect(created.path).toBe('/code/feat');

    mockJson(200, { success: true });
    const removed = await deleteGitWorktree(active, '/code', { directory: '/code/feat' });
    expect(removed.success).toBe(true);
  });
});

describe('icon discover + worktree order', () => {
  it('POSTs icon discover', async () => {
    mockJson(200, { skipped: false });
    const result = await discoverProjectIcon(active, 'proj-1');
    expect(result.ok).toBe(true);
    expect(client.openchamberFetch).toHaveBeenCalledWith(
      active,
      '/api/projects/proj-1/icon/discover',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('PUTs worktree order route', async () => {
    mockJson(200, {
      revision: 2,
      worktreeOrder: {
        projectDirectory: '/code',
        orderedPaths: ['/code/a', '/code/b'],
        revision: 2,
      },
    });
    const result = await setWorktreeOrder(active, {
      requestID: 'req-1',
      projectDirectory: '/code',
      expectedRevision: 1,
      orderedPaths: ['/code/a', '/code/b'],
    });
    expect(result.revision).toBe(2);
    expect(parseWorktreeOrder(result.worktreeOrder)?.orderedPaths).toEqual(['/code/a', '/code/b']);
  });
});
