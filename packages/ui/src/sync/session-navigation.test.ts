import { describe, expect, test, beforeEach } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';

import {
  clearSessionNavigationSnapshot,
  getNavigableRootSessions,
  isSubtaskSession,
  navigateAdjacentSession,
  publishSessionNavigationSnapshot,
  resolveAdjacentNavigationTarget,
  resolveAdjacentRootSession,
  resolveRootSessionId,
  type SessionNavigationTarget,
} from './session-navigation';
import { setSyncRefs } from './sync-refs';
import { ChildStoreManager } from './child-store';
import { INITIAL_STATE } from './types';
import { writeSessionIndexSnapshotQuery } from '@/queries/sessionIndexQueries';
import type { SessionIndexSnapshot } from '@/lib/session-index-api';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionFocusStore } from '@/stores/useSessionFocusStore';

const makeSession = (
  id: string,
  options: {
    parentID?: string | null;
    archived?: boolean;
    updated?: number;
    directory?: string;
  } = {},
): Session =>
  ({
    id,
    parentID: options.parentID ?? null,
    directory: options.directory,
    time: {
      created: options.updated ?? 1,
      updated: options.updated ?? 1,
      archived: options.archived ? Date.now() : undefined,
    },
  }) as Session;

const bootstrapSessions = (sessions: Session[], directory = '/workspace/project') => {
  const childStores = new ChildStoreManager();
  const store = childStores.ensureChild(directory, { bootstrap: false });
  store.getState().replace({
    ...INITIAL_STATE,
    status: 'complete',
    session: sessions,
    sessionTotal: sessions.filter((session) => !session.parentID).length,
    limit: Math.max(sessions.length, INITIAL_STATE.limit),
  });
  setSyncRefs({} as never, childStores, directory);
};

const makeNavigationTarget = (
  scope: 'pinned' | 'project',
  sessionId: string,
  projectId: string | null,
): SessionNavigationTarget => ({
  scope,
  sessionId,
  projectId,
  directory: projectId ? `/workspace/${projectId}` : null,
});

const emptyPinnedSnapshot = (): SessionIndexSnapshot => ({
  revision: 1,
  sync: {
    active: false,
    completed: 0,
    total: 0,
    pendingDirectories: [],
    completedDirectories: [],
    failedDirectories: [],
  },
  directories: [],
});

const snapshotWithPinned = (pinnedIds: string[]): SessionIndexSnapshot => ({
  revision: 1,
  sync: {
    active: false,
    completed: 1,
    total: 1,
    pendingDirectories: [],
    completedDirectories: ['/workspace/project'],
    failedDirectories: [],
  },
  directories: [{
    directory: '/workspace/project',
    cursor: null,
    hasMore: false,
    lastSyncedAt: 1,
    lastFullSyncedAt: 1,
    lastAccessedAt: 1,
    sessions: pinnedIds.map((id) => ({
      id,
      time: { created: 1, updated: 1, pinned: '2026-01-01T00:00:00.000Z' },
    } as SessionIndexSnapshot['directories'][number]['sessions'][number])),
  }],
});

describe('session-navigation', () => {
  beforeEach(() => {
    clearSessionNavigationSnapshot();
    useSessionFocusStore.getState().setFocus(null);
    writeSessionIndexSnapshotQuery(emptyPinnedSnapshot(), { persist: false });
    useGlobalSessionsStore.setState({
      activeSessions: [],
      archivedSessions: [],
      sessionsByDirectory: new Map(),
      reviewTransferBySessionId: new Map(),
      hasLoaded: false,
      status: 'idle',
    });
    useProjectsStore.setState({
      projects: [],
      activeProjectId: null,
    });
  });

  test('isSubtaskSession detects child sessions', () => {
    expect(isSubtaskSession(makeSession('child', { parentID: 'parent' }))).toBe(true);
    expect(isSubtaskSession(makeSession('parent'))).toBe(false);
  });

  test('resolveRootSessionId walks up to the parent session', () => {
    const sessions = [
      makeSession('parent'),
      makeSession('child', { parentID: 'parent' }),
    ];

    expect(resolveRootSessionId('child', sessions)).toBe('parent');
    expect(resolveRootSessionId('parent', sessions)).toBe('parent');
  });

  test('getNavigableRootSessions follows project tree order, not global recent order', () => {
    useProjectsStore.setState({
      projects: [
        { id: 'p1', path: '/workspace/alpha', label: 'alpha' },
        { id: 'p2', path: '/workspace/beta', label: 'beta' },
      ] as never,
      activeProjectId: 'p1',
    });

    // Global recency would put beta-new first (updated=300), then alpha-old (200),
    // then alpha-older (100). Project-tree order must keep alpha sessions together
    // ahead of beta, matching the sidebar below Recent.
    useGlobalSessionsStore.setState({
      activeSessions: [
        makeSession('beta-new', { updated: 300, directory: '/workspace/beta' }),
        makeSession('alpha-old', { updated: 200, directory: '/workspace/alpha' }),
        makeSession('alpha-older', { updated: 100, directory: '/workspace/alpha' }),
        makeSession('child', { parentID: 'alpha-old', updated: 400, directory: '/workspace/alpha' }),
        makeSession('archived', { updated: 500, archived: true, directory: '/workspace/alpha' }),
      ],
      archivedSessions: [],
      sessionsByDirectory: new Map(),
      reviewTransferBySessionId: new Map(),
      hasLoaded: true,
      status: 'ready',
    });

    expect(getNavigableRootSessions().map((session) => session.id)).toEqual([
      'alpha-old',
      'alpha-older',
      'beta-new',
    ]);
  });

  test('resolveAdjacentRootSession cycles only root sessions in project order', () => {
    useProjectsStore.setState({
      projects: [
        { id: 'p1', path: '/workspace/project', label: 'project' },
      ] as never,
      activeProjectId: 'p1',
    });
    useGlobalSessionsStore.setState({
      activeSessions: [
        makeSession('root-a', { updated: 100, directory: '/workspace/project' }),
        makeSession('root-b', { updated: 200, directory: '/workspace/project' }),
        makeSession('child', { parentID: 'root-a', updated: 300, directory: '/workspace/project' }),
      ],
      archivedSessions: [],
      sessionsByDirectory: new Map(),
      reviewTransferBySessionId: new Map(),
      hasLoaded: true,
      status: 'ready',
    });

    // Within a project, pinned+time still applies: root-b (200) before root-a (100).
    expect(resolveAdjacentRootSession(1, 'root-b')?.id).toBe('root-a');
    expect(resolveAdjacentRootSession(-1, 'root-a')?.id).toBe('root-b');
    // From a subsession, navigate relative to its root parent (root-a).
    // With only two roots, both directions from root-a land on root-b.
    expect(resolveAdjacentRootSession(1, 'child')?.id).toBe('root-b');
    expect(resolveAdjacentRootSession(-1, 'child')?.id).toBe('root-b');
  });

  test('resolveAdjacentRootSession respects pinned ordering within a project', () => {
    writeSessionIndexSnapshotQuery(snapshotWithPinned(['root-a']), { persist: false });
    useProjectsStore.setState({
      projects: [
        { id: 'p1', path: '/workspace/project', label: 'project' },
      ] as never,
      activeProjectId: 'p1',
    });
    useGlobalSessionsStore.setState({
      activeSessions: [
        makeSession('root-a', { updated: 100, directory: '/workspace/project' }),
        makeSession('root-b', { updated: 200, directory: '/workspace/project' }),
      ],
      archivedSessions: [],
      sessionsByDirectory: new Map(),
      reviewTransferBySessionId: new Map(),
      hasLoaded: true,
      status: 'ready',
    });

    expect(resolveAdjacentRootSession(1, 'root-a')?.id).toBe('root-b');
    expect(resolveAdjacentRootSession(-1, 'root-b')?.id).toBe('root-a');
  });

  test('cycles within the published pinned order when focus came from pinned', () => {
    publishSessionNavigationSnapshot({
      pinned: [
        makeNavigationTarget('pinned', 'pinned-a', 'p1'),
        makeNavigationTarget('pinned', 'pinned-b', 'p2'),
        makeNavigationTarget('pinned', 'pinned-c', 'p1'),
      ],
      project: [
        makeNavigationTarget('project', 'project-a', 'p1'),
        makeNavigationTarget('project', 'project-b', 'p2'),
      ],
    });

    const pinnedFocus = {
      scope: 'pinned' as const,
      sessionId: 'pinned-b',
      projectId: 'p2',
    };

    expect(resolveAdjacentNavigationTarget(1, 'pinned-b', pinnedFocus)?.sessionId).toBe('pinned-c');
    expect(resolveAdjacentNavigationTarget(-1, 'pinned-b', pinnedFocus)?.sessionId).toBe('pinned-a');
    expect(resolveAdjacentNavigationTarget(1, 'pinned-c', {
      ...pinnedFocus,
      sessionId: 'pinned-c',
      projectId: 'p1',
    })?.sessionId).toBe('pinned-a');
  });

  test('cycles across visible project sessions in sidebar order', () => {
    publishSessionNavigationSnapshot({
      pinned: [
        makeNavigationTarget('pinned', 'project-c', 'p2'),
        makeNavigationTarget('pinned', 'project-a', 'p1'),
      ],
      project: [
        makeNavigationTarget('project', 'project-a', 'p1'),
        makeNavigationTarget('project', 'project-b', 'p1'),
        makeNavigationTarget('project', 'project-d', 'p1'),
        makeNavigationTarget('project', 'project-c', 'p2'),
      ],
    });

    const projectFocus = {
      scope: 'project' as const,
      sessionId: 'project-b',
      projectId: 'p1',
    };

    expect(resolveAdjacentNavigationTarget(1, 'project-b', projectFocus)?.sessionId).toBe('project-d');
    expect(resolveAdjacentNavigationTarget(-1, 'project-b', projectFocus)?.sessionId).toBe('project-a');
    const nextAcrossProjects = resolveAdjacentNavigationTarget(1, 'project-d', {
      ...projectFocus,
      sessionId: 'project-d',
    });
    expect(nextAcrossProjects?.sessionId).toBe('project-c');
    expect(nextAcrossProjects?.projectId).toBe('p2');

    const wrapAcrossProjects = resolveAdjacentNavigationTarget(-1, 'project-a', {
      ...projectFocus,
      sessionId: 'project-a',
    });
    expect(wrapAcrossProjects?.sessionId).toBe('project-c');
    expect(wrapAcrossProjects?.projectId).toBe('p2');
  });

  test('updates focus scope before committing a scoped navigation target', () => {
    publishSessionNavigationSnapshot({
      pinned: [
        makeNavigationTarget('pinned', 'pinned-a', 'p1'),
        makeNavigationTarget('pinned', 'pinned-b', 'p2'),
      ],
      project: [makeNavigationTarget('project', 'project-a', 'p1')],
    });
    useSessionFocusStore.getState().setFocus({
      scope: 'pinned',
      sessionId: 'pinned-a',
      projectId: 'p1',
    });

    let focusAtCommit = null as ReturnType<typeof useSessionFocusStore.getState>['focus'];
    const committedTarget = navigateAdjacentSession(1, 'pinned-a', () => {
      focusAtCommit = useSessionFocusStore.getState().focus;
    });

    expect(committedTarget?.sessionId).toBe('pinned-b');
    expect(focusAtCommit).toEqual({
      scope: 'pinned',
      sessionId: 'pinned-b',
      projectId: 'p2',
    });
  });

  test('falls back from an unavailable pinned sequence to visible project sessions', () => {
    publishSessionNavigationSnapshot({
      pinned: [],
      project: [
        makeNavigationTarget('project', 'project-a', 'p1'),
        makeNavigationTarget('project', 'project-a-next', 'p1'),
        makeNavigationTarget('project', 'project-b', 'p2'),
      ],
    });

    const target = resolveAdjacentNavigationTarget(1, 'project-a', {
      scope: 'pinned',
      sessionId: 'project-a',
      projectId: 'p1',
    });

    expect(target?.scope).toBe('project');
    expect(target?.sessionId).toBe('project-a-next');
    expect(target?.projectId).toBe('p1');

    const wrapTarget = resolveAdjacentNavigationTarget(1, 'project-a-next', {
      scope: 'pinned',
      sessionId: 'project-a-next',
      projectId: 'p1',
    });

    expect(wrapTarget?.scope).toBe('project');
    expect(wrapTarget?.sessionId).toBe('project-b');
    expect(wrapTarget?.projectId).toBe('p2');
  });

  test('anchors a pinned-to-project fallback at the matching project occurrence', () => {
    publishSessionNavigationSnapshot({
      pinned: [],
      project: [
        makeNavigationTarget('project', 'shared-session', 'p1'),
        makeNavigationTarget('project', 'p1-next', 'p1'),
        makeNavigationTarget('project', 'shared-session', 'p2'),
        makeNavigationTarget('project', 'p2-next', 'p2'),
      ],
    });

    const target = resolveAdjacentNavigationTarget(1, 'shared-session', {
      scope: 'pinned',
      sessionId: 'shared-session',
      projectId: 'p2',
    });

    expect(target?.scope).toBe('project');
    expect(target?.sessionId).toBe('p2-next');
    expect(target?.projectId).toBe('p2');
  });

  test('does not use hidden or cross-project fallbacks without a visible sidebar snapshot', () => {
    useProjectsStore.setState({
      projects: [
        { id: 'p1', path: '/workspace/project', label: 'project' },
      ] as never,
      activeProjectId: 'p1',
    });
    useGlobalSessionsStore.setState({
      activeSessions: [
        makeSession('root-a', { updated: 100, directory: '/workspace/project' }),
        makeSession('root-b', { updated: 200, directory: '/workspace/project' }),
      ],
      archivedSessions: [],
      sessionsByDirectory: new Map(),
      reviewTransferBySessionId: new Map(),
      hasLoaded: true,
      status: 'ready',
    });

    const target = resolveAdjacentNavigationTarget(1, 'root-b', {
      scope: 'pinned',
      sessionId: 'root-b',
      projectId: 'p1',
    });

    expect(target).toBeNull();
  });

  test('jumps to other visible project sessions when the focused project has none', () => {
    publishSessionNavigationSnapshot({
      pinned: [],
      project: [makeNavigationTarget('project', 'visible-in-p2', 'p2')],
    });

    const target = resolveAdjacentNavigationTarget(1, 'hidden-in-p1', {
      scope: 'project',
      sessionId: 'hidden-in-p1',
      projectId: 'p1',
    });
    expect(target?.sessionId).toBe('visible-in-p2');
    expect(target?.projectId).toBe('p2');
  });

  test('falls back to sync sessions when global store is empty', () => {
    bootstrapSessions([
      makeSession('root-a', { updated: 100 }),
      makeSession('root-b', { updated: 200 }),
    ]);

    expect(getNavigableRootSessions().map((session) => session.id)).toEqual([
      'root-b',
      'root-a',
    ]);
  });
});
