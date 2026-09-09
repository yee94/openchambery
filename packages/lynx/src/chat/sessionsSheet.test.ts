import { describe, expect, test } from 'vitest';

import type { SessionIndexSnapshot } from '../session-index/types';
import { LYNX_PINNED_SESSION_FILTER_ID } from './sessionStatusBar';
import {
  LYNX_SESSIONS_SHEET_DEFAULT_VISIBLE,
  LYNX_SESSIONS_SHEET_SHOW_MORE_INCREMENT,
  applyLynxSessionsSheetFilter,
  buildLynxSessionsSheetFilterChips,
  buildLynxSessionsSheetModel,
  collapseLynxSessionsSheetVisibleCount,
  lynxProjectsHomeBucketKey,
  nextLynxSessionsSheetVisibleCount,
  resolveLynxSessionsSheetNewChatDirectory,
  resolveLynxSessionsSheetOpenDirectory,
  resolveLynxSessionsSheetTrailingActionIds,
  resolveLynxSessionsSheetTrailingActiveProject,
  sliceLynxSessionsSheetVisible,
} from './sessionsSheet';

const snapshot = (): SessionIndexSnapshot => ({
  revision: 1,
  sync: {
    active: false,
    completed: 2,
    total: 2,
    pendingDirectories: [],
    completedDirectories: ['/a', '/b'],
    failedDirectories: [],
  },
  pinnedSessionIds: ['pin1'],
  directories: [
    {
      directory: '/a',
      cursor: null,
      hasMore: false,
      lastSyncedAt: 1,
      lastFullSyncedAt: 1,
      lastAccessedAt: 1,
      sessions: [
        {
          id: 'pin1',
          title: 'Pinned A',
          directory: '/a',
          time: { created: 1, updated: 30 },
        },
        {
          id: 'a1',
          title: 'Alpha one',
          directory: '/a',
          time: { created: 1, updated: 20 },
          metadata: { openchamber: { sessionStatus: { type: 'busy' } } },
        },
        {
          id: 'a2',
          title: 'Alpha two',
          directory: '/a',
          time: { created: 1, updated: 10 },
        },
      ],
    },
    {
      directory: '/b',
      cursor: null,
      hasMore: false,
      lastSyncedAt: 1,
      lastFullSyncedAt: 1,
      lastAccessedAt: 1,
      sessions: [
        {
          id: 'b1',
          title: 'Beta one',
          directory: '/b',
          time: { created: 1, updated: 25 },
        },
      ],
    },
  ],
});

describe('buildLynxSessionsSheetFilterChips', () => {
  test('All + pinned + projects when pins exist', () => {
    const chips = buildLynxSessionsSheetFilterChips({
      projects: [{ id: '/a', label: 'a' }, { id: '/b', label: 'b' }],
      hasPinnedSessions: true,
      allLabel: 'All',
      pinnedLabel: 'Pinned',
    });
    expect(chips.map((c) => c.id)).toEqual([null, LYNX_PINNED_SESSION_FILTER_ID, '/a', '/b']);
    expect(chips[0]?.kind).toBe('all');
    expect(chips[1]?.kind).toBe('pinned');
  });

  test('omits pinned chip when empty', () => {
    const chips = buildLynxSessionsSheetFilterChips({
      projects: [{ id: '/a', label: 'a' }],
      hasPinnedSessions: false,
      allLabel: 'All',
      pinnedLabel: 'Pinned',
    });
    expect(chips.map((c) => c.id)).toEqual([null, '/a']);
  });
});

describe('applyLynxSessionsSheetFilter + buildLynxSessionsSheetModel', () => {
  test('All lists pinned then project sessions', () => {
    const built = buildLynxSessionsSheetModel({
      snapshot: snapshot(),
      filterProjectId: null,
    });
    expect(built.filterProjectId).toBe(null);
    expect(built.hasPinnedSessions).toBe(true);
    expect(built.sessions.map((s) => s.id)).toEqual(['pin1', 'b1', 'a1', 'a2']);
    expect(built.preserveActiveProjectOnOpen).toBe(true);
  });

  test('pinned filter returns only pins', () => {
    const built = buildLynxSessionsSheetModel({
      snapshot: snapshot(),
      filterProjectId: LYNX_PINNED_SESSION_FILTER_ID,
    });
    expect(built.sessions.map((s) => s.id)).toEqual(['pin1']);
    expect(built.preserveActiveProjectOnOpen).toBe(true);
  });

  test('project filter scopes to one card', () => {
    const built = buildLynxSessionsSheetModel({
      snapshot: snapshot(),
      filterProjectId: '/b',
    });
    expect(built.model.projects.map((p) => p.id)).toEqual(['/b']);
    expect(built.sessions.map((s) => s.id)).toEqual(['b1']);
    expect(built.preserveActiveProjectOnOpen).toBe(false);
  });

  test('project filter includes that project pinned sessions', () => {
    const built = buildLynxSessionsSheetModel({
      snapshot: snapshot(),
      filterProjectId: '/a',
    });
    expect(built.sessions.map((s) => s.id)).toEqual(['pin1', 'a1', 'a2']);
  });

  test('search filters titles', () => {
    const built = buildLynxSessionsSheetModel({
      snapshot: snapshot(),
      filterProjectId: null,
      searchQuery: 'beta',
    });
    expect(built.sessions.map((s) => s.id)).toEqual(['b1']);
  });

  test('stale project filter falls back via resolveMobileSessionSheetDefaultFilter', () => {
    const built = buildLynxSessionsSheetModel({
      snapshot: snapshot(),
      filterProjectId: 'gone',
      activeProjectId: '/a',
    });
    expect(built.filterProjectId).toBe('/a');
  });

  test('applyLynxSessionsSheetFilter All is identity', () => {
    const built = buildLynxSessionsSheetModel({
      snapshot: snapshot(),
      filterProjectId: null,
    });
    expect(applyLynxSessionsSheetFilter(built.model, null)).toBe(built.model);
  });
});

describe('pagination + open directory', () => {
  test('Cap 3 / +7 pagination', () => {
    expect(LYNX_SESSIONS_SHEET_DEFAULT_VISIBLE).toBe(3);
    expect(LYNX_SESSIONS_SHEET_SHOW_MORE_INCREMENT).toBe(7);
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const sliced = sliceLynxSessionsSheetVisible(items, 3);
    expect(sliced.visible).toEqual([1, 2, 3]);
    expect(sliced.remaining).toBe(7);
    expect(sliced.canShowMore).toBe(true);
    expect(nextLynxSessionsSheetVisibleCount(3, 10)).toBe(10);
    expect(collapseLynxSessionsSheetVisibleCount()).toBe(3);
  });

  test('ProjectsHome Cap bucket key is projectId::bucketKey', () => {
    expect(lynxProjectsHomeBucketKey('/repo', 'main')).toBe('/repo::main');
    expect(lynxProjectsHomeBucketKey('proj', 'wt-1')).toBe('proj::wt-1');
  });

  test('search bypass uses full catalog length (no compact slice)', () => {
    // Cap catalogSessions spirit: while searching, pass sessions.length as visibleCount
    // so every match stays visible (ProjectsHome sets searching → skip slice).
    const items = Array.from({ length: 12 }, (_, i) => `s${i}`);
    const full = sliceLynxSessionsSheetVisible(items, items.length);
    expect(full.visible).toHaveLength(12);
    expect(full.canShowMore).toBe(false);
    expect(full.canShowFewer).toBe(true);
  });

  test('preserve-active-project open directory', () => {
    expect(resolveLynxSessionsSheetOpenDirectory({
      filterProjectId: null,
      sessionDirectory: '/session',
      currentDirectory: '/current',
    })).toBe('/current');
    expect(resolveLynxSessionsSheetOpenDirectory({
      filterProjectId: LYNX_PINNED_SESSION_FILTER_ID,
      sessionDirectory: '/session',
      currentDirectory: null,
    })).toBe('/session');
    expect(resolveLynxSessionsSheetOpenDirectory({
      filterProjectId: '/a',
      sessionDirectory: '/session',
      currentDirectory: '/current',
    })).toBe('/session');
  });
});

describe('trailing header actions', () => {
  test('newChat when projects exist; newWorktree when git; addProject always', () => {
    expect(resolveLynxSessionsSheetTrailingActionIds({
      projectCount: 0,
      activeProjectIsGitRepo: false,
    })).toEqual(['addProject']);
    expect(resolveLynxSessionsSheetTrailingActionIds({
      projectCount: 2,
      activeProjectIsGitRepo: false,
    })).toEqual(['newChat', 'addProject']);
    expect(resolveLynxSessionsSheetTrailingActionIds({
      projectCount: 1,
      activeProjectIsGitRepo: true,
    })).toEqual(['newChat', 'newWorktree', 'addProject']);
    expect(resolveLynxSessionsSheetTrailingActionIds({
      projectCount: 0,
      activeProjectIsGitRepo: true,
    })).toEqual(['newWorktree', 'addProject']);
  });

  test('trailing active project prefers filter over chat directory', () => {
    const projects = [
      { id: '/a', path: '/a' },
      { id: '/b', path: '/b' },
    ];
    expect(resolveLynxSessionsSheetTrailingActiveProject({
      projects,
      filterProjectId: '/b',
      activeProjectId: '/a',
    })?.id).toBe('/b');
    expect(resolveLynxSessionsSheetTrailingActiveProject({
      projects,
      filterProjectId: null,
      activeProjectId: '/a',
    })?.id).toBe('/a');
    expect(resolveLynxSessionsSheetTrailingActiveProject({
      projects,
      filterProjectId: LYNX_PINNED_SESSION_FILTER_ID,
      activeProjectId: '/a',
    })?.id).toBe('/a');
    expect(resolveLynxSessionsSheetTrailingActiveProject({
      projects,
      filterProjectId: null,
      activeProjectId: null,
    })).toBe(null);
  });

  test('newChat directory prefers filter project then active then first', () => {
    expect(resolveLynxSessionsSheetNewChatDirectory({
      filterProjectId: '/a',
      filterProjectPath: '/a',
      activeDirectory: '/current',
      firstProjectPath: '/first',
    })).toBe('/a');
    expect(resolveLynxSessionsSheetNewChatDirectory({
      filterProjectId: null,
      activeDirectory: '/current',
      activeProjectPath: '/a',
      firstProjectPath: '/first',
    })).toBe('/current');
    expect(resolveLynxSessionsSheetNewChatDirectory({
      filterProjectId: LYNX_PINNED_SESSION_FILTER_ID,
      activeDirectory: null,
      activeProjectPath: '/a',
      firstProjectPath: '/first',
    })).toBe('/a');
    expect(resolveLynxSessionsSheetNewChatDirectory({
      filterProjectId: null,
      activeDirectory: null,
      activeProjectPath: null,
      firstProjectPath: '/first',
    })).toBe('/first');
  });
});
