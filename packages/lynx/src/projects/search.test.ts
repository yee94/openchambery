import { describe, expect, test } from 'vitest';

import { projectSessionIndexHome } from '../session-index/homeModel';
import type { SessionIndexSnapshot } from '../session-index/types';
import { filterLynxProjectsHomeForSearch } from './search';

const snapshot = (): SessionIndexSnapshot => ({
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
      },
      {
        id: 'ses_other',
        title: 'Docs pass',
        directory: '/Users/dev/openchamber',
        time: { created: 1, updated: 4 },
      },
    ],
  }],
  pinnedSessionIds: [],
});

describe('Projects home search', () => {
  test('filters sessions by title while preserving project cards', () => {
    const model = projectSessionIndexHome(snapshot());
    const filtered = filterLynxProjectsHomeForSearch(model, 'pairing');
    expect(filtered.projects).toHaveLength(1);
    expect(filtered.projects[0]?.sessions.map((row) => row.id)).toEqual(['ses_root']);
  });

  test('empty query returns the same model', () => {
    const model = projectSessionIndexHome(snapshot());
    expect(filterLynxProjectsHomeForSearch(model, '  ')).toBe(model);
  });
});
