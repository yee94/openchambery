import type { Message, Part } from '@opencode-ai/sdk/v2';
import type { ChatMessageEntry } from '@/components/chat/lib/turns/types';
import type { AssistantHistoryEntry, AssistantHistoryPage } from '@/queries/assistantQueries';

export const ASSISTANT_SESSION_DIVIDER_PREFIX = 'oc_asst_session_divider:';

const EMPTY_PREFIX: ChatMessageEntry[] = [];
const EMPTY_PARTS: Part[] = [];

export const isAssistantSessionDivider = (message: ChatMessageEntry | null | undefined): boolean => (
  typeof message?.info?.id === 'string' && message.info.id.startsWith(ASSISTANT_SESSION_DIVIDER_PREFIX)
);

export const createAssistantSessionDivider = (sessionID: string, createdAt = 0): ChatMessageEntry => ({
  info: {
    id: `${ASSISTANT_SESSION_DIVIDER_PREFIX}${sessionID}`,
    role: 'system',
    time: { created: createdAt },
  } as unknown as Message,
  parts: [],
});

/** Directory sync stores bare Message[]; ChatContainer consumes { info, parts }. */
export const toChatMessageEntries = (
  messages: readonly Message[] | undefined,
  partsByMessageID: Record<string, Part[] | undefined> | undefined,
): ChatMessageEntry[] => {
  if (!messages?.length) return EMPTY_PREFIX;
  const result: ChatMessageEntry[] = [];
  for (const info of messages) {
    if (!info || typeof info.id !== 'string' || !info.id) continue;
    result.push({
      info,
      parts: partsByMessageID?.[info.id] ?? EMPTY_PARTS,
    });
  }
  return result.length === 0 ? EMPTY_PREFIX : result;
};

export const flattenAssistantHistoryPages = (pages: readonly Pick<AssistantHistoryPage, 'entries'>[]): AssistantHistoryEntry[] => (
  pages.slice().reverse().flatMap((page) => page.entries)
);

export const stitchHostedSessionHistory = (
  entries: readonly AssistantHistoryEntry[],
  currentSessionID: string | null | undefined,
  previousPrefix: ChatMessageEntry[] = EMPTY_PREFIX,
): ChatMessageEntry[] => {
  if (!entries.length) return EMPTY_PREFIX;

  const result: ChatMessageEntry[] = [];
  let sawContent = false;
  let previousSessionID: string | null = null;
  for (const entry of entries) {
    if (entry.sessionID === currentSessionID) continue;
    if (sawContent && previousSessionID !== entry.sessionID) {
      result.push(createAssistantSessionDivider(entry.sessionID, Number((entry.info as { time?: { created?: number } }).time?.created ?? 0)));
    }
    result.push({ info: entry.info, parts: entry.parts, sourceSessionID: entry.sessionID, sourceDirectory: entry.directory });
    sawContent = true;
    previousSessionID = entry.sessionID;
  }
  if (result.length === 0) return EMPTY_PREFIX;
  return samePrefix(previousPrefix, result) ? previousPrefix : result;
};

const sameAssistantSessionDivider = (
  left: ChatMessageEntry,
  right: ChatMessageEntry,
): boolean => {
  if (!isAssistantSessionDivider(left) || !isAssistantSessionDivider(right)) return false;
  const leftCreatedAt = Number((left.info as { time?: { created?: number } }).time?.created ?? 0);
  const rightCreatedAt = Number((right.info as { time?: { created?: number } }).time?.created ?? 0);
  return left.info.id === right.info.id && leftCreatedAt === rightCreatedAt;
};

const samePrefix = (left: readonly ChatMessageEntry[], right: readonly ChatMessageEntry[]): boolean => {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftEntry = left[index];
    const rightEntry = right[index];
    if (!leftEntry || !rightEntry) return false;
    if (leftEntry === rightEntry || sameAssistantSessionDivider(leftEntry, rightEntry)) continue;
    if (leftEntry?.info !== rightEntry?.info || leftEntry?.parts !== rightEntry?.parts || leftEntry.sourceSessionID !== rightEntry.sourceSessionID || leftEntry.sourceDirectory !== rightEntry.sourceDirectory) return false;
  }
  return true;
};
