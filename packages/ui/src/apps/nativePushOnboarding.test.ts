import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  requestNativePushOnMobileConnect,
  resetNativePushOnboardingForTests,
} from './nativePushOnboarding';

const requestPermissions = vi.fn().mockResolvedValue({ receive: 'granted' });
const checkPermissions = vi.fn().mockResolvedValue({ receive: 'prompt' });

vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: {
    checkPermissions,
    requestPermissions,
  },
}));

const setNativeNotificationsEnabled = vi.fn();
let nativeNotificationsEnabled = false;
let clientPlatform: 'ios' | 'android' = 'ios';

vi.mock('@/lib/platform', () => ({
  getClientPlatform: () => clientPlatform,
}));

vi.mock('@/stores/useUIStore', () => ({
  useUIStore: {
    getState: () => ({
      nativeNotificationsEnabled,
      setNativeNotificationsEnabled: (value: boolean) => {
        nativeNotificationsEnabled = value;
        setNativeNotificationsEnabled(value);
      },
    }),
  },
}));

describe('requestNativePushOnMobileConnect', () => {
  beforeEach(() => {
    clientPlatform = 'ios';
    nativeNotificationsEnabled = false;
    setNativeNotificationsEnabled.mockClear();
    requestPermissions.mockClear();
    checkPermissions.mockClear().mockResolvedValue({ receive: 'prompt' });
    resetNativePushOnboardingForTests();
  });

  afterEach(() => {
    resetNativePushOnboardingForTests();
  });

  it('enables native notifications and requests iOS permission on first connect', async () => {
    requestNativePushOnMobileConnect();
    expect(setNativeNotificationsEnabled).toHaveBeenCalledWith(true);
    await vi.waitFor(() => {
      expect(requestPermissions).toHaveBeenCalledTimes(1);
    });
  });

  it('does not show the iOS permission sheet again after the first attempt', async () => {
    requestNativePushOnMobileConnect();
    await vi.waitFor(() => expect(requestPermissions).toHaveBeenCalledTimes(1));
    requestPermissions.mockClear();
    requestNativePushOnMobileConnect();
    await new Promise((r) => setTimeout(r, 30));
    expect(requestPermissions).not.toHaveBeenCalled();
  });

  it('skips iOS requestPermissions when already granted', async () => {
    checkPermissions.mockResolvedValueOnce({ receive: 'granted' });
    requestNativePushOnMobileConnect();
    await vi.waitFor(() => expect(checkPermissions).toHaveBeenCalled());
    expect(requestPermissions).not.toHaveBeenCalled();
  });

  it('enables native notifications on Android without Capacitor push permission', async () => {
    clientPlatform = 'android';
    requestNativePushOnMobileConnect();
    expect(setNativeNotificationsEnabled).toHaveBeenCalledWith(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(requestPermissions).not.toHaveBeenCalled();
    expect(checkPermissions).not.toHaveBeenCalled();
  });
});
