import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import type { Session } from '@opencode-ai/sdk/v2';

import {
  derivePinnedSessions,
  listInProgressHomeSessions,
  resolveTopSectionSecondaryMeta,
} from './pinnedSessions';
import type { DirectoryOwner } from './sessionOwnership';

const sidebarSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'SessionSidebar.tsx'),
  'utf8',
);

const session = (id: string, created: number): Session => ({
  id,
  time: { created },
} as Session);

const detailedSession = (
  id: string,
  options: {
    parentID?: string | null;
    created?: number;
    updated?: number;
    archived?: number;
  } = {},
): Session =>
  ({
    id,
    title: id,
    time: {
      created: options.created ?? 1,
      ...(options.updated != null ? { updated: options.updated } : {}),
      ...(options.archived != null ? { archived: options.archived } : {}),
    },
    ...(options.parentID ? { parentID: options.parentID } : {}),
  }) as Session;

describe('derivePinnedSessions', () => {
  test('returns every pinned session ordered by creation time', () => {
    const sessions = [
      session('old', 10),
      session('unpinned', 30),
      session('new', 20),
    ];

    expect(derivePinnedSessions(sessions, new Set(['old', 'new']))
      .map((item) => item.id)).toEqual(['new', 'old']);
  });

  test('returns no rows when no session is pinned', () => {
    expect(derivePinnedSessions([session('session-a', 1)], new Set())).toEqual([]);
  });
});

describe('listInProgressHomeSessions', () => {
  test('keeps pinned sessions out and orders running plus unread by activity', () => {
    const active = listInProgressHomeSessions(
      [
        detailedSession('pinned-running', { updated: 50 }),
        detailedSession('running', { updated: 20 }),
        detailedSession('unread', { updated: 40 }),
        detailedSession('idle', { updated: 90 }),
        detailedSession('child-unread', { parentID: 'unread', updated: 80 }),
        detailedSession('archived-unread', { updated: 70, archived: 2 }),
      ],
      new Set(['pinned-running']),
      new Set(['pinned-running', 'running']),
      { unread: 1, 'child-unread': 1, 'archived-unread': 1 },
    );

    expect(active.map((entry) => entry.id)).toEqual(['unread', 'running']);
  });

  test('includes a running child even when the parent is idle', () => {
    const active = listInProgressHomeSessions(
      [
        detailedSession('parent', { updated: 10 }),
        detailedSession('child', { parentID: 'parent', updated: 11 }),
      ],
      new Set(),
      new Set(['child']),
      {},
    );

    expect(active.map((entry) => entry.id)).toEqual(['child']);
  });
});

describe('SessionSidebar pinned/in-progress top section contract', () => {
  test('sidebar derives in-progress rows and passes them to the top section', () => {
    expect(sidebarSource).toContain('listInProgressHomeSessions');
    expect(sidebarSource).toContain('inProgressItems=');
    expect(sidebarSource).toContain('resolveTopSectionSecondaryMeta');
  });
});

describe('resolveTopSectionSecondaryMeta', () => {
  const worktreeOwner: DirectoryOwner = {
    projectId: 'proj',
    projectRoot: '/repo',
    scopeDirectory: '/repo/.worktrees/feat',
    kind: 'worktree',
  };
  const projectOwner: DirectoryOwner = {
    projectId: 'proj',
    projectRoot: '/repo',
    scopeDirectory: '/repo',
    kind: 'project',
  };

  test('uses worktree catalog branch for a worktree-owned session', () => {
    expect(resolveTopSectionSecondaryMeta({
      projectLabel: 'openchamber',
      owner: worktreeOwner,
      sessionWorktree: null,
      worktrees: [{ path: '/repo/.worktrees/feat', branch: 'feat/home' }],
      projectRootBranch: 'main',
      isVSCode: false,
    })).toEqual({
      projectLabel: 'openchamber',
      branchLabel: 'feat/home',
    });
  });

  test('uses project root branch for a project-owned session', () => {
    expect(resolveTopSectionSecondaryMeta({
      projectLabel: 'openchamber',
      owner: projectOwner,
      sessionWorktree: null,
      worktrees: [{ path: '/repo/.worktrees/feat', branch: 'feat/home' }],
      projectRootBranch: 'main',
      isVSCode: false,
    })).toEqual({
      projectLabel: 'openchamber',
      branchLabel: 'main',
    });
  });

  test('drops HEAD and project-name-equal branches, and VS Code omits branch', () => {
    expect(resolveTopSectionSecondaryMeta({
      projectLabel: 'openchamber',
      owner: projectOwner,
      sessionWorktree: null,
      worktrees: [],
      projectRootBranch: 'HEAD',
      isVSCode: false,
    })).toEqual({
      projectLabel: 'openchamber',
      branchLabel: null,
    });
    expect(resolveTopSectionSecondaryMeta({
      projectLabel: 'openchamber',
      owner: worktreeOwner,
      sessionWorktree: null,
      worktrees: [{ path: '/repo/.worktrees/feat', branch: 'openchamber' }],
      projectRootBranch: null,
      isVSCode: false,
    })).toEqual({
      projectLabel: 'openchamber',
      branchLabel: null,
    });
    expect(resolveTopSectionSecondaryMeta({
      projectLabel: 'openchamber',
      owner: worktreeOwner,
      sessionWorktree: null,
      worktrees: [{ path: '/repo/.worktrees/feat', branch: 'feat/home' }],
      projectRootBranch: 'main',
      isVSCode: true,
    })).toEqual({
      projectLabel: 'openchamber',
      branchLabel: null,
    });
  });
});
