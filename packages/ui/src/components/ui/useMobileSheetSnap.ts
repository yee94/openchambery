import React from 'react';

import { getNearestMobileWindowMotionSnapPoint } from './MobileWindowMotionRecipe';

export const MOBILE_SHEET_COLLAPSED_SNAP = 0.72;
export const MOBILE_SHEET_EXPANDED_SNAP = 0.98;
const MOBILE_SHEET_SNAP_POINTS = [MOBILE_SHEET_COLLAPSED_SNAP, MOBILE_SHEET_EXPANDED_SNAP] as const;
const MOBILE_SHEET_SNAP_DURATION_MS = 180;
const MOBILE_SHEET_SNAP_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)';
const DEFAULT_DISMISS_THRESHOLD_PX = 64;

type MobileSheetSnapPoint = typeof MOBILE_SHEET_SNAP_POINTS[number];

type MobileSheetDrag = {
  pointerId: number;
  startY: number;
  startHeight: number;
  startSnapPoint: MobileSheetSnapPoint;
  viewportHeight: number;
};

const getMobileViewportHeight = (): number => Math.max(1, window.innerHeight);

export const shouldDismissMobileSheetSnap = (
  height: number,
  viewportHeight: number,
  dismissThresholdPx = DEFAULT_DISMISS_THRESHOLD_PX,
  collapsedHeight?: number | null,
): boolean => height <= getMobileSheetCollapsedHeight(viewportHeight, collapsedHeight) - dismissThresholdPx;

export const clampMobileSheetSnapDragHeight = (
  height: number,
  viewportHeight: number,
  canDismiss: boolean,
): number => Math.min(
  viewportHeight * MOBILE_SHEET_EXPANDED_SNAP,
  Math.max(canDismiss ? 0 : viewportHeight * MOBILE_SHEET_COLLAPSED_SNAP, height),
);

type MobileSheetSnapOptions = {
  initialSnapPoint?: MobileSheetSnapPoint;
  fitContent?: boolean;
  onDismiss?: () => void;
  dismissThresholdPx?: number;
};

export const getMobileSheetCollapsedHeight = (
  viewportHeight: number,
  contentHeight?: number | null,
): number => {
  const maximumHeight = Math.max(1, viewportHeight) * MOBILE_SHEET_COLLAPSED_SNAP;
  if (contentHeight === null || contentHeight === undefined || !Number.isFinite(contentHeight)) {
    return maximumHeight;
  }
  return Math.min(maximumHeight, Math.max(0, contentHeight));
};

export const getNearestMobileSheetSnapPoint = (
  height: number,
  viewportHeight: number,
  collapsedHeight?: number | null,
): MobileSheetSnapPoint => {
  const resolvedCollapsedHeight = getMobileSheetCollapsedHeight(viewportHeight, collapsedHeight);
  const expandedHeight = Math.max(1, viewportHeight) * MOBILE_SHEET_EXPANDED_SNAP;
  return Math.abs(height - resolvedCollapsedHeight) <= Math.abs(height - expandedHeight)
    ? MOBILE_SHEET_COLLAPSED_SNAP
    : MOBILE_SHEET_EXPANDED_SNAP;
};

export const useMobileSheetSnap = ({
  initialSnapPoint = MOBILE_SHEET_COLLAPSED_SNAP,
  fitContent = false,
  onDismiss,
  dismissThresholdPx = DEFAULT_DISMISS_THRESHOLD_PX,
}: MobileSheetSnapOptions = {}) => {
  const surfaceRef = React.useRef<HTMLDivElement | null>(null);
  const dragRef = React.useRef<MobileSheetDrag | null>(null);
  const frameRef = React.useRef<number | null>(null);
  const pendingHeightRef = React.useRef<number | null>(null);
  const heightAnimationRef = React.useRef<Animation | null>(null);
  const collapsedHeightRef = React.useRef<number | null>(null);
  const draggedRef = React.useRef(false);
  const [snapPoint, setSnapPoint] = React.useState<MobileSheetSnapPoint>(initialSnapPoint);
  const snapPointRef = React.useRef<MobileSheetSnapPoint>(initialSnapPoint);
  const onDismissRef = React.useRef(onDismiss);
  onDismissRef.current = onDismiss;

  const cancelFrame = React.useCallback(() => {
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  }, []);

  const settleAt = React.useCallback((target: MobileSheetSnapPoint, fromHeight?: number) => {
    const surface = surfaceRef.current;
    const previousSnapPoint = snapPointRef.current;
    snapPointRef.current = target;
    setSnapPoint(target);
    cancelFrame();
    pendingHeightRef.current = null;
    heightAnimationRef.current?.cancel();
    heightAnimationRef.current = null;
    if (!surface) return;

    const startHeight = fromHeight ?? surface.getBoundingClientRect().height;
    if (
      fitContent
      && previousSnapPoint === MOBILE_SHEET_COLLAPSED_SNAP
      && collapsedHeightRef.current === null
    ) {
      collapsedHeightRef.current = getMobileSheetCollapsedHeight(getMobileViewportHeight(), startHeight);
    }
    const targetHeight = target === MOBILE_SHEET_COLLAPSED_SNAP
      ? getMobileSheetCollapsedHeight(
        getMobileViewportHeight(),
        fitContent ? collapsedHeightRef.current : undefined,
      )
      : getMobileViewportHeight() * MOBILE_SHEET_EXPANDED_SNAP;
    surface.style.height = '';
    surface.style.willChange = '';
    if (
      Math.abs(startHeight - targetHeight) < 1
      || typeof surface.animate !== 'function'
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      return;
    }

    const animation = surface.animate(
      [{ height: `${startHeight}px` }, { height: `${targetHeight}px` }],
      { duration: MOBILE_SHEET_SNAP_DURATION_MS, easing: MOBILE_SHEET_SNAP_EASING, fill: 'both' },
    );
    heightAnimationRef.current = animation;
    void animation.finished.catch(() => undefined).then(() => {
      if (heightAnimationRef.current !== animation) return;
      heightAnimationRef.current = null;
      animation.cancel();
    });
  }, [cancelFrame, fitContent]);

  const handlePointerDown = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const surface = surfaceRef.current;
    if (!surface) return;
    const startHeight = surface.getBoundingClientRect().height;
    if (fitContent && snapPointRef.current === MOBILE_SHEET_COLLAPSED_SNAP) {
      collapsedHeightRef.current = getMobileSheetCollapsedHeight(getMobileViewportHeight(), startHeight);
    }
    heightAnimationRef.current?.cancel();
    heightAnimationRef.current = null;
    surface.style.height = `${startHeight}px`;
    surface.style.willChange = 'height';
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight,
      startSnapPoint: snapPointRef.current,
      viewportHeight: getMobileViewportHeight(),
    };
    draggedRef.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }, [fitContent]);

  const handlePointerMove = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const surface = surfaceRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !surface) return;
    const delta = drag.startY - event.clientY;
    if (Math.abs(delta) > 3) draggedRef.current = true;
    pendingHeightRef.current = clampMobileSheetSnapDragHeight(
      drag.startHeight + delta,
      drag.viewportHeight,
      Boolean(onDismissRef.current),
    );
    if (frameRef.current === null) {
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
        if (surfaceRef.current && pendingHeightRef.current !== null) {
          surfaceRef.current.style.height = `${pendingHeightRef.current}px`;
        }
      });
    }
    event.preventDefault();
  }, []);

  const finishPointerDrag = React.useCallback((event: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const drag = dragRef.current;
    const surface = surfaceRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !surface) return;
    dragRef.current = null;
    cancelFrame();
    const currentHeight = pendingHeightRef.current ?? surface.getBoundingClientRect().height;
    pendingHeightRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (
      !cancelled
      && onDismissRef.current
      && shouldDismissMobileSheetSnap(
        currentHeight,
        drag.viewportHeight,
        dismissThresholdPx,
        fitContent ? collapsedHeightRef.current : undefined,
      )
    ) {
      surface.style.willChange = '';
      onDismissRef.current();
      event.preventDefault();
      return;
    }
    const target = cancelled
      ? drag.startSnapPoint
      : fitContent
        ? getNearestMobileSheetSnapPoint(currentHeight, drag.viewportHeight, collapsedHeightRef.current)
        : getNearestMobileWindowMotionSnapPoint(currentHeight, drag.viewportHeight, MOBILE_SHEET_SNAP_POINTS) as MobileSheetSnapPoint;
    settleAt(target, currentHeight);
    event.preventDefault();
  }, [cancelFrame, dismissThresholdPx, fitContent, settleAt]);

  const handleClick = React.useCallback(() => {
    if (draggedRef.current) {
      draggedRef.current = false;
      return;
    }
    settleAt(snapPointRef.current === MOBILE_SHEET_EXPANDED_SNAP
      ? MOBILE_SHEET_COLLAPSED_SNAP
      : MOBILE_SHEET_EXPANDED_SNAP);
  }, [settleAt]);

  const handleKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    let target: MobileSheetSnapPoint | null = null;
    if (event.key === 'ArrowUp' || event.key === 'Home') target = MOBILE_SHEET_EXPANDED_SNAP;
    if (event.key === 'ArrowDown' || event.key === 'End') target = MOBILE_SHEET_COLLAPSED_SNAP;
    if (event.key === 'Enter' || event.key === ' ') {
      target = snapPointRef.current === MOBILE_SHEET_EXPANDED_SNAP
        ? MOBILE_SHEET_COLLAPSED_SNAP
        : MOBILE_SHEET_EXPANDED_SNAP;
    }
    if (target === null) return;
    event.preventDefault();
    settleAt(target);
  }, [settleAt]);

  const reset = React.useCallback(() => {
    dragRef.current = null;
    cancelFrame();
    pendingHeightRef.current = null;
    heightAnimationRef.current?.cancel();
    heightAnimationRef.current = null;
    collapsedHeightRef.current = null;
    snapPointRef.current = initialSnapPoint;
    setSnapPoint(initialSnapPoint);
    if (surfaceRef.current) {
      surfaceRef.current.style.height = '';
      surfaceRef.current.style.willChange = '';
    }
  }, [cancelFrame, initialSnapPoint]);

  React.useEffect(() => () => {
    cancelFrame();
    heightAnimationRef.current?.cancel();
  }, [cancelFrame]);

  return {
    surfaceRef,
    snapPoint,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp: (event: React.PointerEvent<HTMLDivElement>) => finishPointerDrag(event, false),
    handlePointerCancel: (event: React.PointerEvent<HTMLDivElement>) => finishPointerDrag(event, true),
    handleClick,
    handleKeyDown,
    reset,
  };
};

export type MobileSheetSnapController = ReturnType<typeof useMobileSheetSnap>;
