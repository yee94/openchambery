import { describe, expect, test } from 'vitest';

import type { SessionIndexSnapshot } from '../session-index/types';
import {
  LYNX_PINNED_SESSION_FILTER_ID,
  buildLynxSessionStatusBarItems,
  countLynxRunningSessions,
  mergeLynxStatusBarRelated,
  normalizeLynxSessionStatusType,
  relatedSessionsFromSessionIndex,
  resolveMobileSessionSheetDefaultFilter,
  shouldPreserveActiveProjectOnSessionOpen,
  shouldShowLynxSessionBusyIndicator,
  shouldShowLynxSessionStatusBar,
} from './sessionStatusBar';

describe('normalizeLynxSessionStatusType', () => {
  test('maps Cap busy/retry/idle', () => {
    expect(normalizeLynxSessionStatusType('busy')).toBe('busy');
    expect(normalizeLynxSessionStatusType('retry')).toBe('retry');
    expect(normalizeLynxSessionStatusType('idle')).toBe('idle');
    expect(normalizeLynxSessionStatusType('other')).toBe('idle');
    expect(normalizeLynxSessionStatusType(null)).toBe('idle');
  });
});

describe('Cap sheet filter / preserve-active-project', () => {
  test('preserve All and pinned scopes', () => {
    expect(shouldPreserveActiveProjectOnSessionOpen(null)).toBe(true);
    expect(shouldPreserveActiveProjectOnSessionOpen(LYNX_PINNED_SESSION_FILTER_ID)).toBe(true);
    expect(shouldPreserveActiveProjectOnSessionOpen('project-a')).toBe(false);
  });

  test('resolveMobileSessionSheetDefaultFilter preserves explicit All/pinned/known', () => {
    const projects = [{ id: 'p1' }, { id: 'p2' }];
    expect(resolveMobileSessionSheetDefaultFilter({
      activeProjectId: 'p1',
      currentFilterProjectId: null,
      projects,
    })).toBe(null);
    expect(resolveMobileSessionSheetDefaultFilter({
      activeProjectId: 'p1',
      currentFilterProjectId: LYNX_PINNED_SESSION_FILTER_ID,
      projects,
    })).toBe(LYNX_PINNED_SESSION_FILTER_ID);
    expect(resolveMobileSessionSheetDefaultFilter({
      activeProjectId: 'p1',
      currentFilterProjectId: 'p2',
      projects,
    })).toBe('p2');
    expect(resolveMobileSessionSheetDefaultFilter({
      activeProjectId: 'p1',
      currentFilterProjectId: 'removed',
      projects,
    })).toBe('p1');
  });
});

describe('buildLynxSessionStatusBarItems', () => {
  test('marks current, normalizes status, dedupes, injects missing current', () => {
    const items = buildLynxSessionStatusBarItems(
      [
        { id: 'a', title: 'Alpha', statusType: 'busy' },
        { id: 'a', title: 'dup' },
        { id: 'b', title: 'Beta', statusType: 'retry' },
      ],
      'c',
    );
    expect(items.map((i) => i.id)).toEqual(['c', 'a', 'b']);
    expect(items.find((i) => i.id === 'a')?.isCurrent).toBe(false);
    expect(items.find((i) => i.id === 'a')?.statusType).toBe('busy');
    expect(items.find((i) => i.id === 'b')?.statusType).toBe('retry');
    expect(items.find((i) => i.id === 'c')?.isCurrent).toBe(true);
  });
});

describe('visibility + busy', () => {
  test('count running + busy indicator gates', () => {
    const items = buildLynxSessionStatusBarItems(
      [
        { id: 'a', title: 'A', statusType: 'busy' },
        { id: 'b', title: 'B', statusType: 'idle' },
      ],
      'a',
    );
    expect(countLynxRunningSessions(items)).toBe(1);
    expect(shouldShowLynxSessionBusyIndicator({ items })).toBe(true);
    expect(shouldShowLynxSessionBusyIndicator({
      items: buildLynxSessionStatusBarItems([{ id: 'a', title: 'A' }], 'a'),
      currentSessionIsWorking: true,
    })).toBe(true);
    expect(shouldShowLynxSessionBusyIndicator({
      items: buildLynxSessionStatusBarItems([{ id: 'a', title: 'A' }], 'a'),
    })).toBe(false);
  });

  test('show bar for multi-session or busy or attention', () => {
    const multi = buildLynxSessionStatusBarItems(
      [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }],
      'a',
    );
    expect(shouldShowLynxSessionStatusBar({ items: multi })).toBe(true);

    const soloBusy = buildLynxSessionStatusBarItems(
      [{ id: 'a', title: 'A', statusType: 'busy' }],
      'a',
    );
    expect(shouldShowLynxSessionStatusBar({ items: soloBusy })).toBe(true);

    const soloIdle = buildLynxSessionStatusBarItems(
      [{ id: 'a', title: 'A' }],
      'a',
    );
    expect(shouldShowLynxSessionStatusBar({ items: soloIdle })).toBe(false);
    expect(shouldShowLynxSessionStatusBar({
      items: soloIdle,
      currentSessionIsWorking: true,
    })).toBe(true);

    const attention = buildLynxSessionStatusBarItems(
      [{ id: 'a', title: 'A', needsAttention: true }],
      'b',
    );
    expect(shouldShowLynxSessionStatusBar({ items: attention })).toBe(true);
  });
});

describe('relatedSessionsFromSessionIndex', () => {
  const snapshot: SessionIndexSnapshot = {
    revision: 1,
    sync: {
      active: false,
      completed: 1,
      total: 1,
      pendingDirectories: [],
      completedDirectories: ['/proj'],
      failedDirectories: [],
    },
    directories: [
      {
        directory: '/proj',
        cursor: null,
        hasMore: false,
        lastSyncedAt: 1,
        lastFullSyncedAt: 1,
        lastAccessedAt: 1,
        sessions: [
          {
            id: 'old',
            title: 'Old',
            directory: '/proj',
            time: { created: 1, updated: 10 },
            metadata: { openchamber: { sessionStatus: { type: 'idle' } } },
          },
          {
            id: 'new',
            title: 'New',
            directory: '/proj',
            time: { created: 2, updated: 20 },
            metadata: { openchamber: { sessionStatus: { type: 'busy' } } },
          },
          {
            id: 'child',
            title: 'Child',
            directory: '/proj',
            parentID: 'new',
            time: { created: 3, updated: 30 },
          },
          {
            id: 'archived',
            title: 'Archived',
            directory: '/proj',
            time: { created: 4, updated: 40, archived: 41 },
          },
          {
            id: 'other',
            title: 'Other dir',
            directory: '/other',
            time: { created: 5, updated: 50 },
          },
        ],
      },
    ],
  };

  test('same-directory top-level newest-first; skips archived/children', () => {
    const related = relatedSessionsFromSessionIndex({
      snapshot,
      currentSessionId: 'old',
      directory: '/proj',
    });
    expect(related.map((r) => r.id)).toEqual(['old', 'new']);
    expect(related.find((r) => r.id === 'new')?.statusType).toBe('busy');
  });

  test('empty snapshot returns []', () => {
    expect(relatedSessionsFromSessionIndex({
      snapshot: null,
      currentSessionId: 'x',
    })).toEqual([]);
  });
});

describe('mergeLynxStatusBarRelated', () => {
  test('prefers ordered ids and fills titles from related', () => {
    const merged = mergeLynxStatusBarRelated({
      orderedSessionIds: ['b', 'a'],
      related: [
        { id: 'a', title: 'Alpha', statusType: 'busy' },
        { id: 'c', title: 'Charlie' },
      ],
      currentSessionId: 'a',
    });
    expect(merged.map((m) => m.id)).toEqual(['b', 'a', 'c']);
    expect(merged.find((m) => m.id === 'a')?.title).toBe('Alpha');
    expect(merged.find((m) => m.id === 'b')?.title).toBeUndefined();
  });
});
