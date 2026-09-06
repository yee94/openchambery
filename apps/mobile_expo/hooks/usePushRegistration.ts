import { useEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';

import { useConnection } from '@/context/ConnectionContext';
import {
  registerApnsToken,
  setPushVisibility,
  unregisterApnsToken,
} from '@/lib/systemShell/pushApi';
import { sessionIdFromPushData } from '@/lib/systemShell/deepLinks';

type Options = {
  enabled: boolean;
  locale?: string;
  onOpenSession?: (sessionId: string) => void;
};

/**
 * Cap useNativePushRegistration equivalent using expo-notifications.
 * Device token → POST /api/push/apns-token; visibility heartbeat; tap → openchamber://session/{id}.
 */
export function usePushRegistration({ enabled, locale, onOpenSession }: Options): void {
  const { state } = useConnection();
  const lastTokenRef = useRef<string | null>(null);
  const localeRef = useRef(locale);
  localeRef.current = locale;

  useEffect(() => {
    if (!enabled || state.phase !== 'connected' || !state.active) return;
    if (Platform.OS !== 'ios' && Platform.OS !== 'android') return;

    let disposed = false;
    const cleanups: (() => void)[] = [];

    void (async () => {
      try {
        const Notifications = await import('expo-notifications');
        const Device = await import('expo-device');
        if (!Device.isDevice) return;

        const existing = await Notifications.getPermissionsAsync();
        let status = existing.status;
        if (status !== 'granted') {
          const requested = await Notifications.requestPermissionsAsync();
          status = requested.status;
        }
        if (status !== 'granted' || disposed) return;

        const tokenResult = await Notifications.getDevicePushTokenAsync();
        const token = typeof tokenResult.data === 'string' ? tokenResult.data : null;
        if (!token || !state.active || disposed) return;

        lastTokenRef.current = token;
        await registerApnsToken(state.active, {
          token,
          platform: Platform.OS === 'ios' ? 'ios' : 'android',
          locale: localeRef.current,
        });

        await setPushVisibility(state.active, AppState.currentState === 'active');

        const sub = AppState.addEventListener('change', (next) => {
          if (!state.active) return;
          void setPushVisibility(state.active, next === 'active');
        });
        cleanups.push(() => sub.remove());

        const responseSub = Notifications.addNotificationResponseReceivedListener((response) => {
          const data = response.notification.request.content.data as Record<string, unknown>;
          const sessionId = sessionIdFromPushData(data);
          if (sessionId) onOpenSession?.(sessionId);
        });
        cleanups.push(() => responseSub.remove());

        // Cold start
        const last = await Notifications.getLastNotificationResponseAsync();
        if (last) {
          const data = last.notification.request.content.data as Record<string, unknown>;
          const sessionId = sessionIdFromPushData(data);
          if (sessionId) onOpenSession?.(sessionId);
        }
      } catch {
        // Device/simulator without push entitlements — honest no-op
      }
    })();

    return () => {
      disposed = true;
      cleanups.forEach((fn) => fn());
    };
  }, [enabled, state.phase, state.active, onOpenSession]);

  useEffect(() => {
    if (!enabled || !state.active || !lastTokenRef.current || !locale) return;
    void registerApnsToken(state.active, {
      token: lastTokenRef.current,
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
      locale,
    });
  }, [locale, enabled, state.active]);

  useEffect(() => {
    if (enabled) return;
    const token = lastTokenRef.current;
    if (!token || !state.active) return;
    lastTokenRef.current = null;
    void unregisterApnsToken(state.active, {
      token,
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
    });
  }, [enabled, state.active]);
}
