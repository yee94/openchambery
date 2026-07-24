import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';

import { evaluateSwipeThresholdHaptic, triggerMobileHaptic } from '@/hooks/streamingHaptics';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

/**
 * Horizontal touch-swipe gesture to switch sessions in the mobile chat.
 *
 * The listeners live on the chat container, but gesture starts are accepted
 * only from the explicitly marked mobile Composer surface:
 *
 * - Left  swipe → step +1 (next / older session)
 * - Right swipe → step -1 (previous / newer session)
 *
 * Vertical movement must stay within the off-axis tolerance.
 *
 * Code blocks and horizontally scrollable ancestors are excluded so the
 * gesture never fights horizontal scrolling.
 *
 * Navigation walks the same ranked list the rest of the mobile UI uses:
 * top-level sessions (no subtasks) across all projects, newest-first by
 * `time.updated`. The order is computed at gesture time from the store
 * (not subscribed) so it's always fresh and never re-attaches.
 *
 * The move listener becomes non-passive so confirmed Composer swipes in either
 * direction can suppress browser history navigation. Progress updates let the
 * caller render compositor-only feedback while the finger moves.
 */

const MIN_DISTANCE = 64; // px of dominant-axis travel required to commit a switch
const MAX_OFF_AXIS_RATIO = 0.6; // off-axis must stay below dominant-axis × this
const THRESHOLD_HYSTERESIS = 8;

// ---------------------------------------------------------------------------
// Interactive / scrollable exclusion helpers
// ---------------------------------------------------------------------------

const CODE_SELECTOR = '[class*="code-block"], [class*="codeBlock"], pre, .cm-editor';
const SESSION_SWIPE_SURFACE_SELECTOR = '[data-session-swipe-surface="true"]';

const isCodeBlock = (element: Element | null): boolean => {
  if (!element) return false;
  return element.matches(CODE_SELECTOR) || element.closest(CODE_SELECTOR) !== null;
};

const hasScrollableAncestorInDirection = (element: Element | null, horizontal: boolean): boolean => {
  let current: Element | null = element;
  while (current && current !== document.body && current !== document.documentElement) {
    const style = window.getComputedStyle(current);
    if (horizontal) {
      const overflowX = style.overflowX;
      if ((overflowX === 'auto' || overflowX === 'scroll') && current.scrollWidth > current.clientWidth) {
        return true;
      }
    } else {
      const overflowY = style.overflowY;
      if ((overflowY === 'auto' || overflowY === 'scroll') && current.scrollHeight > current.clientHeight) {
        return true;
      }
    }
    current = current.parentElement;
  }
  return false;
};

// ---------------------------------------------------------------------------
// Pure helpers — exported for targeted testing
// ---------------------------------------------------------------------------

export interface SwipeDirectionInput {
  /** touchstart clientX */
  startX: number;
  /** touchstart clientY */
  startY: number;
  /** touchend clientX */
  endX: number;
  /** touchend clientY */
  endY: number;
}

export type SwipeDirection = 'prev' | 'next' | null;

type SessionSwipeStartInput = {
  onExplicitSurface: boolean;
  onCodeBlock: boolean;
  withinHorizontalScroller: boolean;
};

/** Gesture ownership policy shared by the DOM hook and focused tests. */
export const shouldStartSessionSwipe = (input: SessionSwipeStartInput): boolean => {
  if (input.onCodeBlock || input.withinHorizontalScroller) return false;
  return input.onExplicitSurface;
};

export interface SwipeProgress {
  direction: Exclude<SwipeDirection, null>;
  /** Commit progress, clamped from 0 to 1. */
  progress: number;
  /** Raw horizontal finger travel in CSS pixels. */
  offsetX: number;
  /** Whether a session exists in this direction. */
  canSwitch: boolean;
}

/**
 * Pure function: determine swipe direction (prev / next) from raw touch
 * coordinates. Callers inject the gate flags; this function only evaluates
 * the geometric constraints — minimum distance, off-axis ratio, and
 * dominant-axis selection.
 */
export const evaluateSwipeDirection = (input: SwipeDirectionInput): SwipeDirection => {
  const dx = input.endX - input.startX;
  const dy = input.endY - input.startY;
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);

  if (absDx < MIN_DISTANCE) return null;
  if (absDy > absDx * MAX_OFF_AXIS_RATIO) return null;
  return dx < 0 ? 'next' : 'prev';
};

export const evaluateSwipeProgress = (
  input: Pick<SwipeDirectionInput, 'startX' | 'startY' | 'endX' | 'endY'>,
  available: { prev: boolean; next: boolean },
): SwipeProgress | null => {
  const dx = input.endX - input.startX;
  const dy = input.endY - input.startY;
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);

  if (absDx < 8 || absDy > absDx * MAX_OFF_AXIS_RATIO) return null;
  const direction = dx < 0 ? 'next' : 'prev';
  return {
    direction,
    progress: Math.min(absDx / MIN_DISTANCE, 1),
    offsetX: dx,
    canSwitch: available[direction],
  };
};

// ---------------------------------------------------------------------------
// Session navigation helpers
// ---------------------------------------------------------------------------

const parentIdOf = (session: Session): string | null =>
  (session as Session & { parentID?: string | null }).parentID ?? null;

const updatedAt = (session: Session): number => session.time?.updated ?? session.time?.created ?? 0;

/** Top-level sessions across all projects, newest-first — the list the swipe walks. */
const orderedTopLevelSessions = (): Session[] =>
  useGlobalSessionsStore
    .getState()
    .activeSessions.filter((session) => parentIdOf(session) === null)
    .slice()
    .sort((a, b) => updatedAt(b) - updatedAt(a));

type SessionSwipeTargets = {
  currentId: string | null;
  prevId: string | null;
  nextId: string | null;
};

const resolveSessionSwipeTargets = (): SessionSwipeTargets => {
  const ordered = orderedTopLevelSessions();
  const currentId = useSessionUIStore.getState().currentSessionId;
  const index = ordered.findIndex((session) => session.id === currentId);
  return {
    currentId,
    prevId: index > 0 ? ordered[index - 1].id : null,
    nextId: index >= 0 && index < ordered.length - 1 ? ordered[index + 1].id : null,
  };
};

const switchToSwipeTarget = (direction: 'prev' | 'next', targets: SessionSwipeTargets): boolean => {
  if (useSessionUIStore.getState().currentSessionId !== targets.currentId) return false;
  const targetId = direction === 'prev' ? targets.prevId : targets.nextId;
  if (!targetId) return false;
  const target = useGlobalSessionsStore.getState().activeSessions.find((session) => session.id === targetId);
  if (!target) return false;
  useSessionUIStore.getState().setCurrentSession(target.id, resolveGlobalSessionDirectory(target));
  return true;
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface EdgeSwipeSessionSwitchOptions {
  /** Called after a successful switch, with the travel direction, so the caller can animate. */
  onSwitch?: (direction: 'prev' | 'next') => void;
  /** Called during a qualifying swipe and with null when tracking ends. */
  onProgress?: (progress: SwipeProgress | null) => void;
}

export const useEdgeSwipeSessionSwitch = (
  ref: React.RefObject<HTMLElement | null>,
  options?: EdgeSwipeSessionSwitchOptions,
  /** Re-bind trigger: flip when the ref's element mounts after first render. */
  active?: unknown,
): void => {
  // Keep onSwitch in a ref so a changing callback identity doesn't re-attach the listeners.
  const onSwitchRef = React.useRef(options?.onSwitch);
  onSwitchRef.current = options?.onSwitch;
  const onProgressRef = React.useRef(options?.onProgress);
  onProgressRef.current = options?.onProgress;

  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;

    let tracking = false;
    let startX = 0;
    let startY = 0;
    let targets: SessionSwipeTargets = { currentId: null, prevId: null, nextId: null };
    let available = { prev: false, next: false };
    let thresholdReached = false;
    let thresholdHapticDelivered = false;
    let progressActive = false;
    let suppressNextClick = false;
    let clickResetTimer: number | null = null;

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        tracking = false;
        return;
      }
      const touch = event.touches[0];
      const target = document.elementFromPoint(touch.clientX, touch.clientY);
      if (!target || !shouldStartSessionSwipe({
        onExplicitSurface: target.closest(SESSION_SWIPE_SURFACE_SELECTOR) !== null,
        onCodeBlock: isCodeBlock(target),
        withinHorizontalScroller: hasScrollableAncestorInDirection(target, true),
      })) {
        tracking = false;
        return;
      }
      tracking = true;
      startX = touch.clientX;
      startY = touch.clientY;
      targets = resolveSessionSwipeTargets();
      available = { prev: targets.prevId !== null, next: targets.nextId !== null };
      thresholdReached = false;
      thresholdHapticDelivered = false;
      progressActive = false;
    };

    const onTouchMove = (event: TouchEvent) => {
      if (!tracking) return;
      if (event.touches.length !== 1) {
        tracking = false;
        if (thresholdReached) triggerMobileHaptic('light', { bypassCadence: true });
        thresholdReached = false;
        thresholdHapticDelivered = false;
        if (progressActive) onProgressRef.current?.(null);
        progressActive = false;
        return;
      }
      const touch = event.touches[0];
      const progress = evaluateSwipeProgress({
        startX,
        startY,
        endX: touch.clientX,
        endY: touch.clientY,
      }, available);

      if (!progress) {
        if (thresholdReached) {
          thresholdReached = false;
          triggerMobileHaptic('light', { bypassCadence: true });
          thresholdHapticDelivered = false;
        }
        if (progressActive) onProgressRef.current?.(null);
        progressActive = false;
        return;
      }

      // Once horizontal intent is authoritative, keep the gesture inside the
      // chat instead of allowing the browser/WebView to navigate history.
      if (event.cancelable) event.preventDefault();
      progressActive = true;
      onProgressRef.current?.(progress);
      const distance = Math.abs(progress.offsetX);
      const transition = evaluateSwipeThresholdHaptic({
        thresholdReached,
        distance,
        enterDistance: MIN_DISTANCE,
        cancelDistance: MIN_DISTANCE - THRESHOLD_HYSTERESIS,
        available: progress.canSwitch,
      });
      thresholdReached = transition.thresholdReached;
      if (transition.event === 'enter') thresholdHapticDelivered = triggerMobileHaptic('medium', { bypassCadence: true });
      if (transition.event === 'cancel') {
        triggerMobileHaptic('light', { bypassCadence: true });
        thresholdHapticDelivered = false;
      }
    };

    const onTouchEnd = (event: TouchEvent) => {
      if (!tracking) return;
      tracking = false;

      const touch = event.changedTouches[0];
      if (!touch) {
        if (thresholdReached) triggerMobileHaptic('light', { bypassCadence: true });
        thresholdReached = false;
        thresholdHapticDelivered = false;
        if (progressActive) onProgressRef.current?.(null);
        progressActive = false;
        return;
      }

      const target = document.elementFromPoint(touch.clientX, touch.clientY);
      if (hasScrollableAncestorInDirection(target, true)) {
        if (thresholdReached) triggerMobileHaptic('light', { bypassCadence: true });
        thresholdReached = false;
        thresholdHapticDelivered = false;
        if (progressActive) onProgressRef.current?.(null);
        progressActive = false;
        return;
      }

      const direction = evaluateSwipeDirection({
        startX,
        startY,
        endX: touch.clientX,
        endY: touch.clientY,
      });

      if (!direction) {
        if (thresholdReached) triggerMobileHaptic('light', { bypassCadence: true });
        thresholdReached = false;
        thresholdHapticDelivered = false;
        if (progressActive) onProgressRef.current?.(null);
        progressActive = false;
        return;
      }

      if (switchToSwipeTarget(direction, targets)) {
        if (!thresholdHapticDelivered) triggerMobileHaptic('medium', { bypassCadence: true });
        suppressNextClick = true;
        if (clickResetTimer !== null) window.clearTimeout(clickResetTimer);
        clickResetTimer = window.setTimeout(() => {
          suppressNextClick = false;
          clickResetTimer = null;
        }, 500);
        onSwitchRef.current?.(direction);
      } else if (thresholdReached) {
        triggerMobileHaptic('light', { bypassCadence: true });
      }
      thresholdReached = false;
      thresholdHapticDelivered = false;
      if (progressActive) onProgressRef.current?.(null);
      progressActive = false;
    };

    const onTouchCancel = () => {
      tracking = false;
      if (thresholdReached) triggerMobileHaptic('light', { bypassCadence: true });
      thresholdReached = false;
      thresholdHapticDelivered = false;
      if (progressActive) onProgressRef.current?.(null);
      progressActive = false;
    };

    const onClickCapture = (event: MouseEvent) => {
      if (!suppressNextClick) return;
      suppressNextClick = false;
      if (clickResetTimer !== null) {
        window.clearTimeout(clickResetTimer);
        clickResetTimer = null;
      }
      event.preventDefault();
      event.stopPropagation();
    };

    element.addEventListener('touchstart', onTouchStart, { passive: true });
    element.addEventListener('touchmove', onTouchMove, { passive: false });
    element.addEventListener('touchend', onTouchEnd, { passive: true });
    element.addEventListener('touchcancel', onTouchCancel, { passive: true });
    element.addEventListener('click', onClickCapture, true);
    return () => {
      if (clickResetTimer !== null) window.clearTimeout(clickResetTimer);
      element.removeEventListener('touchstart', onTouchStart);
      element.removeEventListener('touchmove', onTouchMove);
      element.removeEventListener('touchend', onTouchEnd);
      element.removeEventListener('touchcancel', onTouchCancel);
      element.removeEventListener('click', onClickCapture, true);
    };
    // `active` re-binds when the host element appears after first render (the
    // phone chat subtree mounts only when the secondary page opens).
  }, [ref, active]);
};
