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
 */

const MAX_OFF_AXIS_RATIO = 0.55; // |dy| must stay below |dx| × this
const INTENT_DISTANCE = 8;
const THRESHOLD_HYSTERESIS = 8;
const OPEN_DISTANCE_RATIO = 0.35;

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

/** Updates the opening candidate against the gesture's original touch point. */
export const updateHeaderSwipeGestureState = (
  state: HeaderSwipeGestureState,
  touch: HeaderSwipePoint,
  viewportWidth: number,
): HeaderSwipeGestureState => {
  const dx = touch.clientX - state.segmentStart.clientX;
  const dy = touch.clientY - state.segmentStart.clientY;
  const exceedsThreshold = Math.abs(dx) >= viewportWidth * OPEN_DISTANCE_RATIO;
  const staysOnAxis = Math.abs(dy) <= Math.abs(dx) * MAX_OFF_AXIS_RATIO;

  return {
    segmentStart: state.segmentStart,
    lastTouch: touch,
    open: exceedsThreshold && staysOnAxis && dx < 0,
  };
};

/**
 * Pure function: determine whether a completed touch gesture on the chat body
 * should open the sessions sheet. Callers inject the gate flags; this function
 * only evaluates the geometric and interactive constraints.
 */
export const evaluateHeaderSwipe = (input: HeaderSwipeInput): HeaderSwipeResult => {
  if (input.disabled) return { open: false, back: false };
  if (input.startedOnExcludedTarget) return { open: false, back: false };

  const dx = input.endX - input.startX;
  const dy = input.endY - input.startY;
  const exceedsThreshold = Math.abs(dx) >= input.viewportWidth * OPEN_DISTANCE_RATIO;
  const staysOnAxis = Math.abs(dy) <= Math.abs(dx) * MAX_OFF_AXIS_RATIO;

  return {
    open: exceedsThreshold && staysOnAxis && dx < 0,
    back: exceedsThreshold && staysOnAxis && dx > 0,
  };
};

export const getHeaderSwipePresentationProgress = (
  startX: number,
  currentX: number,
  viewportWidth: number,
): number => Math.min(
  Math.max(0, startX - currentX) / Math.max(1, viewportWidth * OPEN_DISTANCE_RATIO),
  1,
);

export const getHeaderSwipeBackProgress = (
  startX: number,
  currentX: number,
  viewportWidth: number,
): number => Math.min(
  Math.max(0, currentX - startX) / Math.max(1, viewportWidth * OPEN_DISTANCE_RATIO),
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
      const enterThreshold = viewportWidth * OPEN_DISTANCE_RATIO;
      const transition = evaluateSwipeThresholdHaptic({
        thresholdReached,
        distance,
        enterDistance: enterThreshold,
        cancelDistance: enterThreshold - THRESHOLD_HYSTERESIS,
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
      latestDistance = Math.abs(dx);
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
      if (touch) gestureState = updateHeaderSwipeGestureState(gestureState, touch, viewportWidth);
      const result = evaluateHeaderSwipe({
        startX: gestureState.segmentStart.clientX,
        startY: gestureState.segmentStart.clientY,
        endX: gestureState.lastTouch.clientX,
        endY: gestureState.lastTouch.clientY,
        viewportWidth,
        disabled: false,
        startedOnExcludedTarget: false,
      });
      const commit = horizontalIntent === 'sessions' ? result.open : result.back;
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
