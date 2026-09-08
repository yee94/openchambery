import { describe, expect, test } from 'vitest';

import type { SessionIndexSnapshot } from '../session-index/types';
import {
  LYNX_ARCHIVED_OTHER_PROJECT_ID,
  buildLynxArchivedSessionsModel,
  formatLynxArchivedSessionCount,
  getLynxArchivedSessionActivityMs,
  isLynxArchivedByTime,
  listLynxArchivedSessions,
  parseLynxArchivedSessionRow,
} from './archivedSessions';

const snapshot = (): SessionIndexSnapshot => ({
  revision: 1,
  sync: {
    active: false,
    completed: 1,
    total: 1,
    pendingDirectories: [],
    completedDirectories: ['/repo'],
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
      sessions: [
        {
          id: 'active',
          title: 'Active',
          directory: '/repo',
          time: { created: 1, updated: 2 },
        },
      ],
    },
  ],
});

describe('archived session parse + activity', () => {
  test('isLynxArchivedByTime requires time.archived > 0', () => {
    expect(isLynxArchivedByTime({ time: { archived: 9 } })).toBe(true);
    expect(isLynxArchivedByTime({ time: { archived: 0 } })).toBe(false);
    expect(isLynxArchivedByTime({ time: {} })).toBe(false);
  });

  test('parse omits children and non-archived; fills title/directory', () => {
    expect(parseLynxArchivedSessionRow({
      id: 'child',
      title: 'Child',
      parentID: 'parent',
      time: { archived: 9, updated: 8, created: 1 },
    })).toBeNull();
    expect(parseLynxArchivedSessionRow({
      id: 'active',
      title: 'Active',
      time: { updated: 8, created: 1 },
    })).toBeNull();
    expect(parseLynxArchivedSessionRow({
      id: 'ses_1',
      title: '  ',
      directory: '/repo/app',
      time: { archived: 40, updated: 30, created: 10 },
    }, { untitledLabel: 'Untitled' })).toEqual({
      id: 'ses_1',
      title: 'Untitled',
      directory: '/repo/app',
      activityAt: 40,
      archivedAt: 40,
    });
    expect(getLynxArchivedSessionActivityMs({
      time: { created: 1, updated: 5, archived: 9 },
    })).toBe(9);
  });
});

describe('buildLynxArchivedSessionsModel', () => {
  test('groups by directory, labels from snapshot, Other last', () => {
    const model = buildLynxArchivedSessionsModel({
      sessions: [
        {
          id: 'a',
          title: 'A',
          directory: '/repo',
          activityAt: 20,
          archivedAt: 20,
        },
        {
          id: 'b',
          title: 'B',
          directory: '/repo',
          activityAt: 30,
          archivedAt: 30,
        },
        {
          id: 'orphan',
          title: 'Orphan',
          directory: null,
          activityAt: 10,
          archivedAt: 10,
        },
      ],
      snapshot: snapshot(),
      otherLabel: 'Other',
    });
    expect(model.total).toBe(3);
    expect(model.empty).toBe(false);
    expect(model.buckets.map((b) => b.projectId)).toEqual(['/repo', LYNX_ARCHIVED_OTHER_PROJECT_ID]);
    expect(model.buckets[0]?.label).toBe('repo');
    expect(model.buckets[0]?.sessions.map((s) => s.id)).toEqual(['b', 'a']);
    expect(model.buckets[1]?.label).toBe('Other');
  });

  test('empty when no sessions', () => {
    expect(buildLynxArchivedSessionsModel({
      sessions: [],
      otherLabel: 'Other',
    })).toEqual({ buckets: [], total: 0, empty: true });
  });
});

describe('listLynxArchivedSessions', () => {
  test('no-runtime when fetch missing', async () => {
    expect(await listLynxArchivedSessions(null)).toEqual({ status: 'no-runtime' });
  });

  test('GET /api/experimental/session archived+roots; failure ≠ empty', async () => {
    const calls: string[] = [];
    const ok = await listLynxArchivedSessions(async (path) => {
      calls.push(path);
      return {
        ok: true,
        status: 200,
        json: async () => ([
          {
            id: 'ses_arch',
            title: 'Archived',
            directory: '/repo',
            time: { created: 1, updated: 2, archived: 9 },
          },
          {
            id: 'child',
            title: 'Child',
            parentID: 'ses_arch',
            directory: '/repo',
            time: { created: 1, updated: 2, archived: 9 },
          },
        ]),
      };
    });
    expect(ok).toEqual({
      status: 'ok',
      sessions: [{
        id: 'ses_arch',
        title: 'Archived',
        directory: '/repo',
        activityAt: 9,
        archivedAt: 9,
      }],
    });
    expect(calls[0]).toContain('/api/experimental/session?');
    expect(calls[0]).toContain('archived=true');
    expect(calls[0]).toContain('roots=true');

    const failed = await listLynxArchivedSessions(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'boom' }),
    }));
    expect(failed).toEqual({
      status: 'failed',
      error: 'session.list archived failed (500)',
      httpStatus: 500,
    });
  });
});

describe('formatLynxArchivedSessionCount', () => {
  test('singular/plural', () => {
    expect(formatLynxArchivedSessionCount(1, 'session', 'sessions')).toBe('1 session');
    expect(formatLynxArchivedSessionCount(3, 'session', 'sessions')).toBe('3 sessions');
  });
});
