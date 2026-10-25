/**
 * VS Code webview-local ordinary-notification session gate.
 *
 * Mirrors sidebar-visible root session rules used by Host notifications /
 * global session catalog: child sessions and system-owned sessions are
 * suppressed; contact-assigned workers stay eligible.
 */

export type NotificationSessionLike = {
  parentID?: string | null;
  metadata?: {
    yuri?: {
      assistant?: { assistantID?: string };
      assigned?: { from?: string };
      scheduledTask?: { taskID?: string };
      smallModel?: { purpose?: string };
      llm?: { purpose?: string };
    } | null;
  } | null;
} | null | undefined;

/**
 * Returns true when the session must not emit ordinary VS Code native
 * notifications (completion / question / permission).
 */
export const shouldSkipVSCodeNotificationSession = (
  session: NotificationSessionLike,
): boolean => {
  if (!session) return true;
  if (session.parentID) return true;

  const yuri = session.metadata?.yuri;
  if (!yuri || typeof yuri !== 'object') return false;

  // Truthy non-empty purpose only — empty string keeps ordinary-session semantics
  // (parity with Host notifications + globalSessions isSystemOwnedSession).
  if (yuri.smallModel?.purpose) return true;
  if (yuri.llm?.purpose) return true;
  if (yuri.scheduledTask?.taskID) return true;
  if (
    yuri.assistant?.assistantID
    && yuri.assigned?.from !== 'contact'
  ) {
    return true;
  }
  return false;
};
