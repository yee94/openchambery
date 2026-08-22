import * as React from 'react';
import { useEvent } from '@reactuses/core';

import { AssistantView } from '@/components/assistants/AssistantView';
import { useI18n } from '@/lib/i18n';
import { normalizePath } from '@/lib/pathNormalization';
import { useSessionUIStore } from '@/sync/session-ui-store';

import { MobileAssistantTab } from './assistant/MobileAssistantTab';
import type { MobileParentSessionTarget } from './mobileNavigation';
import type { MobileTabId } from './mobileTabs';
import { MobileTabsRoot } from './MobileTabsRoot';
import { mobileBackNavigationCoordinator } from './mobileBackNavigation';
import { MobileProjectsHomeContainer } from './projects';
import { MobileScheduledTab } from './scheduled/MobileScheduledTab';
import { MobileSettingsTab } from './settings/MobileSettingsTab';
import { acknowledgeMobileSessionMirror, useMobileNavigationStore } from './useMobileNavigationStore';

export type MobilePhoneShellProps = {
  /** Opens the directory explorer so the user can add a project. */
  onAddProject: () => void;
  onScanQr?: () => void;
  onSwitchInstance?: () => void;
  /** Enables assistants (opens settings at the assistants section). */
  onEnableAssistants: () => void;
  /** Saved-instance management content for the Settings secondary page. */
  instancesPage?: React.ReactNode;
  /**
   * Authoritative parent of the current chat session (child.parentID). When set
   * on a chat secondary page, back navigates to the parent without closing
   * secondary. Host owns the subscription; shell only consumes the snapshot.
   */
  parentSessionTarget?: MobileParentSessionTarget | null;
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
  renderChat: (target: {
    sessionId: string;
    directory: string | null;
    viewKey: string;
    active: boolean;
  }) => React.ReactNode;
  className?: string;
};

/**
 * Phone-only mobile navigation host: four root tabs plus standard second-level
 * pages. The mobile store owns route order and the session-ui store mirrors
 * the active top route for app-wide session behavior.
 */
export function MobilePhoneShell({
  onAddProject,
  onScanQr,
  onSwitchInstance,
  onEnableAssistants,
  instancesPage,
  parentSessionTarget = null,
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
  const popChatSessionStore = useMobileNavigationStore((state) => state.popChatSession);
  const reconcileChatPredecessor = useMobileNavigationStore((state) => state.reconcileChatPredecessor);
  const materializeDraftSession = useMobileNavigationStore((state) => state.materializeDraftSession);
  const replaceChatSession = useMobileNavigationStore((state) => state.replaceChatSession);

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

  // Unified secondary back: scheduled editor → parent chat session → close page.
  // System / gesture / H5 coordinator / chat header all converge here.
  const handleSecondaryBack = useEvent(() => {
    if (scheduledEditorBackRef.current?.()) return true;
    const secondary = useMobileNavigationStore.getState().secondary;
    if (secondary?.kind === 'chat' && secondary.routes.length > 1) {
      popChatSessionStore();
      return true;
    }
    if (secondary) {
      closeSecondary();
      return true;
    }
    return false;
  });

  // Android-back / external back coordination: MobileApp's overlay chain keeps
  // priority; this handler covers scheduled editor then the secondary page.
  const secondaryOpen = navigation.secondary !== null;
  React.useEffect(() => {
    if (!registerSecondaryBackHandler) return;
    registerSecondaryBackHandler(() => handleSecondaryBack());
    return () => registerSecondaryBackHandler(null);
  }, [registerSecondaryBackHandler, secondaryOpen, handleSecondaryBack]);

  // The chat/draft page renders the authoritative session store state. Read
  // the current target here so the host re-renders when it changes (deep
  // links, edge swipe, draft materialization all flow through the store).
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSessionDirectory = useSessionUIStore((state) =>
    currentSessionId ? state.getDirectoryForSession(currentSessionId) : null,
  );

  React.useEffect(() => {
    const secondary = useMobileNavigationStore.getState().secondary;
    if (secondary?.kind === 'draft' && currentSessionId) {
      materializeDraftSession({ sessionId: currentSessionId, directory: currentSessionDirectory });
      return;
    }
    if (secondary?.kind !== 'chat' || !currentSessionId) return;
    if (acknowledgeMobileSessionMirror({
      sessionId: currentSessionId,
      directory: currentSessionDirectory,
    }) === 'internal') return;
    const top = secondary.routes.at(-1);
    if (
      top?.sessionId !== currentSessionId
      || normalizePath(top.directory) !== normalizePath(currentSessionDirectory)
    ) {
      replaceChatSession({ sessionId: currentSessionId, directory: currentSessionDirectory });
    }
  }, [currentSessionDirectory, currentSessionId, materializeDraftSession, replaceChatSession]);

  React.useEffect(() => {
    const secondary = useMobileNavigationStore.getState().secondary;
    if (secondary?.kind !== 'chat' || !parentSessionTarget) return;
    const top = secondary.routes.at(-1);
    if (!top || top.sessionId !== currentSessionId) return;
    reconcileChatPredecessor({
      sessionId: parentSessionTarget.id,
      directory: parentSessionTarget.directory,
    });
  }, [currentSessionId, parentSessionTarget, reconcileChatPredecessor]);

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
          onScanQr={onScanQr}
          onSwitchInstance={onSwitchInstance}
        />
      ),
      assistant: <MobileAssistantTab onEnable={onEnableAssistants} onOpenAssistant={openAssistant} />,
      scheduled: <MobileScheduledTab showHeader={false}>{scheduledTabBody}</MobileScheduledTab>,
      settings: <MobileSettingsTab instancesPage={instancesPage} />,
    }),
    [openChat, openAssistant, handleNewSessionDraft, onAddProject, onScanQr, onSwitchInstance, onEnableAssistants, instancesPage, scheduledTabBody],
  );

  const secondaryKind = navigation.secondary?.kind ?? null;
  const secondaryPages = React.useMemo(() => {
    if (!secondaryKind) return null;
    if (secondaryKind === 'assistant') {
      return [{
        key: 'assistant-secondary',
        depth: 1,
        ariaLabel: t('assistants.title'),
        onBack: handleSecondaryBack,
        content: (
          <AssistantView
            activeOverride
            onMobileBack={() => mobileBackNavigationCoordinator.requestAnimatedBack('root')}
          />
        ),
      }];
    }
    // Project the render target from the authoritative session store: once a
    // draft's first prompt materializes the real session, the header/status
    // switch to the live entity while the stable host key keeps the ChatView
    // (and composer focus / IME state) mounted.
    if (navigation.secondary?.kind === 'draft') {
      return [{
        key: 'chat-primary',
        depth: 1,
        ariaLabel: t('mobile.nav.secondaryPageAria'),
        onBack: handleSecondaryBack,
        content: renderChat({ sessionId: '', directory: null, viewKey: 'chat-primary', active: true }),
      }];
    }
    if (navigation.secondary?.kind !== 'chat') return [];
    const routeStack = navigation.secondary.routes;
    const routes = routeStack.slice(-2);
    const firstVisibleDepth = routeStack.length - routes.length + 1;
    return routes.map((route, index) => {
      const active = index === routes.length - 1;
      return {
        key: route.key,
        depth: firstVisibleDepth + index,
        ariaLabel: t('mobile.nav.secondaryPageAria'),
        onBack: handleSecondaryBack,
        content: renderChat({
          sessionId: route.sessionId,
          directory: route.directory,
          viewKey: route.key,
          active,
        }),
      };
    });
  }, [secondaryKind, navigation.secondary, handleSecondaryBack, renderChat, t]);

  return (
    <MobileTabsRoot
      className={className}
      navigation={navigation}
      onTabChange={setActiveTab}
      tabs={tabs}
      secondaryPages={secondaryPages ?? []}
      tabBarCovered={scheduledEditorActive}
    />
  );
}
