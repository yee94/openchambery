import {
  LIVE_ACTIVITY_COMPLETE_DISMISSAL_SECONDS,
  LIVE_ACTIVITY_ERROR_DISMISSAL_SECONDS,
} from './constants';
import { buildDeepLink } from './deepLinks';

export const LIVE_ACTIVITY_STATUSES = [
  'working',
  'tool',
  'retry',
  'input',
  'permission',
  'stale',
  'complete',
  'error',
] as const;

export type LiveActivityStatus = (typeof LIVE_ACTIVITY_STATUSES)[number];

export type LiveActivityItem = {
  sessionId: string;
  title: string;
  status: LiveActivityStatus;
  startedAt: number;
  endedAt?: number;
};

export type LiveActivityRequest = {
  sessionId: string;
  startedAt?: number;
  status: LiveActivityStatus;
  eventVersion: number;
  updatedAt: number;
  endedAt?: number;
  dismissalSeconds?: number;
  title?: string;
  workingCount?: number;
  items?: LiveActivityItem[];
};

export function isLiveActivityStatus(value: string): value is LiveActivityStatus {
  return (LIVE_ACTIVITY_STATUSES as readonly string[]).includes(value);
}

export function validateLiveActivityRequest(
  request: LiveActivityRequest,
  requireStartedAt: boolean,
): string | null {
  if (!request.sessionId?.trim()) return 'sessionId is required';
  if (!isLiveActivityStatus(request.status)) return 'status is invalid';
  if (!Number.isFinite(request.eventVersion)) return 'eventVersion is required';
  if (!Number.isFinite(request.updatedAt)) return 'updatedAt is required';
  if (requireStartedAt && !Number.isFinite(request.startedAt)) return 'startedAt is required';
  return null;
}

/** Deep link for Live Activity / push row taps. */
export function liveActivitySessionUrl(sessionId: string): string {
  return buildDeepLink({ type: 'session', sessionId });
}

export async function isLiveActivitySupported(): Promise<boolean> {
  const { Platform } = await import('react-native');
  if (Platform.OS !== 'ios') return false;
  try {
    const { liveActivityNative } = await import('openchamber-system-shell');
    return liveActivityNative.isSupported();
  } catch {
    return false;
  }
}

export async function startLiveActivity(request: LiveActivityRequest): Promise<{ activityId?: string }> {
  const err = validateLiveActivityRequest(request, true);
  if (err) throw new Error(err);
  const { Platform } = await import('react-native');
  if (Platform.OS !== 'ios') return {};
  const { liveActivityNative } = await import('openchamber-system-shell');
  return liveActivityNative.start(request);
}

export async function updateLiveActivity(request: LiveActivityRequest): Promise<void> {
  const err = validateLiveActivityRequest(request, false);
  if (err) throw new Error(err);
  const { Platform } = await import('react-native');
  if (Platform.OS !== 'ios') return;
  const { liveActivityNative } = await import('openchamber-system-shell');
  await liveActivityNative.update(request);
}

export async function endLiveActivity(request: LiveActivityRequest): Promise<void> {
  const err = validateLiveActivityRequest(request, false);
  if (err) throw new Error(err);
  const { Platform } = await import('react-native');
  if (Platform.OS !== 'ios') return;
  const dismissal =
    request.dismissalSeconds ??
    (request.status === 'error'
      ? LIVE_ACTIVITY_ERROR_DISMISSAL_SECONDS
      : LIVE_ACTIVITY_COMPLETE_DISMISSAL_SECONDS);
  const { liveActivityNative } = await import('openchamber-system-shell');
  await liveActivityNative.end({ ...request, dismissalSeconds: dismissal });
}
