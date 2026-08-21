import {
  isLocalRuntimeActive,
  switchToLocalDesktopRuntime,
} from '@/lib/desktopLocalRuntime';
import {
  getRuntimeKey,
  subscribeRuntimeEndpointChanged,
} from '@/lib/runtime-switch';
import { notifySessionOpenFailed } from '@/sync/openSessionWithFeedback';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';

export type DesktopNotificationOpenDetail = {
  sessionId?: string;
  directory?: string;
};

/**
 * Delay after runtimeKey becomes `local` before setCurrentSession.
 * App.tsx's runtime-endpoint coalescer uses 50ms before resetAppForRuntimeEndpointChange;
 * 100ms lets restoreForRuntimeSwitch finish so it does not overwrite the session we open.
 */
const OPEN_AFTER_LOCAL_RUNTIME_MS = 100;

/** Abandon a pending notification open if the local switch never settles. */
const PENDING_OPEN_TIMEOUT_MS = 10_000;

type PendingNotificationOpen = {
  unsubscribe: (() => void) | null;
  openTimer: ReturnType<typeof setTimeout> | null;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
};

let pending: PendingNotificationOpen | null = null;

const clearPending = (): void => {
  if (!pending) return;
  pending.unsubscribe?.();
  if (pending.openTimer !== null) clearTimeout(pending.openTimer);
  if (pending.timeoutTimer !== null) clearTimeout(pending.timeoutTimer);
  pending = null;
};

/** Clear any in-flight notification open (App unmount / remount). */
export function disposePendingNotificationOpen(): void {
  clearPending();
}

const openOnLocalRuntime = (sessionId: string, directory: string | null): void => {
  useUIStore.getState().setActiveMainTab('chat');
  void useSessionUIStore.getState().setCurrentSession(sessionId, directory);
};

/**
 * Open a session from a native desktop notification click.
 * Notifications always belong to the local runtime; switch there first when needed.
 */
export function openSessionFromNotification(detail: DesktopNotificationOpenDetail): void {
  const sessionId = typeof detail?.sessionId === 'string' ? detail.sessionId.trim() : '';
  if (!sessionId) return;
  const directory = typeof detail?.directory === 'string' && detail.directory.trim().length > 0
    ? detail.directory.trim()
    : null;

  if (isLocalRuntimeActive()) {
    openOnLocalRuntime(sessionId, directory);
    return;
  }

  // Drop any prior pending open so a second click does not race timers.
  clearPending();

  void switchToLocalDesktopRuntime().then((result) => {
    if (!result.ok) {
      notifySessionOpenFailed(sessionId, 'missing-directory');
      return;
    }

    // Switch may be a no-op / complete before any endpoint-changed event fires.
    if (getRuntimeKey() === 'local') {
      openOnLocalRuntime(sessionId, directory);
      return;
    }

    let opened = false;
    const openOnce = (): void => {
      if (opened) return;
      opened = true;
      clearPending();
      openOnLocalRuntime(sessionId, directory);
    };

    const unsubscribe = subscribeRuntimeEndpointChanged((endpointDetail) => {
      if (endpointDetail.runtimeKey !== 'local') return;
      unsubscribe();
      if (pending) pending.unsubscribe = null;
      // Wait for App coalescer (50ms) + restoreForRuntimeSwitch before setting session.
      const openTimer = setTimeout(() => {
        if (pending) pending.openTimer = null;
        openOnce();
      }, OPEN_AFTER_LOCAL_RUNTIME_MS);
      if (pending) pending.openTimer = openTimer;
    });

    const timeoutTimer = setTimeout(() => {
      if (opened) return;
      clearPending();
      notifySessionOpenFailed(sessionId, 'missing-directory');
    }, PENDING_OPEN_TIMEOUT_MS);

    pending = {
      unsubscribe,
      openTimer: null,
      timeoutTimer,
    };
  });
}
