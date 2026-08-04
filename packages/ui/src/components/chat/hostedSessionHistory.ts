import type { Message, Part } from '@opencode-ai/sdk/v2';
import { hasUserDisplayableParts } from '@/components/chat/message/normalizeUserDisplayParts';
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

/**
 * Prefer live directory-sync identity, but never let a hollow or lagging live
 * row wipe Assistant SQLite provisional / admission parts.
 *
 * Hollow live means: no parts, or only non-displayable synthetics such as
 * `<system-reminder>` (parts.length > 0 but ChatMessage still renders null).
 * Stateless admits land in SQLite before OpenCode SSE text arrives; overwriting
 * with a hollow live shell eats the bubble until a full refresh.
 *
 * For assistant rows, live may already have reasoning/text while a lagging
 * snapshot still omits tools that history (or a previous live) already holds.
 * Taking live wholesale then blanks Activity tool rows — union by part id,
 * preferring live for the same id.
 */
const mergePartsByIdPreferLive = (
  liveParts: readonly Part[],
  existingParts: readonly Part[],
): Part[] => {
  if (existingParts.length === 0) return liveParts as Part[];
  if (liveParts.length === 0) return existingParts as Part[];
  const byID = new Map<string, Part>();
  for (const part of existingParts) {
    if (part?.id) byID.set(part.id, part);
  }
  for (const part of liveParts) {
    if (part?.id) byID.set(part.id, part);
  }
  // Stable order: existing order first, then live-only appendages by live order.
  const seen = new Set<string>();
  const merged: Part[] = [];
  for (const part of existingParts) {
    if (!part?.id || seen.has(part.id)) continue;
    const next = byID.get(part.id);
    if (next) {
      merged.push(next);
      seen.add(part.id);
    }
  }
  for (const part of liveParts) {
    if (!part?.id || seen.has(part.id)) continue;
    merged.push(part);
    seen.add(part.id);
  }
  if (
    merged.length === liveParts.length
    && merged.every((part, index) => part === liveParts[index])
  ) {
    return liveParts as Part[];
  }
  return merged;
};

const mergeLiveOverHistoryEntry = (
  live: ChatMessageEntry,
  existing: ChatMessageEntry | undefined,
): ChatMessageEntry => {
  if (!existing) return live;

  const liveRole = (live.info as { role?: string }).role;
  if (liveRole === 'assistant' && existing.parts.length > 0) {
    const parts = mergePartsByIdPreferLive(live.parts, existing.parts);
    if (parts === live.parts && live.info === existing.info) return live;
    if (parts === existing.parts && live.info === existing.info && live.parts === existing.parts) {
      return existing;
    }
    return {
      ...live,
      parts,
      ...(existing.sourceParts && !live.sourceParts ? { sourceParts: existing.sourceParts } : {}),
    };
  }

  if (hasUserDisplayableParts(live.parts)) return live;
  if (hasUserDisplayableParts(existing.parts)) {
    if (live.info === existing.info && live.parts === existing.parts) return existing;
    return {
      ...live,
      parts: existing.parts,
      ...(existing.sourceParts && !live.sourceParts ? { sourceParts: existing.sourceParts } : {}),
    };
  }
  // Neither side is displayable — keep previous empty-part policy (live wins if
  // it has any raw parts; otherwise preserve history shell).
  if (live.parts.length > 0 || existing.parts.length === 0) return live;
  if (live.info === existing.info && live.parts === existing.parts) return existing;
  return {
    ...live,
    parts: existing.parts,
    ...(existing.sourceParts && !live.sourceParts ? { sourceParts: existing.sourceParts } : {}),
  };
};

/**
 * Assistant SQLite includes the current binding as a durable fallback. Live
 * directory sync wins per message ID once it carries displayable parts;
 * hollow live rows keep SQLite parts so admitted user bubbles stay visible.
 * A not-yet-materialized admitted user row also remains visible via pending.
 */
export const mergeHostedCurrentSessionHistory = (
  entries: readonly AssistantHistoryEntry[],
  currentSessionID: string | null | undefined,
  liveMessages: readonly ChatMessageEntry[],
  previous: ChatMessageEntry[] = EMPTY_PREFIX,
): ChatMessageEntry[] => {
  if (!currentSessionID) return liveMessages.length > 0 ? Array.from(liveMessages) : EMPTY_PREFIX;
  const byID = new Map<string, { message: ChatMessageEntry; order: number }>();
  let order = 0;
  for (const entry of entries) {
    if (entry.sessionID !== currentSessionID) continue;
    byID.set(entry.info.id, { message: { info: entry.info, parts: entry.parts }, order: order++ });
  }
  for (const message of liveMessages) {
    const existing = byID.get(message.info.id);
    byID.set(message.info.id, {
      message: mergeLiveOverHistoryEntry(message, existing?.message),
      order: existing?.order ?? order++,
    });
  }
  if (byID.size === 0) return EMPTY_PREFIX;
  const result = [...byID.values()]
    .sort((left, right) => {
      const leftCreated = Number((left.message.info as { time?: { created?: number } }).time?.created ?? 0);
      const rightCreated = Number((right.message.info as { time?: { created?: number } }).time?.created ?? 0);
      return leftCreated - rightCreated || left.order - right.order;
    })
    .map(({ message }) => message);
  return samePrefix(previous, result) ? previous : result;
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
