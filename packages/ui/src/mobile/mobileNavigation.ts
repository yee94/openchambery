import type { MobileTabId } from './mobileTabs';

/**
 * Mobile-owned navigation state for the dedicated mobile shell.
 *
 * The desktop `MainTab` / URL router intentionally stays out of this model:
 * mobile navigation is a root tab plus at most one second-level page.
 */
export type MobileSecondaryState =
  | {
      /** Chat page. The session target is owned by the session-ui store
          (single authority); the page renders the store's current session. */
      kind: 'chat';
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
