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
import { isIPadApp } from '@/lib/platform';
import { useMobileNavigationStore } from '@/mobile/useMobileNavigationStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import type { PendingUserMessagePresentation } from '@/sync/session-ui-store';

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
  const openSourceSession = useEvent((targetSessionID: string, targetDirectory: string) => {
    const expectedDirectory = targetSessionID === sessionID ? directory : historyDirectories.get(targetSessionID);
    if (!expectedDirectory || expectedDirectory !== targetDirectory) return;
    // Leave the Assistant surface and continue the underlying OpenCode session in Chat.
    // Phone shell (native or hosted H5): secondary chat route owns mounting.
    // Updating the session store alone changes selection without mounting chat —
    // same contract as scheduled-task history open. Do not gate on isCapacitorApp.
    if (mobileActions && !isIPadApp()) {
      useMobileNavigationStore.getState().openSession({ sessionId: targetSessionID, directory: targetDirectory });
      return;
    }
    if (!useUIStore.getState().setActiveMainTab('chat')) return;
    void useSessionUIStore.getState().setCurrentSession(targetSessionID, targetDirectory);
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
      navigateNestedSession: false,
      mutateSession,
    },
    onRevertMessage,
    // Continuous Assistants stage edits into surfaceDraftKey; history segments are read-only via MessageList.
    ...(onEditMessage ? { onEditMessage } : {}),
    openSourceSession,
  }), [directory, mutateSession, onEditMessage, onRevertMessage, openSourceSession, sessionID, surface.active, surface.surfaceID]);

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
