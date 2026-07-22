import React from 'react';
import { ChatContainer } from '@/components/chat/ChatContainer';
import type { ChatContainerHost } from '@/components/chat/chatContainerHost';
import type { ChatInputSecondarySurface } from '@/components/chat/chatInputSurface';
import { PRIMARY_SESSION_SURFACE_CAPABILITIES } from '@/components/chat/SessionSurfaceContext';
import type { AssistantDTO } from '@/queries/assistantQueries';

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
    },
    onRevertMessage,
  }), [directory, onRevertMessage, sessionID, surface.active, surface.surfaceID]);

  const host = React.useMemo<ChatContainerHost>(() => ({
    sessionId: sessionID,
    directory,
    composerSurface: surface,
    sessionSurface,
    warning,
    historySessionIDs: assistant.historySessionIDs,
    onRevertMessage,
  }), [assistant.historySessionIDs, directory, onRevertMessage, sessionID, sessionSurface, surface, warning]);

  return <ChatContainer autoOpenDraft={false} host={host} />;
};
