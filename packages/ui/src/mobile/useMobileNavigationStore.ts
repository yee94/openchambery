import { create } from 'zustand';

import { useSessionUIStore } from '@/sync/session-ui-store';
import { useAssistantUIStore } from '@/stores/useAssistantUIStore';

import {
  INITIAL_MOBILE_NAVIGATION_STATE,
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
   * Single authoritative entry to open a session in the chat secondary page.
   * Synchronously selects the session in the session store, then opens the
   * page — the page itself renders whatever the session store owns, so there
   * is no second authority to reconcile.
   */
  openSession: (target: OpenSessionTarget) => void;
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

/**
 * Phone navigation state shared between the shell and its host. Session and
 * draft targets are owned by `useSessionUIStore` (single authority); this
 * store only tracks WHICH page is shown, never WHICH session is current.
 */
export const useMobileNavigationStore = create<MobileNavigationStore>((set) => ({
  ...INITIAL_MOBILE_NAVIGATION_STATE,
  setActiveTab: (tab) => set({ activeTab: tab, secondary: null }),
  openSession: (target) => {
    void useSessionUIStore.getState().setCurrentSession(target.sessionId, target.directory ?? null);
    set({ secondary: { kind: 'chat' } });
  },
  openDraft: (options) => {
    useSessionUIStore.getState().openNewSessionDraft(options);
    set({ secondary: { kind: 'draft' } });
  },
  openAssistant: (assistantID) => {
    useAssistantUIStore.getState().selectAssistant(assistantID);
    set({ secondary: { kind: 'assistant' } });
  },
  closeSecondary: () =>
    set((state) => (state.secondary ? { ...state, secondary: null } : state)),
  reset: () => set({ ...INITIAL_MOBILE_NAVIGATION_STATE }),
}));
