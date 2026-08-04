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
 * Filtering to completed+streaming only blanks those earlier tools/reasoning
 * from the Activity timeline until completion metadata lands — visible flicker.
 *
 * While a stream id is known, keep the turn **prefix** through that assistant
 * so every earlier step stays on screen. When the turn is fully settled, show
 * every assistant. Otherwise fall back to completed assistants (or the first
 * shell when none are complete yet).
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

  if (completed.length > 0) {
    return completed;
  }

  const first = assistants[0];
  return first ? [first] : [];
};
