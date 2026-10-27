import { getClientPlatform } from '@/lib/platform';
import { useUIStore } from '@/stores/useUIStore';

const onboardingKeyForPlatform = (platform: 'ios' | 'android'): string =>
  `yuri.${platform}PushOnboardingAttempted`;

const readOnboardingAttempted = (platform: 'ios' | 'android'): boolean => {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(onboardingKeyForPlatform(platform)) === '1';
  } catch {
    return true;
  }
};

const markOnboardingAttempted = (platform: 'ios' | 'android'): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(onboardingKeyForPlatform(platform), '1');
  } catch {
    // ignore quota / private mode
  }
};

const requestIosPushPermissionOnce = (): void => {
  if (readOnboardingAttempted('ios')) return;
  markOnboardingAttempted('ios');

  void import('@capacitor/push-notifications')
    .then(async ({ PushNotifications }) => {
      const permission = await PushNotifications.checkPermissions().catch(() => null);
      if (permission?.receive === 'granted') return;
      await PushNotifications.requestPermissions().catch(() => null);
    })
    .catch(() => undefined);
};

/**
 * Android notification permission is requested inside `YuriNotificationsPlugin.configure`
 * when `useAndroidNotifications` starts the foreground service. Mark onboarding here so
 * we only auto-enable once per install; the hook handles the system dialog.
 */
const markAndroidPushOnboardingAttempted = (): void => {
  if (readOnboardingAttempted('android')) return;
  markOnboardingAttempted('android');
};

/**
 * After the first successful mobile connection (pairing redeem or saved reconnect),
 * turn on native push/notification registration in app state and trigger the platform
 * permission flow once per install. Does not block the connection flow.
 */
export const requestNativePushOnMobileConnect = (): void => {
  if (typeof window === 'undefined') return;
  const platform = getClientPlatform();
  if (platform !== 'ios' && platform !== 'android') return;

  const store = useUIStore.getState();
  if (!store.nativeNotificationsEnabled) {
    store.setNativeNotificationsEnabled(true);
  }

  if (platform === 'ios') {
    requestIosPushPermissionOnce();
    return;
  }
  markAndroidPushOnboardingAttempted();
};

/** @internal test hook */
export const resetNativePushOnboardingForTests = (): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(onboardingKeyForPlatform('ios'));
    window.localStorage.removeItem(onboardingKeyForPlatform('android'));
  } catch {
    // ignore
  }
};
