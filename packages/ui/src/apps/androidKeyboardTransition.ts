type AndroidKeyboardTransitionPhase = 'show' | 'hide';

interface AndroidKeyboardAnimationDetail {
  phase: AndroidKeyboardTransitionPhase;
  slide: 0;
  durationMs: number;
  easing: string;
}

interface AndroidKeyboardTransitionScheduler {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

interface AndroidKeyboardTransitionOptions {
  onAnimation(detail: AndroidKeyboardAnimationDetail): void;
  onSettled(open: boolean): void;
  scheduler?: AndroidKeyboardTransitionScheduler;
  watchdogMs?: number;
}

interface AndroidKeyboardTransitionController {
  willShow(): void;
  didShow(): void;
  willHide(): void;
  didHide(): void;
  dispose(): void;
}

const ANDROID_KEYBOARD_ANIMATION_MS = 500;
const ANDROID_KEYBOARD_ANIMATION_EASING = 'cubic-bezier(0.38, 0.7, 0.125, 1)';
const ANDROID_KEYBOARD_WATCHDOG_MS = 1500;

const defaultScheduler: AndroidKeyboardTransitionScheduler = {
  set: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clear: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createAndroidKeyboardTransitionController({
  onAnimation,
  onSettled,
  scheduler = defaultScheduler,
  watchdogMs = ANDROID_KEYBOARD_WATCHDOG_MS,
}: AndroidKeyboardTransitionOptions): AndroidKeyboardTransitionController {
  let activePhase: AndroidKeyboardTransitionPhase | null = null;
  let watchdog: unknown = null;
  let disposed = false;

  const clearWatchdog = () => {
    if (watchdog === null) return;
    scheduler.clear(watchdog);
    watchdog = null;
  };

  const settle = (phase: AndroidKeyboardTransitionPhase) => {
    if (disposed || activePhase !== phase) return;
    clearWatchdog();
    activePhase = null;
    onSettled(phase === 'show');
  };

  const begin = (phase: AndroidKeyboardTransitionPhase) => {
    if (disposed) return;
    clearWatchdog();
    activePhase = phase;
    onAnimation({
      phase,
      slide: 0,
      durationMs: ANDROID_KEYBOARD_ANIMATION_MS,
      easing: ANDROID_KEYBOARD_ANIMATION_EASING,
    });
    watchdog = scheduler.set(() => settle(phase), watchdogMs);
  };

  return {
    willShow: () => begin('show'),
    didShow: () => settle('show'),
    willHide: () => begin('hide'),
    didHide: () => settle('hide'),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      activePhase = null;
      clearWatchdog();
    },
  };
}
