import { create } from 'zustand';

import { useSessionUIStore } from '@/sync/session-ui-store';
import { useAssistantUIStore } from '@/stores/useAssistantUIStore';
import { isCapacitorApp, isIPadApp } from '@/lib/platform';
import { normalizePath } from '@/lib/pathNormalization';

import {
  INITIAL_MOBILE_NAVIGATION_STATE,
  popMobileChatRoute,
  pushMobileChatRoute,
  reconcileMobileChatPredecessor,
  replaceMobileChatRoute,
  type MobileChatRoute,
  type MobileNavigationState,
} from './mobileNavigation';
import type { MobileTabId } from './mobileTabs';

type OpenSessionTarget = {
  sessionId: string;
  directory?: string | null;
};

type OpenDraftOptions = Parameters<
  ReturnType<typeof useSessionUIStore.getState>['openNewSessionDraft']
>[0];

type MobileNavigationStore = MobileNavigationState & {
  /** Switch root tab; implicitly closes any secondary page. */
  setActiveTab: (tab: MobileTabId) => void;
  /**
   * Opens a root session route and synchronizes the primary session selection.
   */
  openSession: (target: OpenSessionTarget) => void;
  /** Push a nested session while preserving only lightweight route metadata. */
  pushSession: (target: OpenSessionTarget) => void;
  /** Pop one chat route and synchronize the primary session selection. */
  popChatSession: () => void;
  /** Add a resolved direct parent beneath a deep-linked child. */
  reconcileChatPredecessor: (target: OpenSessionTarget) => void;
  /** Replace the top route for an external/session-swipe selection without adding history. */
  replaceChatSession: (target: OpenSessionTarget) => void;
  /** Replace a draft page with its materialized session without adding depth. */
  materializeDraftSession: (target: OpenSessionTarget) => void;
  /**
   * Single authoritative entry to open the new-session draft page. Runs the
   * session-store draft flow synchronously, then opens the page.
   */
  openDraft: (options?: OpenDraftOptions) => void;
  /** Select an Assistant, then open its conversation as the second-level page. */
  openAssistant: (assistantID: string) => void;
  closeSecondary: () => void;
  /** Runtime switch / disconnect: drop all navigation state. */
  reset: () => void;
};

type ExpectedSessionMirror = {
  generation: number;
  sessionId: string;
  directory: string | null;
};

let sessionMirrorGeneration = 0;
let expectedSessionMirror: ExpectedSessionMirror | null = null;

export const expectMobileSessionMirror = (target: OpenSessionTarget): number => {
  const generation = ++sessionMirrorGeneration;
  expectedSessionMirror = {
    generation,
    sessionId: target.sessionId,
    directory: normalizePath(target.directory) ?? null,
  };
  return generation;
};

export const acknowledgeMobileSessionMirror = (target: OpenSessionTarget): 'internal' | 'external' => {
  const expected = expectedSessionMirror;
  if (
    expected
    && expected.generation === sessionMirrorGeneration
    && expected.sessionId === target.sessionId
    && expected.directory === (normalizePath(target.directory) ?? null)
  ) {
    expectedSessionMirror = null;
    return 'internal';
  }
  expectedSessionMirror = null;
  return 'external';
};

export const resetMobileSessionMirror = (): void => {
  sessionMirrorGeneration += 1;
  expectedSessionMirror = null;
};

const mirrorCurrentSession = (target: OpenSessionTarget): void => {
  const sessionState = useSessionUIStore.getState();
  const currentDirectory = sessionState.currentSessionId
    ? sessionState.getDirectoryForSession(sessionState.currentSessionId)
    : null;
  if (
    sessionState.currentSessionId === target.sessionId
    && normalizePath(currentDirectory) === normalizePath(target.directory)
  ) {
    resetMobileSessionMirror();
  } else {
    expectMobileSessionMirror(target);
  }
  void sessionState.setCurrentSession(target.sessionId, target.directory ?? null);
};

/**
 * Phone navigation state shared between the shell and its host. This store
 * owns lightweight route order; `useSessionUIStore` owns the active primary
 * session used by app-wide status and composer behavior.
 */
export const useMobileNavigationStore = create<MobileNavigationStore>((set) => ({
  ...INITIAL_MOBILE_NAVIGATION_STATE,
  setActiveTab: (tab) => {
    resetMobileSessionMirror();
    set({ activeTab: tab, secondary: null });
  },
  openSession: (target) => {
    set({
      secondary: {
        kind: 'chat',
        routes: [createChatRoute(target, 'root')],
      },
    });
    mirrorCurrentSession(target);
  },
  pushSession: (target) => {
    set((state) => {
      const route = createChatRoute(target, 'push');
      const routes = state.secondary?.kind === 'chat'
        ? pushMobileChatRoute(state.secondary.routes, route)
        : [route];
      return { secondary: { kind: 'chat', routes } };
    });
    mirrorCurrentSession(target);
  },
  popChatSession: () => {
    set((state) => {
      if (state.secondary?.kind !== 'chat') return state;
      const routes = popMobileChatRoute(state.secondary.routes);
      return routes.length > 0
        ? { secondary: { kind: 'chat', routes } }
        : { secondary: null };
    });
    const secondary = useMobileNavigationStore.getState().secondary;
    const target = secondary?.kind === 'chat' ? secondary.routes.at(-1) ?? null : null;
    if (target) {
      mirrorCurrentSession(target);
    }
  },
  reconcileChatPredecessor: (target) => set((state) => {
    if (state.secondary?.kind !== 'chat') return state;
    const routes = reconcileMobileChatPredecessor(
      state.secondary.routes,
      createChatRoute(target, 'parent'),
    );
    return routes === state.secondary.routes ? state : { secondary: { kind: 'chat', routes } };
  }),
  replaceChatSession: (target) => set((state) => {
    if (state.secondary?.kind !== 'chat') return state;
    const current = state.secondary.routes.at(-1);
    if (current?.sessionId === target.sessionId && current.directory === (target.directory ?? null)) return state;
    return {
      secondary: {
        kind: 'chat',
        routes: replaceMobileChatRoute(state.secondary.routes, createChatRoute(target, 'root')),
      },
    };
  }),
  materializeDraftSession: (target) => set((state) => (
    state.secondary?.kind === 'draft'
      ? {
          secondary: {
            kind: 'chat',
            routes: [{
              key: 'chat-primary',
              sessionId: target.sessionId,
              directory: target.directory ?? null,
            }],
          },
        }
      : state
  )),
  openDraft: (options) => {
    resetMobileSessionMirror();
    useSessionUIStore.getState().openNewSessionDraft(options);
    set({ secondary: { kind: 'draft' } });
  },
  openAssistant: (assistantID) => {
    resetMobileSessionMirror();
    useAssistantUIStore.getState().selectAssistant(assistantID);
    set({ secondary: { kind: 'assistant' } });
  },
  closeSecondary: () => {
    resetMobileSessionMirror();
    set((state) => (state.secondary ? { ...state, secondary: null } : state));
  },
  reset: () => {
    resetMobileSessionMirror();
    set({ ...INITIAL_MOBILE_NAVIGATION_STATE });
  },
}));

let nextChatRouteKey = 1;

const createChatRoute = (target: OpenSessionTarget, source: 'root' | 'push' | 'parent'): MobileChatRoute => ({
  key: source === 'root' ? 'chat-primary' : `chat-${source}-${nextChatRouteKey++}`,
  sessionId: target.sessionId,
  directory: target.directory ?? null,
});

/** Routes nested sessions through the native phone stack while other runtimes keep their owner. */
export const pushPhoneNestedSession = (target: OpenSessionTarget): boolean => {
  if (!isCapacitorApp() || isIPadApp()) return false;
  useMobileNavigationStore.getState().pushSession(target);
  return true;
};
