import type { ChatInputSurface } from '@/components/chat/chatInputSurface';
import type { SessionSurfaceContextValue } from '@/components/chat/SessionSurfaceContext';
import type { AssistantHistoryEntry } from '@/queries/assistantQueries';
import type { PendingUserMessagePresentation } from '@/sync/session-ui-store';
import type { Message, Part } from '@opencode-ai/sdk/v2';

type SessionMessageRecord = { info: Message; parts: Part[] };

/**
 * Fold retained pending rows into an authoritative transcript.
 * Rows the transcript does not have yet are appended. A row it has but whose
 * parts never landed is substituted by its pending counterpart in place, so a
 * part-less record cannot turn a sent message into an empty bubble; substituting
 * rather than appending keeps one row per message ID.
 */
export const mergePendingUserMessagePresentations = (
  messages: readonly SessionMessageRecord[],
  pending: readonly PendingUserMessagePresentation[],
): SessionMessageRecord[] => {
  if (pending.length === 0) return messages as SessionMessageRecord[];
  const pendingByID = new Map(pending.map((message) => [message.info.id, message]));
  let substituted = false;
  const reconciled = messages.map((message) => {
    if (message.parts.length > 0) return message;
    const standIn = pendingByID.get(message.info.id);
    if (!standIn) return message;
    substituted = true;
    return standIn;
  });
  const base = substituted ? reconciled : messages as SessionMessageRecord[];
  const messageIDs = new Set(messages.map((message) => message.info.id));
  const additions = pending.filter((message) => !messageIDs.has(message.info.id));
  return additions.length === 0 ? base : [...base, ...additions];
};

type PendingCreatedCarrier = {
  info: { time?: { created?: number } };
};

/**
 * Whether host/retained pending rows still imply in-flight work.
 * Pending forces working only until session status has clearly finished this
 * send: missing resolved status/observedAt, or newest pending `time.created`
 * later than `sessionStatusObservedAt`. A fresh idle observation at/after the
 * send no longer forces working (body may still show the retained row).
 */
export const pendingUserMessagesImplyWorking = (
  pending: readonly PendingCreatedCarrier[],
  input: {
    resolvedSessionStatus: { type?: string } | null | undefined;
    sessionStatusObservedAt: number | null | undefined;
  },
): boolean => {
  if (pending.length === 0) return false;

  let newestCreated: number | undefined;
  for (const message of pending) {
    const created = message.info.time?.created;
    if (typeof created !== 'number') continue;
    if (newestCreated === undefined || created > newestCreated) {
      newestCreated = created;
    }
  }

  if (
    !input.resolvedSessionStatus
    || typeof input.sessionStatusObservedAt !== 'number'
    || typeof newestCreated !== 'number'
    || newestCreated > input.sessionStatusObservedAt
  ) {
    return true;
  }

  // observedAt >= newest pending created — status has seen this send; do not
  // keep working solely because the presentation row is still retained.
  return false;
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
