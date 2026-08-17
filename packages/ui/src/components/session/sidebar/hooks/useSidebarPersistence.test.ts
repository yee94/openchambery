import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/v2-types';
import { prunePinnedSessionIds } from './pinnedSessionCleanup';

const makeSession = (id: string): Pick<Session, 'id'> => ({ id });

describe('prunePinnedSessionIds', () => {
  test('keeps pinned ids that still exist in the authoritative session list', () => {
    const sessions = [makeSession('visible-session'), makeSession('hidden-session')];
    const pinnedSessionIds = new Set(['hidden-session', 'missing-session']);

    const next = prunePinnedSessionIds(sessions, pinnedSessionIds);

    expect([...next]).toEqual(['hidden-session']);
    expect(next).not.toBe(pinnedSessionIds);
  });

  test('returns the original set when nothing needs pruning', () => {
    const sessions = [makeSession('visible-session'), makeSession('hidden-session')];
    const pinnedSessionIds = new Set(['visible-session', 'hidden-session']);

    const next = prunePinnedSessionIds(sessions, pinnedSessionIds);

    expect(next).toBe(pinnedSessionIds);
  });

  test('retains pinned ids beyond a bounded 20-row directory snapshot when the full catalog contains them', () => {
    const sessions = Array.from({ length: 25 }, (_, index) => makeSession(`session-${index}`));
    const pinnedSessionIds = new Set(['session-0', 'session-24']);

    expect([...prunePinnedSessionIds(sessions, pinnedSessionIds)]).toEqual(['session-0', 'session-24']);
  });
});
