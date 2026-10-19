import { useEffect } from 'react';
import { toast } from '@/components/ui/toast';
import { useI18n } from '@/lib/i18n';
import {
  androidNotifications, canUseAndroidNotifications, createAndroidNotificationController,
  resolveAndroidNotificationConfig,
} from '@/lib/native-android-notifications';
import { subscribeRuntimeAuthGeneration } from '@/lib/runtime-auth';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useUIStore } from '@/stores/useUIStore';

export function useAndroidNotifications(): void {
  const enabled = useUIStore((state) => state.nativeNotificationsEnabled);
  const { t, locale } = useI18n();
  const service = t('mobile.notifications.service');
  const alerts = t('settings.page.notifications.title');
  const connecting = t('mobile.connect.connecting');
  const connected = t('mobile.notifications.connected');
  const reconnecting = t('layout.browserProvider.status.reconnecting');
  const unavailable = t('mobile.notifications.unavailable');
  const gap = t('mobile.notifications.gap');
  const denied = t('settings.notifications.page.toast.permissionDenied.title');
  const error = t('settings.notifications.page.template.defaults.error.title');
  const auth = t('mobile.notifications.auth');
  const endpoint = t('mobile.notifications.endpoint');
  const response = t('mobile.notifications.response');
  const server = t('mobile.notifications.server');
  const relay = t('mobile.notifications.relay');
  const identity = t('mobile.notifications.identity');

  useEffect(() => {
    if (!canUseAndroidNotifications()) return;
    if (!enabled) { void androidNotifications.stop().catch(() => { console.warn('[Native notifications] stop failed'); }); return; }
    let warned = false;
    const warn = (message: string) => {
      if (warned) return;
      warned = true;
      toast.error(message);
    };
    const controller = createAndroidNotificationController({
      plugin: androidNotifications,
      resolveConfig: () => resolveAndroidNotificationConfig({ service, alerts, connecting, connected, reconnecting, unavailable, gap, error, auth, endpoint, response, server, relay, identity }, locale),
      onState: (state) => { if (state === 'denied' || state === 'unavailable') warn(state === 'denied' ? denied : unavailable); },
      onError: () => warn(unavailable),
    });
    const unsubscribeEndpoint = subscribeRuntimeEndpointChanged(() => { void controller.refresh(); });
    const unsubscribeAuth = subscribeRuntimeAuthGeneration(({ reason }) => {
      if (reason === 'invalidate') controller.stop();
      else if (reason !== 'endpoint-switch') void controller.refresh();
    });
    void controller.refresh();
    return () => { unsubscribeEndpoint(); unsubscribeAuth(); controller.dispose(); };
  }, [enabled, locale, service, alerts, connecting, connected, reconnecting, unavailable, gap, denied, error, auth, endpoint, response, server, relay, identity]);
}
