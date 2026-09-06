/**
 * Cap session-index pin / unpin for Expo MobileSessionsSheet.
 * POST/DELETE /api/openchamber/session-index/session/:id/pin
 */

import type { ActiveRuntime } from '@/lib/connectionController';
import { openchamberFetch } from '@/lib/openchamberClient';

export class SessionIndexPinError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'SessionIndexPinError';
    this.status = status;
  }
}

const pinPath = (sessionId: string): string =>
  `/api/openchamber/session-index/session/${encodeURIComponent(sessionId.trim())}/pin`;

export async function pinSession(
  active: ActiveRuntime,
  sessionId: string,
  options?: { signal?: AbortSignal },
): Promise<void> {
  const id = sessionId.trim();
  if (!id) throw new SessionIndexPinError('session index pin requires a session id');
  const response = await openchamberFetch(active, pinPath(id), {
    method: 'POST',
    signal: options?.signal,
  });
  if (response.status === 501) {
    throw new SessionIndexPinError('session index pin is unsupported', 501);
  }
  if (!response.ok) {
    throw new SessionIndexPinError(`session index pin failed (${response.status})`, response.status);
  }
}

export async function unpinSession(
  active: ActiveRuntime,
  sessionId: string,
  options?: { signal?: AbortSignal },
): Promise<void> {
  const id = sessionId.trim();
  if (!id) throw new SessionIndexPinError('session index unpin requires a session id');
  const response = await openchamberFetch(active, pinPath(id), {
    method: 'DELETE',
    signal: options?.signal,
  });
  if (response.status === 501) {
    throw new SessionIndexPinError('session index unpin is unsupported', 501);
  }
  if (!response.ok) {
    throw new SessionIndexPinError(`session index unpin failed (${response.status})`, response.status);
  }
}

export async function togglePinnedSession(
  active: ActiveRuntime,
  sessionId: string,
  currentlyPinned: boolean,
  options?: { signal?: AbortSignal },
): Promise<boolean> {
  if (currentlyPinned) {
    await unpinSession(active, sessionId, options);
    return false;
  }
  await pinSession(active, sessionId, options);
  return true;
}
