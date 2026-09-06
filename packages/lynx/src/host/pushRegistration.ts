/**
 * Cap `useNativePushRegistration` wiring for Lynx.
 * Host obtains APNs/FCM device tokens (Capacitor PushNotifications or native
 * APIs) and injects them here. Lynx stores the last token and registers with
 * Cap `POST|DELETE /api/push/apns-token` (platform-tagged so relay routes
 * APNs vs FCM). Respect FCM package-id pitfalls (docs/lynx-pitfalls.md §6).
 */
import type { LynxRuntimeFetch } from '../runtime/fetch';

/** Cap release / Play / CI applicationId — must appear in google-services.json. */
export const LYNX_FCM_APPLICATION_IDS = [
  'com.yee94.openchamber',
  'com.yee94.openchamber.debug',
] as const;

/** Legacy Java/R namespace only — not an FCM install id. */
export const LYNX_FCM_LEGACY_NAMESPACE = 'com.openchamber.app';

export type LynxPushPlatform = 'ios' | 'android';

export type LynxPushTokenPayload = {
  token: string;
  /** 'ios' (APNs) or 'android' (FCM). */
  platform: LynxPushPlatform;
  /** App UI locale so push titles match language. */
  locale?: string;
};

export type LynxPushRegisterResult =
  | { status: 'ok' }
  | { status: 'no-runtime' }
  | { status: 'no-token' }
  | { status: 'failed'; error: Error; httpStatus?: number }
  | {
      status: 'fcm-package-mismatch';
      applicationId: string;
      expected: readonly string[];
    };

export type LynxNativePushRegistration = {
  /** Last host-injected token (in-memory). */
  getLastToken: () => LynxPushTokenPayload | null;
  /** Host injects a fresh APNs/FCM token. */
  injectToken: (payload: LynxPushTokenPayload) => void;
  /** Register last (or given) token with Cap `/api/push/apns-token`. */
  registerWithServer: (
    runtimeFetch: LynxRuntimeFetch | null | undefined,
    payload?: LynxPushTokenPayload,
  ) => Promise<LynxPushRegisterResult>;
  /** Unregister token via DELETE `/api/push/apns-token`. */
  unregisterWithServer: (
    runtimeFetch: LynxRuntimeFetch | null | undefined,
    token?: string,
  ) => Promise<LynxPushRegisterResult>;
  /**
   * Optional Android applicationId check before register. When provided and
   * not in LYNX_FCM_APPLICATION_IDS, returns fcm-package-mismatch (does not
   * fake-success).
   */
  assertFcmApplicationId: (applicationId: string | null | undefined) => {
    ok: boolean;
    applicationId: string;
  };
};

const asRecord = (data: unknown): Record<string, unknown> => (
  data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {}
);

export const createLynxNativePushRegistration = (): LynxNativePushRegistration => {
  let lastToken: LynxPushTokenPayload | null = null;

  const injectToken = (payload: LynxPushTokenPayload): void => {
    const token = payload.token.trim();
    if (!token) return;
    lastToken = {
      token,
      platform: payload.platform === 'android' ? 'android' : 'ios',
      locale: payload.locale?.trim() || undefined,
    };
  };

  const getLastToken = (): LynxPushTokenPayload | null => lastToken;

  const assertFcmApplicationId = (applicationId: string | null | undefined) => {
    const id = applicationId?.trim() || '';
    return {
      ok: (LYNX_FCM_APPLICATION_IDS as readonly string[]).includes(id),
      applicationId: id,
    };
  };

  const registerWithServer = async (
    runtimeFetch: LynxRuntimeFetch | null | undefined,
    payload?: LynxPushTokenPayload,
  ): Promise<LynxPushRegisterResult> => {
    if (payload) injectToken(payload);
    if (!runtimeFetch) return { status: 'no-runtime' };
    const current = lastToken;
    if (!current?.token) return { status: 'no-token' };
    try {
      const response = await runtimeFetch('/api/push/apns-token', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          token: current.token,
          platform: current.platform,
          ...(current.locale ? { locale: current.locale } : {}),
        }),
      });
      if (response.status === 0) return { status: 'no-runtime' };
      if (!response.ok) {
        const body = asRecord(await response.json().catch(() => null));
        const message = typeof body.error === 'string' && body.error.trim()
          ? body.error.trim()
          : `push register failed (${response.status})`;
        return { status: 'failed', error: new Error(message), httpStatus: response.status };
      }
      return { status: 'ok' };
    } catch (error) {
      return {
        status: 'failed',
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  };

  const unregisterWithServer = async (
    runtimeFetch: LynxRuntimeFetch | null | undefined,
    token?: string,
  ): Promise<LynxPushRegisterResult> => {
    if (!runtimeFetch) return { status: 'no-runtime' };
    const value = (token ?? lastToken?.token)?.trim();
    if (!value) return { status: 'no-token' };
    try {
      const response = await runtimeFetch('/api/push/apns-token', {
        method: 'DELETE',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ token: value }),
      });
      if (response.status === 0) return { status: 'no-runtime' };
      if (!response.ok) {
        return {
          status: 'failed',
          error: new Error(`push unregister failed (${response.status})`),
          httpStatus: response.status,
        };
      }
      if (lastToken?.token === value) lastToken = null;
      return { status: 'ok' };
    } catch (error) {
      return {
        status: 'failed',
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  };

  return {
    getLastToken,
    injectToken,
    registerWithServer,
    unregisterWithServer,
    assertFcmApplicationId: (applicationId) => {
      const check = assertFcmApplicationId(applicationId);
      return check;
    },
  };
};

/**
 * Guard used by host before Android FCM register. Returns a typed failure
 * instead of posting a useless token when applicationId is wrong.
 */
export const guardLynxFcmApplicationId = (
  registration: LynxNativePushRegistration,
  applicationId: string | null | undefined,
): LynxPushRegisterResult | null => {
  if (!applicationId?.trim()) return null;
  const check = registration.assertFcmApplicationId(applicationId);
  if (check.ok) return null;
  return {
    status: 'fcm-package-mismatch',
    applicationId: check.applicationId,
    expected: LYNX_FCM_APPLICATION_IDS,
  };
};
