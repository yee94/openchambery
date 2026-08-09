import { beforeEach, describe, expect, mock, test } from 'bun:test';

let activeSessions: Array<{ id: string; directory?: string }> = [];
let archivedSessions: Array<{ id: string; directory?: string }> = [];
let hasLoaded = false;
let lookupHit: { id: string; directory: string } | null = null;
let getSessionResult: { id: string; directory?: string } | null = null;
let getSessionThrows = false;

mock.module('@/stores/useGlobalSessionsStore', () => ({
  resolveGlobalSessionDirectory: (session: { directory?: string }) => session.directory ?? null,
  useGlobalSessionsStore: {
    getState: () => ({
      activeSessions,
      archivedSessions,
      hasLoaded,
    }),
  },
}));

mock.module('@/lib/session-index-api', () => ({
  lookupSessionIndexById: async (sessionId: string) => {
    if (lookupHit && lookupHit.id === sessionId) return lookupHit;
    return null;
  },
}));

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    getSession: async (id: string) => {
      if (getSessionThrows) throw new Error('not found');
      if (getSessionResult && getSessionResult.id === id) return getSessionResult;
      throw new Error('not found');
    },
  },
}));

const {
  findSessionById,
  resolveSessionDirectoryForRoute,
  resolveSessionForRoute,
} = await import('./sessionLookup');

describe('sessionLookup (path deep-link)', () => {
  beforeEach(() => {
    activeSessions = [];
    archivedSessions = [];
    hasLoaded = false;
    lookupHit = null;
    getSessionResult = null;
    getSessionThrows = false;
  });

  test('finds session from seed cache without hasLoaded', () => {
    activeSessions = [{ id: 'ses_a', directory: '/repo/a' }];
    hasLoaded = false;

    const hit = findSessionById('ses_a');
    expect(hit?.directory).toBe('/repo/a');
    expect(hit?.fromCache).toBe(true);
    expect(resolveSessionDirectoryForRoute('ses_a')).toBe('/repo/a');
  });

  test('resolveSessionForRoute falls back to session-index by id', async () => {
    lookupHit = { id: 'ses_remote', directory: '/other/worktree' };
    const hit = await resolveSessionForRoute('ses_remote');
    expect(hit).toEqual({
      sessionId: 'ses_remote',
      directory: '/other/worktree',
      session: null,
      fromCache: false,
      source: 'session-index',
    });
  });

  test('resolveSessionForRoute falls back to session.get', async () => {
    getSessionResult = { id: 'ses_sdk', directory: '/from/sdk' };
    const hit = await resolveSessionForRoute('ses_sdk');
    expect(hit?.directory).toBe('/from/sdk');
    expect(hit?.source).toBe('session-get');
  });

  test('resolveSessionForRoute returns null when all sources miss', async () => {
    getSessionThrows = true;
    const hit = await resolveSessionForRoute('ses_missing');
    expect(hit).toBeNull();
  });
});
