import { describe, expect, test } from 'vitest';

import {
  SESSION_ARCHIVE_UNDO_MS,
  createLynxArchiveUndoBanner,
  isLynxArchiveUndoExpired,
  toggleLynxArchiveConfirm,
} from './sessionArchiveUndo';

describe('Lynx session archive undo helpers', () => {
  test('toggleLynxArchiveConfirm arms and cancels like Cap', () => {
    expect(toggleLynxArchiveConfirm(null, 'ses_1')).toBe('ses_1');
    expect(toggleLynxArchiveConfirm('ses_1', 'ses_1')).toBe(null);
    expect(toggleLynxArchiveConfirm('ses_1', 'ses_2')).toBe('ses_2');
  });

  test('createLynxArchiveUndoBanner uses Cap ~10s window', () => {
    const banner = createLynxArchiveUndoBanner({
      sessionId: 'ses_1',
      directory: '/repo',
      now: 1_000,
    });
    expect(banner).toEqual({
      sessionId: 'ses_1',
      directory: '/repo',
      expiresAt: 1_000 + SESSION_ARCHIVE_UNDO_MS,
    });
    expect(SESSION_ARCHIVE_UNDO_MS).toBe(10_000);
    expect(isLynxArchiveUndoExpired(banner, 1_000 + SESSION_ARCHIVE_UNDO_MS - 1)).toBe(false);
    expect(isLynxArchiveUndoExpired(banner, 1_000 + SESSION_ARCHIVE_UNDO_MS)).toBe(true);
    expect(isLynxArchiveUndoExpired(null)).toBe(true);
  });
});
