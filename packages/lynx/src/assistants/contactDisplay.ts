/**
 * Cap contact-transcript display helpers for Lynx.
 * - Settle / synthetic user text filtered like Cap `normalizeUserDisplayParts`
 * - File parts labeled; session dividers as cards
 * - Session / assistant / schedule mention cards from synthetic instruction text
 */
import type { LynxMessagePart } from '../chat/messageParts';
import { parseLynxMessageParts, textFromLynxParts } from '../chat/messageParts';
import type { LynxTimelineEntry, LynxTimelineRole } from '../chat/timelineModel';

/** Mirrors Cap `ASSISTANT_SESSION_DIVIDER_PREFIX` / contactMerge. */
const SESSION_DIVIDER_PREFIX = 'oc_asst_session_divider:';

const GITHUB_ISSUE_CONTEXT_PREFIX = 'GitHub issue context (JSON)';
const GITHUB_PR_CONTEXT_PREFIX = 'GitHub pull request context (JSON)';

const isSessionDividerMessage = (
  message: LynxContactChatMessage | null | undefined,
): boolean => (
  message?.kind === 'session-divider'
  || (typeof message?.info?.id === 'string' && message.info.id.startsWith(SESSION_DIVIDER_PREFIX))
);

export type LynxContactCardKind = 'session' | 'assistant' | 'schedule' | 'file' | 'session-divider';

export type LynxContactCard = {
  kind: LynxContactCardKind;
  id: string;
  label: string;
  targetId?: string;
  directory?: string | null;
  mime?: string;
};

export type LynxContactChatMessage = {
  info: {
    id: string;
    role: string;
    sessionID?: string;
    time?: { created?: number; [key: string]: unknown };
    [key: string]: unknown;
  };
  parts: readonly Record<string, unknown>[];
  sourceSessionID?: string;
  sourceDirectory?: string | null;
  kind?: 'message' | 'session-divider';
};

const asRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const isSessionGoalContinuationText = (text: string): boolean => (
  text.trimStart().startsWith('Continue working toward the active session goal.')
);

const isCompactionCommandText = (text: string): boolean => text.trim() === '/compact';

const shouldKeepSyntheticUserText = (text: string): boolean => (
  text.trim().startsWith('The following tool was executed by the user')
);

const isEmptyText = (text: string): boolean => !text.trim();

/**
 * Cap `normalizeUserDisplayParts` spirit — drop settle / hollow synthetic text
 * that Cap never paints as a user bubble.
 */
export const filterLynxContactDisplayParts = (
  parts: readonly Record<string, unknown>[],
): Record<string, unknown>[] => {
  const out: Record<string, unknown>[] = [];
  for (const part of parts) {
    const type = typeof part.type === 'string' ? part.type : '';
    if (type === 'compaction') continue;
    if (type === 'text') {
      const text = typeof part.text === 'string' ? part.text : '';
      if (isSessionGoalContinuationText(text) || isCompactionCommandText(text)) continue;
      const synthetic = part.synthetic === true;
      if (synthetic) {
        const normalized = text.trimStart();
        if (
          !shouldKeepSyntheticUserText(text)
          && !normalized.startsWith(GITHUB_ISSUE_CONTEXT_PREFIX)
          && !normalized.startsWith(GITHUB_PR_CONTEXT_PREFIX)
          && !normalized.includes('session mention')
          && !normalized.includes('"type":"session"')
          && !normalized.includes('"type":"assistant"')
          && !normalized.includes('"type":"schedule"')
          && !normalized.includes('"type":"scheduled"')
        ) {
          // Cap hides `<system-reminder>` and other synthetic settle shells.
          continue;
        }
        if (shouldKeepSyntheticUserText(text)) {
          out.push({ ...part, text: '/shell' });
          continue;
        }
      }
    }
    out.push(part);
  }
  return out;
};

export const hasLynxUserDisplayableParts = (
  parts: readonly Record<string, unknown>[] | undefined,
): boolean => {
  if (!parts?.length) return false;
  const display = filterLynxContactDisplayParts(parts);
  return display.some((part) => {
    if (part.type === 'text') {
      return typeof part.text === 'string' && !isEmptyText(part.text);
    }
    if (part.type === 'file') {
      const mime = typeof part.mime === 'string' ? part.mime : '';
      const url = typeof part.url === 'string' ? part.url : '';
      return Boolean(mime || url) && Boolean(url);
    }
    return true;
  });
};

const parseMentionCardsFromText = (text: string, messageId: string): LynxContactCard[] => {
  const cards: LynxContactCard[] = [];
  const sessionMatches = text.matchAll(/@session:([A-Za-z0-9_-]+)/g);
  for (const match of sessionMatches) {
    const id = match[1];
    if (!id) continue;
    cards.push({
      kind: 'session',
      id: `${messageId}:session:${id}`,
      label: `Session ${id}`,
      targetId: id,
    });
  }
  const assistantMatches = text.matchAll(/@assistant:([A-Za-z0-9_-]+)/g);
  for (const match of assistantMatches) {
    const id = match[1];
    if (!id) continue;
    cards.push({
      kind: 'assistant',
      id: `${messageId}:assistant:${id}`,
      label: `Assistant ${id}`,
      targetId: id,
    });
  }
  const scheduleMatches = text.matchAll(/@(?:schedule|scheduled):([A-Za-z0-9_-]+)/g);
  for (const match of scheduleMatches) {
    const id = match[1];
    if (!id) continue;
    cards.push({
      kind: 'schedule',
      id: `${messageId}:schedule:${id}`,
      label: `Schedule ${id}`,
      targetId: id,
    });
  }
  // Cap synthetic JSON mention blocks (session / assistant / schedule).
  try {
    const jsonStart = text.indexOf('[');
    if (jsonStart >= 0 && text.includes('"type"')) {
      const parsed = JSON.parse(text.slice(jsonStart)) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const record = asRecord(item);
          const type = typeof record.type === 'string' ? record.type : '';
          if (type === 'session' && typeof record.sessionId === 'string') {
            cards.push({
              kind: 'session',
              id: `${messageId}:session:${record.sessionId}`,
              label: typeof record.title === 'string' ? record.title : `Session ${record.sessionId}`,
              targetId: record.sessionId,
              directory: typeof record.directory === 'string' ? record.directory : null,
            });
          } else if (type === 'assistant' && typeof record.assistantId === 'string') {
            cards.push({
              kind: 'assistant',
              id: `${messageId}:assistant:${record.assistantId}`,
              label: typeof record.name === 'string' ? record.name : `Assistant ${record.assistantId}`,
              targetId: record.assistantId,
            });
          } else if ((type === 'schedule' || type === 'scheduled') && typeof record.taskId === 'string') {
            cards.push({
              kind: 'schedule',
              id: `${messageId}:schedule:${record.taskId}`,
              label: typeof record.name === 'string' ? record.name : `Schedule ${record.taskId}`,
              targetId: record.taskId,
            });
          }
        }
      }
    }
  } catch {
    // ignore malformed synthetic JSON
  }
  return cards;
};

export const extractLynxContactCards = (
  message: LynxContactChatMessage,
): LynxContactCard[] => {
  if (isSessionDividerMessage(message)) {
    const sessionID = message.sourceSessionID
      ?? (typeof message.info.sessionID === 'string' ? message.info.sessionID : '');
    return [{
      kind: 'session-divider',
      id: message.info.id,
      label: sessionID ? `Conversation · ${sessionID}` : 'Conversation',
      targetId: sessionID || undefined,
      directory: message.sourceDirectory ?? null,
    }];
  }
  const cards: LynxContactCard[] = [];
  const displayParts = filterLynxContactDisplayParts(message.parts);
  for (const part of displayParts) {
    if (part.type === 'file') {
      const mime = typeof part.mime === 'string' ? part.mime : 'application/octet-stream';
      const filename = typeof part.filename === 'string'
        ? part.filename
        : typeof part.name === 'string'
          ? part.name
          : mime;
      cards.push({
        kind: 'file',
        id: typeof part.id === 'string' ? part.id : `${message.info.id}:file`,
        label: filename,
        mime,
      });
    }
    if (part.type === 'text' && typeof part.text === 'string') {
      cards.push(...parseMentionCardsFromText(part.text, message.info.id));
    }
  }
  return cards;
};

const roleOf = (value: unknown): LynxTimelineRole => {
  if (value === 'user' || value === 'assistant' || value === 'system') return value;
  return 'unknown';
};

/**
 * Project one contact message into a LegendList timeline entry.
 * Dividers become system rows; settle-filtered parts drive text/parts.
 */
export const projectLynxContactTimelineEntry = (
  message: LynxContactChatMessage,
): LynxTimelineEntry | null => {
  if (isSessionDividerMessage(message)) {
    const sessionID = message.sourceSessionID
      ?? (typeof message.info.sessionID === 'string' ? message.info.sessionID : '');
    return {
      key: message.info.id,
      messageId: message.info.id,
      role: 'system',
      text: sessionID ? `Conversation · ${sessionID}` : 'Conversation',
      createdAt: Number(message.info.time?.created ?? 0) || undefined,
      parts: [{
        type: 'other',
        id: message.info.id,
        rawType: 'session-divider',
      }],
    };
  }

  const displayParts = filterLynxContactDisplayParts(message.parts);
  if (message.info.role === 'user' && !hasLynxUserDisplayableParts(message.parts)) {
    return null;
  }

  const parsed: LynxMessagePart[] = parseLynxMessageParts(displayParts);
  const text = textFromLynxParts(parsed);
  return {
    key: message.info.id,
    messageId: message.info.id,
    role: roleOf(message.info.role),
    text,
    createdAt: Number(message.info.time?.created ?? 0) || undefined,
    parts: parsed,
  };
};

export const projectLynxContactTimelineEntries = (
  messages: readonly LynxContactChatMessage[],
): LynxTimelineEntry[] => {
  const entries: LynxTimelineEntry[] = [];
  for (const message of messages) {
    const entry = projectLynxContactTimelineEntry(message);
    if (entry) entries.push(entry);
  }
  return entries;
};
