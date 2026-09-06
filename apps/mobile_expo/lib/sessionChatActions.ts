/**
 * Cap session overflow actions for Expo Chat — share / fork / refresh helpers.
 * POST /api/session/:id/share , POST /api/session/:id/fork
 */

import type { ActiveRuntime } from '@/lib/connectionController';
import { openchamberFetch } from '@/lib/openchamberClient';

export class SessionChatActionsError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'SessionChatActionsError';
    this.status = status;
  }
}

const withDirectory = (path: string, directory?: string | null): string => {
  if (!directory?.trim()) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}directory=${encodeURIComponent(directory.trim())}`;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export type SharedSession = {
  id: string;
  shareUrl: string | null;
};

export async function shareChatSession(
  active: ActiveRuntime,
  sessionId: string,
  directory?: string | null,
): Promise<SharedSession> {
  const path = withDirectory(`/api/session/${encodeURIComponent(sessionId)}/share`, directory);
  const response = await openchamberFetch(active, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!response.ok) {
    throw new SessionChatActionsError(`session.share failed (${response.status})`, response.status);
  }
  const payload = asRecord(await response.json()) ?? {};
  const data = asRecord(payload.data) ?? payload;
  const share = asRecord(data.share);
  const shareUrl =
    (typeof share?.url === 'string' && share.url) ||
    (typeof data.shareUrl === 'string' && data.shareUrl) ||
    null;
  return {
    id: typeof data.id === 'string' ? data.id : sessionId,
    shareUrl,
  };
}

export async function forkChatSession(
  active: ActiveRuntime,
  sessionId: string,
  options?: { messageId?: string | null; directory?: string | null },
): Promise<{ id: string }> {
  const path = withDirectory(`/api/session/${encodeURIComponent(sessionId)}/fork`, options?.directory);
  const body: Record<string, string> = {};
  if (options?.messageId?.trim()) body.messageID = options.messageId.trim();
  const response = await openchamberFetch(active, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new SessionChatActionsError(`session.fork failed (${response.status})`, response.status);
  }
  const payload = asRecord(await response.json()) ?? {};
  const data = asRecord(payload.data) ?? payload;
  const id = typeof data.id === 'string' ? data.id : null;
  if (!id) throw new SessionChatActionsError('session.fork missing id', response.status);
  return { id };
}
