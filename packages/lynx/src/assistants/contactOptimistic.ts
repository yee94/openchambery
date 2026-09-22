/**
 * Portable Cap `contactOptimisticTurns` for the Lynx contact LegendList.
 *
 * Optimistic user rows: sending → admitted → failed.
 * Assistant previews: admitted → streaming (bubble deltas) → complete | failed | cancelled.
 * Reconcile drops rows the authoritative history page already contains.
 * Failure of a later GET keeps the previous pages — never an empty transcript.
 *
 * Text-only. Host file/camera attachments stay out of this module.
 */
import type { LynxTimelineEntry } from '../chat/timelineModel';
import {
  extractLynxContactCards,
  projectLynxContactTimelineEntries,
  type LynxContactCard,
  type LynxContactChatMessage,
} from './contactDisplay';
import { buildLynxContactTranscript } from './contactMerge';
import {
  flattenLynxAssistantHistoryPages,
  type LynxAssistantHistoryLoadResult,
  type LynxAssistantHistoryPage,
} from './contactMessages';

export type LynxContactOptimisticStatus = 'sending' | 'admitted' | 'failed';

export type LynxContactOptimisticTurn = {
  assistantID: string;
  messageID: string;
  text: string;
  status: LynxContactOptimisticStatus;
  error?: string;
  createdAt: number;
};

export type LynxContactTurnPreviewBubble = {
  bubbleIndex: number;
  text: string;
  done: boolean;
  occurredAt: number;
};

export type LynxContactTurnPreviewStatus = 'admitted' | 'streaming' | 'complete' | 'failed';

export type LynxContactTurnPreview = {
  assistantID: string;
  turnID: string;
  status: LynxContactTurnPreviewStatus;
  bubbles: readonly LynxContactTurnPreviewBubble[];
  error?: string;
  occurredAt: number;
};

export type LynxContactPreviewState = {
  previews: readonly LynxContactTurnPreview[];
  /** Turns that already received turn-end. Late deltas must not reopen them. */
  settledTurnIDs: ReadonlySet<string>;
};

export type LynxContactReconcileRow = {
  id: string;
  role: string;
  text?: string;
};

const EMPTY_MESSAGES: LynxContactChatMessage[] = [];

export const createLynxContactOptimisticTurn = (
  assistantID: string,
  messageID: string,
  text: string,
  createdAt = Date.now(),
): LynxContactOptimisticTurn => ({
  assistantID,
  messageID,
  text,
  status: 'sending',
  createdAt,
});

export const markLynxContactOptimisticAdmitted = (
  turns: readonly LynxContactOptimisticTurn[],
  messageID: string,
): LynxContactOptimisticTurn[] => (
  turns.map((turn) => (
    turn.messageID === messageID ? { ...turn, status: 'admitted' as const, error: undefined } : turn
  ))
);

export const markLynxContactOptimisticFailed = (
  turns: readonly LynxContactOptimisticTurn[],
  messageID: string,
  error: string,
): LynxContactOptimisticTurn[] => (
  turns.map((turn) => (
    turn.messageID === messageID ? { ...turn, status: 'failed' as const, error } : turn
  ))
);

const samePreviewList = (
  next: readonly LynxContactTurnPreview[],
  previous: readonly LynxContactTurnPreview[],
): boolean => (
  next.length === previous.length && next.every((preview, index) => preview === previous[index])
);

const admitLynxContactTurnPreview = (
  previews: readonly LynxContactTurnPreview[],
  assistantID: string,
  turnID: string,
  occurredAt = Date.now(),
): LynxContactTurnPreview[] => {
  const withoutStaleFailed = previews.filter((preview) => (
    preview.assistantID !== assistantID || preview.status !== 'failed' || preview.turnID === turnID
  ));
  if (withoutStaleFailed.some((preview) => preview.assistantID === assistantID && preview.turnID === turnID)) {
    return withoutStaleFailed.length === previews.length ? previews as LynxContactTurnPreview[] : withoutStaleFailed;
  }
  return [...withoutStaleFailed, { assistantID, turnID, status: 'admitted', bubbles: [], occurredAt }];
};

export const applyLynxContactBubbleDelta = (
  previews: readonly LynxContactTurnPreview[],
  event: {
    assistantID: string;
    turnID: string;
    bubbleIndex: number;
    delta: string;
    done: boolean;
    occurredAt: number;
  },
): LynxContactTurnPreview[] => {
  const admitted = admitLynxContactTurnPreview(previews, event.assistantID, event.turnID, event.occurredAt);
  return admitted.map((preview) => {
    if (
      preview.assistantID !== event.assistantID
      || preview.turnID !== event.turnID
      || preview.status === 'failed'
      || preview.status === 'complete'
    ) return preview;
    const existing = preview.bubbles.find((bubble) => bubble.bubbleIndex === event.bubbleIndex);
    if (existing?.done) return preview;
    const nextBubble: LynxContactTurnPreviewBubble = existing
      ? { ...existing, text: `${existing.text}${event.delta}`, done: event.done, occurredAt: event.occurredAt }
      : {
        bubbleIndex: event.bubbleIndex,
        text: event.delta,
        done: event.done,
        occurredAt: event.occurredAt,
      };
    const bubbles = existing
      ? preview.bubbles.map((bubble) => (bubble.bubbleIndex === event.bubbleIndex ? nextBubble : bubble))
      : [...preview.bubbles, nextBubble].sort((left, right) => left.bubbleIndex - right.bubbleIndex);
    return { ...preview, status: 'streaming' as const, bubbles };
  });
};

const endLynxContactTurnPreview = (
  previews: readonly LynxContactTurnPreview[],
  event: {
    assistantID: string;
    turnID: string;
    status: 'complete' | 'error' | 'cancelled';
    error?: string;
    occurredAt: number;
  },
  options: { requireExisting?: boolean } = {},
): LynxContactTurnPreview[] => {
  if (options.requireExisting) {
    if (!previews.some((preview) => preview.assistantID === event.assistantID && preview.turnID === event.turnID)) {
      return previews as LynxContactTurnPreview[];
    }
  }
  if (event.status === 'cancelled') {
    const next = previews.flatMap((preview) => {
      if (preview.assistantID !== event.assistantID || preview.turnID !== event.turnID) return [preview];
      if (preview.bubbles.length === 0) return [];
      if (preview.status === 'complete' || preview.status === 'failed') return [preview];
      return [{ ...preview, status: 'complete' as const }];
    });
    return samePreviewList(next, previews) ? previews as LynxContactTurnPreview[] : next;
  }
  const admitted = admitLynxContactTurnPreview(previews, event.assistantID, event.turnID, event.occurredAt);
  return admitted.map((preview) => {
    if (preview.assistantID !== event.assistantID || preview.turnID !== event.turnID) return preview;
    if (preview.status === 'complete' || preview.status === 'failed') return preview;
    return {
      ...preview,
      status: event.status === 'error' ? 'failed' as const : 'complete' as const,
      ...(event.error ? { error: event.error } : {}),
    };
  });
};

/**
 * Local stop after a successful session abort. Keeps streamed bubble text,
 * drops the empty working placeholder, and does not mark the turn successful
 * beyond text that already arrived.
 */
export const settleLynxContactPreviewsOnAbort = (
  previews: readonly LynxContactTurnPreview[],
  assistantID: string,
): LynxContactTurnPreview[] => {
  const next = previews.flatMap((preview) => {
    if (preview.assistantID !== assistantID) return [preview];
    if (preview.status !== 'admitted' && preview.status !== 'streaming') return [preview];
    if (preview.bubbles.length === 0) return [];
    return [{ ...preview, status: 'complete' as const }];
  });
  return samePreviewList(next, previews) ? previews as LynxContactTurnPreview[] : next;
};

export const createLynxContactPreviewState = (): LynxContactPreviewState => ({
  previews: [],
  settledTurnIDs: new Set(),
});

/**
 * Fold one parsed contact event. Other assistants and late deltas for a
 * settled turn return the same state reference.
 */
export function reduceLynxContactTurnEvent(
  state: LynxContactPreviewState,
  event: {
    type: 'contact-turn-start' | 'contact-bubble-delta' | 'contact-turn-end';
    assistantID: string;
    turnID: string;
    messageID?: string;
    bubbleIndex?: number;
    delta?: string;
    done?: boolean;
    status?: 'complete' | 'error' | 'cancelled';
    error?: string;
    occurredAt: number;
  },
): LynxContactPreviewState {
  if (event.type === 'contact-bubble-delta') {
    if (state.settledTurnIDs.has(event.turnID)) return state;
    const previews = applyLynxContactBubbleDelta(state.previews, {
      assistantID: event.assistantID,
      turnID: event.turnID,
      bubbleIndex: event.bubbleIndex ?? 0,
      delta: event.delta ?? '',
      done: event.done === true,
      occurredAt: event.occurredAt,
    });
    return previews === state.previews ? state : { ...state, previews };
  }

  if (event.type === 'contact-turn-end') {
    const settledTurnIDs = new Set(state.settledTurnIDs);
    settledTurnIDs.add(event.turnID);
    const previews = endLynxContactTurnPreview(state.previews, {
      assistantID: event.assistantID,
      turnID: event.turnID,
      status: event.status ?? 'complete',
      ...(event.error ? { error: event.error } : {}),
      occurredAt: event.occurredAt,
    }, { requireExisting: true });
    return { previews, settledTurnIDs };
  }

  const settledTurnIDs = new Set(state.settledTurnIDs);
  settledTurnIDs.delete(event.turnID);
  return {
    settledTurnIDs,
    previews: admitLynxContactTurnPreview(state.previews, event.assistantID, event.turnID, event.occurredAt),
  };
}

export const reconcileLynxContactOptimisticTurns = (
  turns: readonly LynxContactOptimisticTurn[],
  rows: readonly LynxContactReconcileRow[],
): LynxContactOptimisticTurn[] => {
  const seen = new Set(rows.map((row) => row.id));
  const next = turns.filter((turn) => !seen.has(turn.messageID));
  return next.length === turns.length ? turns as LynxContactOptimisticTurn[] : next;
};

const bubblePrefix = (turnID: string): string => `${turnID}:bubble:`;

const turnPresent = (
  rows: readonly LynxContactReconcileRow[],
  turnID: string,
  extraPresent: ReadonlySet<string> | undefined,
): boolean => {
  if (extraPresent?.has(turnID)) return true;
  return rows.some((row) => row.id === turnID || row.id.startsWith(`${turnID}:`));
};

const turnAuthoritativeAssistant = (
  rows: readonly LynxContactReconcileRow[],
  turnID: string,
): boolean => {
  const prefix = bubblePrefix(turnID);
  if (rows.some((row) => row.role === 'assistant' && (row.id === turnID || row.id.startsWith(prefix)))) {
    return true;
  }
  const start = rows.findIndex((row) => row.id === turnID);
  if (start < 0) return false;
  for (let index = start + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row) break;
    if (row.role === 'user') break;
    if (row.id.startsWith('oc_asst_session_divider:')) break;
    if (row.role === 'assistant' && (row.text ?? '').trim()) return true;
  }
  return false;
};

/**
 * Drop previews the history page already covers.
 * Admitted/streaming overlays stay until turn-end or an authoritative assistant row.
 * Complete previews drop once that assistant row exists.
 * Failed overlays drop once a newer turn is present.
 */
export const reconcileLynxContactTurnPreviews = (
  previews: readonly LynxContactTurnPreview[],
  rows: readonly LynxContactReconcileRow[],
  options?: { presentTurnIDs?: ReadonlySet<string> },
): LynxContactTurnPreview[] => {
  const lastUser = [...rows].reverse().find((row) => row.role === 'user');
  const lastTurnID = lastUser?.id ?? (rows.length > 0 ? rows[rows.length - 1]?.id ?? null : null);
  const liveTurnID = [...previews].reverse().find((preview) => (
    preview.status === 'admitted' || preview.status === 'streaming'
  ))?.turnID ?? lastTurnID;
  const next = previews.filter((preview) => {
    const present = turnPresent(rows, preview.turnID, options?.presentTurnIDs);
    const authoritative = turnAuthoritativeAssistant(rows, preview.turnID);
    if (preview.status === 'admitted' || preview.status === 'streaming') return true;
    if (preview.status === 'complete' && authoritative) return false;
    if (!present) return false;
    if (preview.status === 'failed') {
      if (liveTurnID && liveTurnID !== preview.turnID) return false;
      if (lastTurnID && lastTurnID !== preview.turnID) return false;
    }
    return true;
  });
  return next.length === previews.length ? previews as LynxContactTurnPreview[] : next;
};

const authoritativeBubbleIndexes = (
  messages: readonly LynxContactChatMessage[],
  turnID: string,
): Set<number> => {
  const prefix = bubblePrefix(turnID);
  const indexes = new Set<number>();
  for (const message of messages) {
    if (!message.info.id.startsWith(prefix)) continue;
    const raw = Number(message.info.id.slice(prefix.length));
    if (Number.isSafeInteger(raw) && raw >= 1) indexes.add(raw - 1);
  }
  return indexes;
};

const previewChatMessage = (
  preview: LynxContactTurnPreview,
  bubble: LynxContactTurnPreviewBubble | null,
  status: string,
): LynxContactChatMessage => {
  const text = bubble?.text ?? (status === 'failed' ? (preview.error ?? '') : '…');
  return {
    info: {
      id: bubble
        ? `${preview.turnID}:preview:${bubble.bubbleIndex}`
        : `${preview.turnID}:preview:${status}`,
      role: 'assistant',
      time: { created: bubble?.occurredAt ?? preview.occurredAt },
    },
    parts: text ? [{ type: 'text', text }] : [],
    kind: 'message',
  };
};

const previewMessages = (
  preview: LynxContactTurnPreview,
  covered: ReadonlySet<number>,
): LynxContactChatMessage[] => {
  const bubbles = preview.bubbles
    .filter((bubble) => !covered.has(bubble.bubbleIndex))
    .map((bubble) => previewChatMessage(preview, bubble, bubble.done ? 'complete' : 'streaming'));
  if (preview.status === 'failed') {
    return [...bubbles, previewChatMessage(preview, null, 'failed')];
  }
  if (preview.status === 'admitted' || preview.status === 'streaming') {
    return [...bubbles, previewChatMessage(preview, null, 'admitted')];
  }
  return bubbles;
};

const anchorIndex = (
  messages: readonly LynxContactChatMessage[],
  turnID: string,
): number | undefined => {
  let found = -1;
  for (let index = 0; index < messages.length; index += 1) {
    const id = messages[index]?.info.id ?? '';
    if (id === turnID || id.startsWith(`${turnID}:`)) found = index;
  }
  if (found < 0) return undefined;
  let end = found;
  for (let index = found + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) break;
    if (message.info.role === 'user' || message.kind === 'session-divider') break;
    end = index;
  }
  return end;
};

const belongsToTurn = (message: LynxContactChatMessage, turnID: string): boolean => (
  message.info.id === turnID || message.info.id.startsWith(`${turnID}:`)
);

/**
 * Insert optimistic user rows and assistant preview bubbles into the stitched
 * transcript. One list — callers project it with `projectLynxContactTimelineEntries`.
 */
export function mergeLynxContactTranscript(
  messages: readonly LynxContactChatMessage[],
  optimistic: readonly LynxContactOptimisticTurn[],
  assistantID: string,
  previews: readonly LynxContactTurnPreview[] = [],
): LynxContactChatMessage[] {
  const rows = messages.map((message) => ({
    id: message.info.id,
    role: message.info.role,
    text: message.parts
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join(''),
  }));
  const presentTurnIDs = new Set(
    optimistic.filter((turn) => turn.assistantID === assistantID).map((turn) => turn.messageID),
  );
  const scopedOptimistic = reconcileLynxContactOptimisticTurns(
    optimistic.filter((turn) => turn.assistantID === assistantID),
    rows,
  );
  const scopedPreviews = reconcileLynxContactTurnPreviews(
    previews.filter((preview) => preview.assistantID === assistantID),
    rows,
    { presentTurnIDs },
  );

  const seen = new Set(messages.map((message) => message.info.id));
  const userExtras: LynxContactChatMessage[] = [];
  for (const turn of scopedOptimistic) {
    if (seen.has(turn.messageID)) continue;
    userExtras.push({
      info: {
        id: turn.messageID,
        role: 'user',
        time: { created: turn.createdAt },
      },
      parts: [{ type: 'text', text: turn.text }],
      kind: 'message',
    });
  }
  const base = userExtras.length === 0 ? messages as LynxContactChatMessage[] : [...messages, ...userExtras];
  if (scopedPreviews.length === 0) return base;

  const previewsAfterIndex = new Map<number, LynxContactChatMessage[]>();
  const trailing: LynxContactChatMessage[] = [];
  for (const preview of scopedPreviews) {
    const covered = authoritativeBubbleIndexes(base, preview.turnID);
    const previewRows = previewMessages(preview, covered);
    if (previewRows.length === 0) continue;
    const index = anchorIndex(base, preview.turnID);
    if (index === undefined) {
      if (
        preview.status === 'failed'
        && base.some((message) => !belongsToTurn(message, preview.turnID))
      ) continue;
      trailing.push(...previewRows);
      continue;
    }
    const atIndex = previewsAfterIndex.get(index) ?? [];
    atIndex.push(...previewRows);
    previewsAfterIndex.set(index, atIndex);
  }
  if (previewsAfterIndex.size === 0 && trailing.length === 0) return base;
  return base.flatMap((message, index) => [message, ...(previewsAfterIndex.get(index) ?? [])]).concat(trailing);
}

export function reconcileLynxContactOverlays(input: {
  pages: readonly LynxAssistantHistoryPage[];
  sessionID: string | null | undefined;
  optimistic: readonly LynxContactOptimisticTurn[];
  previews: readonly LynxContactTurnPreview[];
}): {
  optimistic: readonly LynxContactOptimisticTurn[];
  previews: readonly LynxContactTurnPreview[];
} {
  const transcript = buildLynxContactTranscript(
    flattenLynxAssistantHistoryPages(input.pages),
    input.sessionID,
  );
  const rows = transcript.map((message) => ({
    id: message.info.id,
    role: message.info.role,
    text: message.parts
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join(''),
  }));
  const presentTurnIDs = new Set(input.optimistic.map((turn) => turn.messageID));
  return {
    optimistic: reconcileLynxContactOptimisticTurns(input.optimistic, rows),
    previews: reconcileLynxContactTurnPreviews(input.previews, rows, { presentTurnIDs }),
  };
}

const lynxContactOverlayWorking = (
  optimistic: readonly LynxContactOptimisticTurn[],
  previews: readonly LynxContactTurnPreview[],
  assistantID?: string,
): boolean => (
  optimistic.some((turn) => (
    (assistantID === undefined || turn.assistantID === assistantID) && turn.status === 'sending'
  ))
  || previews.some((preview) => (
    (assistantID === undefined || preview.assistantID === assistantID)
    && (preview.status === 'admitted' || preview.status === 'streaming')
  ))
);

/**
 * A failed history refresh keeps `current`. An ok page replaces the window
 * the screen already uses (newest page). Never substitute [] for a failure.
 */
export function pagesAfterLynxContactHistoryRefresh(
  current: readonly LynxAssistantHistoryPage[],
  result: LynxAssistantHistoryLoadResult,
): readonly LynxAssistantHistoryPage[] {
  if (result.status !== 'ok') return current;
  return [result.page];
}

export type LynxContactTimelineComposition = {
  entries: LynxTimelineEntry[];
  cards: Record<string, LynxContactCard[]>;
  working: boolean;
};

/**
 * History pages + optimistic sends + contact previews → one LegendList payload.
 */
export function composeLynxContactTimeline(input: {
  pages: readonly LynxAssistantHistoryPage[];
  sessionID: string | null | undefined;
  assistantID: string;
  optimistic: readonly LynxContactOptimisticTurn[];
  previews: readonly LynxContactTurnPreview[];
}): LynxContactTimelineComposition {
  const flat = flattenLynxAssistantHistoryPages(input.pages);
  const transcript = buildLynxContactTranscript(flat, input.sessionID);
  const merged = mergeLynxContactTranscript(
    transcript.length === 0 ? EMPTY_MESSAGES : transcript,
    input.optimistic,
    input.assistantID,
    input.previews,
  );
  const entries = projectLynxContactTimelineEntries(merged);
  const cards: Record<string, LynxContactCard[]> = {};
  for (const message of merged) {
    cards[message.info.id] = extractLynxContactCards(message);
  }
  return {
    entries,
    cards,
    working: lynxContactOverlayWorking(input.optimistic, input.previews, input.assistantID),
  };
}
