import { describe, expect, test, vi } from 'vitest';
import type { Session } from '@opencode-ai/sdk/v2';

import {
  buildMobileSessionStatusList,
  countMobileSessionStatusBadges,
} from './mobileSessionStatusBarList';

const session = (
  id: string,
  overrides: Partial<Session> & { parentID?: string } = {},
): Session => ({
  id,
  title: id,
  time: { created: 1, updated: Number(id.replace(/\D/g, '') || 1) },
  ...overrides,
} as Session);

describe('countMobileSessionStatusBadges', () => {
  test('matches open-sheet top-level unread + direct-child running semantics', () => {
    const parent = session('parent', { time: { created: 1, updated: 30 } });
    const child = session('child', {
      parentID: 'parent',
      time: { created: 1, updated: 20 },
    } as Session & { parentID: string });
    const grandchild = session('grandchild', {
      parentID: 'child',
      time: { created: 1, updated: 10 },
    } as Session & { parentID: string });
    const orphan = session('orphan', {
      parentID: 'missing-parent',
      time: { created: 1, updated: 5 },
    } as Session & { parentID: string });
    const sessions = [parent, child, grandchild, orphan];

    // Child unread must not inflate the top-level unread badge; grandchild busy
    // is not a direct child of parent so open baseline leaves it out of running.
    const badges = countMobileSessionStatusBadges(
      sessions,
      {
        parent: { type: 'idle' },
        child: { type: 'busy' },
        grandchild: { type: 'busy' },
        orphan: { type: 'retry' },
      },
      { parent: 0, child: 3, grandchild: 1, orphan: 2 },
    );

    // parent: 0 self + 1 direct child busy; orphan top-level retry = 1 → 2
    expect(badges.totalRunning).toBe(2);
    // parent unread 0; orphan unread 1 → only top-level counts
    expect(badges.totalUnread).toBe(1);
  });
});

describe('buildMobileSessionStatusList', () => {
  const activity = (entry: Session) => entry.time?.updated ?? 0;

  test('closed sheet skips enrichment while badges stay live and match open', () => {
    const parent = session('parent', { time: { created: 1, updated: 40 } });
    const child = session('child', {
      parentID: 'parent',
      time: { created: 1, updated: 30 },
    } as Session & { parentID: string });
    const grandchild = session('grandchild', {
      parentID: 'child',
      time: { created: 1, updated: 20 },
    } as Session & { parentID: string });
    const orphan = session('orphan', {
      parentID: 'gone',
      time: { created: 1, updated: 10 },
    } as Session & { parentID: string });
    const idle = session('idle', { time: { created: 1, updated: 5 } });
    const sessions = [parent, child, grandchild, orphan, idle];
    const status = {
      parent: { type: 'busy' as const },
      child: { type: 'busy' as const },
      grandchild: { type: 'busy' as const },
      orphan: { type: 'idle' as const },
    };
    const unseen = { parent: 1, child: 9, orphan: 1 };

    const activitySpy = vi.fn(activity);
    let closedSessionsEmpty = true;
    for (let tick = 0; tick < 12; tick += 1) {
      const closed = buildMobileSessionStatusList(
        sessions,
        status,
        unseen,
        false,
        activitySpy,
      );
      closedSessionsEmpty = closedSessionsEmpty && closed.sessions.length === 0;
      expect(closed.totalCount).toBe(0);
      // parent self busy + direct child busy; orphan idle → 2 (grandchild nested under child)
      expect(closed.totalRunning).toBe(2);
      expect(closed.totalUnread).toBe(2); // parent + orphan top-level only
    }
    expect(closedSessionsEmpty).toBe(true);
    // Closed path must not call the open-sheet sort key.
    expect(activitySpy).not.toHaveBeenCalled();

    const open = buildMobileSessionStatusList(sessions, status, unseen, true, activity);
    expect(open.sessions.length).toBeGreaterThan(0);
    expect(open.totalRunning).toBe(2);
    expect(open.totalUnread).toBe(2);
    expect(open.sessions.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(['parent', 'orphan', 'idle']),
    );
    expect(open.sessions.some((entry) => entry.id === 'child')).toBe(false);
    expect(open.sessions.find((entry) => entry.id === 'parent')?._runningChildrenCount).toBe(1);
  });

  test('open sheet enriches parent/child running counts and ignores archived-only fields', () => {
    const parent = session('parent', { time: { created: 1, updated: 10 } });
    const child = session('child', {
      parentID: 'parent',
      time: { created: 1, updated: 11 },
    } as Session & { parentID: string });
    const result = buildMobileSessionStatusList(
      [parent, child],
      { child: { type: 'busy' } },
      {},
      true,
      activity,
    );
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?._runningChildrenCount).toBe(1);
    expect(result.totalRunning).toBe(1);
  });

  test('closed and open badge totals stay aligned for pinned-style top-level mixes', () => {
    const pinned = session('pinned', { time: { created: 1, updated: 100 } });
    const other = session('other', { time: { created: 1, updated: 50 } });
    const childOfPinned = session('child', {
      parentID: 'pinned',
      time: { created: 1, updated: 90 },
    } as Session & { parentID: string });
    const sessions = [pinned, other, childOfPinned];
    const status = {
      pinned: { type: 'idle' as const },
      other: { type: 'busy' as const },
      child: { type: 'retry' as const },
    };
    const unseen = { pinned: 2, child: 4 };

    const closed = buildMobileSessionStatusList(sessions, status, unseen, false, activity);
    const open = buildMobileSessionStatusList(sessions, status, unseen, true, activity);
    expect(closed.totalRunning).toBe(open.totalRunning);
    expect(closed.totalUnread).toBe(open.totalUnread);
    expect(open.totalRunning).toBe(2); // other self + pinned's child
    expect(open.totalUnread).toBe(1); // pinned only
  });
});

/**
 * Exit-retain helper mirroring MobileSessionStatusBar useSessionGrouping:
 * freeze last open sessions while presence holds; badges stay live independently.
 */
function retainLastOpenWhilePresent(input: {
  open: boolean;
  present: boolean;
  sessions: readonly Session[];
  status: Record<string, { type: string }>;
  unseen: Record<string, number>;
  lastOpen: Session[];
}): { sessions: Session[]; totalRunning: number; totalUnread: number; lastOpen: Session[] } {
  const activity = (entry: Session) => entry.time?.updated ?? 0;
  const built = buildMobileSessionStatusList(
    input.sessions,
    input.status,
    input.unseen,
    input.open,
    activity,
  );
  if (input.open) {
    return {
      sessions: built.sessions,
      totalRunning: built.totalRunning,
      totalUnread: built.totalUnread,
      lastOpen: built.sessions,
    };
  }
  if (!input.present) {
    return {
      sessions: [],
      totalRunning: built.totalRunning,
      totalUnread: built.totalUnread,
      lastOpen: [],
    };
  }
  return {
    sessions: input.lastOpen,
    totalRunning: built.totalRunning,
    totalUnread: built.totalUnread,
    lastOpen: input.lastOpen,
  };
}

describe('status bar exit retain (presence, not timeout)', () => {
  test('keeps last open rows through exit then clears when presence ends', () => {
    const sessions = [
      session('a', { time: { created: 1, updated: 2 } }),
      session('b', { time: { created: 1, updated: 1 } }),
    ];
    const status = { a: { type: 'busy' as const } };
    const unseen = { b: 1 };

    let lastOpen: Session[] = [];
    const opened = retainLastOpenWhilePresent({
      open: true,
      present: true,
      sessions,
      status,
      unseen,
      lastOpen,
    });
    lastOpen = opened.lastOpen;
    expect(opened.sessions.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(opened.totalRunning).toBe(1);
    expect(opened.totalUnread).toBe(1);

    // open=false while present: body frozen, badges can still move
    const exiting = retainLastOpenWhilePresent({
      open: false,
      present: true,
      sessions,
      status: { a: { type: 'busy' }, b: { type: 'busy' } },
      unseen: { a: 1, b: 1 },
      lastOpen,
    });
    expect(exiting.sessions.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(exiting.totalRunning).toBe(2);
    expect(exiting.totalUnread).toBe(2);

    const exited = retainLastOpenWhilePresent({
      open: false,
      present: false,
      sessions,
      status,
      unseen,
      lastOpen: exiting.lastOpen,
    });
    expect(exited.sessions).toEqual([]);
    expect(exited.totalRunning).toBe(1);
  });
});
