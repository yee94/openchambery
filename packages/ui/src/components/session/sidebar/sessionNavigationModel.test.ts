import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';

import type { SessionGroup, SessionNode } from './types';
import {
  buildProjectNavigationTargets,
  filterVisibleProjectNavigationTargets,
  getDefaultProjectGroupVisibleCount,
  resolveProjectVirtualSessionIndex,
  selectVisibleSessionNodes,
  selectVisibleSessions,
} from './sessionNavigationModel';
import type { SessionNavigationTarget } from '@/sync/session-navigation';

const node = (id: string, updated: number, directory = '/project'): SessionNode => ({
  session: {
    id,
    directory,
    time: { created: updated, updated },
  } as Session,
  children: [],
  worktree: null,
});

const session = (id: string): Session => ({
  id,
  directory: '/project',
  time: { created: 1, updated: 1 },
} as Session);

const group = (id: string, sessions: SessionNode[], options?: { main?: boolean; directory?: string }): SessionGroup => ({
  id,
  label: id,
  branch: null,
  description: null,
  isMain: options?.main ?? false,
  worktree: null,
  directory: options?.directory ?? '/project',
  folderScopeKey: options?.directory ?? '/project',
  sessions,
});

describe('selectVisibleSessionNodes / selectVisibleSessions', () => {
  test('keeps running sessions visible beyond the compact boundary', () => {
    const nodes = [
      node('first', 500),
      node('second', 400),
      node('third', 300),
      node('running', 200),
      node('hidden', 100),
    ];

    expect(selectVisibleSessionNodes(nodes, 3, new Set(['running'])).map((item) => item.session.id))
      .toEqual(['first', 'second', 'third', 'running']);
  });

  test('keeps the current viewing session visible beyond the compact boundary', () => {
    const nodes = [
      node('first', 500),
      node('second', 400),
      node('third', 300),
      node('viewing', 200),
      node('hidden', 100),
    ];

    expect(selectVisibleSessionNodes(nodes, 3, new Set(['viewing'])).map((item) => item.session.id))
      .toEqual(['first', 'second', 'third', 'viewing']);
  });

  test('selectVisibleSessions pins always-visible flat sessions past the boundary', () => {
    const sessions = [
      session('first'),
      session('second'),
      session('third'),
      session('running'),
      session('hidden'),
    ];

    expect(selectVisibleSessions(sessions, 3, new Set(['running'])).map((item) => item.id))
      .toEqual(['first', 'second', 'third', 'running']);
  });
});

describe('buildProjectNavigationTargets', () => {

  test('follows visual project, root-group, folder, and row order', () => {
    const rootA = node('root-a', 100);
    const rootB = node('root-b', 200);
    const nested = node('nested', 300, '/project/worktree');

    const targets = buildProjectNavigationTargets({
      sections: [{
        project: { id: 'project-a' },
        // Persisted ordering can put a worktree first, but the renderer always
        // hoists the main group above nested groups.
        groups: [group('worktree', [nested], { directory: '/project/worktree' }), group('root', [rootA, rootB], { main: true })],
      }],
      foldersMap: {
        '/project': [
          { id: 'parent', name: 'Parent', sessionIds: ['root-a'], createdAt: 1, parentId: null },
          { id: 'child', name: 'Child', sessionIds: ['root-b'], createdAt: 2, parentId: 'parent' },
        ],
      },
      getOrderedGroups: (_projectId, groups) => groups,
      pinnedSessionIds: new Set(),
      sessionOrderByScope: {
        '/project': ['root-b', 'root-a'],
        '/project/worktree': ['nested'],
      },
      sessionOrderActivityByScope: {
        '/project': { 'root-a': 100, 'root-b': 200 },
        '/project/worktree': { nested: 300 },
      },
    });

    expect(targets.map((target) => target.sessionId)).toEqual(['root-b', 'root-a', 'nested']);
    expect(targets[0]?.groupKey).toBe('project-a:root');
    expect(targets[0]?.folderAncestorIds).toEqual(['parent', 'child']);
    expect(targets[1]?.folderAncestorIds).toEqual(['parent']);
    expect(targets[2]?.visibleIndex).toBe(0);
  });

  test('excludes archived and child sessions from the project shortcut ring', () => {
    const child = node('child', 300);
    (child.session as Session & { parentID?: string }).parentID = 'parent';
    const archived = node('archived', 400);
    archived.session.time = { ...archived.session.time, archived: 500 };

    const targets = buildProjectNavigationTargets({
      sections: [{
        project: { id: 'project-a' },
        groups: [group('root', [node('parent', 100), child, archived], { main: true })],
      }],
      foldersMap: {},
      getOrderedGroups: (_projectId, groups) => groups,
      pinnedSessionIds: new Set(),
      sessionOrderByScope: {},
      sessionOrderActivityByScope: {},
    });

    expect(targets.map((target) => target.sessionId)).toEqual(['parent']);
  });

  test('keeps manual session order local to each folder scope', () => {
    const targets = buildProjectNavigationTargets({
      sections: [{
        project: { id: 'project-a' },
        groups: [
          group('root', [node('root-a', 100), node('root-b', 200)], { main: true }),
          group('worktree', [node('worktree-a', 100, '/project/worktree'), node('worktree-b', 200, '/project/worktree')], { directory: '/project/worktree' }),
        ],
      }],
      foldersMap: {},
      getOrderedGroups: (_projectId, groups) => groups,
      pinnedSessionIds: new Set(),
      sessionOrderByScope: {
        '/project': ['root-a', 'root-b'],
        '/project/worktree': ['worktree-b', 'worktree-a'],
      },
      sessionOrderActivityByScope: {
        '/project': { 'root-a': 100, 'root-b': 200 },
        '/project/worktree': { 'worktree-a': 100, 'worktree-b': 200 },
      },
    });

    expect(targets.map((target) => target.sessionId)).toEqual(['root-a', 'root-b', 'worktree-b', 'worktree-a']);
  });

  test('restores natural navigation order after activity changes while matching snapshots keep manual order', () => {
    const buildTargets = (rootAUpdatedAt: number, activity: Record<string, number>) => buildProjectNavigationTargets({
      sections: [{ project: { id: 'project-a' }, groups: [group('root', [node('a', rootAUpdatedAt), node('b', 100)], { main: true })] }],
      foldersMap: {},
      getOrderedGroups: (_projectId, groups) => groups,
      pinnedSessionIds: new Set(),
      sessionOrderByScope: { '/project': ['b', 'a'] },
      sessionOrderActivityByScope: { '/project': activity },
    });

    expect(buildTargets(200, { a: 200, b: 100 }).map((target) => target.sessionId)).toEqual(['b', 'a']);
    expect(buildTargets(300, { a: 200, b: 100 }).map((target) => target.sessionId)).toEqual(['a', 'b']);
  });

  test('resolves a validated group-virtualizer index without clamping an unavailable target', () => {
    const first = node('first', 100);
    const second = node('second', 200);
    const target = node('target', 300);

    expect(resolveProjectVirtualSessionIndex(
      [first, second, target],
      'target',
      2,
    )).toBe(2);
    expect(resolveProjectVirtualSessionIndex(
      [first, second],
      'target',
      2,
    )).toBeNull();
    expect(resolveProjectVirtualSessionIndex(
      [target, first, second],
      'target',
      2,
    )).toBe(0);
    expect(resolveProjectVirtualSessionIndex(
      [first, second, target],
      'target',
      undefined,
    )).toBeNull();
  });

  test('keeps only logically visible rows and ignores sessions behind Show more', () => {
    const target = (
      sessionId: string,
      projectId: string,
      groupKey: string,
      options: Partial<SessionNavigationTarget> = {},
    ): SessionNavigationTarget => ({
      scope: 'project',
      sessionId,
      projectId,
      directory: `/${projectId}`,
      groupKey,
      ...options,
    });
    const targets = [
      target('visible-a', 'project-a', 'project-a:root', { visibleIndex: 0 }),
      target('visible-b', 'project-a', 'project-a:root', { visibleIndex: 1 }),
      target('behind-more', 'project-a', 'project-a:root', { visibleIndex: 2 }),
      target('collapsed-group', 'project-a', 'project-a:worktree'),
      target('collapsed-folder', 'project-a', 'project-a:root', { folderAncestorIds: ['folder-a'] }),
      target('collapsed-project', 'project-b', 'project-b:root', { visibleIndex: 0 }),
    ];

    const visible = filterVisibleProjectNavigationTargets({
      targets,
      collapsedProjectIds: new Set(['project-b']),
      collapsedGroupKeys: new Set(['project-a:worktree']),
      collapsedFolderIds: new Set(['folder-a']),
      visibleSessionCountByGroup: new Map(),
      defaultVisibleSessionCount: 2,
      hasSessionSearchQuery: false,
    });

    expect(visible.map((item) => item.sessionId)).toEqual(['visible-a', 'visible-b']);
  });

  test('keeps running shortcut targets beyond the Show more boundary', () => {
    const targets: SessionNavigationTarget[] = [
      {
        scope: 'project',
        sessionId: 'visible',
        projectId: 'project-a',
        directory: '/project-a',
        groupKey: 'project-a:root',
        visibleIndex: 0,
      },
      {
        scope: 'project',
        sessionId: 'running',
        projectId: 'project-a',
        directory: '/project-a',
        groupKey: 'project-a:root',
        visibleIndex: 5,
      },
    ];

    const visible = filterVisibleProjectNavigationTargets({
      targets,
      collapsedProjectIds: new Set(),
      collapsedGroupKeys: new Set(),
      collapsedFolderIds: new Set(),
      visibleSessionCountByGroup: new Map(),
      defaultVisibleSessionCount: 3,
      hasSessionSearchQuery: false,
      alwaysVisibleSessionIds: new Set(['running']),
    });

    expect(visible.map((item) => item.sessionId)).toEqual(['visible', 'running']);
  });

  test('uses the revealed batch size and search expansion rules', () => {
    const targets: SessionNavigationTarget[] = [
      {
        scope: 'project',
        sessionId: 'revealed-by-more',
        projectId: 'project-a',
        directory: '/project-a',
        groupKey: 'project-a:root',
        visibleIndex: 6,
      },
      {
        scope: 'project',
        sessionId: 'revealed-by-search',
        projectId: 'project-a',
        directory: '/project-a',
        groupKey: 'project-a:collapsed',
        folderAncestorIds: ['folder-a'],
        visibleIndex: 20,
      },
    ];

    expect(filterVisibleProjectNavigationTargets({
      targets,
      collapsedProjectIds: new Set(),
      collapsedGroupKeys: new Set(['project-a:collapsed']),
      collapsedFolderIds: new Set(['folder-a']),
      visibleSessionCountByGroup: new Map([['project-a:root', 7]]),
      defaultVisibleSessionCount: 3,
      hasSessionSearchQuery: false,
    }).map((item) => item.sessionId)).toEqual(['revealed-by-more']);

    expect(filterVisibleProjectNavigationTargets({
      targets,
      collapsedProjectIds: new Set(),
      collapsedGroupKeys: new Set(['project-a:collapsed']),
      collapsedFolderIds: new Set(['folder-a']),
      visibleSessionCountByGroup: new Map(),
      defaultVisibleSessionCount: 3,
      hasSessionSearchQuery: true,
    }).map((item) => item.sessionId)).toEqual(['revealed-by-more', 'revealed-by-search']);

    expect(getDefaultProjectGroupVisibleCount()).toBe(3);
  });
});
