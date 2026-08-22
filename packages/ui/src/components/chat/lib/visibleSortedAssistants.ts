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

/**
 * Which assistant message currently owns the sorted live body reveal.
 *
 * The live reveal does not fold on tool arrival (text usually precedes tool
 * calls within one step), so the streaming last assistant keeps streaming its
 * body until the step boundary — its `finish` stamps non-`stop`, or the
 * message completes/errors. While that reveal is active the Activity group
 * must withhold the SAME text (its justification row), or the paragraph
 * renders twice: once in the body of the streaming message and once in the
 * Activity group hosted on the turn's first assistant.
 *
 * The phase derivation is owned by `resolveSortedRevealStreamPhase` — the
 * same single derivation the reveal predicate consumes — so the Activity
 * dedup cannot drift from what the body render decides.
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
    // The streaming id is always the last visible assistant of its turn.
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
