import type { SessionNavigationTarget } from '@/sync/session-navigation';
import type { SessionFocusIdentity } from '@/stores/useSessionFocusStore';

/**
 * Resolve which loaded navigation target should be revealed for sidebar focus.
 * Deep links often announce focus with projectId=null; fall back to sessionId
 * among already-built targets (never invents unloaded sessions).
 */
export function resolveFocusedProjectTarget(
  sessionFocus: SessionFocusIdentity | null,
  projectNavigationTargets: readonly SessionNavigationTarget[],
  metaProjectId: string | null = null,
): SessionNavigationTarget | null {
  if (!sessionFocus || sessionFocus.scope !== 'project' || !sessionFocus.sessionId) {
    return null;
  }

  if (sessionFocus.projectId) {
    const exact = projectNavigationTargets.find(
      (target) =>
        target.sessionId === sessionFocus.sessionId
        && target.projectId === sessionFocus.projectId,
    );
    if (exact) return exact;
  }

  if (metaProjectId) {
    const byMeta = projectNavigationTargets.find(
      (target) =>
        target.sessionId === sessionFocus.sessionId
        && target.projectId === metaProjectId,
    );
    if (byMeta) return byMeta;
  }

  return (
    projectNavigationTargets.find(
      (target) => target.sessionId === sessionFocus.sessionId,
    ) ?? null
  );
}
