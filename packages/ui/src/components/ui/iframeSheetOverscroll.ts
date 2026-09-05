import { getMobileWindowMotionController } from './MobileWindowMotionRegistry';
import {
  getMobileWindowMotionDismissCommitDistance,
  getMobileWindowMotionDismissDistance,
  getMobileWindowMotionDismissProgress,
  getMobileWindowMotionDismissVelocity,
  isMobileWindowMotionDismissIntent,
  shouldCommitMobileWindowMotionDismiss,
} from './useMobileWindowMotionDismissGesture';

export const MOBILE_WINDOW_MOTION_ID_ATTR = 'data-oc-motion-id';

export const findOwningMotionId = (node: Element): string | null => (
  node.closest(`[${MOBILE_WINDOW_MOTION_ID_ATTR}]`)?.getAttribute(MOBILE_WINDOW_MOTION_ID_ATTR) ?? null
);

export const getIframeDocumentScroller = (iframe: HTMLIFrameElement): HTMLElement | null => {
  try {
    const doc = iframe.contentDocument;
    if (!doc) return null;
    return (doc.scrollingElement ?? doc.documentElement) as HTMLElement;
  } catch {
    return null;
  }
};

export const shouldHandIframePanToSheet = (scrollTop: number, deltaY: number): boolean => (
  Number.isFinite(scrollTop) && Number.isFinite(deltaY) && scrollTop <= 1 && deltaY > 0
);

export const shouldKeepIframeSheetDismiss = (
  active: boolean,
  scrollTop: number,
  deltaY: number,
): boolean => {
  if (active) return deltaY > 0;
  return shouldHandIframePanToSheet(scrollTop, deltaY);
};

type OverscrollGesture = {
  startX: number;
  startY: number;
  lastY: number;
  lastTime: number;
  lastVelocityTime: number;
  velocity: number;
  active: boolean;
};

export const attachIframeSheetOverscroll = (iframe: HTMLIFrameElement): (() => void) => {
  let detachDocument: (() => void) | null = null;

  const bindDocument = () => {
    detachDocument?.();
    detachDocument = null;
    const doc = (() => {
      try {
        return iframe.contentDocument;
      } catch {
        return null;
      }
    })();
    if (!doc) return;

    if (!doc.querySelector('style[data-oc-sheet-overscroll]')) {
      const style = doc.createElement('style');
      style.setAttribute('data-oc-sheet-overscroll', 'true');
      style.textContent = 'html, body { overscroll-behavior-y: none; min-height: 100%; }';
      (doc.head ?? doc.documentElement).appendChild(style);
    }

    const motionId = findOwningMotionId(iframe);
    if (!motionId) return;

    const scroller = () => getIframeDocumentScroller(iframe);
    let gesture: OverscrollGesture | null = null;

    const cancel = () => {
      if (gesture?.active) getMobileWindowMotionController(motionId)?.finish('cancel');
      gesture = null;
    };

    const onTouchStart = (event: TouchEvent) => {
      cancel();
      if (event.touches.length !== 1) return;
      const top = scroller()?.scrollTop ?? Number.POSITIVE_INFINITY;
      if (top > 1) return;
      const touch = event.touches[0];
      gesture = {
        startX: touch.clientX,
        startY: touch.clientY,
        lastY: touch.clientY,
        lastTime: event.timeStamp,
        lastVelocityTime: event.timeStamp,
        velocity: 0,
        active: false,
      };
    };

    const onTouchMove = (event: TouchEvent) => {
      if (!gesture || event.touches.length !== 1) {
        cancel();
        return;
      }
      const touch = event.touches[0];
      const top = scroller()?.scrollTop ?? Number.POSITIVE_INFINITY;
      const deltaY = touch.clientY - gesture.startY;
      const deltaX = touch.clientX - gesture.startX;
      const elapsed = event.timeStamp - gesture.lastTime;
      gesture.velocity = getMobileWindowMotionDismissVelocity(
        gesture.velocity,
        touch.clientY - gesture.lastY,
        elapsed,
        event.timeStamp - gesture.lastVelocityTime,
        1,
      );
      if (touch.clientY !== gesture.lastY && elapsed > 0) gesture.lastVelocityTime = event.timeStamp;
      gesture.lastY = touch.clientY;
      gesture.lastTime = event.timeStamp;

      if (!shouldKeepIframeSheetDismiss(gesture.active, top, deltaY)) {
        if (gesture.active) cancel();
        else gesture = null;
        return;
      }

      event.preventDefault();

      if (!gesture.active) {
        if (!isMobileWindowMotionDismissIntent('bottom', deltaX, deltaY, 8, 1)) return;
        const controller = getMobileWindowMotionController(motionId);
        if (!controller?.begin('dismiss')) {
          gesture = null;
          return;
        }
        gesture.active = true;
      }

      const surface = iframe.closest(`[${MOBILE_WINDOW_MOTION_ID_ATTR}]`);
      const motionDistance = surface instanceof HTMLElement
        ? surface.getBoundingClientRect().height || window.innerHeight
        : window.innerHeight;
      const distance = getMobileWindowMotionDismissDistance('bottom', deltaX, deltaY);
      getMobileWindowMotionController(motionId)?.update(
        getMobileWindowMotionDismissProgress(distance, motionDistance),
      );
    };

    const onTouchEnd = (event: TouchEvent) => {
      if (!gesture) return;
      const current = gesture;
      gesture = null;
      if (!current.active) return;
      const surface = iframe.closest(`[${MOBILE_WINDOW_MOTION_ID_ATTR}]`);
      const motionDistance = surface instanceof HTMLElement
        ? surface.getBoundingClientRect().height || window.innerHeight
        : window.innerHeight;
      const touch = event.changedTouches[0];
      const deltaY = touch ? touch.clientY - current.startY : 0;
      const deltaX = touch ? touch.clientX - current.startX : 0;
      const distance = getMobileWindowMotionDismissDistance('bottom', deltaX, deltaY);
      const commitDistance = getMobileWindowMotionDismissCommitDistance(motionDistance, 0.1, 40, 64);
      const commit = shouldCommitMobileWindowMotionDismiss(
        distance,
        current.velocity,
        commitDistance,
        0.65,
        12,
      );
      getMobileWindowMotionController(motionId)?.finish(commit ? 'commit' : 'cancel');
      event.preventDefault();
    };

    doc.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
    doc.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
    doc.addEventListener('touchend', onTouchEnd, { capture: true, passive: false });
    doc.addEventListener('touchcancel', cancel, { capture: true, passive: true });
    detachDocument = () => {
      cancel();
      doc.removeEventListener('touchstart', onTouchStart, true);
      doc.removeEventListener('touchmove', onTouchMove, true);
      doc.removeEventListener('touchend', onTouchEnd, true);
      doc.removeEventListener('touchcancel', cancel, true);
    };
  };

  iframe.addEventListener('load', bindDocument);
  bindDocument();
  return () => {
    iframe.removeEventListener('load', bindDocument);
    detachDocument?.();
  };
};
