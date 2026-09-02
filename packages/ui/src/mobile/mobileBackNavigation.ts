import * as React from 'react';
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { useEvent } from '@reactuses/core';

import { concealNativeComposerIfLeavingChat } from '@/lib/native-ios-composer-leave';
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
  /**
   * Deferred history pops keyed by route id. React Strict Mode (and other
   * remounts) run cleanup → re-register for the same id in one turn. Dropping
   * history synchronously in cleanup then pushing again races the async
   * history.back() and can dispatch the underlay route. Defer the pop and
   * cancel it when the same id reclaims the entry.
   */
  private readonly pendingHistoryRemovals = new Map<string, number>();
  private animatedBackDriver: ((route: RegisteredMobileBackRoute) => boolean) | null = null;
  private presentationCancelDriver: (() => void) | null = null;

  constructor(history: MobileBackHistory | null = browserHistory()) {
    this.history = history;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getTopRoute = (): RegisteredMobileBackRoute | null => this.routes.at(-1) ?? null;

  register = (route: MobileBackRoute): (() => void) => {
    const pendingToken = this.pendingHistoryRemovals.get(route.id);
    this.pendingHistoryRemovals.delete(route.id);

    // Strict Mode remount: the prior cleanup deferred a history.back for this
    // id and the browser is still on that entry — reclaim it instead of
    // pushState + racing back (which used to pop the chat underlay).
    const canReuseHistoryEntry = Boolean(
      this.history
      && pendingToken !== undefined
      && historyToken(this.history.currentState()) === pendingToken,
    );

    const registered: RegisteredMobileBackRoute = {
      ...route,
      token: canReuseHistoryEntry && pendingToken !== undefined
        ? pendingToken
        : this.nextToken++,
    };
    this.routes.push(registered);
    this.ensureHistoryListener();
    if (this.history && !canReuseHistoryEntry) {
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
        this.pendingHistoryRemovals.set(registered.id, registered.token);
        // Defer so a same-id re-register in this turn can cancel the pop.
        queueMicrotask(() => {
          const pending = this.pendingHistoryRemovals.get(registered.id);
          if (pending !== registered.token) return;
          this.pendingHistoryRemovals.delete(registered.id);
          if (!this.history || historyToken(this.history.currentState()) !== registered.token) {
            if (this.routes.length === 0 && this.pendingHistoryRemovals.size === 0) {
              this.disposeHistoryListener();
            }
            return;
          }
          this.programmaticHistoryBackToken = registered.token;
          this.history.back();
          if (this.routes.length === 0 && this.pendingHistoryRemovals.size === 0) {
            this.disposeHistoryListener();
          }
        });
      } else if (this.routes.length === 0 && this.pendingHistoryRemovals.size === 0) {
        this.disposeHistoryListener();
      }
      this.notify();
    };
  };

  backImmediately = (layer?: MobileBackRouteLayer): boolean => {
    const route = this.getTopRoute();
    if (!route || (layer && route.layer !== layer)) return false;
    return route.onBack() !== false;
  };

  requestAnimatedBack = (layer?: MobileBackRouteLayer): boolean => {
    const route = this.getTopRoute();
    if (!route || (layer && route.layer !== layer)) return false;
    if (this.animatedBackDriver?.(route)) return true;
    return this.backImmediately(layer);
  };

  setAnimatedBackDriver = (
    driver: ((route: RegisteredMobileBackRoute) => boolean) | null,
  ): (() => void) => {
    this.animatedBackDriver = driver;
    return () => {
      if (this.animatedBackDriver === driver) this.animatedBackDriver = null;
    };
  };

  setPresentationCancelDriver = (driver: (() => void) | null): (() => void) => {
    this.presentationCancelDriver = driver;
    return () => {
      if (this.presentationCancelDriver === driver) this.presentationCancelDriver = null;
    };
  };

  cancelPresentation = (): void => {
    this.presentationCancelDriver?.();
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
      // Unregister always splices the route out before calling history.back().
      // The pending programmatic token is therefore never equal to the *new*
      // top route — comparing only against top.token falsely treated that
      // synthetic pop as a user back and dispatched the underlay (e.g. chat
      // secondary page) when a short-lived overlay like image-preview cleaned
      // up (React Strict Mode remount, open flicker). Clear and ignore once.
      if (this.programmaticHistoryBackToken !== null) {
        this.programmaticHistoryBackToken = null;
        return;
      }
      const top = this.getTopRoute();
      if (!top) return;
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
    this.pendingHistoryRemovals.clear();
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

type NativeBackEvent = { progress?: number; velocityX?: number };

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

export const commitMobileBackRouteWithoutPresentation = (
  route: MobileBackRoute | null,
  eligible: boolean,
): boolean => {
  if (!route || !eligible) return false;
  return route.onBack() !== false;
};

export const resolveMobileBackSettleDuration = (input: {
  progress: number;
  commit: boolean;
  velocityX?: number;
  viewportWidth?: number;
}): number => {
  const progress = clampMobileBackProgress(input.progress);
  const remaining = input.commit ? 1 - progress : progress;
  if (remaining <= 0.001) return 0;
  const width = Math.max(1, input.viewportWidth ?? 390);
  const velocityPagesPerSecond = Math.abs(input.velocityX ?? 0) / width;
  const pagesPerSecond = Math.max(input.commit ? 2.4 : 2.8, velocityPagesPerSecond);
  const rawDuration = (remaining / pagesPerSecond) * 1000;
  const minimum = input.commit ? 90 : 100;
  const maximum = input.commit ? 320 : 260;
  return Math.round(Math.min(maximum, Math.max(minimum, rawDuration)));
};

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
  const { surface } = presentation;
  // Top page only. Underlay stays at rest so interactive back never parallax-shifts left.
  surface.style.transform = `translate3d(${progress * 100}%, 0, 0)`;
};

export const isMobileBackRouteAcknowledged = (input: {
  surfaceConnected: boolean;
  routeToken: number;
  topRouteToken: number | null;
  routeSurface: HTMLElement | null;
  outgoingSurface: HTMLElement;
}): boolean => (
  !input.surfaceConnected
  || input.topRouteToken !== input.routeToken
  || input.routeSurface !== input.outgoingSurface
);

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
      // Driver cleanup may intentionally interrupt this settlement.
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
    return;
  }
  element.style.transform = `translate3d(${targetPercent}%, 0, 0)`;
};

export const settleMobileBackSurface = async (
  surface: HTMLElement,
  commit: boolean,
  reducedMotion = typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  duration = resolveMobileBackSettleDuration({
    progress: Number.parseFloat(surface.style.transform.match(/translate3d\(([-\d.]+)%/)?.[1] ?? '0') / 100,
    commit,
  }),
): Promise<void> => settleMobileBackElement(
  surface,
  commit ? 100 : 0,
  duration,
  reducedMotion,
);

export class MobileBackCommitQueue {
  private pending = 0;

  enqueue(): void {
    this.pending += 1;
  }

  take(): boolean {
    if (this.pending === 0) return false;
    this.pending -= 1;
    return true;
  }

  clear(): void {
    this.pending = 0;
  }
}

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
    const commitQueue = new MobileBackCommitQueue();
    const handles: PluginListenerHandle[] = [];

    const routeIsEligible = (route: RegisteredMobileBackRoute | null): route is RegisteredMobileBackRoute => (
      Boolean(route) && (!rootRoutesBlocked || route?.layer === 'overlay')
    );

    const syncEnabled = () => {
      const nativeEnabled = routeIsEligible(mobileBackNavigationCoordinator.getTopRoute());
      void OpenChamberNavigation.setEnabled({ enabled: nativeEnabled }).catch(() => undefined);
    };

    const begin = () => {
      mobileBackNavigationCoordinator.cancelPresentation();
      if (settlingPresentation) return;
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
      // Underlay is retained for reveal but never translated.
      surface.style.transition = 'none';
      surface.style.animation = 'none';
      surface.style.willChange = 'transform';
      if (underlay) {
        underlay.style.removeProperty('transform');
        underlay.style.removeProperty('will-change');
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

    const waitForRouteAcknowledgment = (current: InteractivePresentation): Promise<void> => new Promise((resolve) => {
      let frame = 0;
      let framesRemaining = 12;
      let settled = false;
      const complete = () => {
        if (settled) return;
        settled = true;
        unsubscribe();
        if (frame) window.cancelAnimationFrame(frame);
        resolve();
      };
      const acknowledged = () => {
        const top = mobileBackNavigationCoordinator.getTopRoute();
        return isMobileBackRouteAcknowledged({
          surfaceConnected: current.surface.isConnected,
          routeToken: current.route.token,
          topRouteToken: top?.token ?? null,
          routeSurface: current.route.getSurface(),
          outgoingSurface: current.surface,
        });
      };
      const inspect = () => {
        if (acknowledged() || framesRemaining <= 0) {
          complete();
          return;
        }
        framesRemaining -= 1;
        frame = window.requestAnimationFrame(inspect);
      };
      const unsubscribe = mobileBackNavigationCoordinator.subscribe(() => {
        if (acknowledged()) complete();
      });
      inspect();
    });

    const finish = (commit: boolean, finalProgress?: number, velocityX?: number): boolean => {
      if (commit) concealNativeComposerIfLeavingChat();
      if (settlingPresentation) {
        if (commit && routeIsEligible(mobileBackNavigationCoordinator.getTopRoute())) {
          commitQueue.enqueue();
          return true;
        }
        return false;
      }
      if (frame) {
        window.cancelAnimationFrame(frame);
        frame = 0;
      }
      if (!presentation) begin();
      if (presentation && finalProgress !== undefined) {
        renderPresentation(presentation, finalProgress);
      }
      const current = presentation;
      const generation = presentationGeneration;
      presentation = null;
      if (!current) {
        if (!commit) return false;
        const route = mobileBackNavigationCoordinator.getTopRoute();
        return commitMobileBackRouteWithoutPresentation(route, routeIsEligible(route));
      }
      settlingPresentation = current;
      const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
      const progress = clampMobileBackProgress(finalProgress ?? latestProgress);
      const duration = resolveMobileBackSettleDuration({
        progress,
        commit,
        velocityX,
        viewportWidth: window.innerWidth,
      });
      void settleMobileBackSurface(current.surface, commit, reducedMotion, duration).then(async () => {
        if (generation !== presentationGeneration) return;
        if (!disposed && commit) {
          current.route.onBack();
          // Keep the outgoing surface parked until React detaches it or the
          // coordinator observes the replacement route. The frame cap only
          // bounds cleanup when an owner cannot publish acknowledgment.
          await waitForRouteAcknowledgment(current);
        }
        if (generation !== presentationGeneration) return;
        clearPresentation(current);
        if (settlingPresentation === current) settlingPresentation = null;
        if (!disposed && commitQueue.take()) {
          finish(true, 0, 0);
        }
      });
      return true;
    };

    const clearAnimatedBackDriver = mobileBackNavigationCoordinator.setAnimatedBackDriver((route) => {
      if (route !== mobileBackNavigationCoordinator.getTopRoute() || !routeIsEligible(route)) return false;
      return finish(true, 0, 0);
    });

    const unsubscribe = mobileBackNavigationCoordinator.subscribe(syncEnabled);
    const addListeners = async () => {
      const started = await OpenChamberNavigation.addListener('backStarted', begin);
      const progressed = await OpenChamberNavigation.addListener('backProgressed', (event) => update(event.progress ?? 0));
      const cancelled = await OpenChamberNavigation.addListener('backCancelled', (event) => finish(false, event.progress, event.velocityX));
      const invoked = await OpenChamberNavigation.addListener('backInvoked', (event) => finish(true, event.progress, event.velocityX));
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
      commitQueue.clear();
      unsubscribe();
      clearAnimatedBackDriver();
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
