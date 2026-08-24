import { describe, expect, test } from 'bun:test';

import {
  collectRunningSessionIds,
  mergeAlwaysVisibleSessionIds,
} from './useAlwaysVisibleSessionIds';

describe('collectRunningSessionIds', () => {
  test('collects busy and retry from live statuses', () => {
    const ids = collectRunningSessionIds(
      {
        busy: { type: 'busy' },
        retry: { type: 'retry' },
        idle: { type: 'idle' },
      },
      new Map(),
    );

    expect([...ids].sort()).toEqual(['busy', 'retry']);
  });

  test('adds fallback-only entries not covered by live statuses', () => {
    const ids = collectRunningSessionIds(
      {
        liveBusy: { type: 'busy' },
        covered: { type: 'idle' },
      },
      new Map([
        ['liveBusy', { status: 'busy', directory: '/a' }],
        ['covered', { status: 'busy', directory: '/a' }],
        ['fallbackOnly', { status: 'retry', directory: '/b' }],
      ]),
    );

    expect([...ids].sort()).toEqual(['fallbackOnly', 'liveBusy']);
  });

  test('returns empty when both sources are empty', () => {
    expect(collectRunningSessionIds({}, new Map()).size).toBe(0);
  });
});

describe('mergeAlwaysVisibleSessionIds', () => {
  test('returns running set when current is null or undefined', () => {
    const running = new Set(['a', 'b']);
    expect(mergeAlwaysVisibleSessionIds(running, null)).toBe(running);
    expect(mergeAlwaysVisibleSessionIds(running, undefined)).toBe(running);
  });

  test('returns same set when current is already running', () => {
    const running = new Set(['a', 'b']);
    expect(mergeAlwaysVisibleSessionIds(running, 'a')).toBe(running);
  });

  test('appends current when it is not running', () => {
    const running = new Set(['a']);
    const merged = mergeAlwaysVisibleSessionIds(running, 'viewing');
    expect(merged).not.toBe(running);
    expect([...merged].sort()).toEqual(['a', 'viewing']);
  });
});
