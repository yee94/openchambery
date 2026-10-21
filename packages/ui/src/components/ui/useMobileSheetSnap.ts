import React from 'react';
import { useEvent } from '@reactuses/core';
import { useHeightSnap } from './useHeightSnap';

export const MOBILE_SHEET_COLLAPSED_SNAP = 0.72;
export const MOBILE_SHEET_EXPANDED_SNAP = 0.98;
type MobileSheetSnapPoint = typeof MOBILE_SHEET_COLLAPSED_SNAP | typeof MOBILE_SHEET_EXPANDED_SNAP;
const DEFAULT_DISMISS_THRESHOLD_PX = 64;
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
  if (contentHeight === null || contentHeight === undefined || !Number.isFinite(contentHeight)) return maximumHeight;
  return Math.min(maximumHeight, Math.max(0, contentHeight));
};

export const getNearestMobileSheetSnapPoint = (
  height: number,
  viewportHeight: number,
  collapsedHeight?: number | null,
): MobileSheetSnapPoint => {
  const collapsed = getMobileSheetCollapsedHeight(viewportHeight, collapsedHeight);
  const expanded = Math.max(1, viewportHeight) * MOBILE_SHEET_EXPANDED_SNAP;
  return Math.abs(height - collapsed) <= Math.abs(height - expanded)
    ? MOBILE_SHEET_COLLAPSED_SNAP : MOBILE_SHEET_EXPANDED_SNAP;
};

export const useMobileSheetSnap = ({
  initialSnapPoint = MOBILE_SHEET_COLLAPSED_SNAP,
  fitContent = false,
  onDismiss,
  dismissThresholdPx = DEFAULT_DISMISS_THRESHOLD_PX,
}: MobileSheetSnapOptions = {}) => {
  const surfaceRef = React.useRef<HTMLDivElement | null>(null);
  const collapsedHeightRef = React.useRef<number | null>(null);
  const pointRef = React.useRef(initialSnapPoint);
  const controller = useHeightSnap<MobileSheetSnapPoint>({
    surfaceRef,
    initialPoint: initialSnapPoint,
    minimumHeight: onDismiss ? 0 : undefined,
    getPoints: () => {
      const viewport = getMobileViewportHeight();
      if (fitContent && pointRef.current === MOBILE_SHEET_COLLAPSED_SNAP && surfaceRef.current && surfaceRef.current.style.willChange !== 'height') {
        collapsedHeightRef.current = getMobileSheetCollapsedHeight(viewport, surfaceRef.current.getBoundingClientRect().height);
      }
      return [
        { id: MOBILE_SHEET_COLLAPSED_SNAP, height: getMobileSheetCollapsedHeight(viewport, fitContent ? collapsedHeightRef.current : undefined) },
        { id: MOBILE_SHEET_EXPANDED_SNAP, height: viewport * MOBILE_SHEET_EXPANDED_SNAP },
      ];
    },
    onRelease: (height) => {
      if (!onDismiss || !shouldDismissMobileSheetSnap(height, getMobileViewportHeight(), dismissThresholdPx, fitContent ? collapsedHeightRef.current : undefined)) return false;
      onDismiss();
      return true;
    },
    onCommit: (point) => {
      pointRef.current = point;
      if (surfaceRef.current) surfaceRef.current.style.height = '';
    },
  });
  const reset = useEvent(() => {
    collapsedHeightRef.current = null;
    pointRef.current = initialSnapPoint;
    controller.reset();
  });
  return { ...controller, surfaceRef, reset };
};

export type MobileSheetSnapController = ReturnType<typeof useMobileSheetSnap>;
