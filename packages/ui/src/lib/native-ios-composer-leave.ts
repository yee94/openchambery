import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

import type { MobileSecondaryState } from '@/mobile/mobileNavigation';
import { useMobileNavigationStore } from '@/mobile/useMobileNavigationStore';

import { nativeIosComposerSession, type NativeIosComposerSession } from './native-ios-composer-session';

type NativeBackEvent = { progress?: number; velocityX?: number };

type OpenChamberNavigationPlugin = {
  addListener(
    eventName: 'backStarted' | 'backCancelled',
    listener: (event: NativeBackEvent) => void,
  ): Promise<PluginListenerHandle>;
};

const getOpenChamberNavigation = (): OpenChamberNavigationPlugin => (
  registerPlugin<OpenChamberNavigationPlugin>('OpenChamberNavigation')
);

const isComposerSecondary = (secondary: MobileSecondaryState | null): boolean => (
  secondary?.kind === 'chat' || secondary?.kind === 'draft'
);

/** Last chat/draft page leaving to Projects — hide before the underlay is fully on screen. */
export const shouldConcealNativeComposerOnBackStart = (
  secondary: MobileSecondaryState | null,
): boolean => {
  if (!secondary) return false;
  if (secondary.kind === 'draft') return true;
  return secondary.kind === 'chat' && secondary.routes.length <= 1;
};

export const didLeaveNativeComposerSurface = (
  previous: MobileSecondaryState | null,
  next: MobileSecondaryState | null,
): boolean => isComposerSecondary(previous) && !isComposerSecondary(next);

export const concealNativeComposerIfLeavingChat = (
  session: Pick<NativeIosComposerSession, 'conceal'> = nativeIosComposerSession,
): void => {
  if (shouldConcealNativeComposerOnBackStart(useMobileNavigationStore.getState().secondary)) {
    session.conceal();
  }
};

/**
 * Hide the singleton overlay as soon as chat is leaving (store close or the
 * first pixel of interactive back). Teardown still waits for `release`.
 * Nested chat pops keep the overlay — the parent page still owns it.
 */
export const attachNativeIosComposerLeaveConceal = (
  session: Pick<NativeIosComposerSession, 'conceal' | 'reveal'> = nativeIosComposerSession,
): (() => void) => {
  const unsubStore = useMobileNavigationStore.subscribe((state, prev) => {
    if (didLeaveNativeComposerSurface(prev.secondary, state.secondary)) {
      session.conceal();
    }
  });

  let handles: PluginListenerHandle[] = [];
  let cancelled = false;
  if (Capacitor.getPlatform() === 'ios') {
    void (async () => {
      const navigation = getOpenChamberNavigation();
      const started = await navigation.addListener('backStarted', () => {
        if (shouldConcealNativeComposerOnBackStart(useMobileNavigationStore.getState().secondary)) {
          session.conceal();
        }
      });
      const cancelledBack = await navigation.addListener('backCancelled', () => {
        session.reveal();
      });
      if (cancelled) {
        void started.remove();
        void cancelledBack.remove();
        return;
      }
      handles = [started, cancelledBack];
    })();
  }

  return () => {
    cancelled = true;
    unsubStore();
    for (const handle of handles) void handle.remove();
    handles = [];
  };
};
