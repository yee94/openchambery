import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';

export type DesktopNotificationOpenDetail = {
  sessionId?: string;
  directory?: string;
};

/**
 * Open a session from a native desktop notification click.
 * Electron routes the click to its originating window and rejects stale owners.
 * Keep that window's runtime: the session may belong to a direct or relay host.
 */
export function openSessionFromNotification(detail: DesktopNotificationOpenDetail): void {
  const sessionId = typeof detail?.sessionId === 'string' ? detail.sessionId.trim() : '';
  if (!sessionId) return;
  const directory = typeof detail?.directory === 'string' && detail.directory.trim().length > 0
    ? detail.directory.trim()
    : null;

  useUIStore.getState().setActiveMainTab('chat');
  void useSessionUIStore.getState().setCurrentSession(sessionId, directory);
}
