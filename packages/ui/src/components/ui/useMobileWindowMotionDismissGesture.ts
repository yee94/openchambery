import React from 'react';
import {
  getMobileWindowMotionController,
  type MobileWindowMotionController,
} from './MobileWindowMotionRegistry';
import type { MobileWindowMotionEdge } from './MobileWindowMotionRecipe';

type MobileWindowMotionDismissEdge = MobileWindowMotionEdge;

export interface MobileWindowMotionDismissGestureConfig {
  disabled?: boolean;
  scrollContainerSelector?: string;
  reservedTargetSelector?: string;
  intentDistance?: number;
  maxOffAxisRatio?: number;
  commitDistanceRatio?: number;
  minCommitDistance?: number;
  maxCommitDistance?: number;
  flingVelocity?: number;
  flingMinDistance?: number;
}

interface MobileWindowMotionDismissGestureOptions extends MobileWindowMotionDismissGestureConfig {
  motionId: string;
  edge: MobileWindowMotionDismissEdge;
}

interface DismissGesture {
  edge: MobileWindowMotionDismissEdge;
  motionId: string;
  touchId: number;
  startX: number;
  startY: number;
  lastPrimary: number;
  lastTime: number;
  lastVelocityTime: number;
  velocity: number;
  distance: number;
  commitDistance: number;
  motionDistance: number;
  intentDistance: number;
  maxOffAxisRatio: number;
  flingVelocity: number;
  flingMinDistance: number;
  controller: MobileWindowMotionController | null;
  active: boolean;
}

const DEFAULT_SCROLL_CONTAINER_SELECTOR = '.overlay-scrollbar-container';
const SCROLL_EDGE_EPSILON = 1;

export const getMobileWindowMotionDismissAxis = (edge: MobileWindowMotionDismissEdge): 'x' | 'y' => (
  edge === 'left' || edge === 'right' ? 'x' : 'y'
);

export const getMobileWindowMotionDismissDirection = (edge: MobileWindowMotionDismissEdge): 1 | -1 => (
  edge === 'bottom' || edge === 'right' ? 1 : -1
);

export const getMobileWindowMotionDismissDistance = (
  edge: MobileWindowMotionDismissEdge,
  deltaX: number,
  deltaY: number,
): number => {
  const delta = getMobileWindowMotionDismissAxis(edge) === 'x' ? deltaX : deltaY;
  return Math.max(0, delta * getMobileWindowMotionDismissDirection(edge));
};

export const isMobileWindowMotionDismissIntent = (
  edge: MobileWindowMotionDismissEdge,
  deltaX: number,
  deltaY: number,
  intentDistance: number,
  maxOffAxisRatio: number,
): boolean => {
  const primary = getMobileWindowMotionDismissDistance(edge, deltaX, deltaY);
  const offAxis = Math.abs(getMobileWindowMotionDismissAxis(edge) === 'x' ? deltaY : deltaX);
  return Math.hypot(deltaX, deltaY) > intentDistance
    && primary > 0
    && offAxis < primary * maxOffAxisRatio;
};

export const getMobileWindowMotionDismissProgress = (distance: number, motionDistance: number): number => (
  Math.min(1, Math.max(0, distance / Math.max(1, motionDistance)))
);

export const getMobileWindowMotionDismissCommitDistance = (
  motionDistance: number,
  ratio: number,
  minDistance: number,
  maxDistance: number,
): number => Math.min(maxDistance, Math.max(minDistance, motionDistance * ratio));

export const shouldCommitMobileWindowMotionDismiss = (
  distance: number,
  velocity: number,
  commitDistance: number,
  flingVelocity: number,
  flingMinDistance: number,
): boolean => (
  distance >= commitDistance || (distance >= flingMinDistance && velocity >= flingVelocity)
);

export const getMobileWindowMotionDismissVelocity = (
  previousVelocity: number,
  primaryDelta: number,
  elapsed: number,
  idleDuration: number,
  direction: 1 | -1,
): number => {
  if (primaryDelta !== 0 && elapsed > 0) return primaryDelta * direction / elapsed;
  return idleDuration > 80 ? 0 : previousVelocity;
};

export const isMobileWindowMotionDismissScrollBoundary = (
  container: HTMLElement,
  edge: MobileWindowMotionDismissEdge,
  epsilon = SCROLL_EDGE_EPSILON,
): boolean => {
  if (edge === 'bottom') return container.scrollTop <= epsilon;
  if (edge === 'top') return container.scrollTop >= container.scrollHeight - container.clientHeight - epsilon;
  if (container.matches?.(':dir(rtl)')) {
    const maxScrollLeft = container.scrollWidth - container.clientWidth;
    if (edge === 'right') return Math.abs(container.scrollLeft) <= epsilon;
    return Math.abs(container.scrollLeft) >= maxScrollLeft - epsilon;
  }
  if (edge === 'right') return container.scrollLeft <= epsilon;
  return container.scrollLeft >= container.scrollWidth - container.clientWidth - epsilon;
};

const findTouch = (touches: TouchList, touchId: number): Touch | null => {
  for (let index = 0; index < touches.length; index += 1) {
    const touch = touches.item(index);
    if (touch?.identifier === touchId) return touch;
  }
  return null;
};

const isScrollableForDismissEdge = (element: HTMLElement, edge: MobileWindowMotionDismissEdge): boolean => {
  const style = window.getComputedStyle(element);
  const axis = getMobileWindowMotionDismissAxis(edge);
  const overflow = axis === 'x' ? style.overflowX : style.overflowY;
  const scrollSize = axis === 'x' ? element.scrollWidth : element.scrollHeight;
  const clientSize = axis === 'x' ? element.clientWidth : element.clientHeight;
  return (overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') && scrollSize > clientSize;
};

const findDismissScrollContainer = (
  wrapper: HTMLElement,
  target: EventTarget | null,
  edge: MobileWindowMotionDismissEdge,
  selector: string,
): HTMLElement | null => {
  const element = target instanceof Element ? target : null;
  let candidate = element instanceof HTMLElement ? element : element?.parentElement ?? null;
  while (candidate && wrapper.contains(candidate)) {
    if (isScrollableForDismissEdge(candidate, edge)) return candidate;
    if (candidate === wrapper) break;
    candidate = candidate.parentElement;
  }
  const selected = element?.closest<HTMLElement>(selector) ?? null;
  if (selected && wrapper.contains(selected) && isScrollableForDismissEdge(selected, edge)) return selected;
  return null;
};

export const useMobileWindowMotionDismissGesture = (
  options: MobileWindowMotionDismissGestureOptions,
): React.RefCallback<HTMLDivElement> => {
  const optionsRef = React.useRef(options);
  const cleanupRef = React.useRef<(() => void) | null>(null);
  const gestureRef = React.useRef<DismissGesture | null>(null);
  optionsRef.current = options;

  const wrapperRef = React.useCallback((wrapper: HTMLDivElement | null) => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    if (!wrapper) return;

    const cancelGesture = () => {
      const gesture = gestureRef.current;
      gestureRef.current = null;
      if (gesture?.active) gesture.controller?.finish('cancel');
    };
    const updateGesture = (gesture: DismissGesture, touch: Touch, timeStamp: number) => {
      const currentPrimary = getMobileWindowMotionDismissAxis(gesture.edge) === 'x'
        ? touch.clientX
        : touch.clientY;
      const elapsed = timeStamp - gesture.lastTime;
      const primaryDelta = currentPrimary - gesture.lastPrimary;
      gesture.velocity = getMobileWindowMotionDismissVelocity(
        gesture.velocity,
        primaryDelta,
        elapsed,
        timeStamp - gesture.lastVelocityTime,
        getMobileWindowMotionDismissDirection(gesture.edge),
      );
      if (primaryDelta !== 0 && elapsed > 0) gesture.lastVelocityTime = timeStamp;
      gesture.lastPrimary = currentPrimary;
      gesture.lastTime = timeStamp;
      gesture.distance = getMobileWindowMotionDismissDistance(
        gesture.edge,
        touch.clientX - gesture.startX,
        touch.clientY - gesture.startY,
      );
    };
    const onTouchStart = (event: TouchEvent) => {
      cancelGesture();
      const current = optionsRef.current;
      if (current.disabled || event.touches.length !== 1) return;
      const target = event.target instanceof Element ? event.target : null;
      const reservedTarget = current.reservedTargetSelector
        ? target?.closest(current.reservedTargetSelector)
        : null;
      if (reservedTarget && wrapper.contains(reservedTarget)) return;
      // Form fields live outside the list scroller (pinned search chrome). Arming
      // dismiss on them lets tiny finger jitter call preventDefault on touchmove
      // and steals focus/keyboard on Android WebView — the field looks dead.
      if (
        target?.closest(
          'input, textarea, select, [contenteditable=""], [contenteditable="true"], [data-mobile-sheet-no-dismiss]',
        )
      ) {
        return;
      }
      const touch = event.touches[0];
      const scrollContainer = findDismissScrollContainer(
        wrapper,
        event.target,
        current.edge,
        current.scrollContainerSelector ?? DEFAULT_SCROLL_CONTAINER_SELECTOR,
      );
      if (scrollContainer && !isMobileWindowMotionDismissScrollBoundary(scrollContainer, current.edge)) return;
      const rect = wrapper.getBoundingClientRect();
      const motionDistance = getMobileWindowMotionDismissAxis(current.edge) === 'x'
        ? rect.width || window.innerWidth
        : rect.height || window.innerHeight;
      gestureRef.current = {
        edge: current.edge,
        motionId: current.motionId,
        touchId: touch.identifier,
        startX: touch.clientX,
        startY: touch.clientY,
        lastPrimary: getMobileWindowMotionDismissAxis(current.edge) === 'x' ? touch.clientX : touch.clientY,
        lastTime: event.timeStamp,
        lastVelocityTime: event.timeStamp,
        velocity: 0,
        distance: 0,
        commitDistance: getMobileWindowMotionDismissCommitDistance(
          motionDistance,
          current.commitDistanceRatio ?? 0.1,
          current.minCommitDistance ?? 40,
          current.maxCommitDistance ?? 64,
        ),
        motionDistance,
        intentDistance: current.intentDistance ?? 8,
        maxOffAxisRatio: current.maxOffAxisRatio ?? 1,
        flingVelocity: current.flingVelocity ?? 0.65,
        flingMinDistance: current.flingMinDistance ?? 12,
        controller: null,
        active: false,
      };
    };
    const onTouchMove = (event: TouchEvent) => {
      const gesture = gestureRef.current;
      if (!gesture) return;
      if (optionsRef.current.disabled || event.touches.length !== 1) {
        cancelGesture();
        return;
      }
      const touch = findTouch(event.touches, gesture.touchId);
      if (!touch) {
        cancelGesture();
        return;
      }
      updateGesture(gesture, touch, event.timeStamp);
      if (!gesture.active) {
        if (Math.hypot(touch.clientX - gesture.startX, touch.clientY - gesture.startY)
          <= gesture.intentDistance) return;
        if (!isMobileWindowMotionDismissIntent(
          gesture.edge,
          touch.clientX - gesture.startX,
          touch.clientY - gesture.startY,
          gesture.intentDistance,
          gesture.maxOffAxisRatio,
        )) {
          gestureRef.current = null;
          return;
        }
        const controller = getMobileWindowMotionController(gesture.motionId);
        if (!controller) {
          gestureRef.current = null;
          return;
        }
        if (!controller.begin('dismiss')) {
          gestureRef.current = null;
          return;
        }
        gesture.active = true;
        gesture.controller = controller;
      }
      gesture.controller?.update(
        getMobileWindowMotionDismissProgress(gesture.distance, gesture.motionDistance),
      );
      event.preventDefault();
    };
    const onTouchEnd = (event: TouchEvent) => {
      const gesture = gestureRef.current;
      if (!gesture) return;
      const touch = findTouch(event.changedTouches, gesture.touchId);
      if (!touch) {
        cancelGesture();
        return;
      }
      gestureRef.current = null;
      if (!gesture.active) return;
      updateGesture(gesture, touch, event.timeStamp);
      gesture.controller?.update(
        getMobileWindowMotionDismissProgress(gesture.distance, gesture.motionDistance),
      );
      const commit = shouldCommitMobileWindowMotionDismiss(
        gesture.distance,
        gesture.velocity,
        gesture.commitDistance,
        gesture.flingVelocity,
        gesture.flingMinDistance,
      );
      gesture.controller?.finish(commit ? 'commit' : 'cancel');
      event.preventDefault();
    };
    const onTouchCancel = () => cancelGesture();

    wrapper.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
    wrapper.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
    wrapper.addEventListener('touchend', onTouchEnd, { passive: false, capture: true });
    wrapper.addEventListener('touchcancel', onTouchCancel, { passive: true, capture: true });
    cleanupRef.current = () => {
      cancelGesture();
      wrapper.removeEventListener('touchstart', onTouchStart, true);
      wrapper.removeEventListener('touchmove', onTouchMove, true);
      wrapper.removeEventListener('touchend', onTouchEnd, true);
      wrapper.removeEventListener('touchcancel', onTouchCancel, true);
    };
  }, []);

  return wrapperRef;
};
