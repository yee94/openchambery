/**
 * Cap `hostedSessionHistory` merge helpers — portable TS (no React Query).
 * Stitch archived Assistant history + merge live current-binding rows.
 */
import type { LynxAssistantHistoryEntry } from './contactMessages';
import {
  hasLynxUserDisplayableParts,
  type LynxContactChatMessage,
} from './contactDisplay';

export const LYNX_ASSISTANT_SESSION_DIVIDER_PREFIX = 'oc_asst_session_divider:';

const EMPTY: LynxContactChatMessage[] = [];

export const isLynxAssistantSessionDivider = (
  message: LynxContactChatMessage | null | undefined,
): boolean => (
  typeof message?.info?.id === 'string'
  && message.info.id.startsWith(LYNX_ASSISTANT_SESSION_DIVIDER_PREFIX)
);

export const createLynxAssistantSessionDivider = (
  sessionID: string,
  createdAt = 0,
): LynxContactChatMessage => ({
  info: {
    id: `${LYNX_ASSISTANT_SESSION_DIVIDER_PREFIX}${sessionID}`,
    role: 'system',
    sessionID,
    time: { created: createdAt },
  },
  parts: [],
  kind: 'session-divider',
  sourceSessionID: sessionID,
});

/**
 * Cap `stitchHostedSessionHistory`: archived sessions only (skip current),
 * insert dividers between session changes.
 */
export const stitchLynxAssistantHistory = (
  entries: readonly LynxAssistantHistoryEntry[],
  currentSessionID: string | null | undefined,
): LynxContactChatMessage[] => {
  if (!entries.length) return EMPTY;
  const result: LynxContactChatMessage[] = [];
  let sawContent = false;
  let previousSessionID: string | null = null;
  for (const entry of entries) {
    if (entry.sessionID === currentSessionID) continue;
    if (sawContent && previousSessionID !== entry.sessionID) {
      result.push(createLynxAssistantSessionDivider(
        entry.sessionID,
        Number(entry.info.time?.created ?? 0),
      ));
    }
    result.push({
      info: entry.info,
      parts: entry.parts,
      sourceSessionID: entry.sessionID,
      sourceDirectory: entry.directory,
      kind: 'message',
    });
    sawContent = true;
    previousSessionID = entry.sessionID;
  }
  return result.length === 0 ? EMPTY : result;
};

const mergePartsByIdPreferLive = (
  liveParts: readonly Record<string, unknown>[],
  existingParts: readonly Record<string, unknown>[],
): Record<string, unknown>[] => {
  if (existingParts.length === 0) return liveParts as Record<string, unknown>[];
  if (liveParts.length === 0) return existingParts as Record<string, unknown>[];
  const byID = new Map<string, Record<string, unknown>>();
  for (const part of existingParts) {
    const id = typeof part.id === 'string' ? part.id : '';
    if (id) byID.set(id, part);
  }
  for (const part of liveParts) {
    const id = typeof part.id === 'string' ? part.id : '';
    if (id) byID.set(id, part);
  }
  const seen = new Set<string>();
  const merged: Record<string, unknown>[] = [];
  for (const part of existingParts) {
    const id = typeof part.id === 'string' ? part.id : '';
    if (!id || seen.has(id)) continue;
    const next = byID.get(id);
    if (next) {
      merged.push(next);
      seen.add(id);
    }
  }
  for (const part of liveParts) {
    const id = typeof part.id === 'string' ? part.id : '';
    if (!id || seen.has(id)) continue;
    merged.push(part);
    seen.add(id);
  }
  return merged;
};

const mergeLiveOverHistoryEntry = (
  live: LynxContactChatMessage,
  existing: LynxContactChatMessage | undefined,
): LynxContactChatMessage => {
  if (!existing) return live;
  const liveRole = live.info.role;
  if (liveRole === 'assistant' && existing.parts.length > 0) {
    const parts = mergePartsByIdPreferLive(
      live.parts as Record<string, unknown>[],
      existing.parts as Record<string, unknown>[],
    );
    return { ...live, parts: parts as LynxContactChatMessage['parts'] };
  }
  if (hasLynxUserDisplayableParts(live.parts)) return live;
  if (hasLynxUserDisplayableParts(existing.parts)) {
    return { ...live, parts: existing.parts };
  }
  if (live.parts.length > 0 || existing.parts.length === 0) return live;
  return { ...live, parts: existing.parts };
};

/**
 * Cap `mergeHostedCurrentSessionHistory`: SQLite/history for the live binding
 * plus live SSE rows, preferring displayable parts so hollow live never wipes
 * admission bubbles.
 */
export const mergeLynxCurrentSessionHistory = (
  entries: readonly LynxAssistantHistoryEntry[],
  currentSessionID: string | null | undefined,
  liveMessages: readonly LynxContactChatMessage[],
): LynxContactChatMessage[] => {
  if (!currentSessionID) {
    return liveMessages.length > 0 ? Array.from(liveMessages) : EMPTY;
  }
  const byID = new Map<string, { message: LynxContactChatMessage; order: number }>();
  let order = 0;
  for (const entry of entries) {
    if (entry.sessionID !== currentSessionID) continue;
    byID.set(entry.info.id, {
      message: {
        info: entry.info,
        parts: entry.parts,
        sourceSessionID: entry.sessionID,
        sourceDirectory: entry.directory,
        kind: 'message',
      },
      order: order++,
    });
  }
  for (const message of liveMessages) {
    const existing = byID.get(message.info.id);
    byID.set(message.info.id, {
      message: mergeLiveOverHistoryEntry(message, existing?.message),
      order: existing?.order ?? order++,
    });
  }
  if (byID.size === 0) return EMPTY;
  return [...byID.values()]
    .sort((left, right) => {
      const leftCreated = Number(left.message.info.time?.created ?? 0);
      const rightCreated = Number(right.message.info.time?.created ?? 0);
      return leftCreated - rightCreated || left.order - right.order;
    })
    .map(({ message }) => message);
};

/** Full contact transcript: archived stitch + current merge. */
export const buildLynxContactTranscript = (
  entries: readonly LynxAssistantHistoryEntry[],
  currentSessionID: string | null | undefined,
  liveMessages: readonly LynxContactChatMessage[] = EMPTY,
): LynxContactChatMessage[] => {
  const archived = stitchLynxAssistantHistory(entries, currentSessionID);
  const current = mergeLynxCurrentSessionHistory(entries, currentSessionID, liveMessages);
  if (archived.length === 0) return current;
  if (current.length === 0) return archived;
  // Divider between last archived session and current binding when both exist.
  const lastArchived = archived[archived.length - 1];
  const dividerNeeded = lastArchived
    && lastArchived.kind !== 'session-divider'
    && currentSessionID
    && lastArchived.sourceSessionID !== currentSessionID;
  if (dividerNeeded && currentSessionID) {
    return [
      ...archived,
      createLynxAssistantSessionDivider(
        currentSessionID,
        Number(current[0]?.info.time?.created ?? 0),
      ),
      ...current,
    ];
  }
  return [...archived, ...current];
};
