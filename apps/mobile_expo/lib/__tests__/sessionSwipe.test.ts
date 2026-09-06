import { describe, expect, it } from 'vitest';

import {
  evaluateSwipeDirection,
  rankSessionsForSwipe,
  resolveSessionSwipeNeighbor,
  shouldStartSessionSwipe,
} from '@/lib/sessionSwipe';
import { evaluateHeaderSwipe } from '@/lib/headerSwipe';

describe('evaluateSwipeDirection', () => {
  it('commits horizontal swipes past threshold', () => {
    expect(
      evaluateSwipeDirection({ startX: 200, startY: 10, endX: 100, endY: 12 }),
    ).toBe('next');
    expect(
      evaluateSwipeDirection({ startX: 100, startY: 10, endX: 200, endY: 12 }),
    ).toBe('prev');
    expect(
      evaluateSwipeDirection({ startX: 100, startY: 10, endX: 120, endY: 12 }),
    ).toBeNull();
  });
});

describe('shouldStartSessionSwipe', () => {
  it('requires explicit composer surface and rejects typing/edge', () => {
    expect(
      shouldStartSessionSwipe({
        onExplicitSurface: true,
        onCodeBlock: false,
        withinHorizontalScroller: false,
      }),
    ).toBe(true);
    expect(
      shouldStartSessionSwipe({
        onExplicitSurface: true,
        onCodeBlock: false,
        withinHorizontalScroller: false,
        composerActive: true,
      }),
    ).toBe(false);
    expect(
      shouldStartSessionSwipe({
        onExplicitSurface: false,
        onCodeBlock: false,
        withinHorizontalScroller: false,
      }),
    ).toBe(false);
  });
});

describe('rankSessionsForSwipe / neighbor', () => {
  it('walks newest-first top-level ids', () => {
    const ordered = rankSessionsForSwipe([
      { id: 'a', activityMs: 1, parentID: null },
      { id: 'b', activityMs: 3, parentID: null },
      { id: 'c', activityMs: 2, parentID: 'b' },
    ]);
    expect(ordered).toEqual(['b', 'a']);
    expect(resolveSessionSwipeNeighbor(ordered, 'b', 'next')).toBe('a');
    expect(resolveSessionSwipeNeighbor(ordered, 'b', 'prev')).toBeNull();
  });
});

describe('evaluateHeaderSwipe', () => {
  it('opens on RTL past 35% viewport and backs on LTR', () => {
    expect(
      evaluateHeaderSwipe({
        startX: 200,
        startY: 30,
        endX: 100,
        endY: 35,
        viewportWidth: 180,
        disabled: false,
        startedOnExcludedTarget: false,
      }),
    ).toEqual({ open: true, back: false });
    expect(
      evaluateHeaderSwipe({
        startX: 100,
        startY: 30,
        endX: 200,
        endY: 35,
        viewportWidth: 180,
        disabled: false,
        startedOnExcludedTarget: false,
      }),
    ).toEqual({ open: false, back: true });
  });
});
