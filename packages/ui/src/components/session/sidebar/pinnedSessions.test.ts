import { describe, expect, test } from 'vitest';
import type { Session } from '@opencode-ai/sdk/v2';

import { derivePinnedSessions } from './pinnedSessions';

const session = (id: string, created: number): Session => ({
  id,
  time: { created },
} as Session);

describe('derivePinnedSessions', () => {
  test('returns every pinned session ordered by creation time', () => {
    const sessions = [
      session('old', 10),
      session('unpinned', 30),
      session('new', 20),
    ];

    expect(derivePinnedSessions(sessions, new Set(['old', 'new']))
      .map((item) => item.id)).toEqual(['new', 'old']);
  });

  test('returns no rows when no session is pinned', () => {
    expect(derivePinnedSessions([session('session-a', 1)], new Set())).toEqual([]);
  });
});
