/**
 * Cap `@aparajita/capacitor-secure-storage` spirit for Lynx.
 * Host injects Keychain (iOS) / EncryptedSharedPreferences+Keystore (Android).
 * Without host → memory/unavailable — never log token values.
 *
 * Cap source: packages/ui/src/apps/mobileConnections.ts (internalGetItem/Set/Remove
 * with prefixedKey + KeychainAccess.whenUnlocked + bounded timeout).
 */
import type { LynxSecureStore } from '../connection/types';

export const LYNX_SECURE_STORAGE_PREFIX = 'openchamber.mobile.';
export const LYNX_SECURE_TIMEOUT_MS = 2_500;

/** Cap KeychainAccess.whenUnlocked = 0 */
export const LYNX_KEYCHAIN_ACCESS_WHEN_UNLOCKED = 0;

export type LynxSecureStoreNativeCall =
  | { op: 'get'; prefixedKey: string }
  | { op: 'set'; prefixedKey: string; data: string; access: number }
  | { op: 'delete'; prefixedKey: string };

/**
 * Host binder — real API shape mirrors Cap plugin native methods.
 * iOS: SecItemCopyMatching / SecItemAdd / SecItemDelete (kSecAttrAccessibleWhenUnlocked).
 * Android: EncryptedSharedPreferences (MasterKey / AES256_GCM).
 */
export type LynxSecureStoreBinder = {
  getItem: (options: { prefixedKey: string; sync?: boolean }) => Promise<string | null | undefined>;
  setItem: (options: {
    prefixedKey: string;
    data: string;
    sync?: boolean;
    access?: number;
  }) => Promise<void>;
  removeItem: (options: { prefixedKey: string; sync?: boolean }) => Promise<void>;
};

export type LynxSecureStoreAdapter = LynxSecureStore & {
  inject: (binder: LynxSecureStoreBinder | null) => void;
  isAvailable: () => boolean;
};

const withTimeout = async <T,>(operation: Promise<T>, fallback: T, ms = LYNX_SECURE_TIMEOUT_MS): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timeoutId = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([operation.catch(() => fallback), timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
};

export const lynxSecurePrefixedTokenKey = (connectionKey: string): string =>
  `${LYNX_SECURE_STORAGE_PREFIX}token.${encodeURIComponent(connectionKey)}`;

/**
 * Host-backed secure store. Bound every call so a hung Keychain never blocks connect.
 * No host → get returns undefined, set returns false, delete no-ops (honest).
 */
export const createLynxSecureStoreAdapter = (): LynxSecureStoreAdapter => {
  let binder: LynxSecureStoreBinder | null = null;
  return {
    inject: (next) => {
      binder = next;
    },
    isAvailable: () => binder !== null,
    get: async (key) => {
      if (!binder) return undefined;
      const value = await withTimeout(
        binder.getItem({ prefixedKey: key, sync: false }).then((data) => (
          typeof data === 'string' && data.trim() ? data : undefined
        )),
        undefined,
      );
      return value;
    },
    set: async (key, value) => {
      if (!binder) return false;
      return withTimeout(
        binder.setItem({
          prefixedKey: key,
          data: value,
          sync: false,
          access: LYNX_KEYCHAIN_ACCESS_WHEN_UNLOCKED,
        }).then(() => true),
        false,
      );
    },
    delete: async (key) => {
      if (!binder) return;
      await withTimeout(
        binder.removeItem({ prefixedKey: key, sync: false }).then(() => true),
        false,
      );
    },
  };
};
