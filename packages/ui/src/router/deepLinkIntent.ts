import type { DeepLinkIntent } from '@/apps/deepLinks';
import type { NavigationIntent } from './navigationIntent';

/**
 * Map `openchamber://` deep-link intents that have a browser path counterpart
 * into NavigationIntent for createAppNavigation().applyIntent.
 *
 * Intents that are shell-only (sessions sheet, status panel, open-project draft,
 * pairing connect payload) return null — deepLinkNavigation still owns those.
 */
export function deepLinkToNavigationIntent(
  intent: DeepLinkIntent,
): NavigationIntent | null {
  switch (intent.type) {
    case 'session':
      return {
        type: 'session',
        sessionId: intent.sessionId,
        // directory is runtime context, not path
      };
    case 'new-session':
      return { type: 'new-session' };
    case 'settings':
      return { type: 'settings', slug: intent.section ?? 'home' };
    case 'changes':
      return {
        type: 'session',
        sessionId: '', // caller must supply current session when empty
        tab: 'git',
        file: intent.path ?? null,
      };
    case 'view':
      if (intent.target === 'files') {
        return { type: 'session', sessionId: '', tab: 'files' };
      }
      if (intent.target === 'mcp' || intent.target === 'instances') {
        return {
          type: 'settings',
          slug: intent.target === 'mcp' ? 'mcp' : 'remote-instances',
        };
      }
      return null;
    case 'connect':
      return { type: 'connect' };
    case 'open-project':
    case 'sessions':
    case 'status':
      return null;
    default: {
      const _exhaustive: never = intent;
      void _exhaustive;
      return null;
    }
  }
}

/**
 * Resolve a deep-link navigation intent that may need the current session id
 * (changes / view files).
 */
export function resolveDeepLinkNavigationIntent(
  intent: DeepLinkIntent,
  currentSessionId: string | null,
): NavigationIntent | null {
  const mapped = deepLinkToNavigationIntent(intent);
  if (!mapped) return null;

  if (mapped.type === 'session' && !mapped.sessionId) {
    if (!currentSessionId) return null;
    return { ...mapped, sessionId: currentSessionId };
  }

  return mapped;
}
