import type {
  ApnsTokenPayload,
  LiveActivityTokenPayload,
  LiveActivityTokenUnregisterPayload,
  PushAPI,
  PushSubscribePayload,
  PushUnsubscribePayload,
} from '@yuriai/ui/lib/api/types';
import { runtimeFetch } from '@yuriai/ui/lib/runtime-fetch';
import { getMobileAppId } from '@yuriai/ui/lib/mobileAppVersion';
import { getRuntimeTransportIdentity } from '@yuriai/ui/lib/runtime-switch';

const registerNativeToken = async (path: string, payload: ApnsTokenPayload | LiveActivityTokenPayload): Promise<{ ok: true } | null> => {
  const identity = getRuntimeTransportIdentity();
  try {
    const bundleId = await getMobileAppId();
    if (getRuntimeTransportIdentity() !== identity) return null;
    return fetchJson<{ ok: true }>(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, ...(bundleId ? { bundleId } : {}) }),
    });
  } catch {
    return null;
  }
};

const fetchJson = async <T>(input: string | URL | Request, init?: RequestInit): Promise<T | null> => {
  try {
    const res = await runtimeFetch(input, {
      ...init,
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(init?.headers ?? {}),
      },
    });

    if (!res.ok) {
      return null;
    }

    return (await res.json()) as T;
  } catch {
    return null;
  }
};

export const createWebPushAPI = (): PushAPI => ({
  async getVapidPublicKey() {
    return fetchJson<{ publicKey: string }>('/api/push/vapid-public-key');
  },

  async subscribe(payload: PushSubscribePayload) {
    return fetchJson<{ ok: true }>('/api/push/subscribe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  },

  async unsubscribe(payload: PushUnsubscribePayload) {
    return fetchJson<{ ok: true }>('/api/push/subscribe', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  },

  async setVisibility(payload: { visible: boolean; platform?: string }) {
    return fetchJson<{ ok: true }>('/api/push/visibility', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      keepalive: true,
    });
  },

  async registerApnsToken(payload: ApnsTokenPayload) {
    return registerNativeToken('/api/push/apns-token', payload);
  },

  async unregisterApnsToken(payload: ApnsTokenPayload) {
    return fetchJson<{ ok: true }>('/api/push/apns-token', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  },

  async registerLiveActivityToken(payload: LiveActivityTokenPayload) {
    return registerNativeToken('/api/push/live-activity-token', payload);
  },

  async unregisterLiveActivityToken(payload: LiveActivityTokenUnregisterPayload) {
    return fetchJson<{ ok: true }>('/api/push/live-activity-token', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  },
});
