import React from 'react';
import { createPortal } from 'react-dom';

import { isMobileOverlayFocusRestoreSuppressed } from '@/lib/mobileOverlayFocusRestore';
import { cn } from '@/lib/utils';
import { markOverlayScrimPress, shouldCommitOverlayScrimDismiss } from './matchingPress';
import { mobileWindowStack } from './MobileWindowStack';
import {
  getMobileWindowMotionFrame,
  getMobileWindowMotionControlledTarget,
  getMobileWindowMotionOperationTarget,
  getMobileWindowMotionSurfaceLayout,
  getMobileWindowMotionVisibleProgress,
  type MobileWindowMotionEdge,
  type MobileWindowMotionOperation,
  type MobileWindowMotionPresentation,
} from './MobileWindowMotionRecipe';
import {
  type MobileWindowMotionController,
  registerMobileWindowMotionController,
} from './MobileWindowMotionRegistry';
import {
  useMobileWindowMotionDismissGesture,
  type MobileWindowMotionDismissGestureConfig,
} from './useMobileWindowMotionDismissGesture';

export type {
  MobileWindowMotionEdge,
  MobileWindowMotionFinish,
  MobileWindowMotionOperation,
  MobileWindowMotionPresentation,
} from './MobileWindowMotionRecipe';

type ActiveSettle = { from: number; target: number; animations: Animation[] };
type MobileWindowMotionMode = 'standard' | 'interactive-present' | 'interactive-dismiss';

const OVERLAY_ROOT_ID = 'mobile-overlay-root';
const DURATION_MS = 200;
const MIN_DURATION_MS = 80;
const EASING = 'cubic-bezier(0.32, 0.72, 0, 1)';
const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

const ensureOverlayRoot = () => {
  if (typeof document === 'undefined') return null;
  let root = document.getElementById(OVERLAY_ROOT_ID);
  if (!root) {
    root = document.createElement('div');
    root.id = OVERLAY_ROOT_ID;
    document.body.appendChild(root);
  }
  return root;
};

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

interface MobileWindowMotionProps {
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  keepMounted?: boolean;
  presentation?: MobileWindowMotionPresentation;
  edge?: MobileWindowMotionEdge;
  children: React.ReactNode;
  className?: string;
  scrimClassName?: string;
  surfaceClassName?: string;
  surfaceElementRef?: React.Ref<HTMLDivElement>;
  dismissGesture?: boolean | MobileWindowMotionDismissGestureConfig;
  onExitComplete?: () => void;
  ariaLabel: string;
}

export const MobileWindowMotion: React.FC<MobileWindowMotionProps> = ({
  id, open, onOpenChange, keepMounted = false, presentation = 'sheet', edge = 'bottom', children, className, scrimClassName, surfaceClassName, surfaceElementRef, dismissGesture = false, onExitComplete, ariaLabel,
}) => {
  const overlayRootRef = React.useRef<HTMLElement | null>(null);
  const scrimRef = React.useRef<HTMLDivElement | null>(null);
  const surfaceRef = React.useRef<HTMLDivElement | null>(null);
  const openRef = React.useRef(open);
  const onOpenChangeRef = React.useRef(onOpenChange);
  const onExitCompleteRef = React.useRef(onExitComplete);
  const progressRef = React.useRef(0);
  const pendingProgressRef = React.useRef(0);
  const frameRef = React.useRef<number | null>(null);
  const animationsRef = React.useRef<Animation[]>([]);
  const activeSettleRef = React.useRef<ActiveSettle | null>(null);
  const modeRef = React.useRef<MobileWindowMotionMode>('standard');
  const operationRef = React.useRef<MobileWindowMotionOperation>('present');
  const interactionGenerationRef = React.useRef(0);
  const interactionActiveRef = React.useRef(false);
  const previousControlledOpenRef = React.useRef(open);
  const mountedRef = React.useRef(false);
  const activeRef = React.useRef(open);
  const controllerActionsRef = React.useRef<MobileWindowMotionController | null>(null);
  const [mounted, setMounted] = React.useState(open);
  const [active, setActive] = React.useState(open);
  const [mode, setMode] = React.useState<MobileWindowMotionMode>('standard');
  const [motionActive, setMotionActive] = React.useState(false);
  const isPreview = mode === 'interactive-present';
  const topId = React.useSyncExternalStore(mobileWindowStack.subscribe, mobileWindowStack.getSnapshot, mobileWindowStack.getSnapshot);
  const isTop = active && !isPreview && topId === id;
  const dismissGestureRef = useMobileWindowMotionDismissGesture({
    motionId: id,
    edge,
    disabled: !dismissGesture,
    ...(typeof dismissGesture === 'object' ? dismissGesture : {}),
  });
  const setSurfaceRef = React.useCallback((surface: HTMLDivElement | null) => {
    surfaceRef.current = surface;
    dismissGestureRef(surface);
    if (typeof surfaceElementRef === 'function') {
      surfaceElementRef(surface);
    } else if (surfaceElementRef && typeof surfaceElementRef === 'object') {
      (surfaceElementRef as React.MutableRefObject<HTMLDivElement | null>).current = surface;
    }
  }, [dismissGestureRef, surfaceElementRef]);

  const deactivate = React.useCallback(() => {
    if (!activeRef.current) return;
    activeRef.current = false;
    setActive(false);
    if (!keepMounted) setMounted(false);
    onExitCompleteRef.current?.();
  }, [keepMounted]);

  openRef.current = open;
  onOpenChangeRef.current = onOpenChange;
  onExitCompleteRef.current = onExitComplete;
  if (typeof document !== 'undefined' && !overlayRootRef.current) overlayRootRef.current = ensureOverlayRoot();

  const applyFrame = React.useCallback((progress: number) => {
    const frame = getMobileWindowMotionFrame(edge, progress);
    progressRef.current = frame.progress;
    if (!scrimRef.current || !surfaceRef.current) return;
    scrimRef.current.style.opacity = String(frame.scrimOpacity);
    surfaceRef.current.style.transform = frame.surfaceTransform;
    surfaceRef.current.style.opacity = String(frame.surfaceOpacity);
  }, [edge]);

  const cancelFrame = React.useCallback(() => {
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  }, []);
  const clearMotionStyles = React.useCallback(() => {
    if (scrimRef.current) scrimRef.current.style.willChange = '';
    if (surfaceRef.current) surfaceRef.current.style.willChange = '';
  }, []);
  const cancelAnimations = React.useCallback((animations = animationsRef.current) => {
    for (const animation of animations) animation.cancel();
    animationsRef.current = [];
  }, []);
  const interruptMotion = React.useCallback(() => {
    cancelFrame();
    const active = activeSettleRef.current;
    if (active) {
      const timing = active.animations[1]?.effect?.getComputedTiming().progress;
      applyFrame(typeof timing === 'number' && Number.isFinite(timing)
        ? active.from + (active.target - active.from) * timing
        : progressRef.current);
      cancelAnimations(active.animations);
      activeSettleRef.current = null;
    } else cancelAnimations();
    clearMotionStyles();
    setMotionActive(false);
  }, [applyFrame, cancelAnimations, cancelFrame, clearMotionStyles]);
  const settle = React.useCallback((target: number, onFinish?: () => void) => {
    if (activeSettleRef.current?.target === target) return;
    interruptMotion();
    const from = progressRef.current;
    const scrim = scrimRef.current;
    const surface = surfaceRef.current;
    setMotionActive(true);
    if (!scrim || !surface || reducedMotion() || from === target) {
      applyFrame(target);
      clearMotionStyles();
      setMotionActive(false);
      onFinish?.();
      return;
    }
    const fromFrame = getMobileWindowMotionFrame(edge, from);
    const toFrame = getMobileWindowMotionFrame(edge, target);
    scrim.style.willChange = 'opacity';
    surface.style.willChange = 'transform, opacity';
    const duration = Math.max(MIN_DURATION_MS, DURATION_MS * Math.abs(target - from));
    const animations = [
      scrim.animate([{ opacity: fromFrame.scrimOpacity }, { opacity: toFrame.scrimOpacity }], { duration, easing: EASING, fill: 'forwards' }),
      surface.animate([{ transform: fromFrame.surfaceTransform, opacity: fromFrame.surfaceOpacity }, { transform: toFrame.surfaceTransform, opacity: toFrame.surfaceOpacity }], { duration, easing: EASING, fill: 'forwards' }),
    ];
    animationsRef.current = animations;
    const active = { from, target, animations };
    activeSettleRef.current = active;
    void Promise.all(animations.map((animation) => animation.finished.catch(() => undefined))).then(() => {
      if (activeSettleRef.current !== active) return;
      applyFrame(target);
      cancelAnimations(animations);
      activeSettleRef.current = null;
      clearMotionStyles();
      setMotionActive(false);
      onFinish?.();
    });
  }, [applyFrame, cancelAnimations, clearMotionStyles, edge, interruptMotion]);

  React.useLayoutEffect(() => {
    mountedRef.current = mounted;
    if (mounted) applyFrame(pendingProgressRef.current);
  }, [applyFrame, mounted]);
  React.useLayoutEffect(() => {
    activeRef.current = active;
  }, [active]);

  React.useEffect(() => {
    if (open && !mountedRef.current) {
      pendingProgressRef.current = progressRef.current;
      setMounted(true);
    }
    if (open && !activeRef.current) {
      activeRef.current = true;
      setActive(true);
    }
    if (mountedRef.current && modeRef.current === 'standard') {
      settle(getMobileWindowMotionControlledTarget(open), () => {
        if (!openRef.current && modeRef.current === 'standard') deactivate();
      });
    }
  }, [deactivate, open, settle]);
  React.useLayoutEffect(() => {
    if (!mounted || modeRef.current !== 'standard') return;
    settle(open ? 1 : 0, () => {
      if (!openRef.current && modeRef.current === 'standard') deactivate();
    });
  }, [deactivate, mounted, open, settle]);

  React.useEffect(() => {
    if (!active || isPreview) return;
    window.dispatchEvent(new Event('oc:mobile-overlay-opened'));
    return () => { window.dispatchEvent(new Event('oc:mobile-overlay-closed')); };
  }, [active, isPreview]);
  React.useEffect(() => {
    if (!active || isPreview) return;
    return mobileWindowStack.add({ id, onClose: () => onOpenChangeRef.current(false) }, document.body);
  }, [active, id, isPreview]);
  React.useEffect(() => {
    if (!active || isPreview || !isTop) return;
    const surface = surfaceRef.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Keep initial focus on the surface shell. Auto-focusing the first FOCUSABLE
    // hits the resize handle (`tabIndex={0}`) or a random button, and re-running
    // this effect (stack top churn) would steal focus from the search field mid-tap.
    surface?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') mobileWindowStack.closeTop();
      if (event.key !== 'Tab' || !surface) return;
      const focusable = Array.from(surface.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter((element) => !element.closest('[data-mobile-sheet-snap-handle]'));
      const first = focusable[0] ?? surface;
      const last = focusable.at(-1) ?? surface;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      // A session switch closes the sheet as navigation — restoring the
      // composer focus would raise the old conversation's keyboard over the
      // new one (see lib/mobileOverlayFocusRestore).
      if (!isMobileOverlayFocusRestoreSuppressed()) {
        previous?.focus({ preventScroll: true });
      }
    };
  }, [active, isPreview, isTop]);

  controllerActionsRef.current = {
    begin: (operation) => {
      if (operation === 'dismiss' && (!activeRef.current || modeRef.current === 'interactive-present')) return false;
      interruptMotion();
      interactionGenerationRef.current += 1;
      interactionActiveRef.current = true;
      operationRef.current = operation;
      const nextMode: MobileWindowMotionMode = operation === 'present' ? 'interactive-present' : 'interactive-dismiss';
      modeRef.current = nextMode;
      setMode(nextMode);
      setMotionActive(true);
      if (operation === 'present') {
        pendingProgressRef.current = progressRef.current;
        activeRef.current = true;
        setActive(true);
        setMounted(true);
      }
      return true;
    },
    update: (progress) => {
      if (!interactionActiveRef.current) return;
      pendingProgressRef.current = getMobileWindowMotionVisibleProgress(operationRef.current, progress);
      if (frameRef.current !== null) return;
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
        if (interactionActiveRef.current) applyFrame(pendingProgressRef.current);
      });
    },
    finish: (finish) => {
      if (!interactionActiveRef.current) return;
      interactionActiveRef.current = false;
      const generation = interactionGenerationRef.current;
      const operation = operationRef.current;
      const target = getMobileWindowMotionOperationTarget(operation, finish);
      if (frameRef.current !== null) {
        cancelFrame();
        applyFrame(pendingProgressRef.current);
      }
      settle(target, () => {
        if (generation !== interactionGenerationRef.current) return;
        if (finish === 'commit') onOpenChangeRef.current(operation === 'present');
        if (operation === 'present' && finish === 'cancel' && !openRef.current) deactivate();
        modeRef.current = 'standard';
        setMode('standard');
        // A committed close is visually complete once the settle animation lands.
        // Unmount now instead of waiting on a reconcile pass: the controlled
        // `open` prop drives any later correction, and re-settling from the
        // pre-commit `openRef` value would flash the surface back to full screen.
        if (target === 0) deactivate();
      });
    },
    interrupt: () => {
      interactionGenerationRef.current += 1;
      interactionActiveRef.current = false;
      const interruptedPresentation = modeRef.current === 'interactive-present' && !openRef.current;
      if (!interruptedPresentation) {
        modeRef.current = 'standard';
        setMode('standard');
      }
      interruptMotion();
      settle(getMobileWindowMotionControlledTarget(openRef.current), () => {
        if (!openRef.current) deactivate();
        if (interruptedPresentation) {
          modeRef.current = 'standard';
          setMode('standard');
        }
      });
    },
  };
  React.useLayoutEffect(() => {
    const previousOpen = previousControlledOpenRef.current;
    previousControlledOpenRef.current = open;
    if (previousOpen && !open && modeRef.current !== 'standard') {
      controllerActionsRef.current?.interrupt();
    }
  }, [open]);
  React.useEffect(() => {
    const controller: MobileWindowMotionController = {
      begin: (operation) => controllerActionsRef.current?.begin(operation) ?? false,
      update: (progress) => controllerActionsRef.current?.update(progress),
      finish: (finish) => controllerActionsRef.current?.finish(finish),
      interrupt: () => controllerActionsRef.current?.interrupt(),
    };
    const unregister = registerMobileWindowMotionController(id, controller);
    return () => {
      unregister();
      cancelFrame();
      cancelAnimations();
      activeSettleRef.current = null;
      clearMotionStyles();
      controllerActionsRef.current = null;
    };
  }, [cancelAnimations, cancelFrame, clearMotionStyles, id]);

  if (!mounted || !overlayRootRef.current) return null;
  const content = (
    <div
      ref={scrimRef}
      className={cn('oc-mobile-window-motion oc-keyboard-inset-surface fixed inset-0 z-[60] flex flex-col bg-[rgb(0_0_0_/_0.45)]', motionActive && 'oc-mobile-window-motion-active', !active && !isPreview && 'pointer-events-none invisible', scrimClassName, className)}
      data-mobile-overlay-active={String(active)}
      role={isPreview ? undefined : 'dialog'} aria-label={isPreview ? undefined : ariaLabel}
      aria-modal={active && isTop ? 'true' : undefined} aria-hidden={isPreview || !active || !isTop || undefined} inert={isPreview || !active || !isTop || undefined}
      onPointerDown={markOverlayScrimPress}
      onClick={(event) => {
        if (!active || isPreview || !isTop) return;
        if (!shouldCommitOverlayScrimDismiss(event)) return;
        onOpenChangeRef.current(false);
      }}
    >
      <div ref={setSurfaceRef} tabIndex={-1} className={cn('oc-mobile-floating-shell', getMobileWindowMotionSurfaceLayout(presentation, edge), surfaceClassName)} data-oc-motion-id={id} style={{ contain: 'layout paint style' }} onClick={(event) => event.stopPropagation()}>
        {children}
      </div>
    </div>
  );
  return createPortal(content, overlayRootRef.current);
};
