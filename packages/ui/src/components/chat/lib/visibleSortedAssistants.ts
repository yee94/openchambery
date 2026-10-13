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
 * The transcript owns membership. A streaming pointer describes activity, not
 * visibility: delayed status for an older step cannot hide received siblings.
 */
export const resolveVisibleSortedAssistants = (
  assistants: readonly ChatMessageEntry[],
  _streamingAssistantMessageId: string | null | undefined,
): ChatMessageEntry[] => {
  return assistants as ChatMessageEntry[];
};
