import { describe, expect, test } from 'vitest';

import { projectSessionIndexHome } from '../session-index/homeModel';
import type { SessionIndexSnapshot } from '../session-index/types';

const snapshot = (): SessionIndexSnapshot => ({
  revision: 1,
  sync: {
    active: false,
    completed: 2,
    total: 2,
    pendingDirectories: [],
    completedDirectories: ['/repo', '/repo-wt'],
    failedDirectories: [],
  },
  directories: [
    {
      directory: '/repo',
      cursor: null,
      hasMore: false,
      lastSyncedAt: 1,
      lastFullSyncedAt: 1,
      lastAccessedAt: 1,
      sessions: [{
        id: 'ses_main',
        title: 'Main work',
        directory: '/repo',
        time: { created: 1, updated: 10 },
        metadata: { openchamber: { sessionStatus: { type: 'busy' } } },
      }],
    },
    {
      directory: '/repo-wt',
      cursor: null,
      hasMore: false,
      lastSyncedAt: 1,
      lastFullSyncedAt: 1,
      lastAccessedAt: 1,
      sessions: [{
        id: 'ses_wt',
        title: 'Worktree work',
        directory: '/repo-wt',
        time: { created: 1, updated: 8 },
      }],
    },
  ],
  pinnedSessionIds: [],
});

describe('Projects home worktree projection', () => {
  test('nests linked worktrees under the parent project card', () => {
    const model = projectSessionIndexHome(snapshot(), {
      projectRootByDirectory: {
        '/repo': '/repo',
        '/repo-wt': '/repo',
      },
      worktreeBranchByDirectory: {
        '/repo': 'main',
        '/repo-wt': 'feature/lynx',
      },
    });
    expect(model.projects).toHaveLength(1);
    expect(model.projects[0]?.worktrees.map((group) => group.kind)).toEqual(['main', 'worktree']);
    expect(model.projects[0]?.sessions[0]?.subtitle).toBe('repo · main');
    expect(model.inProgressSessions.map((row) => row.id)).toEqual(['ses_main']);
  });
});
