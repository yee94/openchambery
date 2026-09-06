import { getMetaStoreBackend } from '@/lib/metaStore';

const MOBILE_DEVICE_ID_STORAGE_KEY = 'openchamber.mobile.deviceId';

const createUuid = (): string => {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

let cachedDeviceId: string | null = null;

export const getMobileDeviceId = async (): Promise<string> => {
  if (cachedDeviceId) return cachedDeviceId;
  const store = getMetaStoreBackend();
  try {
    const existing = await store.getItem(MOBILE_DEVICE_ID_STORAGE_KEY);
    if (existing && existing.trim()) {
      cachedDeviceId = existing.trim();
      return cachedDeviceId;
    }
  } catch {
    // fall through
  }
  const generated = createUuid();
  cachedDeviceId = generated;
  try {
    await store.setItem(MOBILE_DEVICE_ID_STORAGE_KEY, generated);
  } catch {
    // ephemeral id
  }
  return generated;
};

export const mobileClientDedupeKey = async (): Promise<string> => `mobile:${await getMobileDeviceId()}`;

export const resetDeviceIdCacheForTests = (): void => {
  cachedDeviceId = null;
};

export { createUuid };

/** Cap-parity display platform for server device list ("ios" / "android"). */
export const mobileDevicePlatform = (): string | undefined => {
  try {
    // Lazy require so node unit tests never load the native module.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Platform } = require('react-native') as { Platform?: { OS?: string } };
    const os = Platform?.OS;
    return os === 'ios' || os === 'android' ? os : undefined;
  } catch {
    return undefined;
  }
};
