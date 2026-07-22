import type { ChatInputSurface } from '@/components/chat/chatInputSurface';
import type { SessionSurfaceContextValue } from '@/components/chat/SessionSurfaceContext';

export type ChatContainerHostFeatures = {
  /** Primary-only new-session draft welcome. Hosted surfaces default this off. */
  newSessionDraft?: boolean;
  /** Desktop prompt navigator rail. Hosted surfaces default this off. */
  promptNavigator?: boolean;
  /** Navigate back to a parent/subagent session. Hosted surfaces default this off. */
  returnToParent?: boolean;
};

/**
 * Explicit host contract for embedding ChatContainer outside the primary
 * session selector (Assistant, and future secondary transcripts).
 *
 * When present, ChatContainer skips the primary session-view cache and renders
 * one bound transcript + composer for the supplied session/directory.
 */
export type ChatContainerHost = {
  sessionId: string;
  directory: string;
  composerSurface: ChatInputSurface;
  sessionSurface: SessionSurfaceContextValue;
  warning?: string | null;
  /** Prior OpenCode sessions to prepend (read-only) ahead of the live binding. */
  historySessionIDs?: readonly string[];
  features?: ChatContainerHostFeatures;
  onRevertMessage?: (messageId: string) => Promise<void>;
};

export const resolveChatContainerHostFeatures = (
  host: ChatContainerHost | undefined,
): Required<ChatContainerHostFeatures> => ({
  newSessionDraft: host?.features?.newSessionDraft ?? !host,
  promptNavigator: host?.features?.promptNavigator ?? !host,
  returnToParent: host?.features?.returnToParent ?? !host,
});
