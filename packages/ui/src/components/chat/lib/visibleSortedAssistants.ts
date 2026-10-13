import { canRevealSortedFinalBody, resolveSortedRevealStreamPhase } from './turns/assistantMessageLifecycle';
import type { TurnActivityRecord } from './turns/types';
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

/**
 * Which assistant message currently owns the sorted live body reveal.
 *
 * Body ownership is independent of tools, errors and completion. If an input
 * projection also supplies justification rows, withhold the matching row to
 * avoid duplication; never use this pointer to filter transcript membership.
 */
export const resolveLiveRevealBodyMessageId = (input: {
  chatRenderMode: 'sorted' | 'live';
  assistants: readonly ChatMessageEntry[];
  streamingAssistantMessageId: string | null | undefined;
  activeStreamingPhase: string | null | undefined;
}): string | null => {
  if (input.chatRenderMode !== 'sorted') return null;
  const streamingId = input.streamingAssistantMessageId;
  if (!streamingId) return null;

  const streaming = input.assistants.find(
    (assistant) => assistant.info.id === streamingId,
  );
  if (!streaming) return null;

  const info = streaming.info as { finish?: unknown; error?: unknown };
  const streamPhase = resolveSortedRevealStreamPhase({
    finish: info.finish,
    isMessageCompleted: isAssistantMessageCompleted(streaming),
    activeStreamingPhase: input.activeStreamingPhase,
  });

  const reveal = canRevealSortedFinalBody({
    finish: info.finish,
    parts: streaming.parts,
    streamPhase,
    error: info.error,
    // Position is diagnostic only; every received message retains its body.
    isLastAssistantInTurn: true,
  });
  return reveal ? streamingId : null;
};

/**
 * Withhold the live-reveal message's justification rows from the Activity
 * viewport while its body streams, so the text renders exactly once. Returns
 * the same array reference when nothing is dropped.
 */
export const dropLiveRevealJustificationParts = <T extends Pick<TurnActivityRecord, 'kind' | 'messageId'>>(
  parts: readonly T[],
  liveRevealBodyMessageId: string | null,
): T[] => {
  if (!liveRevealBodyMessageId) return parts as T[];
  const filtered = parts.filter(
    (part) => !(part.kind === 'justification' && part.messageId === liveRevealBodyMessageId),
  );
  return filtered.length === parts.length ? (parts as T[]) : filtered;
};

/**
 * Withhold the live-reveal message's justification rows across an Activity
 * segment list. Segment identity (and every segment whose parts are
 * untouched) keeps its original reference, so downstream memo/renderCompare
 * keys stay stable while the reveal is active.
 */
export const withholdLiveRevealActivitySegments = <
  T extends { parts: readonly TurnActivityRecord[] },
>(
  segments: readonly T[],
  liveRevealBodyMessageId: string | null,
): T[] => {
  if (!liveRevealBodyMessageId) return segments as T[];
  let changed = false;
  const withheld = segments.map((segment) => {
    const parts = dropLiveRevealJustificationParts(segment.parts, liveRevealBodyMessageId);
    if (parts === segment.parts) return segment;
    changed = true;
    return { ...segment, parts };
  });
  return changed ? withheld : (segments as T[]);
};
