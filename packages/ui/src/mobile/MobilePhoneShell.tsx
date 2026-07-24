import * as React from 'react';
import { useEvent } from '@reactuses/core';

import { AssistantView } from '@/components/assistants/AssistantView';
import { useI18n } from '@/lib/i18n';
import { useSessionUIStore } from '@/sync/session-ui-store';

import { MobileAssistantTab } from './assistant/MobileAssistantTab';
import type { MobileTabId } from './mobileTabs';
import { MobileTabsRoot } from './MobileTabsRoot';
import { MobileProjectsHomeContainer } from './projects';
import { MobileScheduledTab } from './scheduled/MobileScheduledTab';
import { MobileSettingsTab } from './settings/MobileSettingsTab';
import { useMobileNavigationStore } from './useMobileNavigationStore';

export type MobilePhoneShellProps = {
  /** Opens the directory explorer so the user can add a project. */
  onAddProject: () => void;
  /** Enables assistants (opens settings at the assistants section). */
  onEnableAssistants: () => void;
  /** Registers a back handler for the chat secondary page; return true when handled. */
  registerSecondaryBackHandler?: (handler: (() => boolean) | null) => void;
  /**
   * Scheduled-tab content. Receives an editor-back registration so Android back
   * can dismiss an open task editor before leaving the secondary chat page.
   */
  scheduledContent?: React.ReactNode | ((
    registerEditorBackHandler: (handler: (() => boolean) | null) => void,
    onEditorActiveChange: (active: boolean) => void,
  ) => React.ReactNode);
  /** Chat secondary page content. Rendered with the active chat target. */
  renderChat: (target: { sessionId: string; directory: string | null }) => React.ReactNode;
  className?: string;
};

/**
 * Phone-only mobile navigation host: four root tabs plus a second-level chat
 * page. Session/draft targets are owned by the session-ui store; this host
 * only projects that authoritative state into the secondary page.
 */
export function MobilePhoneShell({
  onAddProject,
  onEnableAssistants,
  registerSecondaryBackHandler,
  scheduledContent,
  renderChat,
  className,
}: MobilePhoneShellProps) {
  const { t } = useI18n();
  const navigation = useMobileNavigationStore();
  const setActiveTabStore = useMobileNavigationStore((state) => state.setActiveTab);
  const openSessionStore = useMobileNavigationStore((state) => state.openSession);
  const openDraftStore = useMobileNavigationStore((state) => state.openDraft);
  const openAssistantStore = useMobileNavigationStore((state) => state.openAssistant);
  const closeSecondaryStore = useMobileNavigationStore((state) => state.closeSecondary);

  const setActiveTab = useEvent((tab: MobileTabId) => {
    setActiveTabStore(tab);
  });

  const openChat = useEvent((target: { sessionId: string; directory: string | null }) => {
    openSessionStore(target);
  });

  const closeSecondary = useEvent(() => {
    closeSecondaryStore();
  });

  const handleNewSessionDraft = useEvent(() => {
    openDraftStore();
  });

  const openAssistant = useEvent((assistantID: string) => {
    openAssistantStore(assistantID);
  });

  // Scheduled-tab editor back (open create/edit form) sits above chat secondary
  // in the phone back chain: overlays → scheduled editor → chat secondary → root.
  const scheduledEditorBackRef = React.useRef<(() => boolean) | null>(null);
  const [scheduledEditorActive, setScheduledEditorActive] = React.useState(false);
  const registerScheduledEditorBack = useEvent((handler: (() => boolean) | null) => {
    scheduledEditorBackRef.current = handler;
  });
  const handleScheduledEditorActiveChange = useEvent((active: boolean) => {
    setScheduledEditorActive(active);
  });

  // Android-back / external back coordination: MobileApp's overlay chain keeps
  // priority; this handler covers scheduled editor then the chat secondary page.
  const secondaryOpen = navigation.secondary !== null;
  React.useEffect(() => {
    if (!registerSecondaryBackHandler) return;
    registerSecondaryBackHandler(() => {
      if (scheduledEditorBackRef.current?.()) return true;
      if (!useMobileNavigationStore.getState().secondary) return false;
      closeSecondary();
      return true;
    });
    return () => registerSecondaryBackHandler(null);
  }, [registerSecondaryBackHandler, secondaryOpen, closeSecondary]);

  // The chat/draft page renders the authoritative session store state. Read
  // the current target here so the host re-renders when it changes (deep
  // links, edge swipe, draft materialization all flow through the store).
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSessionDirectory = useSessionUIStore((state) =>
    currentSessionId ? state.getDirectoryForSession(currentSessionId) : null,
  );

  const scheduledTabBody: React.ReactNode = typeof scheduledContent === 'function'
    ? scheduledContent(registerScheduledEditorBack, handleScheduledEditorActiveChange)
    : scheduledContent;

  const tabs = React.useMemo(
    () => ({
      projects: (
        <MobileProjectsHomeContainer
          onOpenChat={openChat}
          onAddProject={onAddProject}
          onNewSession={handleNewSessionDraft}
        />
      ),
      assistant: <MobileAssistantTab onEnable={onEnableAssistants} onOpenAssistant={openAssistant} />,
      scheduled: <MobileScheduledTab showHeader={!scheduledEditorActive}>{scheduledTabBody}</MobileScheduledTab>,
      settings: <MobileSettingsTab />,
    }),
    [openChat, openAssistant, handleNewSessionDraft, onAddProject, onEnableAssistants, scheduledEditorActive, scheduledTabBody],
  );

  const secondaryKind = navigation.secondary?.kind ?? null;
  const secondaryPage = React.useMemo(() => {
    if (!secondaryKind) return null;
    if (secondaryKind === 'assistant') {
      return {
        key: 'assistant-secondary',
        ariaLabel: t('assistants.title'),
        content: <AssistantView activeOverride onMobileBack={closeSecondary} />,
      };
    }
    // Project the render target from the authoritative session store: once a
    // draft's first prompt materializes the real session, the header/status
    // switch to the live entity while the stable host key keeps the ChatView
    // (and composer focus / IME state) mounted.
    const hasLiveSession = Boolean(currentSessionId);
    return {
      // Stable host key: draft → chat materialization must NOT remount the
      // ChatView (composer focus, IME composition, DOM state are preserved).
      key: 'chat-secondary',
      ariaLabel: t('mobile.nav.secondaryPageAria'),
      content: renderChat(
        hasLiveSession
          ? { sessionId: currentSessionId ?? '', directory: currentSessionDirectory ?? null }
          : { sessionId: '', directory: null },
      ),
    };
  }, [secondaryKind, closeSecondary, currentSessionId, currentSessionDirectory, renderChat, t]);

  return (
    <MobileTabsRoot
      className={className}
      navigation={navigation}
      onTabChange={setActiveTab}
      tabs={tabs}
      secondaryPage={secondaryPage}
    />
  );
}
