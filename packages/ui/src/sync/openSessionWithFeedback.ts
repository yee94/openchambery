import { toast } from '@/components/ui';
import { formatMessage, useI18nStore } from '@/lib/i18n/store';
import type { I18nKey } from '@/lib/i18n/store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import { useMobileNavigationStore } from '@/mobile/useMobileNavigationStore';
import { isIPadApp } from '@/lib/platform';

export type OpenSessionFailureReason =
  | 'missing-session-id'
  | 'missing-directory'
  | 'tab-switch-blocked';

export type OpenSessionResult =
  | { ok: true; sessionId: string; directory: string }
  | { ok: false; reason: OpenSessionFailureReason; sessionId: string | null };

const nonEmpty = (value: string | null | undefined): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/** Shorten long session ids for toast copy (e.g. ses_01e1…hwsk). */
export function formatSessionIdForDisplay(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (trimmed.length <= 18) return trimmed;
  return `${trimmed.slice(0, 10)}…${trimmed.slice(-4)}`;
}

function t(key: I18nKey, params?: Record<string, string | number>): string {
  return formatMessage(useI18nStore.getState().dictionary, key, params);
}

/**
 * Show a visible error when a conversation cannot be opened.
 * Call from any non-React path (sync, dialogs, deep links).
 */
export function notifySessionOpenFailed(
  sessionId: string | null | undefined,
  reason: OpenSessionFailureReason = 'missing-directory',
): void {
  const displayId = nonEmpty(sessionId) ? formatSessionIdForDisplay(sessionId) : null;

  if (reason === 'missing-session-id' || !displayId) {
    toast.error(t('sessions.toast.openFailedMissingSessionId'));
    return;
  }

  if (reason === 'missing-directory') {
    toast.error(
      t('sessions.toast.openFailedMissingDirectory', { sessionId: displayId }),
    );
    return;
  }

  toast.error(t('sessions.toast.openFailed', { sessionId: displayId }));
}

export type OpenSessionWithFeedbackOptions = {
  /** Switch main tab to chat before opening (desktop). Default true. */
  switchToChat?: boolean;
  /**
   * Phone shell: push secondary chat route instead of only setCurrentSession.
   * Default: auto-detect via mobile nav store presence is not enough — callers
   * that know they are in phone panel should pass `phoneShell: true`.
   */
  phoneShell?: boolean;
  /** When false, skip toast (caller shows its own). Default true. */
  notify?: boolean;
};

/**
 * Open a session with required directory. Fails loudly when id or directory
 * is missing — never falls back to the current project cwd for "unknown" sessions.
 */
export function openSessionWithFeedback(
  sessionId: string | null | undefined,
  directory: string | null | undefined,
  options: OpenSessionWithFeedbackOptions = {},
): OpenSessionResult {
  const notify = options.notify !== false;

  if (!nonEmpty(sessionId)) {
    if (notify) notifySessionOpenFailed(null, 'missing-session-id');
    return { ok: false, reason: 'missing-session-id', sessionId: null };
  }

  if (!nonEmpty(directory)) {
    if (notify) notifySessionOpenFailed(sessionId, 'missing-directory');
    return { ok: false, reason: 'missing-directory', sessionId: sessionId.trim() };
  }

  const id = sessionId.trim();
  const dir = directory.trim();

  if (options.phoneShell && !isIPadApp()) {
    useMobileNavigationStore.getState().openSession({
      sessionId: id,
      directory: dir,
    });
    return { ok: true, sessionId: id, directory: dir };
  }

  if (options.switchToChat !== false) {
    if (!useUIStore.getState().setActiveMainTab('chat')) {
      if (notify) notifySessionOpenFailed(id, 'tab-switch-blocked');
      return { ok: false, reason: 'tab-switch-blocked', sessionId: id };
    }
  }

  void useSessionUIStore.getState().setCurrentSession(id, dir);
  return { ok: true, sessionId: id, directory: dir };
}
