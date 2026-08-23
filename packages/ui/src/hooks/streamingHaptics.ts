/**
 * Haptic feedback for Capacitor native mobile apps.
 *
 * Pure logic (platform checks, visible-session evaluation, dedup state machine)
 * lives here and is tested standalone. The hook wraps it with store subscriptions
 * and the native OpenChamber haptics plugin.
 */

import React from 'react';
import { Capacitor, registerPlugin } from '@capacitor/core';
import {
  createStreamingHapticEventDeduper,
  subscribeToStreamingHapticEvents,
} from '@/sync/streaming-haptic-events';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getClientPlatform } from '@/lib/platform';
import { notePerfHapticFired } from '@/sync/perf-diagnostics';

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? React.useLayoutEffect : React.useEffect;

export type MobileHapticStrength = 'light' | 'medium' | 'heavy';

type OpenChamberHapticsPlugin = {
  impactLight: () => Promise<void>;
  impactMedium: () => Promise<void>;
  impactHeavy: () => Promise<void>;
};

const OpenChamberHaptics = registerPlugin<OpenChamberHapticsPlugin>('OpenChamberHaptics');
let nativeHapticsAvailable: boolean | null = null;

const isNativeHapticsAvailable = (): boolean => {
  nativeHapticsAvailable ??= Capacitor.isPluginAvailable('OpenChamberHaptics');
  return nativeHapticsAvailable;
};

/** Maps declared strength to the matching native plugin method. */
export function resolveMobileHapticMethod(
  strength: MobileHapticStrength,
): keyof OpenChamberHapticsPlugin {
  switch (strength) {
    case 'medium':
      return 'impactMedium';
    case 'heavy':
      return 'impactHeavy';
    case 'light':
    default:
      return 'impactLight';
  }
}

// ---------------------------------------------------------------------------
// Pure logic – tested without Capacitor or React
// ---------------------------------------------------------------------------

/** True when running inside the Capacitor native shell (iOS / Android). */
export function isCapacitorNativePlatform(): boolean {
  if (typeof window === 'undefined') return false;
  const maybeCapacitor = (window as typeof window & {
    Capacitor?: { isNativePlatform?: () => boolean };
  }).Capacitor;
  return maybeCapacitor?.isNativePlatform?.() === true;
}

/** Platform is Capacitor AND the agent is iOS or Android (not a PWA inside a WebView pretending to be native). */
export function isCapacitorMobileNative(): boolean {
  if (!isCapacitorNativePlatform()) return false;
  const platform = (window as typeof window & {
    Capacitor?: { getPlatform?: () => string };
  }).Capacitor?.getPlatform?.();
  return platform === 'ios' || platform === 'android';
}

/** Snapshot of the store + environment used by the decision function. */
export type HapticsInput = {
  /** Session that produced the visible part update. */
  eventSessionId: string;
  /** Session currently displayed by the mobile shell. */
  currentSessionId: string | null;
  /** True when the app is in the foreground (e.g. `oc-native-app-active` class is set). */
  isForeground: boolean;
  /** True when document.visibilityState is 'visible'. */
  isVisible: boolean;
};

/** The result of evaluating whether haptics should fire. */
export type HapticsDecision = {
  shouldTrigger: boolean;
  reason: HapticsDecisionReason;
};

type HapticsDecisionReason =
  | 'trigger'
  | 'different-session'
  | 'background'
  | 'hidden';

/**
 * Pure function that determines whether an event belongs to the visible,
 * foreground session.
 */
export function evaluateHaptics(input: HapticsInput): HapticsDecision {
  const { eventSessionId, currentSessionId, isForeground, isVisible } = input;

  if (!currentSessionId || eventSessionId !== currentSessionId) {
    return {
      shouldTrigger: false,
      reason: 'different-session',
    };
  }

  // 2. App is backgrounded or hidden
  if (!isForeground) {
    return {
      shouldTrigger: false,
      reason: 'background',
    };
  }
  if (!isVisible) {
    return {
      shouldTrigger: false,
      reason: 'hidden',
    };
  }

  // 5. Fire
  return {
    shouldTrigger: true,
    reason: 'trigger',
  };
}

const HAPTIC_MIN_INTERVAL_MS = 20;
const STREAMING_TEXT_HAPTIC_MIN_INTERVAL_MS = 750;

export function shouldTriggerHaptic(lastTriggeredAt: number, now: number): boolean {
  return now - lastTriggeredAt >= HAPTIC_MIN_INTERVAL_MS;
}

export function shouldTriggerStreamingTextHaptic(lastTriggeredAt: number, now: number): boolean {
  return now - lastTriggeredAt >= STREAMING_TEXT_HAPTIC_MIN_INTERVAL_MS;
}

export type SwipeThresholdHapticEvent = 'enter' | 'cancel' | null;

export function evaluateSwipeThresholdHaptic(input: {
  thresholdReached: boolean;
  distance: number;
  enterDistance: number;
  cancelDistance: number;
  available: boolean;
}): { thresholdReached: boolean; event: SwipeThresholdHapticEvent } {
  if (!input.thresholdReached && input.available && input.distance >= input.enterDistance) {
    return { thresholdReached: true, event: 'enter' };
  }
  if (input.thresholdReached && (!input.available || input.distance <= input.cancelDistance)) {
    return { thresholdReached: false, event: 'cancel' };
  }
  return { thresholdReached: input.thresholdReached, event: null };
}

let lastHapticAt = Number.NEGATIVE_INFINITY;

/** Fires one haptic while the Capacitor mobile app is visible and active. */
export function triggerMobileHaptic(
  strength: MobileHapticStrength = 'light',
  options?: { bypassCadence?: boolean },
): boolean {
  if (!isCapacitorMobileNative()) return false;
  if (!isNativeHapticsAvailable()) return false;
  if (document.visibilityState !== 'visible' || !document.documentElement.classList.contains('oc-native-app-active')) return false;

  const now = Date.now();
  if (!options?.bypassCadence && !shouldTriggerHaptic(lastHapticAt, now)) return false;
  lastHapticAt = now;

  const method = resolveMobileHapticMethod(strength);
  void OpenChamberHaptics[method]().catch(() => undefined);
  notePerfHapticFired(strength);
  return true;
}

// Base UI menu items render as div[role="menuitem"] (nativeButton defaults
// false), so they must be included alongside ordinary buttons.
export const MOBILE_PRESS_TARGET_SELECTOR = 'button, [role="button"], [role="menuitem"]';

/** Adds light feedback when an enabled mobile control completes a tap. */
export function useMobilePressHaptics(): void {
  React.useEffect(() => {
    if (!isCapacitorMobileNative()) return;

    const handleClick = (event: MouseEvent) => {
      if (!event.isTrusted || !(event.target instanceof Element)) return;
      const control = event.target.closest<HTMLElement>(MOBILE_PRESS_TARGET_SELECTOR);
      if (!control) return;
      if (control.matches(':disabled, [aria-disabled="true"], [data-mobile-press-feedback="none"]')) return;
      // Button taps stay on light; medium/heavy are reserved for threshold
      // commits and deliberate stronger interactions.
      triggerMobileHaptic('light');
    };

    document.addEventListener('click', handleClick, true);
    return () => document.removeEventListener('click', handleClick, true);
  }, []);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Fires a light haptic when a visible streaming part updates.
 *
 * - Only active on Capacitor iOS / Android native builds.
 * - Android assistant text changes emit at most once every 750ms; reasoning and tool appearances fire once per part.
 */
export function useStreamingHaptics(): void {
  useIsomorphicLayoutEffect(() => {
    if (!isCapacitorMobileNative()) return;

    const shouldProcessEvent = createStreamingHapticEventDeduper();
    const limitStreamingTextHaptics = getClientPlatform() === 'android';
    let lastStreamingTextHapticAt = Number.NEGATIVE_INFINITY;

    const unsubscribe = subscribeToStreamingHapticEvents((event) => {
      if (!shouldProcessEvent(event)) return;

      const currentSessionId = useSessionUIStore.getState().currentSessionId;
      const isForeground = document.documentElement.classList.contains('oc-native-app-active');

      const decision = evaluateHaptics({
        eventSessionId: event.sessionID,
        currentSessionId,
        isForeground,
        isVisible: document.visibilityState === 'visible',
      });

      if (!decision.shouldTrigger) return;

      if (limitStreamingTextHaptics && event.kind === 'text') {
        const now = Date.now();
        if (!shouldTriggerStreamingTextHaptic(lastStreamingTextHapticAt, now)) return;
        if (triggerMobileHaptic()) {
          lastStreamingTextHapticAt = now;
        }
        return;
      }

      triggerMobileHaptic();
    });

    return unsubscribe;
  }, []);
}
