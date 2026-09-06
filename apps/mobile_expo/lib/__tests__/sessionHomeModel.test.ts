import { describe, expect, it } from 'vitest';

import {
  buildSessionHomeModel,
  filterHomeCatalogForSearch,
  formatHomeSessionSubtitle,
  isDraftSessionRouteId,
  listInProgressHomeSessions,
  resolveChatSessionId,
} from '@/lib/sessionHomeModel';
import type { SessionIndexSnapshot } from '@/lib/sessionIndex';
import { parseSessionIndexSnapshot } from '@/lib/sessionIndex';

const snapshot = (over: Partial<SessionIndexSnapshot> & { directories?: SessionIndexSnapshot['directories'] } = {}): SessionIndexSnapshot => ({
  available: true,
  revision: 1,
  sync: {
    active: false,
    completed: 1,
    total: 1,
    pendingDirectories: [],
    completedDirectories: ['/code/openchamber'],
    failedDirectories: [],
  },
  directories: over.directories ?? [
    {
      directory: '/code/openchamber',
      cursor: null,
      hasMore: false,
      sessions: [
        {
          id: 'pinned-1',
          title: 'Pinned work',
          time: { created: 100, updated: 200, pinned: '2026-01-01' },
          project: { branch: 'feat/home' },
        },
        {
          id: 'unread-1',
          title: 'Fix mobile search',
          time: { created: 50, updated: 150 },
          project: { branch: 'main' },
        },
        {
          id: 'plain-1',
          title: 'Other session',
          time: { created: 10, updated: 20 },
        },
        {
          id: 'child-1',
          title: 'Subagent',
          parentID: 'plain-1',
          time: { created: 11, updated: 21 },
        },
      ],
    },
  ],
  pinnedSessionIds: over.pinnedSessionIds ?? ['pinned-1'],
  ...over,
});

describe('formatHomeSessionSubtitle', () => {
  it('joins project and branch with middle dot', () => {
    expect(formatHomeSessionSubtitle('openchamber', 'feat/home')).toBe('openchamber · feat/home');
    expect(formatHomeSessionSubtitle('openchamber', '  ')).toBe('openchamber');
    expect(formatHomeSessionSubtitle('openchamber', null)).toBe('openchamber');
  });
});

describe('buildSessionHomeModel', () => {
  it('builds pinned rows with 项目 · 分支 subtitle and unread dots', () => {
    const model = buildSessionHomeModel(snapshot(), {
      unseenBySession: { 'unread-1': 2, 'child-1': 9 },
    });
    expect(model.pinned).toHaveLength(1);
    expect(model.pinned[0]?.subtitle).toBe('openchamber · feat/home');
    expect(model.inProgress.map((s) => s.id)).toEqual(['unread-1']);
    expect(model.inProgress[0]?.unread).toBe(true);
    expect(model.inProgress[0]?.subtitle).toBe('openchamber · main');
    // Child unread does not promote a subagent into in-progress / unread alone.
    expect(model.catalog.find((s) => s.id === 'child-1')).toBeUndefined();
    const plain = model.directories[0]?.sessions.find((s) => s.id === 'plain-1');
    expect(plain?.subtitle).toBe('openchamber');
  });

  it('omits pinned ids from directory lists', () => {
    const model = buildSessionHomeModel(snapshot());
    expect(model.directories[0]?.sessions.map((s) => s.id)).toEqual(['unread-1', 'plain-1']);
  });
});

describe('filterHomeCatalogForSearch', () => {
  it('matches loaded titles and keeps highlight query hits', () => {
    const model = buildSessionHomeModel(snapshot());
    const result = filterHomeCatalogForSearch(model, 'mobile search');
    expect(result.sessions.map((s) => s.id)).toEqual(['unread-1']);
  });
});

describe('listInProgressHomeSessions', () => {
  it('includes running non-pinned sessions', () => {
    const sessions = [
      { id: 'a', parentID: null },
      { id: 'b', parentID: null },
    ];
    const result = listInProgressHomeSessions(
      sessions,
      new Set(['a']),
      new Set(['b']),
      {},
      () => false,
    );
    expect(result.map((s) => s.id)).toEqual(['b']);
  });
});

describe('draft session route', () => {
  it('maps draft / empty route ids to sessionId == ""', () => {
    expect(isDraftSessionRouteId('draft')).toBe(true);
    expect(isDraftSessionRouteId('')).toBe(true);
    expect(isDraftSessionRouteId('abc')).toBe(false);
    expect(resolveChatSessionId('draft')).toBe('');
    expect(resolveChatSessionId('abc')).toBe('abc');
  });
});

describe('parseSessionIndexSnapshot', () => {
  it('treats available≠true as unsupported null, not empty success', () => {
    expect(parseSessionIndexSnapshot({ available: false, directories: [] })).toBeNull();
    expect(parseSessionIndexSnapshot({ directories: [] })).toBeNull();
    const ok = parseSessionIndexSnapshot({
      available: true,
      revision: 3,
      directories: [{ directory: '/x', sessions: [] }],
      pinnedSessionIds: ['a'],
    });
    expect(ok?.revision).toBe(3);
    expect(ok?.pinnedSessionIds).toEqual(['a']);
  });
});
