import type { MobileTabId } from './mobileTabs';

/**
 * Mobile-owned navigation state for the dedicated mobile shell.
 *
 * The desktop `MainTab` / URL router intentionally stays out of this model:
 * mobile navigation is a root tab plus a lightweight push-route stack.
 */
export type MobileChatRoute = {
  key: string;
  sessionId: string;
  directory: string | null;
};

export type MobileSecondaryState =
  | {
      /** Chat routes are metadata-only; the phone host renders the top two. */
      kind: 'chat';
      routes: MobileChatRoute[];
    }
  | {
      /** New-session draft composer: the primary ChatView renders the draft
          for the store-owned current directory. */
      kind: 'draft';
    }
  | {
      /** Assistant conversation page. The selected Assistant is owned by the
          Assistant UI store; navigation only owns the page depth. */
      kind: 'assistant';
    };

export type MobileNavigationState = {
  activeTab: MobileTabId;
  secondary: MobileSecondaryState | null;
};

export type MobileNavigationActions = {
  setActiveTab: (tab: MobileTabId) => void;
  openChat: (target: { sessionId: string; directory?: string | null }) => void;
  openAssistant: (assistantID: string) => void;
  closeSecondary: () => void;
};

export function pushMobileChatRoute(
  routes: readonly MobileChatRoute[],
  route: MobileChatRoute,
): MobileChatRoute[] {
  const existingIndex = routes.findIndex((candidate) => candidate.sessionId === route.sessionId);
  if (existingIndex >= 0) return routes.slice(0, existingIndex + 1) as MobileChatRoute[];
  return [...routes, route];
}

export function popMobileChatRoute(routes: readonly MobileChatRoute[]): MobileChatRoute[] {
  return routes.length > 1 ? routes.slice(0, -1) : [];
}

export function replaceMobileChatRoute(
  routes: readonly MobileChatRoute[],
  route: MobileChatRoute,
): MobileChatRoute[] {
  const current = routes.at(-1);
  return [{ ...route, key: current?.key ?? route.key }];
}

export function reconcileMobileChatPredecessor(
  routes: readonly MobileChatRoute[],
  parent: MobileChatRoute,
): MobileChatRoute[] {
  const top = routes.at(-1);
  if (!top || top.sessionId === parent.sessionId) return routes as MobileChatRoute[];
  const predecessor = routes.at(-2);
  if (predecessor?.sessionId === parent.sessionId) {
    if (predecessor.directory === parent.directory) return routes as MobileChatRoute[];
    return [...routes.slice(0, -2), parent, top];
  }
  if (routes.length === 1) return [parent, top];
  return routes as MobileChatRoute[];
}

export const INITIAL_MOBILE_NAVIGATION_STATE: MobileNavigationState = {
  activeTab: 'projects',
  secondary: null,
};

/**
 * Back priority for the dedicated mobile shell. Lower numbers run first.
 * Modal/window surfaces keep their existing handlers in MobileApp; the chat
 * secondary page sits between overlays and the root tab switch.
 */
export const MOBILE_BACK_PRIORITY = {
  overlays: 0,
  secondaryPage: 1,
  rootTab: 2,
} as const;

/** Slim parent target for secondary-page back (authoritative child.parentID). */
export type MobileParentSessionTarget = {
  id: string;
  directory: string | null;
};

/**
 * Pure back decision for the phone secondary page (after scheduled-editor
 * handlers). Chat with a parent keeps secondary open and switches session;
 * draft / assistant / root chat close secondary; no secondary is a no-op.
 */
export type MobileSecondaryBackDecision =
  | { action: 'none' }
  | { action: 'closeSecondary' }
  | { action: 'popChatSession'; parent: MobileParentSessionTarget };

export function resolveMobileSecondaryBackDecision(input: {
  secondary: MobileSecondaryState | null;
  parentSessionTarget: MobileParentSessionTarget | null;
}): MobileSecondaryBackDecision {
  if (!input.secondary) return { action: 'none' };
  if (input.secondary.kind === 'chat' && input.secondary.routes.length > 1) {
    const predecessor = input.secondary.routes.at(-2)!;
    return {
      action: 'popChatSession',
      parent: { id: predecessor.sessionId, directory: predecessor.directory },
    };
  }
  return { action: 'closeSecondary' };
}
