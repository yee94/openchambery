import { describe, expect, test } from 'bun:test';
import {
  createHeaderSwipeGestureState,
  evaluateHeaderSwipe,
  getHeaderSwipeBackProgress,
  getHeaderSwipePresentationProgress,
  updateHeaderSwipeGestureState,
} from './useHeaderSwipeToSessions';

import type { HeaderSwipeInput } from './useHeaderSwipeToSessions';

/**
 * Pure-function tests for evaluateHeaderSwipe.
 *
 * The DOM-dependent part of the hook (touch listeners, interactive-target
 * detection) exercises touch-event patterns that are verified through
 * component-level smoke on device. These tests cover every geometric
 * gate: direction, minimum distance, off-axis ratio, and disabled /
 * interactive bypass rules.
 */

const base = (
  overrides: Partial<HeaderSwipeInput> = {},
): HeaderSwipeInput => ({
  startX: 200,
  startY: 30,
  endX: 100,
  endY: 35,
  viewportWidth: 180,
  disabled: false,
  startedOnExcludedTarget: false,
  ...overrides,
});

describe('evaluateHeaderSwipe', () => {
  // -----------------------------------------------------------------------
  // Happy path: clean leftward swipe across the open threshold
  // -----------------------------------------------------------------------
  test('opens on clean horizontal right-to-left swipe', () => {
    expect(evaluateHeaderSwipe(base())).toEqual({ open: true, back: false });
  });

  // -----------------------------------------------------------------------
  // Direction: must be right-to-left (dx < 0)
  // -----------------------------------------------------------------------
  test('maps a qualifying left-to-right swipe to secondary-page back', () => {
    expect(evaluateHeaderSwipe(base({ startX: 100, endX: 200 }))).toEqual({ open: false, back: true });
    expect(evaluateHeaderSwipe(base({ startX: 100, endX: 110 }))).toEqual({ open: false, back: false });
  });

  test('rejects stationary touch (no horizontal movement)', () => {
    expect(evaluateHeaderSwipe(base({ startX: 200, endX: 200 })).open).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 35%-viewport threshold
  // -----------------------------------------------------------------------
  test('rejects swipe below the open threshold', () => {
    expect(evaluateHeaderSwipe(base({ startX: 200, endX: 138, viewportWidth: 180 })).open).toBe(false);
  });

  test('accepts swipe exactly at the open threshold', () => {
    expect(evaluateHeaderSwipe(base({ startX: 200, endX: 137, viewportWidth: 180 })).open).toBe(true);
  });

  test('accepts swipe beyond the open threshold', () => {
    expect(evaluateHeaderSwipe(base({ startX: 200, endX: 136, viewportWidth: 180 })).open).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Off-axis (vertical) rejection
  // -----------------------------------------------------------------------
  test('rejects primarily vertical swipe', () => {
    // dx = 100, dy = -200, |dy|/|dx| = 2.0 > 0.55
    expect(evaluateHeaderSwipe(base({ startX: 200, startY: 200, endX: 100, endY: 0 })).open).toBe(false);
  });

  test('rejects diagonal with strong vertical component', () => {
    // dx = 100, dy = -60, |60/100| = 0.6 > 0.55
    expect(evaluateHeaderSwipe(base({ startX: 200, startY: 100, endX: 100, endY: 40 })).open).toBe(false);
  });

  test('accepts mildly diagonal swipe within off-axis tolerance', () => {
    // dx = 200, dy = -80, |80/200| = 0.4 < 0.55
    expect(evaluateHeaderSwipe(base({ startX: 300, startY: 100, endX: 100, endY: 20 })).open).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Disabled gate
  // -----------------------------------------------------------------------
  test('rejects when disabled', () => {
    expect(evaluateHeaderSwipe(base({ disabled: true }))).toEqual({ open: false, back: false });
  });

  // -----------------------------------------------------------------------
  // Interactive target gate
  // -----------------------------------------------------------------------
  test('rejects when started on an excluded target', () => {
    expect(evaluateHeaderSwipe(base({ startedOnExcludedTarget: true }))).toEqual({ open: false, back: false });
  });
});

describe('updateHeaderSwipeGestureState', () => {
  const viewportWidth = 200;

  const update = (
    state: ReturnType<typeof createHeaderSwipeGestureState>,
    clientX: number,
    clientY = 0,
  ) => updateHeaderSwipeGestureState(state, { clientX, clientY }, viewportWidth);

  test('reopens after a leftward candidate is cancelled by rightward travel', () => {
    let state = createHeaderSwipeGestureState({ clientX: 200, clientY: 0 });
    state = update(state, 99);
    expect(state.open).toBe(true);
    state = update(state, 200);
    expect(state.open).toBe(false);
    state = update(state, 99);
    expect(state.open).toBe(true);
  });

  test('keeps the candidate cancelled after a final rightward segment', () => {
    let state = createHeaderSwipeGestureState({ clientX: 200, clientY: 0 });
    state = update(state, 99);
    state = update(state, 200);

    expect(state.open).toBe(false);
  });

  test('keeps the original origin while tracking rightward travel', () => {
    let state = createHeaderSwipeGestureState({ clientX: 200, clientY: 0 });
    state = update(state, 99);
    state = update(state, 131);

    expect(state.open).toBe(false);
    expect(state.segmentStart.clientX).toBe(200);
  });

  test('uses the same threshold distance when reopening after rightward travel', () => {
    let state = createHeaderSwipeGestureState({ clientX: 200, clientY: 0 });
    state = update(state, 99);
    state = update(state, 131);
    expect(state.open).toBe(false);
    state = update(state, 130);

    expect(state.open).toBe(true);
    expect(state.segmentStart.clientX).toBe(200);
  });

  test('keeps the candidate unchanged for an off-axis segment', () => {
    let state = createHeaderSwipeGestureState({ clientX: 200, clientY: 0 });
    state = update(state, 99);
    state = update(state, 200);
    state = update(state, 99, 60);

    expect(state.open).toBe(false);
  });
});

describe('getHeaderSwipePresentationProgress', () => {
  test('tracks zero to open to zero to open during one continuous touch', () => {
    const startX = 200;
    const viewportWidth = 200;

    expect(getHeaderSwipePresentationProgress(startX, 200, viewportWidth)).toBe(0);
    expect(getHeaderSwipePresentationProgress(startX, 130, viewportWidth)).toBe(1);
    expect(getHeaderSwipePresentationProgress(startX, 200, viewportWidth)).toBe(0);
    expect(getHeaderSwipePresentationProgress(startX, 130, viewportWidth)).toBe(1);
  });
});

describe('getHeaderSwipeBackProgress', () => {
  test('tracks only left-to-right travel toward the back threshold', () => {
    const startX = 20;
    const viewportWidth = 200;

    expect(getHeaderSwipeBackProgress(startX, 20, viewportWidth)).toBe(0);
    expect(getHeaderSwipeBackProgress(startX, 55, viewportWidth)).toBe(0.5);
    expect(getHeaderSwipeBackProgress(startX, 90, viewportWidth)).toBe(1);
    expect(getHeaderSwipeBackProgress(startX, 0, viewportWidth)).toBe(0);
  });
});
