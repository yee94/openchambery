import React from 'react';
import { ChatContainer } from '@/components/chat/ChatContainer';
import { flattenAssistantHistoryPages } from '@/components/chat/hostedSessionHistory';
import type { ChatContainerHost } from '@/components/chat/chatContainerHost';
import type { ChatInputSecondarySurface } from '@/components/chat/chatInputSurface';
import { PRIMARY_SESSION_SURFACE_CAPABILITIES } from '@/components/chat/SessionSurfaceContext';
import type { AssistantDTO } from '@/queries/assistantQueries';
import { useAssistantHistoryInfiniteQuery } from '@/queries/assistantQueries';
import { useEvent } from '@reactuses/core';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';

type AssistantConversationSurfaceProps = {
  assistant: AssistantDTO;
  sessionID: string;
  warning?: string | null;
  surface: ChatInputSecondarySurface;
  onRevertMessage: (messageId: string) => Promise<void>;
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
    if (historyQuery.hasNextPage) await historyQuery.fetchNextPage();
  });
  // Stateless turns cannot rewrite history; keep continuous Assistants mutable.
  const mutateSession = assistant.mode === 'continuous';
  const openSourceSession = useEvent((targetSessionID: string, targetDirectory: string) => {
    const expectedDirectory = targetSessionID === sessionID ? directory : historyDirectories.get(targetSessionID);
    if (!expectedDirectory || expectedDirectory !== targetDirectory) return;
    // Leave the Assistant tab and continue the underlying OpenCode session in Chat.
    useUIStore.getState().setActiveMainTab('chat');
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
    openSourceSession,
  }), [directory, mutateSession, onRevertMessage, openSourceSession, sessionID, surface.active, surface.surfaceID]);

  const host = React.useMemo<ChatContainerHost>(() => ({
    sessionId: sessionID,
    directory,
    composerSurface: surface,
    sessionSurface,
    warning,
    assistantHistory: {
      entries: historyEntries,
      complete: historyQuery.isSuccess && !historyQuery.hasNextPage,
      loading: historyQuery.isFetching,
      fetchPrevious: fetchPreviousHistory,
    },
    onRevertMessage,
  }), [directory, fetchPreviousHistory, historyEntries, historyQuery.hasNextPage, historyQuery.isFetching, historyQuery.isSuccess, onRevertMessage, sessionID, sessionSurface, surface, warning]);

  return <ChatContainer autoOpenDraft={false} host={host} />;
};
