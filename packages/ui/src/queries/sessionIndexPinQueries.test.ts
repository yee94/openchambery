import { beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { SessionIndexSnapshot } from '@/lib/session-index-api';
import { writeSessionIndexSnapshotQuery } from './sessionIndexQueries';
import {
  derivePinnedSessionIdsFromSnapshot,
  isSessionIndexPinned,
  patchSessionIndexPinned,
  readPinnedSessionIds,
  togglePinnedSession,
} from './sessionIndexPinQueries';

const snapshot = (
  sessions: Array<{ id: string; pinned?: string | number | null }>,
  directory = '/repo',
): SessionIndexSnapshot => ({
  revision: 1,
  sync: {
    active: false,
    completed: 1,
    total: 1,
    pendingDirectories: [],
    completedDirectories: [directory],
    failedDirectories: [],
  },
  directories: [{
    directory,
    cursor: null,
    hasMore: false,
    lastSyncedAt: 1,
    lastFullSyncedAt: 1,
    lastAccessedAt: 1,
    sessions: sessions.map((session) => ({
      id: session.id,
      title: session.id,
      projectID: 'p',
      directory,
      version: '1',
      time: {
        created: 1,
        updated: 1,
        ...(session.pinned !== undefined ? { pinned: session.pinned } : {}),
      },
    })) as SessionIndexSnapshot['directories'][number]['sessions'],
  }],
});

const pinSessionMock = vi.hoisted(() => vi.fn(async () => undefined));
const unpinSessionMock = vi.hoisted(() => vi.fn(async () => undefined));
const toastErrorMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/session-index-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session-index-api')>();
  return {
    ...actual,
    pinSession: pinSessionMock,
    unpinSession: unpinSessionMock,
  };
});

vi.mock('@/components/ui', () => ({
  toast: {
    error: toastErrorMock,
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

describe('sessionIndexPinQueries', () => {
  let client: QueryClient;

  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    pinSessionMock.mockReset();
    unpinSessionMock.mockReset();
    toastErrorMock.mockReset();
    pinSessionMock.mockResolvedValue(undefined);
    unpinSessionMock.mockResolvedValue(undefined);
  });

  test('derivePinnedSessionIdsFromSnapshot excludes null/absent pinned', () => {
    const ids = derivePinnedSessionIdsFromSnapshot(snapshot([
      { id: 'pinned-iso', pinned: '2026-01-01T00:00:00.000Z' },
      { id: 'pinned-number', pinned: 1_700_000_000_000 },
      { id: 'unpinned-null', pinned: null },
      { id: 'unpinned-absent' },
    ]));
    expect([...ids].sort()).toEqual(['pinned-iso', 'pinned-number']);
    expect(isSessionIndexPinned({ time: { created: 1, updated: 1, pinned: null } })).toBe(false);
    expect(isSessionIndexPinned({ time: { created: 1, updated: 1 } })).toBe(false);
  });

  test('null snapshot yields empty pinned set (unsupported)', () => {
    expect(derivePinnedSessionIdsFromSnapshot(null)).toEqual(new Set());
    expect(readPinnedSessionIds(client, 'transport-a').size).toBe(0);
  });

  test('togglePinnedSession optimistically pins then rolls back on failure', async () => {
    writeSessionIndexSnapshotQuery(snapshot([{ id: 'ses_1' }]), {
      client,
      transport: 'transport-a',
      persist: false,
    });
    pinSessionMock.mockRejectedValueOnce(new Error('pin failed'));

    await expect(togglePinnedSession('ses_1', { client, transport: 'transport-a' }))
      .rejects.toThrow('pin failed');

    expect(readPinnedSessionIds(client, 'transport-a').has('ses_1')).toBe(false);
    expect(toastErrorMock).toHaveBeenCalled();
  });

  test('togglePinnedSession no-ops when snapshot is unsupported', async () => {
    await togglePinnedSession('ses_1', { client, transport: 'transport-missing' });
    expect(pinSessionMock).not.toHaveBeenCalled();
    expect(unpinSessionMock).not.toHaveBeenCalled();
  });

  test('togglePinnedSession optimistically updates then keeps pin on success', async () => {
    writeSessionIndexSnapshotQuery(snapshot([{ id: 'ses_1' }]), {
      client,
      transport: 'transport-a',
      persist: false,
    });

    await togglePinnedSession('ses_1', { client, transport: 'transport-a' });

    expect(readPinnedSessionIds(client, 'transport-a').has('ses_1')).toBe(true);
    expect(pinSessionMock).toHaveBeenCalledWith('ses_1');
  });

  test('patchSessionIndexPinned clears and sets pinned timestamps', () => {
    const base = snapshot([{ id: 'ses_1', pinned: '2026-01-01T00:00:00.000Z' }, { id: 'ses_2' }]);
    const cleared = patchSessionIndexPinned(base, 'ses_1', null);
    expect(isSessionIndexPinned(cleared.directories[0]?.sessions[0])).toBe(false);
    const pinned = patchSessionIndexPinned(cleared, 'ses_2', '2026-02-01T00:00:00.000Z');
    expect(isSessionIndexPinned(pinned.directories[0]?.sessions[1])).toBe(true);
  });

  test('derivePinnedSessionIdsFromSnapshot includes snapshot.pinnedSessionIds outside the newest page', () => {
    const base = snapshot([{ id: 'ses_visible' }]);
    const ids = derivePinnedSessionIdsFromSnapshot({
      ...base,
      pinnedSessionIds: ['ses_old'],
    });
    expect([...ids]).toEqual(['ses_old']);
  });

  test('togglePinnedSession can pin a session missing from the newest-page snapshot', async () => {
    writeSessionIndexSnapshotQuery(snapshot([{ id: 'ses_visible' }]), {
      client,
      transport: 'transport-a',
      persist: false,
    });

    await togglePinnedSession('ses_old', { client, transport: 'transport-a' });

    expect(readPinnedSessionIds(client, 'transport-a').has('ses_old')).toBe(true);
    expect(pinSessionMock).toHaveBeenCalledWith('ses_old');
  });
});
