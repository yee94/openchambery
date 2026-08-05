import type { ChatMessageEntry } from './turns/types';

export const isAssistantMessageCompleted = (message: ChatMessageEntry): boolean => {
  const info = message.info as { time?: { completed?: unknown }; status?: unknown };
  const completed = info.time?.completed;
  const status = info.status;
  if (typeof completed !== 'number' || completed <= 0) {
    return false;
  }
  if (typeof status === 'string') {
    return status === 'completed';
  }
  return true;
};

/**
 * Which assistant messages belong in a sorted-mode turn viewport.
 *
 * Multi-step agent turns create several assistant messages. Only the last is
 * "streaming"; earlier siblings often still lack `time.completed` for a while.
 *
 * While a stream id is known, keep the turn **prefix** through that assistant
 * so every earlier step stays on screen. When the turn is fully settled, show
 * every assistant.
 *
 * When the stream id is briefly unknown (common between shell steps while
 * session_status flaps idle), do **not** fall back to completed-only or
 * first-only filters: that drops incomplete assistants and their Activity
 * tools for a frame, then remounts them (fold flash). The turn already scopes
 * the assistant set — paint the whole set unless a live stream id narrows it.
 */
export const resolveVisibleSortedAssistants = (
  assistants: readonly ChatMessageEntry[],
  streamingAssistantMessageId: string | null | undefined,
): ChatMessageEntry[] => {
  if (assistants.length === 0) return [];

  const completed = assistants.filter(isAssistantMessageCompleted);
  if (completed.length === assistants.length) {
    return assistants as ChatMessageEntry[];
  }

  if (streamingAssistantMessageId) {
    const streamingIndex = assistants.findIndex(
      (assistant) => assistant.info.id === streamingAssistantMessageId,
    );
    if (streamingIndex >= 0) {
      return assistants.slice(0, streamingIndex + 1) as ChatMessageEntry[];
    }
  }

  // Stream id missing mid-turn: keep every assistant already in the turn.
  return assistants as ChatMessageEntry[];
};
