import React from 'react';
import type { Message, Part } from '@opencode-ai/sdk/v2';
import type { ChatMessageEntry } from '@/components/chat/lib/turns/types';
import { useDirectoryStore } from '@/sync/sync-context';
import { fetchMessagesForSession } from '@/sync/session-actions';
import { useSync } from '@/sync/use-sync';

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

export const stitchHostedSessionHistory = (
  historySessionIDs: readonly string[],
  currentSessionID: string | null | undefined,
  directory: string | null | undefined,
  readEntries: (sessionID: string) => readonly ChatMessageEntry[],
  previousPrefix: ChatMessageEntry[] = EMPTY_PREFIX,
): ChatMessageEntry[] => {
  if (!historySessionIDs.length || !directory) return EMPTY_PREFIX;

  const result: ChatMessageEntry[] = [];
  let sawContent = false;
  for (const sessionID of historySessionIDs) {
    if (!sessionID || sessionID === currentSessionID) continue;
    const messages = readEntries(sessionID);
    if (!messages.length) continue;
    if (sawContent) {
      const createdAt = Number((messages[0]?.info as { time?: { created?: number } } | undefined)?.time?.created ?? 0);
      result.push(createAssistantSessionDivider(sessionID, createdAt));
    }
    result.push(...messages);
    sawContent = true;
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
    if (leftEntry?.info !== rightEntry?.info || leftEntry?.parts !== rightEntry?.parts) return false;
  }
  return true;
};

/**
 * Loads prior hosted-session transcripts (Assistant history chain) and returns
 * a prefix of messages + session dividers to prepend ahead of the live binding.
 */
export const useHostedSessionHistoryPrefix = (
  historySessionIDs: readonly string[] | undefined,
  currentSessionID: string | null | undefined,
  directory: string | null | undefined,
): ChatMessageEntry[] => {
  const sync = useSync();
  const store = useDirectoryStore(directory ?? undefined);
  const sessionKey = React.useMemo(
    () => (historySessionIDs ?? []).filter((sessionID) => sessionID && sessionID !== currentSessionID).join('\0'),
    [currentSessionID, historySessionIDs],
  );
  const resolvedIDs = React.useMemo(
    () => (sessionKey ? sessionKey.split('\0') : []),
    [sessionKey],
  );
  const cacheRef = React.useRef<ChatMessageEntry[]>(EMPTY_PREFIX);

  React.useEffect(() => {
    if (!directory || resolvedIDs.length === 0) return;
    for (const sessionID of resolvedIDs) {
      void sync.ensureSessionRenderable(sessionID, { directory });
      void fetchMessagesForSession(sessionID, directory);
    }
  }, [directory, resolvedIDs, sync]);

  const getSnapshot = React.useCallback(() => {
    if (!directory || resolvedIDs.length === 0) {
      cacheRef.current = EMPTY_PREFIX;
      return EMPTY_PREFIX;
    }
    const state = store.getState();
    const next = stitchHostedSessionHistory(
      resolvedIDs,
      currentSessionID,
      directory,
      (sessionID) => toChatMessageEntries(state.message[sessionID], state.part),
      cacheRef.current,
    );
    cacheRef.current = next;
    return next;
  }, [currentSessionID, directory, resolvedIDs, store]);

  const subscribe = React.useCallback((notify: () => void) => {
    if (!directory || resolvedIDs.length === 0) return () => undefined;
    return store.subscribe(notify);
  }, [directory, resolvedIDs, store]);

  return React.useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_PREFIX);
};
