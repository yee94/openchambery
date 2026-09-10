/**
 * Cap `useHeaderSwipeToSessions` semantics for Lynx.
 *
 * Horizontal RTL swipe across ~1/3 viewport opens the sessions sheet.
 * Opposite LTR swipe can back out of phone secondary chat via the caller's
 * existing `onBack`.
 *
 * Lynx JS owns the pure geometry + state machine. The **host** (or Lynx native
 * gesture arena) binds the actual pan / touch stream and feeds events into
 * `createLynxHeaderSwipeToSessionsMachine`. Do not claim DOM touch listeners
 * work inside LynxView the same way Cap WebView did — same honesty as edge-swipe.
 *
 * Source: packages/ui/src/apps/useHeaderSwipeToSessions.ts
 */

export const LYNX_HEADER_SWIPE_MAX_OFF_AXIS_RATIO = 0.85;
export const LYNX_HEADER_SWIPE_INTENT_DISTANCE = 8;
export const LYNX_HEADER_SWIPE_OPEN_DISTANCE_RATIO = 0.35;
/** After arming, retreat below this fraction of the viewport to cancel. */
export const LYNX_HEADER_SWIPE_CANCEL_DISTANCE_RATIO = 0.22;
export const LYNX_HEADER_SWIPE_THRESHOLD_HYSTERESIS = 8;

// ---------------------------------------------------------------------------
// Pure helpers — exported for targeted testing
// ---------------------------------------------------------------------------

export type LynxHeaderSwipeInput = {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  viewportWidth: number;
  /** Inactive chat body or overlay already open. */
  disabled: boolean;
  /** Touch began on composer / horizontal scroller (host-reported). */
  startedOnExcludedTarget: boolean;
};

export type LynxHeaderSwipeResult = {
  open: boolean;
  back: boolean;
};

export type LynxHeaderSwipePoint = {
  clientX: number;
  clientY: number;
};

export type LynxHeaderSwipeGestureState = {
  segmentStart: LynxHeaderSwipePoint;
  lastTouch: LynxHeaderSwipePoint;
  open: boolean;
};

export const createLynxHeaderSwipeGestureState = (
  touch: LynxHeaderSwipePoint,
): LynxHeaderSwipeGestureState => ({
  segmentStart: touch,
  lastTouch: touch,
  open: false,
});

export const getLynxHeaderSwipeOpenDistance = (viewportWidth: number): number => (
  viewportWidth * LYNX_HEADER_SWIPE_OPEN_DISTANCE_RATIO
);

export const getLynxHeaderSwipeCancelDistance = (viewportWidth: number): number => (
  viewportWidth * LYNX_HEADER_SWIPE_CANCEL_DISTANCE_RATIO
);

export const getLynxHeaderSwipeLeftwardDistance = (
  startX: number,
  currentX: number,
): number => Math.max(0, startX - currentX);

export const getLynxHeaderSwipeRightwardDistance = (
  startX: number,
  currentX: number,
): number => Math.max(0, currentX - startX);

export const isLynxHeaderSwipeOnAxis = (dx: number, dy: number): boolean => {
  const absDx = Math.abs(dx);
  if (absDx < LYNX_HEADER_SWIPE_INTENT_DISTANCE) return true;
  return Math.abs(dy) <= absDx * LYNX_HEADER_SWIPE_MAX_OFF_AXIS_RATIO;
};

/**
 * Sticky open candidate for continuous tracking.
 * Arm only on a clean enough leftward pass of the open threshold; once armed,
 * stay armed until leftward travel drops below the cancel threshold (hysteresis).
 * Off-axis drift after arming does not cancel — only retreating does.
 */
export const updateLynxHeaderSwipeGestureState = (
  state: LynxHeaderSwipeGestureState,
  touch: LynxHeaderSwipePoint,
  viewportWidth: number,
): LynxHeaderSwipeGestureState => {
  const dx = touch.clientX - state.segmentStart.clientX;
  const dy = touch.clientY - state.segmentStart.clientY;
  const leftward = getLynxHeaderSwipeLeftwardDistance(
    state.segmentStart.clientX,
    touch.clientX,
  );
  const openDistance = getLynxHeaderSwipeOpenDistance(viewportWidth);
  const cancelDistance = getLynxHeaderSwipeCancelDistance(viewportWidth);

  let open = state.open;
  if (leftward <= 0) {
    open = false;
  } else if (state.open) {
    open = leftward >= cancelDistance;
  } else {
    open = leftward >= openDistance && isLynxHeaderSwipeOnAxis(dx, dy);
  }

  return {
    segmentStart: state.segmentStart,
    lastTouch: touch,
    open,
  };
};

/**
 * Stateless evaluation uses the open threshold only (no prior arming). Live
 * tracking uses updateLynxHeaderSwipeGestureState for cancel hysteresis.
 */
export const evaluateLynxHeaderSwipe = (
  input: LynxHeaderSwipeInput,
): LynxHeaderSwipeResult => {
  if (input.disabled) return { open: false, back: false };
  if (input.startedOnExcludedTarget) return { open: false, back: false };

  const dx = input.endX - input.startX;
  const dy = input.endY - input.startY;
  const leftward = getLynxHeaderSwipeLeftwardDistance(input.startX, input.endX);
  const rightward = getLynxHeaderSwipeRightwardDistance(input.startX, input.endX);
  const openDistance = getLynxHeaderSwipeOpenDistance(input.viewportWidth);
  const onAxis = isLynxHeaderSwipeOnAxis(dx, dy);

  return {
    open: leftward >= openDistance && onAxis,
    back: rightward >= openDistance && onAxis,
  };
};

export const getLynxHeaderSwipePresentationProgress = (
  startX: number,
  currentX: number,
  viewportWidth: number,
): number => Math.min(
  getLynxHeaderSwipeLeftwardDistance(startX, currentX)
    / Math.max(1, getLynxHeaderSwipeOpenDistance(viewportWidth)),
  1,
);

export const getLynxHeaderSwipeBackProgress = (
  startX: number,
  currentX: number,
  viewportWidth: number,
): number => Math.min(
  getLynxHeaderSwipeRightwardDistance(startX, currentX)
    / Math.max(1, getLynxHeaderSwipeOpenDistance(viewportWidth)),
  1,
);

/** Structural selection probe — unit-testable without a DOM. */
export type LynxHeaderSwipeSelectionProbe = {
  rangeCount: number;
  isCollapsed: boolean;
  anchorNode: {
    nodeType: number;
    parentElement: unknown;
  } | null;
};

const ELEMENT_NODE_TYPE = 1;

/**
 * Whether an expanded text selection anchored inside the gesture host should
 * own the touch instead of the swipe.
 */
export const isLynxHeaderSwipeSelectionExcluded = (
  selection: LynxHeaderSwipeSelectionProbe | null,
  rootContains: ((node: unknown) => boolean) | null,
): boolean => {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
  if (!rootContains) return true;
  const node = selection.anchorNode;
  if (!node) return false;
  const element = node.nodeType === ELEMENT_NODE_TYPE
    ? node
    : node.parentElement;
  return Boolean(element && rootContains(element));
};

/**
 * Host-reported start exclusion (composer / horizontal scroll / selection).
 * Pure so LynxView does not need DOM `closest` / `getComputedStyle`.
 */
export type LynxHeaderSwipeStartInput = {
  onComposerSurface: boolean;
  withinHorizontalScroller: boolean;
  textSelectionOwnsTouch: boolean;
  /** Overlay already open / inactive chat body / missing open handler. */
  disabled: boolean;
};

export const shouldStartLynxHeaderSwipe = (
  input: LynxHeaderSwipeStartInput,
): boolean => {
  if (input.disabled) return false;
  if (input.onComposerSurface) return false;
  if (input.withinHorizontalScroller) return false;
  if (input.textSelectionOwnsTouch) return false;
  return true;
};

// ---------------------------------------------------------------------------
// Host-fed state machine (same honesty as edge-swipe)
// ---------------------------------------------------------------------------

export type LynxHeaderSwipeIntent = 'sessions' | 'back' | null;

export type LynxHeaderSwipeMachineEvent =
  | {
      type: 'pointerDown';
      x: number;
      y: number;
      viewportWidth: number;
      start: LynxHeaderSwipeStartInput;
      /** When false, LTR never arms back (e.g. no onBack / root chat). */
      allowBack?: boolean;
    }
  | { type: 'pointerMove'; x: number; y: number }
  | { type: 'pointerUp'; x: number; y: number }
  | { type: 'pointerCancel' };

export type LynxHeaderSwipeMachineEffect =
  | { type: 'progress'; kind: 'sessions' | 'back'; progress: number }
  | { type: 'progressClear' }
  | { type: 'previewStart' }
  | { type: 'haptic'; strength: 'light' | 'medium'; reason: 'enter' | 'cancel' | 'commit' }
  | { type: 'open' }
  | { type: 'back' }
  | { type: 'suppressClick' };

export type LynxHeaderSwipeMachineState = {
  tracking: boolean;
  viewportWidth: number;
  allowBack: boolean;
  gesture: LynxHeaderSwipeGestureState | null;
  intent: LynxHeaderSwipeIntent;
  previewStarted: boolean;
  thresholdReached: boolean;
  thresholdHapticDelivered: boolean;
};

export const createInitialLynxHeaderSwipeState = (): LynxHeaderSwipeMachineState => ({
  tracking: false,
  viewportWidth: 0,
  allowBack: true,
  gesture: null,
  intent: null,
  previewStarted: false,
  thresholdReached: false,
  thresholdHapticDelivered: false,
});

export type LynxHeaderSwipeMachine = {
  getState: () => LynxHeaderSwipeMachineState;
  dispatch: (event: LynxHeaderSwipeMachineEvent) => LynxHeaderSwipeMachineEffect[];
};

export type LynxHeaderSwipeMachineOptions = {
  /** Optional host haptic threshold enter distance override (defaults to open distance). */
  enterDistanceFor?: (viewportWidth: number) => number;
};

const directionalDistance = (
  intent: Exclude<LynxHeaderSwipeIntent, null>,
  startX: number,
  currentX: number,
): number => (
  intent === 'sessions'
    ? getLynxHeaderSwipeLeftwardDistance(startX, currentX)
    : getLynxHeaderSwipeRightwardDistance(startX, currentX)
);

/**
 * Pure state machine — host binds pan and calls `dispatch`.
 * Call sites: chat body (not composer); exclusions via start flags.
 */
export const createLynxHeaderSwipeToSessionsMachine = (
  _options: LynxHeaderSwipeMachineOptions = {},
): LynxHeaderSwipeMachine => {
  let state = createInitialLynxHeaderSwipeState();

  const clearProgress = (effects: LynxHeaderSwipeMachineEffect[]): void => {
    if (state.intent !== null || state.previewStarted) {
      effects.push({ type: 'progressClear' });
    }
  };

  const reset = (
    effects: LynxHeaderSwipeMachineEffect[],
    hapticOnThreshold: boolean,
  ): void => {
    if (hapticOnThreshold && state.thresholdReached) {
      effects.push({ type: 'haptic', strength: 'light', reason: 'cancel' });
    }
    clearProgress(effects);
    state = createInitialLynxHeaderSwipeState();
  };

  const dispatch = (event: LynxHeaderSwipeMachineEvent): LynxHeaderSwipeMachineEffect[] => {
    const effects: LynxHeaderSwipeMachineEffect[] = [];

    if (event.type === 'pointerDown') {
      if (!shouldStartLynxHeaderSwipe(event.start)) {
        state = createInitialLynxHeaderSwipeState();
        return effects;
      }
      const touch = { clientX: event.x, clientY: event.y };
      state = {
        tracking: true,
        viewportWidth: Math.max(1, event.viewportWidth),
        allowBack: event.allowBack !== false,
        gesture: createLynxHeaderSwipeGestureState(touch),
        intent: null,
        previewStarted: false,
        thresholdReached: false,
        thresholdHapticDelivered: false,
      };
      return effects;
    }

    if (!state.tracking || !state.gesture) return effects;

    if (event.type === 'pointerCancel') {
      reset(effects, true);
      return effects;
    }

    if (event.type === 'pointerMove') {
      const touch = { clientX: event.x, clientY: event.y };
      const prior = state.gesture;
      let gesture = updateLynxHeaderSwipeGestureState(
        prior,
        touch,
        state.viewportWidth,
      );
      const dx = touch.clientX - gesture.segmentStart.clientX;
      const dy = touch.clientY - gesture.segmentStart.clientY;
      let intent = state.intent;
      let previewStarted = state.previewStarted;

      if (intent === null) {
        const absDx = Math.abs(dx);
        if (absDx < LYNX_HEADER_SWIPE_INTENT_DISTANCE) {
          state = { ...state, gesture };
          return effects;
        }
        if (Math.abs(dy) > absDx * LYNX_HEADER_SWIPE_MAX_OFF_AXIS_RATIO) {
          state = { ...state, gesture };
          return effects;
        }
        if (dx < 0) {
          intent = 'sessions';
          previewStarted = true;
          effects.push({ type: 'previewStart' });
        } else if (state.allowBack) {
          intent = 'back';
        } else {
          state = { ...state, gesture };
          return effects;
        }
      }

      const distance = directionalDistance(
        intent,
        gesture.segmentStart.clientX,
        touch.clientX,
      );
      const enterDistance = getLynxHeaderSwipeOpenDistance(state.viewportWidth);
      const cancelDistance = enterDistance - LYNX_HEADER_SWIPE_THRESHOLD_HYSTERESIS;
      let thresholdReached = state.thresholdReached;
      let thresholdHapticDelivered = state.thresholdHapticDelivered;

      if (!thresholdReached && distance >= enterDistance) {
        thresholdReached = true;
        thresholdHapticDelivered = true;
        effects.push({ type: 'haptic', strength: 'medium', reason: 'enter' });
      } else if (thresholdReached && distance <= cancelDistance) {
        thresholdReached = false;
        thresholdHapticDelivered = false;
        effects.push({ type: 'haptic', strength: 'light', reason: 'cancel' });
      }

      const progress = intent === 'sessions'
        ? getLynxHeaderSwipePresentationProgress(
          gesture.segmentStart.clientX,
          touch.clientX,
          state.viewportWidth,
        )
        : getLynxHeaderSwipeBackProgress(
          gesture.segmentStart.clientX,
          touch.clientX,
          state.viewportWidth,
        );
      effects.push({ type: 'progress', kind: intent, progress });

      state = {
        ...state,
        gesture,
        intent,
        previewStarted,
        thresholdReached,
        thresholdHapticDelivered,
      };
      return effects;
    }

    if (event.type === 'pointerUp') {
      const gesture = state.gesture;
      const intent = state.intent;
      const thresholdReached = state.thresholdReached;
      const thresholdHapticDelivered = state.thresholdHapticDelivered;
      const viewportWidth = state.viewportWidth;
      const touch = { clientX: event.x, clientY: event.y };
      const updated = updateLynxHeaderSwipeGestureState(gesture, touch, viewportWidth);

      state = createInitialLynxHeaderSwipeState();
      effects.push({ type: 'progressClear' });

      if (!intent) {
        return effects;
      }

      const commit = intent === 'sessions'
        ? updated.open
        : evaluateLynxHeaderSwipe({
          startX: updated.segmentStart.clientX,
          startY: updated.segmentStart.clientY,
          endX: updated.lastTouch.clientX,
          endY: updated.lastTouch.clientY,
          viewportWidth,
          disabled: false,
          startedOnExcludedTarget: false,
        }).back;

      if (commit && !thresholdHapticDelivered) {
        effects.push({ type: 'haptic', strength: 'medium', reason: 'commit' });
      }
      if (commit) {
        effects.push({ type: 'suppressClick' });
        effects.push(intent === 'sessions' ? { type: 'open' } : { type: 'back' });
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
export const LYNX_HEADER_SWIPE_HOST_CONTRACT = {
  surface: 'chat-body',
  ownership: 'host-binds-pan',
  openDistanceRatio: LYNX_HEADER_SWIPE_OPEN_DISTANCE_RATIO,
  cancelDistanceRatio: LYNX_HEADER_SWIPE_CANCEL_DISTANCE_RATIO,
  maxOffAxisRatio: LYNX_HEADER_SWIPE_MAX_OFF_AXIS_RATIO,
  notes: [
    'Accept starts only when shouldStartLynxHeaderSwipe is true.',
    'Exclude composer surface, horizontal scrollers, and expanded text selection.',
    'Disable while overlays (sessions sheet, settings, files, menu) are open.',
    'Feed pointerDown/Move/Up/Cancel into createLynxHeaderSwipeToSessionsMachine.',
    'Apply open → onOpenSessionsSheet; back → shell onBack; haptics via host adapter.',
    'Do not claim native pan success without a host binder — same honesty as edge-swipe.',
  ],
} as const;
