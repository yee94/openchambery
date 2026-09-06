import type { ActiveRuntime } from '@/lib/connectionController';
import { openchamberFetch } from '@/lib/openchamberClient';
import { Platform } from 'react-native';

export type ApnsTokenPayload = {
  token: string;
  platform?: string;
  locale?: string;
};

/**
 * Host push registration — same Cap contract:
 * POST /api/push/apns-token (iOS APNs + Android FCM token, tagged by platform)
 * POST /api/push/visibility heartbeat
 */
export async function registerApnsToken(
  active: ActiveRuntime,
  payload: ApnsTokenPayload,
): Promise<boolean> {
  const response = await openchamberFetch(active, '/api/push/apns-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: payload.token,
      platform: payload.platform ?? (Platform.OS === 'ios' ? 'ios' : 'android'),
      ...(payload.locale ? { locale: payload.locale } : {}),
    }),
  });
  return response.ok;
}

export async function unregisterApnsToken(
  active: ActiveRuntime,
  payload: Pick<ApnsTokenPayload, 'token' | 'platform'>,
): Promise<boolean> {
  const response = await openchamberFetch(active, '/api/push/apns-token', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: payload.token,
      platform: payload.platform ?? (Platform.OS === 'ios' ? 'ios' : 'android'),
    }),
  });
  return response.ok;
}

export async function setPushVisibility(
  active: ActiveRuntime,
  visible: boolean,
): Promise<boolean> {
  const response = await openchamberFetch(active, '/api/push/visibility', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      visible,
      platform: Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web',
    }),
  });
  return response.ok;
}

export async function registerLiveActivityToken(
  active: ActiveRuntime,
  payload: {
    activityId: string;
    sessionId: string;
    token: string;
    items?: {
      sessionId: string;
      title: string;
      status: string;
      startedAt: number;
      endedAt?: number;
    }[];
  },
): Promise<boolean> {
  const response = await openchamberFetch(active, '/api/push/live-activity-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.ok;
}
