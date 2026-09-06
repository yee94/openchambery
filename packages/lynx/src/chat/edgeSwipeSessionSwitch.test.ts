import { describe, expect, test } from 'vitest';

import {
  LYNX_EDGE_SWIPE_HOST_CONTRACT,
  LYNX_EDGE_SWIPE_MIN_DISTANCE,
  createLynxEdgeSwipeSessionSwitchMachine,
  evaluateLynxSwipeDirection,
  evaluateLynxSwipeProgress,
  evaluateLynxSwipeThresholdHaptic,
  resolveLynxSessionSwipeTargets,
  shouldStartLynxSessionSwipe,
  type LynxSwipeDirectionInput,
} from './edgeSwipeSessionSwitch';

const baseSwipe = (
  overrides: Partial<LynxSwipeDirectionInput> = {},
): LynxSwipeDirectionInput => ({
  startX: 200,
  startY: 300,
  endX: 200,
  endY: 300,
  ...overrides,
});

describe('shouldStartLynxSessionSwipe', () => {
  test('rejects transcript content outside the explicit Composer surface', () => {
    expect(shouldStartLynxSessionSwipe({
      onExplicitSurface: false,
      onCodeBlock: false,
      withinHorizontalScroller: false,
    })).toBe(false);
  });

  test('accepts the marked mobile Composer surface', () => {
    expect(shouldStartLynxSessionSwipe({
      onExplicitSurface: true,
      onCodeBlock: false,
      withinHorizontalScroller: false,
    })).toBe(true);
  });

  test('excludes code, scrollers, native back edge, and active composer', () => {
    expect(shouldStartLynxSessionSwipe({
      onExplicitSurface: true,
      onCodeBlock: true,
      withinHorizontalScroller: false,
    })).toBe(false);
    expect(shouldStartLynxSessionSwipe({
      onExplicitSurface: true,
      onCodeBlock: false,
      withinHorizontalScroller: true,
    })).toBe(false);
    expect(shouldStartLynxSessionSwipe({
      onExplicitSurface: true,
      onCodeBlock: false,
      withinHorizontalScroller: false,
      withinNativeBackEdge: true,
    })).toBe(false);
    expect(shouldStartLynxSessionSwipe({
      onExplicitSurface: true,
      onCodeBlock: false,
      withinHorizontalScroller: false,
      composerActive: true,
    })).toBe(false);
  });
});

describe('evaluateLynxSwipeDirection', () => {
  test('left swipe maps to next', () => {
    expect(evaluateLynxSwipeDirection(baseSwipe({ endX: 100, endY: 303 }))).toBe('next');
  });

  test('right swipe maps to previous', () => {
    expect(evaluateLynxSwipeDirection(baseSwipe({ endX: 300, endY: 303 }))).toBe('prev');
  });

  test('vertical gestures are ignored', () => {
    expect(evaluateLynxSwipeDirection(baseSwipe({ endX: 203, endY: 200 }))).toBe(null);
    expect(evaluateLynxSwipeDirection(baseSwipe({ endX: 203, endY: 400 }))).toBe(null);
  });

  test('below min distance is ignored', () => {
    expect(evaluateLynxSwipeDirection(baseSwipe({
      endX: 200 - (LYNX_EDGE_SWIPE_MIN_DISTANCE - 1),
      endY: 302,
    }))).toBe(null);
  });
});

describe('evaluateLynxSwipeProgress + threshold haptic', () => {
  test('progress reports commit fraction', () => {
    const progress = evaluateLynxSwipeProgress(
      baseSwipe({ endX: 200 - 32, endY: 302 }),
      { prev: true, next: true },
    );
    expect(progress?.direction).toBe('next');
    expect(progress?.progress).toBeCloseTo(0.5);
    expect(progress?.canSwitch).toBe(true);
  });

  test('threshold haptic enter/cancel with hysteresis', () => {
    expect(evaluateLynxSwipeThresholdHaptic({
      thresholdReached: false,
      distance: 64,
      enterDistance: 64,
      cancelDistance: 56,
      available: true,
    }).event).toBe('enter');
    expect(evaluateLynxSwipeThresholdHaptic({
      thresholdReached: true,
      distance: 50,
      enterDistance: 64,
      cancelDistance: 56,
      available: true,
    }).event).toBe('cancel');
  });
});

describe('session targets + state machine', () => {
  test('resolveLynxSessionSwipeTargets walks newest-first list', () => {
    expect(resolveLynxSessionSwipeTargets(['a', 'b', 'c'], 'b')).toEqual({
      currentId: 'b',
      prevId: 'a',
      nextId: 'c',
    });
  });

  test('machine commits switch only from composer surface with enough travel', () => {
    const machine = createLynxEdgeSwipeSessionSwitchMachine({
      resolveTargets: () => ({ currentId: 'b', prevId: 'a', nextId: 'c' }),
    });
    expect(machine.dispatch({
      type: 'pointerDown',
      x: 200,
      y: 400,
      start: {
        onExplicitSurface: false,
        onCodeBlock: false,
        withinHorizontalScroller: false,
      },
    })).toEqual([]);
    expect(machine.getState().tracking).toBe(false);

    machine.dispatch({
      type: 'pointerDown',
      x: 200,
      y: 400,
      start: {
        onExplicitSurface: true,
        onCodeBlock: false,
        withinHorizontalScroller: false,
      },
    });
    expect(machine.getState().tracking).toBe(true);

    const moveEffects = machine.dispatch({ type: 'pointerMove', x: 120, y: 402 });
    expect(moveEffects.some((e) => e.type === 'progress')).toBe(true);

    const upEffects = machine.dispatch({ type: 'pointerUp', x: 100, y: 402 });
    expect(upEffects).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'switch', direction: 'next', targetId: 'c' }),
    ]));
  });

  test('host contract documents composer-only + host-binds-pan', () => {
    expect(LYNX_EDGE_SWIPE_HOST_CONTRACT.surface).toBe('composer-only');
    expect(LYNX_EDGE_SWIPE_HOST_CONTRACT.ownership).toBe('host-binds-pan');
  });
});
