import { describe, expect, test } from 'vitest';

import { formatHomeSessionSubtitle, projectSessionIndexHome } from './homeModel';
import type { SessionIndexSnapshot } from './types';

const snapshot = (overrides?: Partial<SessionIndexSnapshot>): SessionIndexSnapshot => ({
  revision: 1,
  sync: {
    active: false,
    completed: 1,
    total: 1,
    pendingDirectories: [],
    completedDirectories: ['/Users/dev/openchamber'],
    failedDirectories: [],
  },
  directories: [{
    directory: '/Users/dev/openchamber',
    cursor: null,
    hasMore: false,
    lastSyncedAt: 1,
    lastFullSyncedAt: 1,
    lastAccessedAt: 1,
    sessions: [
      {
        id: 'ses_root',
        title: 'Wire pairing',
        directory: '/Users/dev/openchamber',
        time: { created: 1, updated: 10 },
        metadata: { openchamber: { titleRefresh: { activityUpdatedAt: 10 }, sessionStatus: { type: 'busy' } } },
      },
      {
        id: 'ses_child',
        title: 'subagent',
        directory: '/Users/dev/openchamber',
        parentID: 'ses_root',
        time: { created: 2, updated: 11 },
      },
      {
        id: 'ses_old',
        title: 'Older root',
        directory: '/Users/dev/openchamber',
        time: { created: 1, updated: 3 },
        metadata: { openchamber: { titleRefresh: { activityUpdatedAt: 3 }, sessionStatus: { type: 'idle' } } },
      },
      {
        id: 'ses_archived',
        title: 'Gone',
        directory: '/Users/dev/openchamber',
        time: { created: 1, updated: 2, archived: 9 },
      },
    ],
  }],
  pinnedSessionIds: ['ses_old'],
  ...overrides,
});

describe('Projects home session-index projection', () => {
  test('formats 项目 · 分支 the same way as Cap', () => {
    expect(formatHomeSessionSubtitle('openchamber', 'main')).toBe('openchamber · main');
    expect(formatHomeSessionSubtitle('openchamber')).toBe('openchamber');
  });

  test('uses directory order activity, omits children and archived roots, and splits pinned / in-progress', () => {
    const model = projectSessionIndexHome(snapshot(), {
      worktreeBranchByDirectory: { '/Users/dev/openchamber': 'work/lynx-native' },
    });
    expect(model.projects).toHaveLength(1);
    expect(model.projects[0]?.label).toBe('openchamber');
    expect(model.projects[0]?.sessions.map((row) => row.id)).toEqual(['ses_root']);
    expect(model.projects[0]?.worktrees).toHaveLength(1);
    expect(model.projects[0]?.worktrees[0]?.kind).toBe('main');
    expect(model.projects[0]?.sessions[0]?.subtitle).toBe('openchamber · work/lynx-native');
    expect(model.pinnedSessions.map((row) => row.id)).toEqual(['ses_old']);
    expect(model.inProgressSessions.map((row) => row.id)).toEqual(['ses_root']);
    expect(model.sessionById.has('ses_child')).toBe(true);
  });

  test('does not invent rows when the snapshot has empty directories', () => {
    const model = projectSessionIndexHome({
      ...snapshot(),
      directories: [{
        directory: '/empty',
        cursor: null,
        hasMore: false,
        lastSyncedAt: 1,
        lastFullSyncedAt: 1,
        lastAccessedAt: 1,
        sessions: [],
      }],
      pinnedSessionIds: [],
    });
    expect(model.projects[0]?.sessionCount).toBe(0);
    expect(model.pinnedSessions).toEqual([]);
    expect(model.inProgressSessions).toEqual([]);
  });
});
