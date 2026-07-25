import React from 'react';

import { evaluateSwipeThresholdHaptic, triggerMobileHaptic } from '@/hooks/streamingHaptics';

/**
 * Mobile chat-body horizontal navigation gesture.
 *
 * A horizontal right-to-left swipe across roughly one third of the viewport
 * opens the session panel. On phone, the opposite direction returns from the
 * current secondary chat page through the caller's existing back handler.
 *
 * - The caller gates whether a Session chat body is currently active.
 * - Disabled when any overlay (sessions sheet, settings, files, etc.) is
 *   already open so the gesture doesn't stack sheets or compete with
 *   overlay dismiss gestures.
 * - Tappable content remains a click candidate until horizontal intent wins.
 * - The listener runs in capture phase so nested tools cannot interrupt an
 *   already-recognized swipe.
 * - Composer surfaces and horizontally-scrollable ancestors are excluded so
 *   the gesture stays separate from session switching and horizontal scrolling.
 * - Once a leftward open candidate is armed, cancel only by retreating past the
 *   lower cancel threshold — mild off-axis arcs do not drop an armed candidate.
 */

const MAX_OFF_AXIS_RATIO = 0.85; // |dy| must stay below |dx| × this when arming
const INTENT_DISTANCE = 8;
const OPEN_DISTANCE_RATIO = 0.35;
/** After arming, retreat below this fraction of the viewport to cancel. */
const CANCEL_DISTANCE_RATIO = 0.22;

// ---------------------------------------------------------------------------
// Pure helpers — exported for targeted testing
// ---------------------------------------------------------------------------

export interface HeaderSwipeInput {
  /** touchstart clientX */
  startX: number;
  /** touchstart clientY */
  startY: number;
  /** touchend clientX */
  endX: number;
  /** touchend clientY */
  endY: number;
  /** current viewport width in CSS pixels */
  viewportWidth: number;
  /** whether the gesture is disabled (inactive chat body or overlay open) */
  disabled: boolean;
  /** whether the touch started on the composer or a horizontally-scrollable target */
  startedOnExcludedTarget: boolean;
}

interface HeaderSwipeResult {
  /** Whether the gesture should trigger opening the sessions sheet */
  open: boolean;
  /** Whether the gesture should trigger phone secondary-page back navigation */
  back: boolean;
}

interface HeaderSwipePoint {
  clientX: number;
  clientY: number;
}

interface HeaderSwipeGestureState {
  segmentStart: HeaderSwipePoint;
  lastTouch: HeaderSwipePoint;
  open: boolean;
}

export const createHeaderSwipeGestureState = (
  touch: HeaderSwipePoint,
): HeaderSwipeGestureState => ({
  segmentStart: touch,
  lastTouch: touch,
  open: false,
});

const getHeaderSwipeOpenDistance = (viewportWidth: number): number => (
  viewportWidth * OPEN_DISTANCE_RATIO
);

const getHeaderSwipeCancelDistance = (viewportWidth: number): number => (
  viewportWidth * CANCEL_DISTANCE_RATIO
);

const getHeaderSwipeLeftwardDistance = (startX: number, currentX: number): number => (
  Math.max(0, startX - currentX)
);

const getHeaderSwipeRightwardDistance = (startX: number, currentX: number): number => (
  Math.max(0, currentX - startX)
);

const isHeaderSwipeOnAxis = (dx: number, dy: number): boolean => {
  const absDx = Math.abs(dx);
  if (absDx < INTENT_DISTANCE) return true;
  return Math.abs(dy) <= absDx * MAX_OFF_AXIS_RATIO;
};

/**
 * Sticky open candidate for continuous tracking.
 * Arm only on a clean enough leftward pass of the open threshold; once armed,
 * stay armed until leftward travel drops below the cancel threshold (hysteresis).
 * Off-axis drift after arming does not cancel — only retreating does.
 */
export const updateHeaderSwipeGestureState = (
  state: HeaderSwipeGestureState,
  touch: HeaderSwipePoint,
  viewportWidth: number,
): HeaderSwipeGestureState => {
  const dx = touch.clientX - state.segmentStart.clientX;
  const dy = touch.clientY - state.segmentStart.clientY;
  const leftward = getHeaderSwipeLeftwardDistance(state.segmentStart.clientX, touch.clientX);
  const openDistance = getHeaderSwipeOpenDistance(viewportWidth);
  const cancelDistance = getHeaderSwipeCancelDistance(viewportWidth);

  let open = state.open;
  if (leftward <= 0) {
    open = false;
  } else if (state.open) {
    open = leftward >= cancelDistance;
  } else {
    open = leftward >= openDistance && isHeaderSwipeOnAxis(dx, dy);
  }

  return {
    segmentStart: state.segmentStart,
    lastTouch: touch,
    open,
  };
};

/**
 * Pure function: determine whether a completed touch gesture on the chat body
 * should open the sessions sheet. Callers inject the gate flags; this function
 * only evaluates the geometric and interactive constraints.
 *
 * Stateless evaluation uses the open threshold only (no prior arming). Live
 * tracking uses updateHeaderSwipeGestureState for cancel hysteresis.
 */
export const evaluateHeaderSwipe = (input: HeaderSwipeInput): HeaderSwipeResult => {
  if (input.disabled) return { open: false, back: false };
  if (input.startedOnExcludedTarget) return { open: false, back: false };

  const dx = input.endX - input.startX;
  const dy = input.endY - input.startY;
  const leftward = getHeaderSwipeLeftwardDistance(input.startX, input.endX);
  const rightward = getHeaderSwipeRightwardDistance(input.startX, input.endX);
  const openDistance = getHeaderSwipeOpenDistance(input.viewportWidth);
  const onAxis = isHeaderSwipeOnAxis(dx, dy);

  return {
    open: leftward >= openDistance && onAxis,
    back: rightward >= openDistance && onAxis,
  };
};

export const getHeaderSwipePresentationProgress = (
  startX: number,
  currentX: number,
  viewportWidth: number,
): number => Math.min(
  getHeaderSwipeLeftwardDistance(startX, currentX) / Math.max(1, getHeaderSwipeOpenDistance(viewportWidth)),
  1,
);

export const getHeaderSwipeBackProgress = (
  startX: number,
  currentX: number,
  viewportWidth: number,
): number => Math.min(
  getHeaderSwipeRightwardDistance(startX, currentX) / Math.max(1, getHeaderSwipeOpenDistance(viewportWidth)),
  1,
);

// ---------------------------------------------------------------------------
// Interactive / scrollable exclusion helpers
// ---------------------------------------------------------------------------

const hasHorizontallyScrollableAncestor = (element: Element | null): boolean => {
  let current: Element | null = element;
  while (current && current !== document.body && current !== document.documentElement) {
    const style = window.getComputedStyle(current);
    const overflowX = style.overflowX;
    if (overflowX === 'auto' || overflowX === 'scroll') {
      if (current.scrollWidth > current.clientWidth) return true;
    }
    current = current.parentElement;
  }
  return false;
};

const isExcludedTarget = (touch: Touch): boolean => {
  const element = document.elementFromPoint(touch.clientX, touch.clientY);
  return Boolean(element?.closest('[data-session-swipe-surface="true"]'))
    || hasHorizontallyScrollableAncestor(element);
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

interface HeaderSwipeToSessionsOptions {
  /** Called when a qualifying swipe is detected. */
  onOpen: () => void;
  /** Mounts the sessions surface when horizontal intent is first recognized. */
  onPreviewStart?: () => void;
  /** Closes a mounted preview when the gesture is cancelled. */
  onPreviewCancel?: () => void;
  /** Drives the mounted sessions surface while the finger moves. */
  onProgress?: (progress: number | null) => void;
  /** Returns from the phone's current secondary chat page. */
  onBack?: () => void;
  /** Drives phone secondary-page feedback during a back swipe. */
  onBackProgress?: (progress: number | null) => void;
  /** Whether the gesture is currently disabled (inactive chat body or overlay open). */
  disabled: boolean;
}

export const useHeaderSwipeToSessions = (
  ref: React.RefObject<HTMLElement | null>,
  options: HeaderSwipeToSessionsOptions,
  /** Re-bind trigger for the phone chat body, which mounts after navigation. */
  active?: unknown,
): void => {
  const onOpenRef = React.useRef(options.onOpen);
  onOpenRef.current = options.onOpen;
  const onPreviewStartRef = React.useRef(options.onPreviewStart);
  onPreviewStartRef.current = options.onPreviewStart;
  const onPreviewCancelRef = React.useRef(options.onPreviewCancel);
  onPreviewCancelRef.current = options.onPreviewCancel;
  const onProgressRef = React.useRef(options.onProgress);
  onProgressRef.current = options.onProgress;
  const onBackRef = React.useRef(options.onBack);
  onBackRef.current = options.onBack;
  const onBackProgressRef = React.useRef(options.onBackProgress);
  onBackProgressRef.current = options.onBackProgress;
  const disabledRef = React.useRef(options.disabled);
  disabledRef.current = options.disabled;

  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;

    let tracking = false;
    let startedOnExcludedTarget = false;
    let horizontalIntent: 'sessions' | 'back' | null = null;
    let previewStarted = false;
    let thresholdReached = false;
    let thresholdHapticDelivered = false;
    let latestDistance = 0;
    let viewportWidth = 0;
    let gestureState: HeaderSwipeGestureState | null = null;

    const updateThreshold = (distance: number) => {
      const enterThreshold = getHeaderSwipeOpenDistance(viewportWidth);
      const transition = evaluateSwipeThresholdHaptic({
        thresholdReached,
        distance,
        enterDistance: enterThreshold,
        cancelDistance: getHeaderSwipeCancelDistance(viewportWidth),
        available: true,
      });
      thresholdReached = transition.thresholdReached;
      if (transition.event === 'enter') thresholdHapticDelivered = triggerMobileHaptic('medium', { bypassCadence: true });
      if (transition.event === 'cancel') {
        triggerMobileHaptic('light', { bypassCadence: true });
        thresholdHapticDelivered = false;
      }
    };

    const finishPreview = (commit: boolean) => {
      onProgressRef.current?.(null);
      if (thresholdReached && !commit) triggerMobileHaptic('light', { bypassCadence: true });
      thresholdReached = false;
      thresholdHapticDelivered = false;
      if (commit) {
        onOpenRef.current();
      } else if (previewStarted) {
        onPreviewCancelRef.current?.();
      }
      previewStarted = false;
    };

    const finishBack = (commit: boolean) => {
      onBackProgressRef.current?.(null);
      if (thresholdReached && !commit) triggerMobileHaptic('light', { bypassCadence: true });
      thresholdReached = false;
      thresholdHapticDelivered = false;
      if (commit) onBackRef.current?.();
    };

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        tracking = false;
        gestureState = null;
        return;
      }
      if (disabledRef.current) {
        tracking = false;
        gestureState = null;
        return;
      }

      const touch = event.touches[0];
      tracking = true;
      viewportWidth = window.innerWidth;
      startedOnExcludedTarget = isExcludedTarget(touch);
      horizontalIntent = null;
      previewStarted = false;
      thresholdReached = false;
      thresholdHapticDelivered = false;
      latestDistance = 0;
      gestureState = createHeaderSwipeGestureState(touch);
    };

    const onTouchMove = (event: TouchEvent) => {
      if (!tracking || startedOnExcludedTarget || !gestureState) return;
      if (event.touches.length !== 1) {
        if (horizontalIntent === 'sessions') finishPreview(false);
        if (horizontalIntent === 'back') finishBack(false);
        tracking = false;
        gestureState = null;
        return;
      }
      const touch = event.touches[0];
      gestureState = updateHeaderSwipeGestureState(gestureState, touch, viewportWidth);
      const dx = touch.clientX - gestureState.segmentStart.clientX;
      const dy = touch.clientY - gestureState.segmentStart.clientY;

      if (horizontalIntent === null) {
        const absDx = Math.abs(dx);
        if (absDx < INTENT_DISTANCE) return;
        if (Math.abs(dy) > absDx * MAX_OFF_AXIS_RATIO) return;
        if (dx < 0) {
          horizontalIntent = 'sessions';
          previewStarted = true;
          onPreviewStartRef.current?.();
        } else if (onBackRef.current) {
          horizontalIntent = 'back';
        } else {
          return;
        }
      }

      event.preventDefault();
      // Directional distance only: retreating past the origin must not keep the
      // opposite-direction magnitude from holding the armed threshold open.
      latestDistance = horizontalIntent === 'sessions'
        ? getHeaderSwipeLeftwardDistance(gestureState.segmentStart.clientX, touch.clientX)
        : getHeaderSwipeRightwardDistance(gestureState.segmentStart.clientX, touch.clientX);
      updateThreshold(latestDistance);
      if (horizontalIntent === 'sessions') {
        onProgressRef.current?.(getHeaderSwipePresentationProgress(
          gestureState.segmentStart.clientX,
          touch.clientX,
          viewportWidth,
        ));
      } else {
        onBackProgressRef.current?.(getHeaderSwipeBackProgress(
          gestureState.segmentStart.clientX,
          touch.clientX,
          viewportWidth,
        ));
      }
    };

    const onTouchEnd = (event: TouchEvent) => {
      if (!tracking || !gestureState) return;
      tracking = false;
      const touch = event.changedTouches[0];
      if (touch) {
        gestureState = updateHeaderSwipeGestureState(gestureState, touch, viewportWidth);
        latestDistance = horizontalIntent === 'sessions'
          ? getHeaderSwipeLeftwardDistance(gestureState.segmentStart.clientX, touch.clientX)
          : getHeaderSwipeRightwardDistance(gestureState.segmentStart.clientX, touch.clientX);
        updateThreshold(latestDistance);
      }
      // Sessions open uses sticky hysteresis from continuous tracking. Back still
      // uses a one-shot evaluation because it has no preview arming state.
      const commit = horizontalIntent === 'sessions'
        ? gestureState.open
        : evaluateHeaderSwipe({
          startX: gestureState.segmentStart.clientX,
          startY: gestureState.segmentStart.clientY,
          endX: gestureState.lastTouch.clientX,
          endY: gestureState.lastTouch.clientY,
          viewportWidth,
          disabled: false,
          startedOnExcludedTarget: false,
        }).back;
      gestureState = null;
      if (!horizontalIntent) return;
      event.preventDefault();
      if (commit && !thresholdHapticDelivered) triggerMobileHaptic('medium', { bypassCadence: true });
      if (horizontalIntent === 'sessions') finishPreview(commit);
      else finishBack(commit);
    };

    const onTouchCancel = () => {
      if (horizontalIntent === 'sessions') finishPreview(false);
      if (horizontalIntent === 'back') finishBack(false);
      tracking = false;
      gestureState = null;
    };

    element.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
    element.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
    element.addEventListener('touchend', onTouchEnd, { passive: false, capture: true });
    element.addEventListener('touchcancel', onTouchCancel, { passive: true, capture: true });
    return () => {
      if (previewStarted) finishPreview(false);
      if (horizontalIntent === 'back') finishBack(false);
      element.removeEventListener('touchstart', onTouchStart, true);
      element.removeEventListener('touchmove', onTouchMove, true);
      element.removeEventListener('touchend', onTouchEnd, true);
      element.removeEventListener('touchcancel', onTouchCancel, true);
    };
    // `active` re-binds after the phone secondary chat page mounts.
  }, [ref, active]);
};
