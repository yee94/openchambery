/**
 * Cap `useEdgeSwipeSessionSwitch` semantics for Lynx.
 *
 * Gesture starts are accepted **only** from the explicitly marked Composer
 * surface (`data-session-swipe-surface="true"` spirit). Transcript content
 * never owns the session-switch pan.
 *
 * - Left  swipe → step +1 (next / older session)
 * - Right swipe → step -1 (previous / newer session)
 *
 * Lynx JS owns the pure geometry + state machine. The **host** (or Lynx native
 * gesture arena) binds the actual pan / touch stream and feeds events into
 * `createLynxEdgeSwipeSessionSwitchMachine`. Do not claim DOM touch listeners
 * work inside LynxView the same way Cap WebView did.
 *
 * Source: packages/ui/src/apps/useEdgeSwipeSessionSwitch.ts
 */

export const LYNX_EDGE_SWIPE_MIN_DISTANCE = 64;
export const LYNX_EDGE_SWIPE_MAX_OFF_AXIS_RATIO = 0.6;
export const LYNX_EDGE_SWIPE_THRESHOLD_HYSTERESIS = 8;
/** Native iOS owns touches that begin in its system back-gesture edge. */
export const LYNX_NATIVE_IOS_BACK_EDGE_WIDTH = 28;
export const LYNX_SESSION_SWIPE_SURFACE_ATTR = 'data-session-swipe-surface';

export type LynxSwipeDirection = 'prev' | 'next' | null;

export type LynxSwipeDirectionInput = {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
};

export type LynxSessionSwipeStartInput = {
  /** Touch began on the Composer surface marked for session swipe. */
  onExplicitSurface: boolean;
  onCodeBlock: boolean;
  withinHorizontalScroller: boolean;
  /** Native iOS owns the system back-gesture edge. */
  withinNativeBackEdge?: boolean;
  /** Textarea focused / silhouette expanded — typing surface, never a swipe. */
  composerActive?: boolean;
};

/** Gesture ownership policy shared by host binders and unit tests. */
export const shouldStartLynxSessionSwipe = (
  input: LynxSessionSwipeStartInput,
): boolean => {
  if (input.composerActive) return false;
  if (input.onCodeBlock || input.withinHorizontalScroller || input.withinNativeBackEdge) {
    return false;
  }
  return input.onExplicitSurface;
};

export const isLynxNativeIOSBackEdgeStart = (
  clientX: number,
  platform: 'ios' | 'android' | 'other' = 'ios',
): boolean => platform === 'ios' && clientX <= LYNX_NATIVE_IOS_BACK_EDGE_WIDTH;

export type LynxSwipeProgress = {
  direction: Exclude<LynxSwipeDirection, null>;
  /** Commit progress, clamped from 0 to 1. */
  progress: number;
  /** Raw horizontal finger travel in CSS pixels. */
  offsetX: number;
  /** Whether a session exists in this direction. */
  canSwitch: boolean;
};

export const evaluateLynxSwipeDirection = (
  input: LynxSwipeDirectionInput,
): LynxSwipeDirection => {
  const dx = input.endX - input.startX;
  const dy = input.endY - input.startY;
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);

  if (absDx < LYNX_EDGE_SWIPE_MIN_DISTANCE) return null;
  if (absDy > absDx * LYNX_EDGE_SWIPE_MAX_OFF_AXIS_RATIO) return null;
  return dx < 0 ? 'next' : 'prev';
};

export const evaluateLynxSwipeProgress = (
  input: Pick<LynxSwipeDirectionInput, 'startX' | 'startY' | 'endX' | 'endY'>,
  available: { prev: boolean; next: boolean },
): LynxSwipeProgress | null => {
  const dx = input.endX - input.startX;
  const dy = input.endY - input.startY;
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);

  if (absDx < 8 || absDy > absDx * LYNX_EDGE_SWIPE_MAX_OFF_AXIS_RATIO) return null;
  const direction = dx < 0 ? 'next' : 'prev';
  return {
    direction,
    progress: Math.min(absDx / LYNX_EDGE_SWIPE_MIN_DISTANCE, 1),
    offsetX: dx,
    canSwitch: available[direction],
  };
};

export type LynxSwipeThresholdHapticEvent = 'enter' | 'cancel' | null;

/** Cap `evaluateSwipeThresholdHaptic` — host fires haptics on enter/cancel. */
export const evaluateLynxSwipeThresholdHaptic = (input: {
  thresholdReached: boolean;
  distance: number;
  enterDistance: number;
  cancelDistance: number;
  available: boolean;
}): { thresholdReached: boolean; event: LynxSwipeThresholdHapticEvent } => {
  if (!input.thresholdReached && input.available && input.distance >= input.enterDistance) {
    return { thresholdReached: true, event: 'enter' };
  }
  if (input.thresholdReached && (!input.available || input.distance <= input.cancelDistance)) {
    return { thresholdReached: false, event: 'cancel' };
  }
  return { thresholdReached: input.thresholdReached, event: null };
};

export type LynxSessionSwipeTargets = {
  currentId: string | null;
  prevId: string | null;
  nextId: string | null;
};

/**
 * Resolve prev/next from a newest-first top-level session id list
 * (Cap `orderedTopLevelSessions` spirit — caller supplies the ordered ids).
 */
export const resolveLynxSessionSwipeTargets = (
  orderedTopLevelIds: readonly string[],
  currentId: string | null,
): LynxSessionSwipeTargets => {
  const index = currentId
    ? orderedTopLevelIds.findIndex((id) => id === currentId)
    : -1;
  return {
    currentId,
    prevId: index > 0 ? orderedTopLevelIds[index - 1]! : null,
    nextId: index >= 0 && index < orderedTopLevelIds.length - 1
      ? orderedTopLevelIds[index + 1]!
      : null,
  };
};

export type LynxEdgeSwipeMachineEvent =
  | {
      type: 'pointerDown';
      x: number;
      y: number;
      start: LynxSessionSwipeStartInput;
    }
  | { type: 'pointerMove'; x: number; y: number }
  | { type: 'pointerUp'; x: number; y: number }
  | { type: 'pointerCancel' };

export type LynxEdgeSwipeMachineEffect =
  | { type: 'progress'; progress: LynxSwipeProgress | null }
  | { type: 'haptic'; strength: 'light' | 'medium'; reason: 'enter' | 'cancel' | 'commit' }
  | { type: 'switch'; direction: 'prev' | 'next'; targetId: string }
  | { type: 'suppressClick' };

export type LynxEdgeSwipeMachineState = {
  tracking: boolean;
  startX: number;
  startY: number;
  targets: LynxSessionSwipeTargets;
  available: { prev: boolean; next: boolean };
  thresholdReached: boolean;
  thresholdHapticDelivered: boolean;
  progressActive: boolean;
};

export const createInitialLynxEdgeSwipeState = (): LynxEdgeSwipeMachineState => ({
  tracking: false,
  startX: 0,
  startY: 0,
  targets: { currentId: null, prevId: null, nextId: null },
  available: { prev: false, next: false },
  thresholdReached: false,
  thresholdHapticDelivered: false,
  progressActive: false,
});

export type LynxEdgeSwipeMachine = {
  getState: () => LynxEdgeSwipeMachineState;
  /**
   * Feed a host pan/touch event. Returns effects the host/JS shell should apply
   * (progress UI, haptics adapter, session navigation).
   */
  dispatch: (event: LynxEdgeSwipeMachineEvent) => LynxEdgeSwipeMachineEffect[];
};

export type LynxEdgeSwipeMachineOptions = {
  /** Newest-first top-level session ids at gesture start (Cap store snapshot). */
  resolveTargets: () => LynxSessionSwipeTargets;
};

/**
 * Pure state machine — host binds pan and calls `dispatch`.
 * Call sites: composer surface only (see `shouldStartLynxSessionSwipe`).
 */
export const createLynxEdgeSwipeSessionSwitchMachine = (
  options: LynxEdgeSwipeMachineOptions,
): LynxEdgeSwipeMachine => {
  let state = createInitialLynxEdgeSwipeState();

  const resetTracking = (
    effects: LynxEdgeSwipeMachineEffect[],
    hapticOnThreshold: boolean,
  ): void => {
    if (hapticOnThreshold && state.thresholdReached) {
      effects.push({ type: 'haptic', strength: 'light', reason: 'cancel' });
    }
    if (state.progressActive) {
      effects.push({ type: 'progress', progress: null });
    }
    state = {
      ...createInitialLynxEdgeSwipeState(),
      targets: state.targets,
      available: state.available,
    };
  };

  const dispatch = (event: LynxEdgeSwipeMachineEvent): LynxEdgeSwipeMachineEffect[] => {
    const effects: LynxEdgeSwipeMachineEffect[] = [];

    if (event.type === 'pointerDown') {
      if (!shouldStartLynxSessionSwipe(event.start)) {
        state = createInitialLynxEdgeSwipeState();
        return effects;
      }
      const targets = options.resolveTargets();
      state = {
        tracking: true,
        startX: event.x,
        startY: event.y,
        targets,
        available: { prev: targets.prevId !== null, next: targets.nextId !== null },
        thresholdReached: false,
        thresholdHapticDelivered: false,
        progressActive: false,
      };
      return effects;
    }

    if (!state.tracking) return effects;

    if (event.type === 'pointerCancel') {
      resetTracking(effects, true);
      return effects;
    }

    if (event.type === 'pointerMove') {
      const progress = evaluateLynxSwipeProgress({
        startX: state.startX,
        startY: state.startY,
        endX: event.x,
        endY: event.y,
      }, state.available);

      if (!progress) {
        if (state.thresholdReached) {
          state = { ...state, thresholdReached: false, thresholdHapticDelivered: false };
          effects.push({ type: 'haptic', strength: 'light', reason: 'cancel' });
        }
        if (state.progressActive) {
          state = { ...state, progressActive: false };
          effects.push({ type: 'progress', progress: null });
        }
        return effects;
      }

      state = { ...state, progressActive: true };
      effects.push({ type: 'progress', progress });

      const distance = Math.abs(progress.offsetX);
      const transition = evaluateLynxSwipeThresholdHaptic({
        thresholdReached: state.thresholdReached,
        distance,
        enterDistance: LYNX_EDGE_SWIPE_MIN_DISTANCE,
        cancelDistance: LYNX_EDGE_SWIPE_MIN_DISTANCE - LYNX_EDGE_SWIPE_THRESHOLD_HYSTERESIS,
        available: progress.canSwitch,
      });
      state = { ...state, thresholdReached: transition.thresholdReached };
      if (transition.event === 'enter') {
        state = { ...state, thresholdHapticDelivered: true };
        effects.push({ type: 'haptic', strength: 'medium', reason: 'enter' });
      }
      if (transition.event === 'cancel') {
        state = { ...state, thresholdHapticDelivered: false };
        effects.push({ type: 'haptic', strength: 'light', reason: 'cancel' });
      }
      return effects;
    }

    if (event.type === 'pointerUp') {
      const direction = evaluateLynxSwipeDirection({
        startX: state.startX,
        startY: state.startY,
        endX: event.x,
        endY: event.y,
      });
      const targets = state.targets;
      const thresholdReached = state.thresholdReached;
      const thresholdHapticDelivered = state.thresholdHapticDelivered;
      const progressActive = state.progressActive;

      state = createInitialLynxEdgeSwipeState();

      if (progressActive) effects.push({ type: 'progress', progress: null });

      if (!direction) {
        if (thresholdReached) {
          effects.push({ type: 'haptic', strength: 'light', reason: 'cancel' });
        }
        return effects;
      }

      const targetId = direction === 'prev' ? targets.prevId : targets.nextId;
      if (targetId) {
        if (!thresholdHapticDelivered) {
          effects.push({ type: 'haptic', strength: 'medium', reason: 'commit' });
        }
        effects.push({ type: 'suppressClick' });
        effects.push({ type: 'switch', direction, targetId });
      } else if (thresholdReached) {
        effects.push({ type: 'haptic', strength: 'light', reason: 'cancel' });
      }
      return effects;
    }

    return effects;
  };

  return {
    getState: () => state,
    dispatch,
  };
};

/**
 * Host binding contract (docs for native / Lynx gesture arena).
 * JS never claims WebView-style document touch listeners inside LynxView.
 */
export const LYNX_EDGE_SWIPE_HOST_CONTRACT = {
  surface: 'composer-only',
  surfaceAttr: LYNX_SESSION_SWIPE_SURFACE_ATTR,
  ownership: 'host-binds-pan',
  nativeBackEdgeWidth: LYNX_NATIVE_IOS_BACK_EDGE_WIDTH,
  minDistance: LYNX_EDGE_SWIPE_MIN_DISTANCE,
  notes: [
    'Accept starts only when shouldStartLynxSessionSwipe is true.',
    'Feed pointerDown/Move/Up/Cancel into createLynxEdgeSwipeSessionSwitchMachine.',
    'Apply haptic effects via host-injected LynxHapticsAdapter (no fake success).',
    'Apply switch effects by navigating to targetId in the shell session stack.',
  ],
} as const;
