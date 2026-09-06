import { isLynxTabId, type LynxTabId } from './tabs';

/**
 * Phone navigation: one root tab plus a lightweight push stack.
 * Mirrors Capacitor `mobileNavigation.ts`. Native code never owns this stack.
 */
export type LynxChatRoute = {
  key: string;
  sessionId: string;
  directory: string | null;
};

export type LynxSecondaryKind = 'chat' | 'draft' | 'assistant' | 'instances';

export type LynxSecondaryState =
  | {
      kind: 'chat';
      routes: LynxChatRoute[];
    }
  | {
      kind: 'draft';
      directory?: string | null;
    }
  | {
      /** Assistant conversation page — Cap depth; Lynx reuses chat chrome when session exists. */
      kind: 'assistant';
      assistantId: string;
      sessionId: string | null;
      directory: string | null;
      title?: string | null;
    }
  | {
      kind: 'instances';
    };

export type LynxNavigationState = {
  activeTab: LynxTabId;
  secondary: LynxSecondaryState | null;
};

export const INITIAL_LYNX_NAVIGATION_STATE: LynxNavigationState = {
  activeTab: 'projects',
  secondary: null,
};

export const LYNX_BACK_PRIORITY = {
  overlays: 0,
  secondaryPage: 1,
  rootTab: 2,
} as const;

export type LynxParentSessionTarget = {
  id: string;
  directory: string | null;
};

export type LynxSecondaryBackDecision =
  | { action: 'none' }
  | { action: 'closeSecondary' }
  | { action: 'popChatSession'; parent: LynxParentSessionTarget };

export function pushLynxChatRoute(
  routes: readonly LynxChatRoute[],
  route: LynxChatRoute,
): LynxChatRoute[] {
  const existingIndex = routes.findIndex((candidate) => candidate.sessionId === route.sessionId);
  if (existingIndex >= 0) return routes.slice(0, existingIndex + 1);
  return [...routes, route];
}

export function popLynxChatRoute(routes: readonly LynxChatRoute[]): LynxChatRoute[] {
  return routes.length > 1 ? routes.slice(0, -1) : [];
}

export function replaceLynxChatRoute(
  routes: readonly LynxChatRoute[],
  route: LynxChatRoute,
): LynxChatRoute[] {
  const current = routes.at(-1);
  return [{ ...route, key: current?.key ?? route.key }];
}


export function reconcileLynxChatPredecessor(
  routes: readonly LynxChatRoute[],
  parent: LynxChatRoute,
): LynxChatRoute[] {
  const top = routes.at(-1);
  if (!top || top.sessionId === parent.sessionId) return [...routes];
  const predecessor = routes.at(-2);
  if (predecessor?.sessionId === parent.sessionId) {
    if (predecessor.directory === parent.directory) return [...routes];
    return [...routes.slice(0, -2), parent, top];
  }
  if (routes.length === 1) return [parent, top];
  return [...routes];
}

/** Cap phone stack: top chat + immediate predecessor for underlay chrome. */
export function lynxChatStackWindow(
  routes: readonly LynxChatRoute[],
): { top: LynxChatRoute | null; predecessor: LynxChatRoute | null } {
  const top = routes.at(-1) ?? null;
  const predecessor = routes.length > 1 ? routes.at(-2) ?? null : null;
  return { top, predecessor };
}

export function resolveLynxSecondaryBackDecision(input: {
  secondary: LynxSecondaryState | null;
  parentSessionTarget: LynxParentSessionTarget | null;
}): LynxSecondaryBackDecision {
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

export type LynxNavigationAction =
  | { type: 'setActiveTab'; tab: LynxTabId }
  | { type: 'openChat'; sessionId: string; directory?: string | null }
  | { type: 'pushChat'; sessionId: string; directory?: string | null }
  | { type: 'popChat' }
  | { type: 'openDraft'; directory?: string | null }
  | {
      type: 'openAssistant';
      assistantId: string;
      sessionId?: string | null;
      directory?: string | null;
      title?: string | null;
    }
  | { type: 'openInstances' }
  | { type: 'closeSecondary' }
  | { type: 'reconcileChatParent'; sessionId: string; directory?: string | null }
  | { type: 'reset' };

function createChatRoute(
  sessionId: string,
  directory: string | null,
  key: string,
): LynxChatRoute {
  return { key, sessionId, directory };
}

/**
 * Pure reducer for the phone shell. Switching a root tab always closes the
 * secondary page so Chat cannot linger as a hidden fifth surface.
 */
export function reduceLynxNavigation(
  state: LynxNavigationState,
  action: LynxNavigationAction,
): LynxNavigationState {
  switch (action.type) {
    case 'setActiveTab':
      if (!isLynxTabId(action.tab)) return state;
      return { activeTab: action.tab, secondary: null };
    case 'openChat':
      return {
        ...state,
        secondary: {
          kind: 'chat',
          routes: [createChatRoute(action.sessionId, action.directory ?? null, 'chat-primary')],
        },
      };
    case 'pushChat': {
      const route = createChatRoute(
        action.sessionId,
        action.directory ?? null,
        `chat-push-${action.sessionId}`,
      );
      const routes = state.secondary?.kind === 'chat'
        ? pushLynxChatRoute(state.secondary.routes, route)
        : [route];
      return { ...state, secondary: { kind: 'chat', routes } };
    }
    case 'popChat': {
      if (state.secondary?.kind !== 'chat') return state;
      const routes = popLynxChatRoute(state.secondary.routes);
      return {
        ...state,
        secondary: routes.length > 0 ? { kind: 'chat', routes } : null,
      };
    }
    case 'openDraft':
      return {
        ...state,
        secondary: {
          kind: 'draft',
          directory: action.directory ?? null,
        },
      };
    case 'openAssistant':
      return {
        ...state,
        secondary: {
          kind: 'assistant',
          assistantId: action.assistantId,
          sessionId: action.sessionId ?? null,
          directory: action.directory ?? null,
          title: action.title ?? null,
        },
      };
    case 'openInstances':
      return { ...state, secondary: { kind: 'instances' } };
    case 'reconcileChatParent': {
      if (state.secondary?.kind !== 'chat') return state;
      const parent = createChatRoute(
        action.sessionId,
        action.directory ?? null,
        'chat-parent',
      );
      const routes = reconcileLynxChatPredecessor(state.secondary.routes, parent);
      return { ...state, secondary: { kind: 'chat', routes } };
    }
    case 'closeSecondary':
      return state.secondary ? { ...state, secondary: null } : state;
    case 'reset':
      return INITIAL_LYNX_NAVIGATION_STATE;
  }
}

export function isSecondaryPageVisible(state: LynxNavigationState): boolean {
  return state.secondary !== null;
}

/** Dock / host tab chrome hide whenever a secondary page is showing. */
export function isDockHidden(state: LynxNavigationState): boolean {
  return isSecondaryPageVisible(state);
}
