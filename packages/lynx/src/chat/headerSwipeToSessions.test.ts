import { describe, expect, test } from 'vitest';

import {
  LYNX_HEADER_SWIPE_HOST_CONTRACT,
  createLynxHeaderSwipeGestureState,
  createLynxHeaderSwipeToSessionsMachine,
  evaluateLynxHeaderSwipe,
  getLynxHeaderSwipeBackProgress,
  getLynxHeaderSwipePresentationProgress,
  isLynxHeaderSwipeSelectionExcluded,
  shouldStartLynxHeaderSwipe,
  updateLynxHeaderSwipeGestureState,
  type LynxHeaderSwipeInput,
  type LynxHeaderSwipeSelectionProbe,
} from './headerSwipeToSessions';

const base = (
  overrides: Partial<LynxHeaderSwipeInput> = {},
): LynxHeaderSwipeInput => ({
  startX: 200,
  startY: 30,
  endX: 100,
  endY: 35,
  viewportWidth: 180,
  disabled: false,
  startedOnExcludedTarget: false,
  ...overrides,
});

describe('evaluateLynxHeaderSwipe', () => {
  test('opens on clean horizontal right-to-left swipe', () => {
    expect(evaluateLynxHeaderSwipe(base())).toEqual({ open: true, back: false });
  });

  test('maps a qualifying left-to-right swipe to secondary-page back', () => {
    expect(evaluateLynxHeaderSwipe(base({ startX: 100, endX: 200 }))).toEqual({
      open: false,
      back: true,
    });
    expect(evaluateLynxHeaderSwipe(base({ startX: 100, endX: 110 }))).toEqual({
      open: false,
      back: false,
    });
  });

  test('rejects stationary touch', () => {
    expect(evaluateLynxHeaderSwipe(base({ startX: 200, endX: 200 })).open).toBe(false);
  });

  test('rejects swipe below the open threshold', () => {
    expect(evaluateLynxHeaderSwipe(base({
      startX: 200,
      endX: 138,
      viewportWidth: 180,
    })).open).toBe(false);
  });

  test('accepts swipe exactly at the open threshold', () => {
    expect(evaluateLynxHeaderSwipe(base({
      startX: 200,
      endX: 137,
      viewportWidth: 180,
    })).open).toBe(true);
  });

  test('rejects primarily vertical swipe', () => {
    expect(evaluateLynxHeaderSwipe(base({
      startX: 200,
      startY: 200,
      endX: 100,
      endY: 0,
    })).open).toBe(false);
  });

  test('rejects diagonal beyond the off-axis tolerance', () => {
    expect(evaluateLynxHeaderSwipe(base({
      startX: 200,
      startY: 100,
      endX: 100,
      endY: 10,
    })).open).toBe(false);
  });

  test('accepts arced diagonal within off-axis tolerance', () => {
    expect(evaluateLynxHeaderSwipe(base({
      startX: 200,
      startY: 100,
      endX: 100,
      endY: 30,
    })).open).toBe(true);
  });

  test('rejects when disabled or started on excluded target', () => {
    expect(evaluateLynxHeaderSwipe(base({ disabled: true }))).toEqual({
      open: false,
      back: false,
    });
    expect(evaluateLynxHeaderSwipe(base({ startedOnExcludedTarget: true }))).toEqual({
      open: false,
      back: false,
    });
  });
});

describe('updateLynxHeaderSwipeGestureState', () => {
  const viewportWidth = 200;
  const update = (
    state: ReturnType<typeof createLynxHeaderSwipeGestureState>,
    clientX: number,
    clientY = 0,
  ) => updateLynxHeaderSwipeGestureState(state, { clientX, clientY }, viewportWidth);

  test('arms, cancels on retreat, and reopens only past open threshold', () => {
    let state = createLynxHeaderSwipeGestureState({ clientX: 200, clientY: 0 });
    state = update(state, 99);
    expect(state.open).toBe(true);
    state = update(state, 157);
    expect(state.open).toBe(false);
    state = update(state, 156);
    expect(state.open).toBe(false);
    state = update(state, 130);
    expect(state.open).toBe(true);
  });

  test('keeps an armed candidate through mild off-axis arc', () => {
    let state = createLynxHeaderSwipeGestureState({ clientX: 200, clientY: 0 });
    state = update(state, 99);
    expect(state.open).toBe(true);
    state = update(state, 99, 70);
    expect(state.open).toBe(true);
  });

  test('does not arm on a first pass that is too off-axis', () => {
    let state = createLynxHeaderSwipeGestureState({ clientX: 200, clientY: 0 });
    state = update(state, 99, 95);
    expect(state.open).toBe(false);
  });
});

describe('progress helpers', () => {
  test('presentation progress tracks leftward travel', () => {
    expect(getLynxHeaderSwipePresentationProgress(200, 200, 200)).toBe(0);
    expect(getLynxHeaderSwipePresentationProgress(200, 130, 200)).toBe(1);
  });

  test('back progress tracks rightward travel', () => {
    expect(getLynxHeaderSwipeBackProgress(20, 20, 200)).toBe(0);
    expect(getLynxHeaderSwipeBackProgress(20, 55, 200)).toBe(0.5);
    expect(getLynxHeaderSwipeBackProgress(20, 90, 200)).toBe(1);
  });
});

describe('shouldStartLynxHeaderSwipe + selection exclusion', () => {
  test('excludes composer, horizontal scroller, selection, and disabled', () => {
    expect(shouldStartLynxHeaderSwipe({
      onComposerSurface: false,
      withinHorizontalScroller: false,
      textSelectionOwnsTouch: false,
      disabled: false,
    })).toBe(true);
    expect(shouldStartLynxHeaderSwipe({
      onComposerSurface: true,
      withinHorizontalScroller: false,
      textSelectionOwnsTouch: false,
      disabled: false,
    })).toBe(false);
    expect(shouldStartLynxHeaderSwipe({
      onComposerSurface: false,
      withinHorizontalScroller: true,
      textSelectionOwnsTouch: false,
      disabled: false,
    })).toBe(false);
    expect(shouldStartLynxHeaderSwipe({
      onComposerSurface: false,
      withinHorizontalScroller: false,
      textSelectionOwnsTouch: true,
      disabled: false,
    })).toBe(false);
    expect(shouldStartLynxHeaderSwipe({
      onComposerSurface: false,
      withinHorizontalScroller: false,
      textSelectionOwnsTouch: false,
      disabled: true,
    })).toBe(false);
  });

  test('isLynxHeaderSwipeSelectionExcluded matches Cap spirit', () => {
    const child = { nodeType: 1, parentElement: null as unknown };
    const contained = new Set<unknown>([child]);
    const rootContains = (node: unknown) => contained.has(node);
    const selection = (anchorNode: LynxHeaderSwipeSelectionProbe['anchorNode']): LynxHeaderSwipeSelectionProbe => ({
      rangeCount: 1,
      isCollapsed: false,
      anchorNode,
    });

    expect(isLynxHeaderSwipeSelectionExcluded(null, rootContains)).toBe(false);
    expect(isLynxHeaderSwipeSelectionExcluded({
      rangeCount: 1,
      isCollapsed: true,
      anchorNode: child,
    }, rootContains)).toBe(false);
    expect(isLynxHeaderSwipeSelectionExcluded(selection(child), rootContains)).toBe(true);
    expect(isLynxHeaderSwipeSelectionExcluded(selection(child), null)).toBe(true);
    const outside = { nodeType: 3, parentElement: { nodeType: 1 } };
    expect(isLynxHeaderSwipeSelectionExcluded(selection(outside), rootContains)).toBe(false);
  });
});

describe('createLynxHeaderSwipeToSessionsMachine', () => {
  const startOk = {
    onComposerSurface: false,
    withinHorizontalScroller: false,
    textSelectionOwnsTouch: false,
    disabled: false,
  };

  test('commits open on RTL travel past open threshold', () => {
    const machine = createLynxHeaderSwipeToSessionsMachine();
    expect(machine.dispatch({
      type: 'pointerDown',
      x: 200,
      y: 40,
      viewportWidth: 200,
      start: { ...startOk, onComposerSurface: true },
    })).toEqual([]);
    expect(machine.getState().tracking).toBe(false);

    machine.dispatch({
      type: 'pointerDown',
      x: 200,
      y: 40,
      viewportWidth: 200,
      start: startOk,
    });
    expect(machine.getState().tracking).toBe(true);

    const move = machine.dispatch({ type: 'pointerMove', x: 120, y: 42 });
    expect(move.some((e) => e.type === 'previewStart')).toBe(true);
    expect(move.some((e) => e.type === 'progress')).toBe(true);

    const up = machine.dispatch({ type: 'pointerUp', x: 100, y: 42 });
    expect(up).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'open' }),
    ]));
  });

  test('commits back on LTR when allowBack', () => {
    const machine = createLynxHeaderSwipeToSessionsMachine();
    machine.dispatch({
      type: 'pointerDown',
      x: 40,
      y: 40,
      viewportWidth: 200,
      start: startOk,
      allowBack: true,
    });
    machine.dispatch({ type: 'pointerMove', x: 120, y: 42 });
    const up = machine.dispatch({ type: 'pointerUp', x: 130, y: 42 });
    expect(up).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'back' }),
    ]));
  });

  test('host contract documents chat-body + host-binds-pan', () => {
    expect(LYNX_HEADER_SWIPE_HOST_CONTRACT.surface).toBe('chat-body');
    expect(LYNX_HEADER_SWIPE_HOST_CONTRACT.ownership).toBe('host-binds-pan');
  });
});
