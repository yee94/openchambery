import { AssistantAPIError, type AssistantContactMessage, type AssistantContactPart } from '@/queries/assistantDTO';

export const EMPTY_CONTACT_MESSAGES: AssistantContactMessage[] = [];

export type ContactOptimisticTurnStatus = 'sending' | 'failed';

export type ContactOptimisticTurn = {
  assistantID: string;
  messageID: string;
  parts: readonly AssistantContactPart[];
  status: ContactOptimisticTurnStatus;
  error?: string;
  createdAt: number;
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

export const mergeContactTranscript = (
  messages: readonly AssistantContactMessage[],
  optimistic: readonly ContactOptimisticTurn[],
  assistantID: string,
): AssistantContactMessage[] => {
  const seen = new Set(messages.map((message) => message.messageID));
  const extras = optimistic.flatMap((turn, index) => {
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
  return extras.length === 0 ? messages as AssistantContactMessage[] : [...messages, ...extras];
};

export const reconcileContactOptimisticTurns = (
  optimistic: readonly ContactOptimisticTurn[],
  messages: readonly Pick<AssistantContactMessage, 'messageID'>[],
): ContactOptimisticTurn[] => {
  const seen = new Set(messages.map((message) => message.messageID));
  const next = optimistic.filter((turn) => !seen.has(turn.messageID));
  return next.length === optimistic.length ? optimistic as ContactOptimisticTurn[] : next;
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
  labels: { noProvider: string; sendFailed: string },
): string => {
  if (error instanceof AssistantAPIError) {
    if (error.code === 'no_provider') return labels.noProvider;
    if (error.message && error.message !== error.code) return error.message;
  }
  return labels.sendFailed;
};

export const contactOptimisticSending = (optimistic: readonly ContactOptimisticTurn[]): boolean => (
  optimistic.some((turn) => turn.status === 'sending')
);
