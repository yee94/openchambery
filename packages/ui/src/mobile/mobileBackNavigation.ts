import * as React from 'react';
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { useEvent } from '@reactuses/core';

import { isCapacitorApp } from '@/lib/platform';

export type MobileBackRouteLayer = 'root' | 'overlay';

export type MobileBackRoute = {
  id: string;
  layer: MobileBackRouteLayer;
  onBack: () => boolean | void;
  getSurface: () => HTMLElement | null;
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
};

export const useMobileBackRoute = ({
  id,
  active,
  layer = 'root',
  onBack,
  surfaceRef,
}: UseMobileBackRouteOptions): void => {
  const handleBack = useEvent(onBack);

  React.useEffect(() => {
    if (!active) return;
    return mobileBackNavigationCoordinator.register({
      id,
      layer,
      onBack: handleBack,
      getSurface: () => surfaceRef.current,
    });
  }, [active, handleBack, id, layer, surfaceRef]);
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
  // Interactive native progress is already time-based. CSS transitions here
  // would interpolate every bridge update and visibly oscillate behind the finger.
  surface.style.transition = 'none';
  surface.style.animation = 'none';
  surface.style.willChange = 'transform, opacity';
  surface.style.transform = `translate3d(${progress * 100}%, 0, 0)`;
  surface.style.opacity = String(1 - progress * 0.04);
  surface.style.boxShadow = '-14px 0 28px color-mix(in srgb, var(--surface-foreground) 12%, transparent)';
  if (underlay) {
    underlay.style.transition = 'none';
    underlay.style.animation = 'none';
    underlay.style.willChange = 'transform, opacity';
    underlay.style.transform = `translate3d(${(progress - 1) * 8}%, 0, 0)`;
    underlay.style.opacity = String(0.88 + progress * 0.12);
  }
};

const settlePresentation = async (
  presentation: InteractivePresentation,
  commit: boolean,
): Promise<void> => {
  const progress = commit ? 1 : 0;
  const reducedMotion = typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (!reducedMotion && typeof presentation.surface.animate === 'function') {
    const currentTransform = presentation.surface.style.transform || 'translate3d(0%, 0, 0)';
    const animation = presentation.surface.animate(
      [
        { transform: currentTransform, opacity: presentation.surface.style.opacity || '1' },
        { transform: `translate3d(${progress * 100}%, 0, 0)`, opacity: commit ? 0.96 : 1 },
      ],
      { duration: commit ? 170 : 210, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' },
    );
    await animation.finished.catch(() => undefined);
  }
};

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
      const underlay = route.layer === 'root'
        ? surface.parentElement?.querySelector<HTMLElement>('[data-mobile-navigation-underlay="true"]') ?? null
        : null;
      presentationGeneration += 1;
      presentation = {
        route,
        surface,
        underlay,
        surfaceTransition: surface.style.transition,
        surfaceAnimation: surface.style.animation,
        underlayTransition: underlay?.style.transition ?? null,
        underlayAnimation: underlay?.style.animation ?? null,
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

    const finish = (commit: boolean) => {
      if (frame) {
        window.cancelAnimationFrame(frame);
        frame = 0;
      }
      const current = presentation;
      const generation = presentationGeneration;
      presentation = null;
      if (!current) {
        if (commit) mobileBackNavigationCoordinator.backImmediately();
        return;
      }
      settlingPresentation = current;
      void settlePresentation(current, commit).then(() => {
        if (generation !== presentationGeneration) return;
        clearPresentation(current);
        if (settlingPresentation === current) settlingPresentation = null;
        if (!disposed && commit) current.route.onBack();
      });
    };

    const unsubscribe = mobileBackNavigationCoordinator.subscribe(syncEnabled);
    const addListeners = async () => {
      const started = await OpenChamberNavigation.addListener('backStarted', begin);
      const progressed = await OpenChamberNavigation.addListener('backProgressed', (event) => update(event.progress ?? 0));
      const cancelled = await OpenChamberNavigation.addListener('backCancelled', () => finish(false));
      const invoked = await OpenChamberNavigation.addListener('backInvoked', () => finish(true));
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
        clearPresentation(settlingPresentation);
      }
      presentation = null;
      settlingPresentation = null;
      void OpenChamberNavigation.setEnabled({ enabled: false }).catch(() => undefined);
      handles.forEach((handle) => void handle.remove());
    };
  }, [enabled, rootRoutesBlocked]);
};
