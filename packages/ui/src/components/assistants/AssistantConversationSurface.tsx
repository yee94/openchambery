import React from 'react';
import { ChatContainer } from '@/components/chat/ChatContainer';
import { flattenAssistantHistoryPages } from '@/components/chat/hostedSessionHistory';
import type { ChatContainerHost } from '@/components/chat/chatContainerHost';
import type { ChatInputSecondarySurface } from '@/components/chat/chatInputSurface';
import { PRIMARY_SESSION_SURFACE_CAPABILITIES, type SessionSurfaceMessageEditSnapshot } from '@/components/chat/SessionSurfaceContext';
import type { AssistantDTO } from '@/queries/assistantQueries';
import { useAssistantHistoryInfiniteQuery } from '@/queries/assistantQueries';
import { useEvent } from '@reactuses/core';
import { useMobileAppActions } from '@/apps/mobileAppContext';
import { useDeviceInfo } from '@/lib/device';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isIPadApp } from '@/lib/platform';
import { useI18n } from '@/lib/i18n';
import type { PendingUserMessagePresentation } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import {
  notifySessionOpenFailed,
  openSessionWithFeedback,
} from '@/sync/openSessionWithFeedback';
import { resolveAssistantNestedOpenMode } from './assistantNestedSession';

type AssistantConversationSurfaceProps = {
  assistant: AssistantDTO;
  sessionID: string;
  warning?: string | null;
  surface: ChatInputSecondarySurface;
  onRevertMessage: (messageId: string) => Promise<void>;
  onEditMessage?: (messageId: string, snapshot: SessionSurfaceMessageEditSnapshot) => Promise<void>;
  pendingUserMessages: readonly PendingUserMessagePresentation[];
  onPendingUserMessagesMaterialized: (messageIDs: readonly string[]) => void;
};

/**
 * Assistant transcript + composer host.
 * Renders the shared ChatContainer shell (MessageList, StatusRow, Q/P cards,
 * timeline, auto-follow) with an injected secondary composer surface. Assistant
 * keeps list/selection/binding ownership in AssistantView; it does not fork the
 * session transcript rendering tree.
 */
export const AssistantConversationSurface: React.FC<AssistantConversationSurfaceProps> = ({
  assistant,
  sessionID,
  warning,
  surface,
  onRevertMessage,
  onEditMessage,
  pendingUserMessages,
  onPendingUserMessagesMaterialized,
}) => {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const directory = assistant.effectiveWorkspacePath;
  const historyQuery = useAssistantHistoryInfiniteQuery(
    assistant.id,
    { sessionID, sessionGeneration: assistant.sessionGeneration },
    surface.active,
  );
  const historyEntries = React.useMemo(
    () => flattenAssistantHistoryPages(historyQuery.data?.pages ?? []),
    [historyQuery.data?.pages],
  );
  const historyDirectories = React.useMemo(() => {
    const directories = new Map<string, string | null>();
    for (const entry of historyEntries) {
      const previous = directories.get(entry.sessionID);
      directories.set(entry.sessionID, previous === undefined || previous === entry.directory ? entry.directory : null);
    }
    return directories;
  }, [historyEntries]);
  const fetchPreviousHistory = useEvent(async () => {
    if (historyQuery.hasNextPage || historyQuery.isFetchNextPageError) {
      await historyQuery.fetchNextPage();
    }
  });
  // Stateless turns cannot rewrite history; keep continuous Assistants mutable.
  const mutateSession = assistant.mode === 'continuous';
  // Dedicated MobileApp (Capacitor phone + hosted H5 phone shell) owns chat as a
  // secondary route. Detect it the same way ChatContainer does — not Capacitor alone.
  const mobileActions = useMobileAppActions();
  const isPhoneShell = Boolean(mobileActions && !isIPadApp());
  const openLinkedSession = useEvent((targetSessionID: string, targetDirectory: string) => {
    openSessionWithFeedback(targetSessionID, targetDirectory, {
      phoneShell: isPhoneShell,
      switchToChat: true,
    });
  });
  const openSourceSession = useEvent((targetSessionID: string, targetDirectory: string) => {
    const expectedDirectory = targetSessionID === sessionID ? directory : historyDirectories.get(targetSessionID);
    // History entry must carry a stable workspace path. If missing or conflicting,
    // fail visibly — never open under the wrong current project cwd.
    if (!expectedDirectory || expectedDirectory !== targetDirectory) {
      notifySessionOpenFailed(targetSessionID, 'missing-directory');
      return;
    }
    // Leave the Assistant surface and continue the underlying OpenCode session in Chat.
    // Phone shell (native or hosted H5): secondary chat route owns mounting.
    openLinkedSession(targetSessionID, targetDirectory);
  });
  const navigateSession = useEvent((targetSessionID: string, targetDirectory: string) => {
    const sessionId = targetSessionID.trim();
    const targetDirectoryValue = targetDirectory.trim();
    if (!sessionId) {
      notifySessionOpenFailed(targetSessionID, 'missing-session-id');
      return;
    }
    if (!targetDirectoryValue) {
      notifySessionOpenFailed(sessionId, 'missing-directory');
      return;
    }
    const mode = resolveAssistantNestedOpenMode({
      isPhoneShell,
      isMobile,
      isIPad: isIPadApp(),
      isVSCode: isVSCodeRuntime(),
    });
    if (mode === 'session') {
      openLinkedSession(sessionId, targetDirectoryValue);
      return;
    }
    useUIStore.getState().openContextPanelTab(targetDirectoryValue, {
      mode: 'chat',
      dedupeKey: `session:${sessionId}`,
      label: t('contextPanel.mode.chat'),
      readOnly: true,
    });
  });
  const sessionSurface = React.useMemo(() => ({
    kind: 'embedded' as const,
    surfaceId: surface.surfaceID,
    sessionId: sessionID,
    directory,
    active: surface.active,
    capabilities: {
      ...PRIMARY_SESSION_SURFACE_CAPABILITIES,
      forkSession: false,
      mutateSession,
    },
    navigateSession,
    onRevertMessage,
    // Continuous Assistants stage edits into surfaceDraftKey; history segments are read-only via MessageList.
    ...(onEditMessage ? { onEditMessage } : {}),
    openSourceSession,
  }), [directory, mutateSession, navigateSession, onEditMessage, onRevertMessage, openSourceSession, sessionID, surface.active, surface.surfaceID]);

  // Terminal error: stop load-older from spinning forever. Background refetches
  // must not flip loading (near-top controller). Only initial/next-page fetches load.
  const historyComplete = historyQuery.isError || (historyQuery.isSuccess && !historyQuery.hasNextPage);
  const historyLoading = historyQuery.isLoading || historyQuery.isFetchingNextPage;

  const host = React.useMemo<ChatContainerHost>(() => ({
    sessionId: sessionID,
    directory,
    composerSurface: surface,
    sessionSurface,
    warning,
    pendingUserMessages,
    onPendingUserMessagesMaterialized,
    assistantHistory: {
      entries: historyEntries,
      complete: historyComplete,
      loading: historyLoading,
      fetchPrevious: fetchPreviousHistory,
    },
    onRevertMessage,
  }), [directory, fetchPreviousHistory, historyComplete, historyEntries, historyLoading, onPendingUserMessagesMaterialized, onRevertMessage, pendingUserMessages, sessionID, sessionSurface, surface, warning]);

  return <ChatContainer autoOpenDraft={false} host={host} />;
};
