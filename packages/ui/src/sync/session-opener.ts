import {
  notifySessionOpenFailed,
  openSessionWithFeedback,
  type OpenSessionResult,
} from './openSessionWithFeedback';

type SessionOpener = (sessionID: string, directory: string) => void;

let sessionOpener: SessionOpener | null = null;

export const setSessionOpener = (opener: SessionOpener | null) => {
  sessionOpener = opener;
};

/**
 * Open a session from toasts / scheduled history / notifications.
 * Requires a non-empty directory; shows an error toast when the conversation
 * cannot be loaded (missing id or workspace path).
 */
export const openSessionFromToast = (
  sessionID: string | null | undefined,
  directory: string | null | undefined,
): OpenSessionResult => {
  if (typeof sessionOpener === 'function'
    && typeof sessionID === 'string'
    && sessionID.trim()
    && typeof directory === 'string'
    && directory.trim()
  ) {
    // Prefer registered opener when both args are valid (full app wiring).
    sessionOpener(sessionID.trim(), directory.trim());
    return { ok: true, sessionId: sessionID.trim(), directory: directory.trim() };
  }

  // Fallback path with validation + toast (and when opener not registered yet).
  return openSessionWithFeedback(sessionID, directory, { switchToChat: true });
};

export { notifySessionOpenFailed, openSessionWithFeedback };
