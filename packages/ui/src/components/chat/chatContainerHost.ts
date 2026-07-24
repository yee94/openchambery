import type { ChatInputSurface } from '@/components/chat/chatInputSurface';
import type { SessionSurfaceContextValue } from '@/components/chat/SessionSurfaceContext';
import type { AssistantHistoryEntry } from '@/queries/assistantQueries';
import type { PendingUserMessagePresentation } from '@/sync/session-ui-store';
import type { Message, Part } from '@opencode-ai/sdk/v2';

type SessionMessageRecord = { info: Message; parts: Part[] };

export const mergePendingUserMessagePresentations = (
  messages: readonly SessionMessageRecord[],
  pending: readonly PendingUserMessagePresentation[],
): SessionMessageRecord[] => {
  if (pending.length === 0) return messages as SessionMessageRecord[];
  const messageIDs = new Set(messages.map((message) => message.info.id));
  const additions = pending.filter((message) => !messageIDs.has(message.info.id));
  return additions.length === 0 ? messages as SessionMessageRecord[] : [...messages, ...additions];
};

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
  /** Local user rows retained until the same stable message ID materializes. */
  pendingUserMessages?: readonly PendingUserMessagePresentation[];
  onPendingUserMessagesMaterialized?: (messageIDs: readonly string[]) => void;
  /** Server-paged prior OpenCode entries to prepend ahead of the live binding. */
  assistantHistory?: {
    entries: readonly AssistantHistoryEntry[];
    complete: boolean;
    loading: boolean;
    fetchPrevious: () => Promise<unknown>;
  };
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
