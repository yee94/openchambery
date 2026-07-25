import { describe, expect, test } from 'bun:test';

import { createAndroidKeyboardTransitionController } from './androidKeyboardTransition';

type RecordedEvent =
  | { type: 'anim'; phase: 'show' | 'hide'; slide: 0; durationMs: number; easing: string }
  | { type: 'settled'; open: boolean };

const createHarness = () => {
  const events: RecordedEvent[] = [];
  let nextTimer = 1;
  const timers = new Map<number, () => void>();
  const controller = createAndroidKeyboardTransitionController({
    onAnimation: (detail) => events.push({ type: 'anim', ...detail }),
    onSettled: (open) => events.push({ type: 'settled', open }),
    scheduler: {
      set: (callback) => {
        const timer = nextTimer++;
        timers.set(timer, callback);
        return timer;
      },
      clear: (handle) => timers.delete(handle as number),
    },
  });

  const runWatchdog = () => {
    const callbacks = [...timers.values()];
    timers.clear();
    callbacks.forEach((callback) => callback());
  };

  return { controller, events, timers, runWatchdog };
};

describe('Android keyboard transition controller', () => {
  test('willShow then didShow emits one animation and one settlement in order', () => {
    const { controller, events, runWatchdog } = createHarness();

    controller.willShow();
    controller.didShow();
    runWatchdog();

    expect(events).toEqual([
      {
        type: 'anim',
        phase: 'show',
        slide: 0,
        durationMs: 500,
        easing: 'cubic-bezier(0.38, 0.7, 0.125, 1)',
      },
      { type: 'settled', open: true },
    ]);
  });

  test('a stale didShow cannot settle an active hide transition', () => {
    const { controller, events } = createHarness();

    controller.willShow();
    controller.willHide();
    controller.didShow();
    controller.didHide();

    expect(events).toEqual([
      {
        type: 'anim',
        phase: 'show',
        slide: 0,
        durationMs: 500,
        easing: 'cubic-bezier(0.38, 0.7, 0.125, 1)',
      },
      {
        type: 'anim',
        phase: 'hide',
        slide: 0,
        durationMs: 500,
        easing: 'cubic-bezier(0.38, 0.7, 0.125, 1)',
      },
      { type: 'settled', open: false },
    ]);
  });

  test('watchdog settles a transition when its did event is missing', () => {
    const { controller, events, runWatchdog } = createHarness();

    controller.willShow();
    runWatchdog();

    expect(events).toEqual([
      {
        type: 'anim',
        phase: 'show',
        slide: 0,
        durationMs: 500,
        easing: 'cubic-bezier(0.38, 0.7, 0.125, 1)',
      },
      { type: 'settled', open: true },
    ]);
  });

  test('dispose clears the watchdog and suppresses later events', () => {
    const { controller, events, timers, runWatchdog } = createHarness();

    controller.willHide();
    expect(timers.size).toBe(1);
    controller.dispose();
    expect(timers.size).toBe(0);
    controller.didHide();
    runWatchdog();

    expect(events).toEqual([{
      type: 'anim',
      phase: 'hide',
      slide: 0,
      durationMs: 500,
      easing: 'cubic-bezier(0.38, 0.7, 0.125, 1)',
    }]);
  });
});
