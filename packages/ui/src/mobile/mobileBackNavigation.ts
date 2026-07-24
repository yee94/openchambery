import * as React from 'react';
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { useEvent } from '@reactuses/core';
import { flushSync } from 'react-dom';

import { isCapacitorApp } from '@/lib/platform';

export type MobileBackRouteLayer = 'root' | 'overlay';

export type MobileBackRoute = {
  id: string;
  layer: MobileBackRouteLayer;
  onBack: () => boolean | void;
  getSurface: () => HTMLElement | null;
  getUnderlay: () => HTMLElement | null;
};

type RegisteredMobileBackRoute = MobileBackRoute & {
  token: number;
};

type HistoryState = Record<string, unknown> | null;

export type MobileBackHistory = {
  currentState: () => HistoryState;
  pushState: (state: Record<string, unknown>) => void;
  back: () => void;
  subscribe: (listener: (state: HistoryState) => void) => () => void;
};

const MOBILE_BACK_HISTORY_KEY = '__openchamberMobileBackRoute';

const browserHistory = (): MobileBackHistory | null => {
  if (typeof window === 'undefined' || isCapacitorApp()) return null;
  return {
    currentState: () => (
      window.history.state && typeof window.history.state === 'object'
        ? window.history.state as Record<string, unknown>
        : null
    ),
    pushState: (state) => window.history.pushState(state, '', window.location.href),
    back: () => window.history.back(),
    subscribe: (listener) => {
      const handlePopState = (event: PopStateEvent) => listener(
        event.state && typeof event.state === 'object'
          ? event.state as Record<string, unknown>
          : null,
      );
      window.addEventListener('popstate', handlePopState);
      return () => window.removeEventListener('popstate', handlePopState);
    },
  };
};

const historyToken = (state: HistoryState): number | null => {
  const value = state?.[MOBILE_BACK_HISTORY_KEY];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

/**
 * One navigation-depth authority for phone push pages. Route owners keep their
 * local state; this coordinator only orders active routes, dispatches back to
 * the top owner, and mirrors that depth into browser history on hosted H5.
 */
export class MobileBackNavigationCoordinator {
  private readonly routes: RegisteredMobileBackRoute[] = [];
  private readonly listeners = new Set<() => void>();
  private nextToken = 1;
  private history: MobileBackHistory | null;
  private removeHistoryListener: (() => void) | null = null;
  private programmaticHistoryBackToken: number | null = null;

  constructor(history: MobileBackHistory | null = browserHistory()) {
    this.history = history;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getTopRoute = (): RegisteredMobileBackRoute | null => this.routes.at(-1) ?? null;

  register = (route: MobileBackRoute): (() => void) => {
    const registered: RegisteredMobileBackRoute = { ...route, token: this.nextToken++ };
    this.routes.push(registered);
    this.ensureHistoryListener();
    if (this.history) {
      this.history.pushState({
        ...(this.history.currentState() ?? {}),
        [MOBILE_BACK_HISTORY_KEY]: registered.token,
      });
    }
    this.notify();

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const index = this.routes.indexOf(registered);
      if (index < 0) return;
      this.routes.splice(index, 1);
      if (this.history && historyToken(this.history.currentState()) === registered.token) {
        this.programmaticHistoryBackToken = registered.token;
        this.history.back();
      }
      if (this.routes.length === 0) this.disposeHistoryListener();
      this.notify();
    };
  };

  backImmediately = (layer?: MobileBackRouteLayer): boolean => {
    const route = this.getTopRoute();
    if (!route || (layer && route.layer !== layer)) return false;
    return route.onBack() !== false;
  };

  requestBrowserBack = (): boolean => {
    const route = this.getTopRoute();
    if (!route) return false;
    if (this.history && historyToken(this.history.currentState()) === route.token) {
      this.history.back();
      return true;
    }
    return route.onBack() !== false;
  };

  private ensureHistoryListener(): void {
    if (!this.history || this.removeHistoryListener) return;
    this.removeHistoryListener = this.history.subscribe((state) => {
      const top = this.getTopRoute();
      if (!top) return;
      if (this.programmaticHistoryBackToken === top.token) {
        this.programmaticHistoryBackToken = null;
        return;
      }
      // A nested owner (for example Settings' split-detail history) may use
      // its own entry while retaining our token. Only pop when our marker was
      // actually removed, otherwise both owners would navigate at once.
      if (historyToken(state) === top.token) return;
      const handled = top.onBack() !== false;
      if (!handled && this.history) {
        this.history.pushState({
          ...(this.history.currentState() ?? {}),
          [MOBILE_BACK_HISTORY_KEY]: top.token,
        });
      }
    });
  }

  private disposeHistoryListener(): void {
    this.removeHistoryListener?.();
    this.removeHistoryListener = null;
    this.programmaticHistoryBackToken = null;
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener());
  }
}

export const mobileBackNavigationCoordinator = new MobileBackNavigationCoordinator();

export type UseMobileBackRouteOptions = {
  id: string;
  active: boolean;
  layer?: MobileBackRouteLayer;
  onBack: () => boolean | void;
  surfaceRef: React.RefObject<HTMLElement | null>;
  underlayRef?: React.RefObject<HTMLElement | null>;
};

export const useMobileBackRoute = ({
  id,
  active,
  layer = 'root',
  onBack,
  surfaceRef,
  underlayRef,
}: UseMobileBackRouteOptions): void => {
  const handleBack = useEvent(onBack);

  React.useEffect(() => {
    if (!active) return;
    return mobileBackNavigationCoordinator.register({
      id,
      layer,
      onBack: handleBack,
      getSurface: () => surfaceRef.current,
      getUnderlay: () => underlayRef?.current ?? null,
    });
  }, [active, handleBack, id, layer, surfaceRef, underlayRef]);
};

type NativeBackEvent = { progress?: number };

type OpenChamberNavigationPlugin = {
  setEnabled(options: { enabled: boolean }): Promise<void>;
  addListener(
    eventName: 'backStarted' | 'backProgressed' | 'backCancelled' | 'backInvoked',
    listener: (event: NativeBackEvent) => void,
  ): Promise<PluginListenerHandle>;
};

const OpenChamberNavigation = registerPlugin<OpenChamberNavigationPlugin>('OpenChamberNavigation');

type InteractivePresentation = {
  route: RegisteredMobileBackRoute;
  surface: HTMLElement;
  underlay: HTMLElement | null;
  surfaceTransition: string;
  surfaceAnimation: string;
  underlayTransition: string | null;
  underlayAnimation: string | null;
};

export const clampMobileBackProgress = (progress: number): number => (
  Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0))
);

const clearPresentation = (presentation: InteractivePresentation): void => {
  const {
    surface,
    underlay,
    surfaceTransition,
    surfaceAnimation,
    underlayTransition,
    underlayAnimation,
  } = presentation;
  surface.style.removeProperty('transform');
  surface.style.removeProperty('opacity');
  surface.style.removeProperty('will-change');
  surface.style.removeProperty('box-shadow');
  surface.style.transition = surfaceTransition;
  surface.style.animation = surfaceAnimation;
  if (underlay) {
    underlay.style.removeProperty('transform');
    underlay.style.removeProperty('opacity');
    underlay.style.removeProperty('will-change');
    underlay.style.transition = underlayTransition ?? '';
    underlay.style.animation = underlayAnimation ?? '';
  }
};

const renderPresentation = (presentation: InteractivePresentation, rawProgress: number): void => {
  const progress = clampMobileBackProgress(rawProgress);
  const { surface, underlay } = presentation;
  surface.style.transform = `translate3d(${progress * 100}%, 0, 0)`;
  if (underlay) {
    underlay.style.transform = `translate3d(${(progress - 1) * 8}%, 0, 0)`;
  }
};

const settleMobileBackElement = async (
  element: HTMLElement,
  targetPercent: number,
  duration: number,
  reducedMotion: boolean,
): Promise<void> => {
  if (!reducedMotion && typeof element.animate === 'function') {
    const currentTransform = element.style.transform || 'translate3d(0%, 0, 0)';
    const targetTransform = `translate3d(${targetPercent}%, 0, 0)`;
    const animation = element.animate(
      [
        { transform: currentTransform },
        { transform: targetTransform },
      ],
      { duration, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' },
    );
    let completed = false;
    try {
      await animation.finished;
      completed = true;
    } catch {
      // A newer gesture may intentionally interrupt this settlement.
    } finally {
      // Preserve the rendered endpoint in the inline transform before
      // cancelling fill-forwards. Otherwise WebKit exposes the pre-settlement
      // transform for one frame while React commits the route pop.
      if (completed) element.style.transform = targetTransform;
      // `fill: forwards` must never survive route mutation. A retained or
      // reused surface would otherwise stay shifted and expand horizontal
      // overflow after the navigation owner changes state.
      animation.cancel();
    }
  }
};

export const settleMobileBackSurface = async (
  surface: HTMLElement,
  commit: boolean,
  reducedMotion = typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
): Promise<void> => settleMobileBackElement(
  surface,
  commit ? 100 : 0,
  commit ? 170 : 210,
  reducedMotion,
);

export type UseMobileNavigationDriverOptions = {
  enabled: boolean;
  /** True while a modal/sheet is above root routes. Overlay-owned child routes remain eligible. */
  rootRoutesBlocked: boolean;
};

/**
 * Native-only gesture driver. Native code owns edge/predictive recognition;
 * this hook coalesces progress to one compositor update per animation frame.
 */
export const useMobileNavigationDriver = ({
  enabled,
  rootRoutesBlocked,
}: UseMobileNavigationDriverOptions): void => {
  React.useEffect(() => {
    if (!enabled || !isCapacitorApp() || Capacitor.getPlatform() === 'web') return;

    let disposed = false;
    let presentation: InteractivePresentation | null = null;
    let settlingPresentation: InteractivePresentation | null = null;
    let frame = 0;
    let latestProgress = 0;
    let presentationGeneration = 0;
    const handles: PluginListenerHandle[] = [];

    const routeIsEligible = (route: RegisteredMobileBackRoute | null): route is RegisteredMobileBackRoute => (
      Boolean(route) && (!rootRoutesBlocked || route?.layer === 'overlay')
    );

    const syncEnabled = () => {
      const nativeEnabled = routeIsEligible(mobileBackNavigationCoordinator.getTopRoute());
      void OpenChamberNavigation.setEnabled({ enabled: nativeEnabled }).catch(() => undefined);
    };

    const begin = () => {
      const route = mobileBackNavigationCoordinator.getTopRoute();
      if (!routeIsEligible(route)) return;
      const surface = route.getSurface();
      if (!surface) return;
      surface.getAnimations().forEach((animation) => animation.cancel());
      settlingPresentation = null;
      const underlay = route.layer === 'root' ? route.getUnderlay() : null;
      const surfaceTransition = surface.style.transition;
      const surfaceAnimation = surface.style.animation;
      const underlayTransition = underlay?.style.transition ?? null;
      const underlayAnimation = underlay?.style.animation ?? null;
      underlay?.getAnimations().forEach((animation) => animation.cancel());
      // Interactive native progress is already time-based. Set all static
      // compositor hints once; the animation frame hot path writes transform only.
      surface.style.transition = 'none';
      surface.style.animation = 'none';
      surface.style.willChange = 'transform';
      surface.style.boxShadow = '-14px 0 28px color-mix(in srgb, var(--surface-foreground) 12%, transparent)';
      if (underlay) {
        underlay.style.transition = 'none';
        underlay.style.animation = 'none';
        underlay.style.willChange = 'transform';
      }
      presentationGeneration += 1;
      presentation = {
        route,
        surface,
        underlay,
        surfaceTransition,
        surfaceAnimation,
        underlayTransition,
        underlayAnimation,
      };
      renderPresentation(presentation, 0);
    };

    const update = (progress: number) => {
      latestProgress = clampMobileBackProgress(progress);
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        if (presentation) renderPresentation(presentation, latestProgress);
      });
    };

    const finish = (commit: boolean, finalProgress?: number) => {
      if (frame) {
        window.cancelAnimationFrame(frame);
        frame = 0;
      }
      if (presentation && finalProgress !== undefined) {
        renderPresentation(presentation, finalProgress);
      }
      const current = presentation;
      const generation = presentationGeneration;
      presentation = null;
      if (!current) {
        if (commit) mobileBackNavigationCoordinator.backImmediately();
        return;
      }
      settlingPresentation = current;
      const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
      const duration = commit ? 170 : 210;
      void Promise.all([
        settleMobileBackSurface(current.surface, commit, reducedMotion),
        current.underlay
          ? settleMobileBackElement(current.underlay, commit ? 0 : -8, duration, reducedMotion)
          : Promise.resolve(),
      ]).then(() => {
        if (generation !== presentationGeneration) return;
        if (settlingPresentation === current) settlingPresentation = null;
        try {
          if (!disposed && commit) {
            // Commit the route while the outgoing surface is still parked at
            // 100%. Clearing first can reveal it at x=0 for one WebKit frame.
            flushSync(() => {
              current.route.onBack();
            });
          }
        } finally {
          clearPresentation(current);
        }
      });
    };

    const unsubscribe = mobileBackNavigationCoordinator.subscribe(syncEnabled);
    const addListeners = async () => {
      const started = await OpenChamberNavigation.addListener('backStarted', begin);
      const progressed = await OpenChamberNavigation.addListener('backProgressed', (event) => update(event.progress ?? 0));
      const cancelled = await OpenChamberNavigation.addListener('backCancelled', (event) => finish(false, event.progress));
      const invoked = await OpenChamberNavigation.addListener('backInvoked', (event) => finish(true, event.progress));
      if (disposed) {
        await Promise.all([started.remove(), progressed.remove(), cancelled.remove(), invoked.remove()]);
        return;
      }
      handles.push(started, progressed, cancelled, invoked);
      syncEnabled();
    };
    void addListeners().catch(() => undefined);
    syncEnabled();

    return () => {
      disposed = true;
      presentationGeneration += 1;
      unsubscribe();
      if (frame) window.cancelAnimationFrame(frame);
      if (presentation) clearPresentation(presentation);
      if (settlingPresentation) {
        settlingPresentation.surface.getAnimations().forEach((animation) => animation.cancel());
        settlingPresentation.underlay?.getAnimations().forEach((animation) => animation.cancel());
        clearPresentation(settlingPresentation);
      }
      presentation = null;
      settlingPresentation = null;
      void OpenChamberNavigation.setEnabled({ enabled: false }).catch(() => undefined);
      handles.forEach((handle) => void handle.remove());
    };
  }, [enabled, rootRoutesBlocked]);
};
