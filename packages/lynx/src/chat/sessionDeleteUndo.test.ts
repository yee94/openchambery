import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  SESSION_DELETE_UNDO_MS,
  cancelLynxScheduledSessionDeletes,
  clearLynxScheduledSessionDeletesForTests,
  createLynxDeleteUndoBanner,
  isLynxDeleteUndoExpired,
  scheduleLynxSessionDeletes,
} from './sessionDeleteUndo';

afterEach(() => {
  clearLynxScheduledSessionDeletesForTests();
  vi.useRealTimers();
});

describe('Lynx session delete undo helpers', () => {
  test('createLynxDeleteUndoBanner uses Cap ~10s window', () => {
    const banner = createLynxDeleteUndoBanner({
      batchId: 'batch-1',
      sessionIds: ['ses_1', 'ses_1', ''],
      now: 1_000,
    });
    expect(banner).toEqual({
      batchId: 'batch-1',
      sessionIds: ['ses_1'],
      expiresAt: 1_000 + SESSION_DELETE_UNDO_MS,
    });
    expect(SESSION_DELETE_UNDO_MS).toBe(10_000);
    expect(isLynxDeleteUndoExpired(banner, 1_000 + SESSION_DELETE_UNDO_MS - 1)).toBe(false);
    expect(isLynxDeleteUndoExpired(banner, 1_000 + SESSION_DELETE_UNDO_MS)).toBe(true);
    expect(isLynxDeleteUndoExpired(null)).toBe(true);
  });

  test('schedule commits after delay; cancel skips commit', async () => {
    vi.useFakeTimers();
    const commits: string[][] = [];
    const { batchId, scheduledIds } = scheduleLynxSessionDeletes(
      [
        { sessionId: 'ses_1', directory: '/repo' },
        { sessionId: 'ses_2', directory: null },
        { sessionId: 'ses_1', directory: '/other' },
      ],
      {
        onCommit: (entries) => {
          commits.push(entries.map((entry) => entry.sessionId));
        },
      },
    );
    expect(batchId).toMatch(/^lynx-session-delete-/);
    expect(scheduledIds).toEqual(['ses_1', 'ses_2']);
    expect(commits).toEqual([]);

    expect(cancelLynxScheduledSessionDeletes(batchId)).toBe(true);
    await vi.advanceTimersByTimeAsync(SESSION_DELETE_UNDO_MS + 50);
    expect(commits).toEqual([]);

    const second = scheduleLynxSessionDeletes(
      [{ sessionId: 'ses_3', directory: '/r' }],
      {
        onCommit: (entries) => {
          commits.push(entries.map((entry) => entry.sessionId));
        },
      },
    );
    await vi.advanceTimersByTimeAsync(SESSION_DELETE_UNDO_MS + 50);
    expect(commits).toEqual([['ses_3']]);
    expect(cancelLynxScheduledSessionDeletes(second.batchId)).toBe(false);
  });
});
