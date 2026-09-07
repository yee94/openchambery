import { AssistantAPIError, isAbortError, type AssistantContactFilePart, type AssistantContactMessage, type AssistantContactPart, type AssistantContactTextPart } from '@/queries/assistantDTO';

type ContactComposerSendPart = AssistantContactTextPart | AssistantContactFilePart;

export const EMPTY_CONTACT_MESSAGES: AssistantContactMessage[] = [];

export type ContactOptimisticTurnStatus = 'sending' | 'admitted' | 'failed';

export type ContactOptimisticTurn = {
  assistantID: string;
  messageID: string;
  parts: readonly AssistantContactPart[];
  status: ContactOptimisticTurnStatus;
  error?: string;
  createdAt: number;
};

export type ContactTurnPreviewBubble = {
  bubbleIndex: number;
  text: string;
  done: boolean;
  occurredAt: number;
};

export type ContactTurnPreview = {
  assistantID: string;
  turnID: string;
  status: 'admitted' | 'streaming' | 'complete' | 'failed';
  bubbles: readonly ContactTurnPreviewBubble[];
  error?: string;
  occurredAt: number;
};

const optimisticText = (parts: readonly AssistantContactPart[]): string => (
  parts.flatMap((part) => (part.type === 'text' && part.text.trim() ? [part.text] : [])).join('\n')
);

export const createContactOptimisticTurn = (
  assistantID: string,
  messageID: string,
  parts: readonly AssistantContactPart[],
  createdAt = Date.now(),
): ContactOptimisticTurn => ({
  assistantID,
  messageID,
  parts,
  status: 'sending',
  createdAt,
});

export const scopeContactOptimisticTurns = (
  optimistic: readonly ContactOptimisticTurn[],
  assistantID: string,
): ContactOptimisticTurn[] => {
  const next = optimistic.filter((turn) => turn.assistantID === assistantID);
  return next.length === optimistic.length ? optimistic as ContactOptimisticTurn[] : next;
};

export const scopeContactTurnPreviews = (
  previews: readonly ContactTurnPreview[],
  assistantID: string,
): ContactTurnPreview[] => {
  const next = previews.filter((preview) => preview.assistantID === assistantID);
  return next.length === previews.length ? previews as ContactTurnPreview[] : next;
};

const previewMessage = (
  preview: ContactTurnPreview,
  bubble: ContactTurnPreviewBubble | null,
  ordinal: number,
  status: string,
): AssistantContactMessage => ({
  messageID: bubble
    ? `${preview.turnID}:preview:${bubble.bubbleIndex}`
    : `${preview.turnID}:preview:${status}`,
  assistantID: preview.assistantID,
  role: 'assistant',
  turnID: preview.turnID,
  bubbleIndex: bubble?.bubbleIndex ?? 0,
  createdAt: bubble?.occurredAt ?? preview.occurredAt,
  ordinal,
  status,
  fromAssistantID: null,
  fromAssistantName: null,
  parts: bubble ? [{ type: 'text', text: bubble.text }] : [],
  text: bubble?.text ?? '',
  cards: [],
});

const previewMessages = (
  preview: ContactTurnPreview,
  authoritativeBubbleIndexes: ReadonlySet<number>,
  ordinal: number,
): AssistantContactMessage[] => {
  const bubbles = preview.bubbles
    .filter((bubble) => !authoritativeBubbleIndexes.has(bubble.bubbleIndex))
    .map((bubble, index) => previewMessage(preview, bubble, ordinal + index, bubble.done ? 'complete' : 'streaming'));
  if (preview.status === 'failed') {
    return [...bubbles, previewMessage(preview, null, ordinal + bubbles.length, 'failed')];
  }
  // Working placeholder stays after any spoken bubbles until the turn ends.
  if (preview.status === 'admitted' || preview.status === 'streaming') {
    return [...bubbles, previewMessage(preview, null, ordinal + bubbles.length, 'admitted')];
  }
  return bubbles;
};

export const mergeContactTranscript = (
  messages: readonly AssistantContactMessage[],
  optimistic: readonly ContactOptimisticTurn[],
  assistantID: string,
  previews: readonly ContactTurnPreview[] = [],
): AssistantContactMessage[] => {
  const seen = new Set(messages.map((message) => message.messageID));
  const userExtras = optimistic.flatMap((turn, index) => {
    if (turn.assistantID !== assistantID || seen.has(turn.messageID)) return [];
    return [{
      messageID: turn.messageID,
      assistantID,
      role: 'user' as const,
      turnID: turn.messageID,
      bubbleIndex: 0,
      createdAt: turn.createdAt,
      ordinal: messages.length + index,
      status: turn.status,
      fromAssistantID: null,
      fromAssistantName: null,
      parts: [...turn.parts],
      text: optimisticText(turn.parts),
      cards: [],
    }];
  });
  const base = userExtras.length === 0
    ? messages as AssistantContactMessage[]
    : [...messages, ...userExtras];
  const scopedPreviews = previews.filter((preview) => preview.assistantID === assistantID);
  if (scopedPreviews.length === 0) return base;

  const lastIndexByTurn = new Map<string, number>();
  const authoritativeBubbleIndexesByTurn = new Map<string, Set<number>>();
  base.forEach((message, index) => {
    lastIndexByTurn.set(message.turnID, index);
    if (message.role !== 'assistant' || message.messageID.includes(':preview:')) return;
    const indexes = authoritativeBubbleIndexesByTurn.get(message.turnID) ?? new Set<number>();
    indexes.add(message.bubbleIndex);
    authoritativeBubbleIndexesByTurn.set(message.turnID, indexes);
  });
  const previewsAfterIndex = new Map<number, AssistantContactMessage[]>();
  const trailing: AssistantContactMessage[] = [];
  for (const preview of scopedPreviews) {
    const rows = previewMessages(
      preview,
      authoritativeBubbleIndexesByTurn.get(preview.turnID) ?? new Set<number>(),
      base.length + trailing.length,
    );
    if (rows.length === 0) continue;
    const index = lastIndexByTurn.get(preview.turnID);
    if (index === undefined) {
      trailing.push(...rows);
      continue;
    }
    const atIndex = previewsAfterIndex.get(index) ?? [];
    atIndex.push(...rows);
    previewsAfterIndex.set(index, atIndex);
  }
  if (previewsAfterIndex.size === 0 && trailing.length === 0) return base;
  return base.flatMap((message, index) => [message, ...(previewsAfterIndex.get(index) ?? [])]).concat(trailing);
};

export const reconcileContactOptimisticTurns = (
  optimistic: readonly ContactOptimisticTurn[],
  messages: readonly Pick<AssistantContactMessage, 'messageID'>[],
): ContactOptimisticTurn[] => {
  const seen = new Set(messages.map((message) => message.messageID));
  const next = optimistic.filter((turn) => !seen.has(turn.messageID));
  return next.length === optimistic.length ? optimistic as ContactOptimisticTurn[] : next;
};

export const markContactOptimisticAdmitted = (
  optimistic: readonly ContactOptimisticTurn[],
  messageID: string,
): ContactOptimisticTurn[] => (
  optimistic.map((turn) => (turn.messageID === messageID ? { ...turn, status: 'admitted' as const } : turn))
);

export const admitContactTurnPreview = (
  previews: readonly ContactTurnPreview[],
  assistantID: string,
  turnID: string,
  occurredAt = Date.now(),
): ContactTurnPreview[] => {
  if (previews.some((preview) => preview.assistantID === assistantID && preview.turnID === turnID)) {
    return previews as ContactTurnPreview[];
  }
  return [...previews, { assistantID, turnID, status: 'admitted', bubbles: [], occurredAt }];
};

export const applyContactBubbleDelta = (
  previews: readonly ContactTurnPreview[],
  event: {
    assistantID: string;
    turnID: string;
    bubbleIndex: number;
    delta: string;
    done: boolean;
    occurredAt: number;
  },
): ContactTurnPreview[] => {
  const admitted = admitContactTurnPreview(previews, event.assistantID, event.turnID, event.occurredAt);
  return admitted.map((preview) => {
    if (preview.assistantID !== event.assistantID || preview.turnID !== event.turnID || preview.status === 'failed' || preview.status === 'complete') return preview;
    const existing = preview.bubbles.find((bubble) => bubble.bubbleIndex === event.bubbleIndex);
    if (existing?.done) return preview;
    const nextBubble: ContactTurnPreviewBubble = existing
      ? { ...existing, text: `${existing.text}${event.delta}`, done: event.done, occurredAt: event.occurredAt }
      : { bubbleIndex: event.bubbleIndex, text: event.delta, done: event.done, occurredAt: event.occurredAt };
    const bubbles = existing
      ? preview.bubbles.map((bubble) => bubble.bubbleIndex === event.bubbleIndex ? nextBubble : bubble)
      : [...preview.bubbles, nextBubble].sort((left, right) => left.bubbleIndex - right.bubbleIndex);
    return { ...preview, status: 'streaming' as const, bubbles };
  });
};

export const endContactTurnPreview = (
  previews: readonly ContactTurnPreview[],
  event: {
    assistantID: string;
    turnID: string;
    status: 'complete' | 'error';
    error?: string;
    occurredAt: number;
  },
): ContactTurnPreview[] => {
  const admitted = admitContactTurnPreview(previews, event.assistantID, event.turnID, event.occurredAt);
  return admitted.map((preview) => {
    if (preview.assistantID !== event.assistantID || preview.turnID !== event.turnID) return preview;
    return {
      ...preview,
      status: event.status === 'error' ? 'failed' as const : 'complete' as const,
      ...(event.error ? { error: event.error } : {}),
    };
  });
};

export const reconcileContactTurnPreviews = (
  previews: readonly ContactTurnPreview[],
  messages: readonly Pick<AssistantContactMessage, 'role' | 'turnID'>[],
): ContactTurnPreview[] => {
  const authoritativeTurns = new Set(messages.flatMap((message) => message.role === 'assistant' ? [message.turnID] : []));
  const next = previews.filter((preview) => preview.status !== 'complete' || !authoritativeTurns.has(preview.turnID));
  return next.length === previews.length ? previews as ContactTurnPreview[] : next;
};

export const markContactOptimisticFailed = (
  optimistic: readonly ContactOptimisticTurn[],
  messageID: string,
  error: string,
): ContactOptimisticTurn[] => (
  optimistic.map((turn) => (turn.messageID === messageID ? { ...turn, status: 'failed' as const, error } : turn))
);

export const contactSendErrorMessage = (
  error: unknown,
  labels: { noProvider: string; sendFailed: string; timedOut: string },
): string => {
  if (error instanceof AssistantAPIError) {
    if (error.code === 'no_provider') return labels.noProvider;
    if (error.code === 'admission_timeout' || error.code === 'generate_timeout') return labels.timedOut;
    if (error.message && error.message !== error.code) return error.message;
  }
  if (isAbortError(error)) return labels.timedOut;
  return labels.sendFailed;
};

export type ContactSendGate = {
  tryAcquire: () => boolean;
  release: () => void;
};

export const createContactSendGate = (): ContactSendGate => {
  let locked = false;
  return {
    tryAcquire: () => {
      if (locked) return false;
      locked = true;
      return true;
    },
    release: () => {
      locked = false;
    },
  };
};

export const beginContactComposerSubmit = (input: {
  gate: ContactSendGate;
  sending: boolean;
  text: string;
  attachments: readonly { mime: string; url: string; name: string }[];
  assistantID: string;
  createMessageID: () => string;
  createdAt?: number;
}): { ok: true; messageID: string; parts: ContactComposerSendPart[]; turn: ContactOptimisticTurn } | { ok: false } => {
  const text = input.text.trim();
  if (input.sending || (!text && input.attachments.length === 0)) return { ok: false };
  if (!input.gate.tryAcquire()) return { ok: false };
  const parts: ContactComposerSendPart[] = [
    ...(text ? [{ type: 'text' as const, text }] : []),
    ...input.attachments.map((attachment) => ({
      type: 'file' as const,
      mime: attachment.mime,
      url: attachment.url,
      filename: attachment.name,
    })),
  ];
  const messageID = input.createMessageID();
  return {
    ok: true,
    messageID,
    parts,
    turn: createContactOptimisticTurn(input.assistantID, messageID, parts, input.createdAt),
  };
};

export const contactOptimisticSending = (optimistic: readonly ContactOptimisticTurn[]): boolean => (
  optimistic.some((turn) => turn.status === 'sending')
);

export const contactTurnPreviewWorking = (previews: readonly ContactTurnPreview[]): boolean => (
  previews.some((preview) => preview.status === 'admitted' || preview.status === 'streaming')
);
