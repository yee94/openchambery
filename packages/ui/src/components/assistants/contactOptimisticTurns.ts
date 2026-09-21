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
      // Failed overlays must not trail into a later conversation after wipe.
      if (preview.status === 'failed' && base.some((message) => message.turnID !== preview.turnID)) continue;
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
  const withoutStaleFailed = previews.filter((preview) => (
    preview.assistantID !== assistantID || preview.status !== 'failed' || preview.turnID === turnID
  ));
  if (withoutStaleFailed.some((preview) => preview.assistantID === assistantID && preview.turnID === turnID)) {
    return withoutStaleFailed.length === previews.length
      ? previews as ContactTurnPreview[]
      : withoutStaleFailed as ContactTurnPreview[];
  }
  return [...withoutStaleFailed, { assistantID, turnID, status: 'admitted', bubbles: [], occurredAt }];
};

/**
 * Rehydrate the 3-dot processing row from server-authoritative activeContactTurn
 * after APP restart / remount. Local SSE previews remain temporary overlays.
 */
export const seedContactTurnPreviewFromServer = (
  previews: readonly ContactTurnPreview[],
  active: { assistantID: string; turnID: string; admittedAt: number } | null | undefined,
  settledTurnIDs?: ReadonlySet<string>,
): ContactTurnPreview[] => {
  if (!active?.turnID || !active.assistantID) return previews as ContactTurnPreview[];
  if (settledTurnIDs?.has(active.turnID)) return previews as ContactTurnPreview[];
  return admitContactTurnPreview(previews, active.assistantID, active.turnID, active.admittedAt);
};

/**
 * Apply snapshot authority to local previews.
 * - Seed from activeContactTurn when server is busy.
 * - When server is idle and snapshot revision covers admission, drop stale
 *   admitted/streaming overlays (missed contact-turn-end recovery).
 * - Never clear a newer local send whose admission revision is ahead of this
 *   snapshot, or a turn still in optimistic "sending".
 * - Recover durable error rows from contact messages without SSE.
 * - Failed overlays are ephemeral: a newer turn or vanished turnID drops them
 *   so a timeout cannot trail into the next conversation.
 */
export const applyServerContactTurnAuthority = (
  previews: readonly ContactTurnPreview[],
  input: {
    assistantID: string;
    activeContactTurn?: { turnID: string; admittedAt: number } | null;
    serverWorking?: boolean;
    snapshotRevision?: number | null;
    admissionRevisionByTurnID?: ReadonlyMap<string, number> | Record<string, number>;
    pendingSendTurnIDs?: ReadonlySet<string>;
    messages?: readonly Pick<AssistantContactMessage, 'role' | 'turnID' | 'status' | 'text'>[];
    settledTurnIDs?: ReadonlySet<string>;
    occurredAt?: number;
  },
): ContactTurnPreview[] => {
  const assistantID = input.assistantID;
  const pending = input.pendingSendTurnIDs ?? new Set<string>();
  const settled = input.settledTurnIDs ?? new Set<string>();
  const revision = typeof input.snapshotRevision === 'number' && Number.isFinite(input.snapshotRevision)
    ? input.snapshotRevision
    : null;
  const admissionRevisions = input.admissionRevisionByTurnID instanceof Map
    ? input.admissionRevisionByTurnID
    : new Map(Object.entries(input.admissionRevisionByTurnID ?? {}).map(([key, value]) => [key, Number(value)]));
  const occurredAt = input.occurredAt ?? Date.now();
  const active = input.activeContactTurn && input.activeContactTurn.turnID
    ? input.activeContactTurn
    : null;
  const serverBusy = Boolean(input.serverWorking || active);

  let next = seedContactTurnPreviewFromServer(
    previews,
    active ? { assistantID, turnID: active.turnID, admittedAt: active.admittedAt } : null,
    settled,
  );

  const messages = Array.isArray(input.messages) ? input.messages : [];
  for (const message of messages) {
    if (message.role !== 'assistant' || message.status !== 'error') continue;
    if (pending.has(message.turnID) || settled.has(message.turnID)) continue;
    next = endContactTurnPreview(next, {
      assistantID,
      turnID: message.turnID,
      status: 'error',
      error: message.text || 'upstream_error',
      occurredAt,
    });
  }

  next = reconcileContactTurnPreviews(next, messages);

  if (serverBusy) {
    // Keep other local turns unless a stale idle path; only ensure active is present.
    const busyFiltered = next.filter((preview) => {
      if (preview.assistantID !== assistantID) return true;
      if (preview.status !== 'admitted' && preview.status !== 'streaming') return true;
      if (pending.has(preview.turnID)) return true;
      if (active && preview.turnID === active.turnID) return true;
      // Server is busy on a different turn — drop overlays the server no longer owns
      // once their admission is covered by this snapshot revision.
      const admittedAt = admissionRevisions.get(preview.turnID);
      if (typeof admittedAt === 'number' && revision != null && revision < admittedAt) return true;
      if (typeof admittedAt === 'number' && revision != null && revision >= admittedAt && preview.turnID !== active?.turnID) {
        return false;
      }
      // Unknown admission age while server points at another turn: keep until covered.
      return !active || preview.turnID === active.turnID;
    });
    if (
      busyFiltered.length === previews.length
      && busyFiltered.every((preview, index) => preview === previews[index])
    ) {
      return previews as ContactTurnPreview[];
    }
    return busyFiltered as ContactTurnPreview[];
  }

  // Without an authoritative snapshot revision, seed only — do not clear local overlays.
  if (revision == null) {
    if (
      next.length === previews.length
      && next.every((preview, index) => preview === previews[index])
    ) {
      return previews as ContactTurnPreview[];
    }
    return next;
  }

  // Server idle: clear temporary processing once snapshot covers admission.
  const filtered = next.filter((preview) => {
    if (preview.assistantID !== assistantID) return true;
    if (preview.status !== 'admitted' && preview.status !== 'streaming') return true;
    if (pending.has(preview.turnID)) return true;
    if (settled.has(preview.turnID)) return false;
    const admittedAt = admissionRevisions.get(preview.turnID);
    if (typeof admittedAt === 'number' && revision < admittedAt) {
      // Stale idle snapshot must not wipe a newer send.
      return true;
    }
    // Covered by idle authority (or seeded without local admission tracking after
    // a full snapshot refresh that already reports idle).
    return false;
  });
  if (
    filtered.length === previews.length
    && filtered.every((preview, index) => preview === previews[index])
  ) {
    return previews as ContactTurnPreview[];
  }
  return filtered.length === next.length ? next : filtered as ContactTurnPreview[];
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
  options: {
    /** Ignore stale ends for turns the surface never tracked (do not invent failed rows). */
    requireExisting?: boolean;
  } = {},
): ContactTurnPreview[] => {
  if (options.requireExisting) {
    if (!previews.some((preview) => preview.assistantID === event.assistantID && preview.turnID === event.turnID)) {
      return previews as ContactTurnPreview[];
    }
  }
  const admitted = admitContactTurnPreview(previews, event.assistantID, event.turnID, event.occurredAt);
  return admitted.map((preview) => {
    if (preview.assistantID !== event.assistantID || preview.turnID !== event.turnID) return preview;
    // A later-admitted turn must not be wiped by a stale end for an older turnID.
    if (preview.status === 'complete' || preview.status === 'failed') return preview;
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
  const presentTurnIDs = new Set(messages.map((message) => message.turnID).filter(Boolean));
  const lastTurnID = messages.length > 0 ? messages[messages.length - 1]?.turnID ?? null : null;
  const liveTurnID = [...previews].reverse().find((preview) => (
    preview.status === 'admitted' || preview.status === 'streaming'
  ))?.turnID ?? lastTurnID;
  const authoritativeTurns = new Set(messages.flatMap((message) => message.role === 'assistant' ? [message.turnID] : []));
  const next = previews.filter((preview) => {
    if (preview.status === 'admitted' || preview.status === 'streaming') return true;
    if (preview.status === 'complete' && authoritativeTurns.has(preview.turnID)) return false;
    if (!presentTurnIDs.has(preview.turnID)) return false;
    if (preview.status === 'failed') {
      if (liveTurnID && liveTurnID !== preview.turnID) return false;
      if (lastTurnID && lastTurnID !== preview.turnID) return false;
    }
    return true;
  });
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
