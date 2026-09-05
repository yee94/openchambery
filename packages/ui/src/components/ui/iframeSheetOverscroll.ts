import {
  getMobileWindowMotionController,
  type MobileWindowMotionController,
} from './MobileWindowMotionRegistry';
import {
  getMobileWindowMotionDismissCommitDistance,
  getMobileWindowMotionDismissDistance,
  getMobileWindowMotionDismissProgress,
  getMobileWindowMotionDismissVelocity,
  isMobileWindowMotionDismissIntent,
  shouldCommitMobileWindowMotionDismiss,
} from './useMobileWindowMotionDismissGesture';

export const MOBILE_WINDOW_MOTION_ID_ATTR = 'data-oc-motion-id';

const SHEET_OVERSCROLL_STYLE_ATTR = 'data-oc-sheet-overscroll';
const SHEET_OVERSCROLL_STYLE = 'html, body { overscroll-behavior-y: none; }';
/** Form / editable chrome must never arm sheet dismiss (incl. plaintext-only). */
const NO_DISMISS_TARGET_SELECTOR = [
  'input',
  'textarea',
  'select',
  '[contenteditable]:not([contenteditable="false"])',
  '[data-mobile-sheet-no-dismiss]',
].join(', ');

export const findOwningMotionId = (node: Element): string | null => (
  node.closest(`[${MOBILE_WINDOW_MOTION_ID_ATTR}]`)?.getAttribute(MOBILE_WINDOW_MOTION_ID_ATTR) ?? null
);

/** Root scroller for an iframe document (failure-safe across origins). */
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

/** Once the sheet owns the gesture, keep it through reverse/scrollTop noise until end. */
export const shouldKeepIframeSheetDismiss = (
  active: boolean,
  scrollTop: number,
  deltaY: number,
): boolean => {
  if (active) return true;
  return shouldHandIframePanToSheet(scrollTop, deltaY);
};

/** Realm-safe: iframe nodes belong to the iframe window, not the outer global. */
const isDocumentElement = (doc: Document, node: EventTarget | null): node is Element => {
  const view = doc.defaultView;
  if (!view || node == null) return false;
  return node instanceof view.Element;
};

const isDocumentHtmlElement = (doc: Document, node: EventTarget | null): node is HTMLElement => {
  const view = doc.defaultView;
  if (!view || node == null) return false;
  return node instanceof view.HTMLElement;
};

const isDocumentStyleElement = (doc: Document, node: Element | null): node is HTMLStyleElement => {
  const view = doc.defaultView;
  if (!view || node == null) return false;
  return node instanceof view.HTMLStyleElement;
};

const touchAt = (touches: TouchList, index: number): Touch | null => {
  if (typeof touches.item === 'function') {
    const viaItem = touches.item(index);
    if (viaItem) return viaItem;
  }
  return (touches as unknown as ArrayLike<Touch>)[index] ?? null;
};

const findTouch = (touches: TouchList, touchId: number): Touch | null => {
  for (let index = 0; index < touches.length; index += 1) {
    const touch = touchAt(touches, index);
    if (touch?.identifier === touchId) return touch;
  }
  return null;
};

const isVerticallyScrollable = (doc: Document, element: HTMLElement): boolean => {
  try {
    const style = doc.defaultView?.getComputedStyle(element);
    if (!style) return false;
    const overflowY = style.overflowY;
    return (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay')
      && element.scrollHeight > element.clientHeight + 1;
  } catch {
    return false;
  }
};

/**
 * Walk the full ancestor chain (target → root scroller). Any scrollable still
 * above top keeps the pan inside the iframe — even when an inner nest is at top.
 */
export const collectIframeScrollChain = (
  doc: Document,
  target: EventTarget | null,
): HTMLElement[] => {
  const chain: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();
  const push = (el: HTMLElement | null) => {
    if (!el || seen.has(el)) return;
    if (!isVerticallyScrollable(doc, el)) return;
    seen.add(el);
    chain.push(el);
  };

  let candidate: Element | null = isDocumentElement(doc, target) ? target : null;
  while (candidate) {
    if (isDocumentHtmlElement(doc, candidate)) push(candidate);
    if (candidate === doc.documentElement || candidate === doc.body) break;
    candidate = candidate.parentElement;
  }

  const root = doc.scrollingElement ?? doc.documentElement;
  if (isDocumentHtmlElement(doc, root)) push(root);
  return chain;
};

/** True when every scrollable ancestor (incl. root) is at the top edge. */
export const isIframeScrollChainAtTop = (
  doc: Document,
  target: EventTarget | null,
): boolean => {
  const chain = collectIframeScrollChain(doc, target);
  if (chain.length === 0) {
    const root = (doc.scrollingElement ?? doc.documentElement) as HTMLElement | null;
    const top = root?.scrollTop ?? Number.POSITIVE_INFINITY;
    return Number.isFinite(top) && top <= 1;
  }
  return chain.every((el) => el.scrollTop <= 1);
};

type PendingGesture = {
  touchId: number;
  startX: number;
  startY: number;
  lastY: number;
  lastTime: number;
  lastVelocityTime: number;
  velocity: number;
  motionDistance: number;
  commitDistance: number;
  active: false;
  controller: null;
};

type ActiveGesture = {
  touchId: number;
  startX: number;
  startY: number;
  lastY: number;
  lastTime: number;
  lastVelocityTime: number;
  velocity: number;
  motionDistance: number;
  commitDistance: number;
  active: true;
  controller: MobileWindowMotionController;
};

type OverscrollGesture = PendingGesture | ActiveGesture;

const snapshotSurfaceMotionDistance = (iframe: HTMLIFrameElement): number => {
  // Surface lives in the parent document (same realm as this module).
  const surface = iframe.closest(`[${MOBILE_WINDOW_MOTION_ID_ATTR}]`);
  if (surface instanceof HTMLElement) {
    const height = surface.getBoundingClientRect().height;
    if (Number.isFinite(height) && height > 0) return height;
  }
  return window.innerHeight || 1;
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

    const motionId = findOwningMotionId(iframe);
    // Fullscreen / no owning sheet: leave the document and scroll styles untouched.
    if (!motionId) return;

    // Style lifetime: only remove the node THIS binding created.
    let createdStyle: HTMLStyleElement | null = null;
    const existing = doc.querySelector(`style[${SHEET_OVERSCROLL_STYLE_ATTR}]`);
    if (!isDocumentStyleElement(doc, existing)) {
      const style = doc.createElement('style');
      style.setAttribute(SHEET_OVERSCROLL_STYLE_ATTR, 'true');
      style.textContent = SHEET_OVERSCROLL_STYLE;
      (doc.head ?? doc.documentElement).appendChild(style);
      createdStyle = style;
    }

    let gesture: OverscrollGesture | null = null;

    const cancel = () => {
      if (gesture?.active) gesture.controller.finish('cancel');
      gesture = null;
    };

    const onTouchStart = (event: TouchEvent) => {
      cancel();
      if (event.touches.length !== 1) return;
      const target = isDocumentElement(doc, event.target) ? event.target : null;
      if (target?.closest(NO_DISMISS_TARGET_SELECTOR)) return;

      // Any scrolled ancestor (inner nest at top but outer/root still down) blocks handoff.
      if (!isIframeScrollChainAtTop(doc, event.target)) return;

      const touch = touchAt(event.touches, 0);
      if (!touch) return;

      // Physical outer/screen coords stay stable while the sheet translates under the finger.
      const motionDistance = snapshotSurfaceMotionDistance(iframe);
      gesture = {
        touchId: touch.identifier,
        startX: touch.screenX,
        startY: touch.screenY,
        lastY: touch.screenY,
        lastTime: event.timeStamp,
        lastVelocityTime: event.timeStamp,
        velocity: 0,
        motionDistance,
        commitDistance: getMobileWindowMotionDismissCommitDistance(motionDistance, 0.1, 40, 64),
        active: false,
        controller: null,
      };
    };

    const onTouchMove = (event: TouchEvent) => {
      if (!gesture) return;
      if (event.touches.length !== 1) {
        cancel();
        return;
      }
      const touch = findTouch(event.touches, gesture.touchId);
      if (!touch) {
        cancel();
        return;
      }

      const deltaY = touch.screenY - gesture.startY;
      const deltaX = touch.screenX - gesture.startX;
      const elapsed = event.timeStamp - gesture.lastTime;
      gesture.velocity = getMobileWindowMotionDismissVelocity(
        gesture.velocity,
        touch.screenY - gesture.lastY,
        elapsed,
        event.timeStamp - gesture.lastVelocityTime,
        1,
      );
      if (touch.screenY !== gesture.lastY && elapsed > 0) gesture.lastVelocityTime = event.timeStamp;
      gesture.lastY = touch.screenY;
      gesture.lastTime = event.timeStamp;

      if (!gesture.active) {
        if (!isIframeScrollChainAtTop(doc, event.target)) {
          gesture = null;
          return;
        }
        const root = getIframeDocumentScroller(iframe);
        const scrollTop = root?.scrollTop ?? 0;
        if (!shouldKeepIframeSheetDismiss(false, scrollTop, deltaY)) {
          gesture = null;
          return;
        }
        if (!isMobileWindowMotionDismissIntent('bottom', deltaX, deltaY, 8, 1)) return;
        const controller = getMobileWindowMotionController(motionId);
        if (!controller?.begin('dismiss')) {
          gesture = null;
          return;
        }
        // Snapshot the single owner for the rest of the gesture lifetime.
        const accepted: ActiveGesture = {
          ...gesture,
          active: true,
          controller,
        };
        gesture = accepted;
      }

      const active = gesture;
      if (!active.active) return;

      // Sheet owns the gesture until end/cancel — reverse is progress toward 0, not cancel.
      event.preventDefault();
      const distance = getMobileWindowMotionDismissDistance('bottom', deltaX, deltaY);
      active.controller.update(getMobileWindowMotionDismissProgress(distance, active.motionDistance));
    };

    const onTouchEnd = (event: TouchEvent) => {
      if (!gesture) return;
      const current = gesture;
      const touch = findTouch(event.changedTouches, current.touchId);
      gesture = null;
      if (!current.active) return;

      // Missing tracked touch must cancel — never commit with a stale distance.
      if (!touch) {
        current.controller.finish('cancel');
        return;
      }

      const elapsed = event.timeStamp - current.lastTime;
      current.velocity = getMobileWindowMotionDismissVelocity(
        current.velocity,
        touch.screenY - current.lastY,
        elapsed,
        event.timeStamp - current.lastVelocityTime,
        1,
      );
      if (touch.screenY !== current.lastY && elapsed > 0) current.lastVelocityTime = event.timeStamp;
      current.lastY = touch.screenY;
      current.lastTime = event.timeStamp;

      const deltaY = touch.screenY - current.startY;
      const deltaX = touch.screenX - current.startX;
      const distance = getMobileWindowMotionDismissDistance('bottom', deltaX, deltaY);
      const commit = shouldCommitMobileWindowMotionDismiss(
        distance,
        current.velocity,
        current.commitDistance,
        0.65,
        12,
      );
      current.controller.finish(commit ? 'commit' : 'cancel');
      event.preventDefault();
    };

    const onTouchCancel = () => cancel();

    doc.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
    doc.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
    doc.addEventListener('touchend', onTouchEnd, { capture: true, passive: false });
    doc.addEventListener('touchcancel', onTouchCancel, { capture: true, passive: true });
    detachDocument = () => {
      cancel();
      doc.removeEventListener('touchstart', onTouchStart, true);
      doc.removeEventListener('touchmove', onTouchMove, true);
      doc.removeEventListener('touchend', onTouchEnd, true);
      doc.removeEventListener('touchcancel', onTouchCancel, true);
      try {
        createdStyle?.remove();
      } catch {
        // Detached / cross-origin — best effort.
      }
      createdStyle = null;
    };
  };

  iframe.addEventListener('load', bindDocument);
  bindDocument();
  return () => {
    iframe.removeEventListener('load', bindDocument);
    detachDocument?.();
  };
};
