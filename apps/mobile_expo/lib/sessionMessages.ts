import type { ActiveRuntime } from '@/lib/connectionController';
import { openchamberFetch } from '@/lib/openchamberClient';

/** Initial Host turn window for Chat open (Track 3 contract: turns=6). */
export const CHAT_INITIAL_TURNS = 6;

export type ChatMessageInfo = {
  id: string;
  role?: string;
  sessionID?: string;
  time?: { created?: number; completed?: number };
  [key: string]: unknown;
};

export type ChatMessagePart = {
  id?: string;
  type?: string;
  text?: string;
  [key: string]: unknown;
};

export type ChatMessageRecord = {
  info: ChatMessageInfo;
  parts: ChatMessagePart[];
};

export type SessionMessagesPage = {
  records: ChatMessageRecord[];
  cursor: string | null;
  complete: boolean;
  turnCount: number;
};

export class SessionMessagesError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'SessionMessagesError';
    this.status = status;
  }
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

const parseRecord = (entry: unknown, index: number): ChatMessageRecord => {
  const row = asRecord(entry);
  if (!row) throw new SessionMessagesError(`messages[${index}] must be an object`);
  const info = asRecord(row.info);
  if (!info || typeof info.id !== 'string' || !info.id) {
    throw new SessionMessagesError(`messages[${index}].info.id must be a non-empty string`);
  }
  const partsRaw = row.parts;
  const parts: ChatMessagePart[] = Array.isArray(partsRaw)
    ? partsRaw.flatMap((part) => {
        const p = asRecord(part);
        return p ? [p as ChatMessagePart] : [];
      })
    : [];
  return { info: info as ChatMessageInfo, parts };
};

export const parseSessionMessagesPage = (
  payload: unknown,
  requestedTurns: number = CHAT_INITIAL_TURNS,
): SessionMessagesPage => {
  const body = asRecord(payload);
  if (!body) throw new SessionMessagesError('session messages: expected JSON object');
  if (body.partial === true) {
    throw new SessionMessagesError('session messages: partial responses are not accepted');
  }

  // Cap Host shape: { records, cursor, complete, turnCount }
  if (Array.isArray(body.records)) {
    const records = body.records.map((entry, i) => parseRecord(entry, i));
    const complete = body.complete === true;
    const cursor =
      body.cursor == null || body.cursor === ''
        ? null
        : typeof body.cursor === 'string'
          ? body.cursor
          : null;
    if (complete && cursor != null) {
      throw new SessionMessagesError('session messages: complete=true requires cursor=null');
    }
    const turnCount =
      typeof body.turnCount === 'number' && Number.isFinite(body.turnCount)
        ? body.turnCount
        : records.length;
    if (turnCount < 0 || turnCount > requestedTurns) {
      throw new SessionMessagesError(
        `session messages: turnCount must be an integer in 0..${requestedTurns}`,
      );
    }
    return { records, cursor, complete, turnCount };
  }

  // OpenCode SDK list shape: Message[] with { info, parts }
  if (Array.isArray(payload)) {
    const records = payload.map((entry, i) => parseRecord(entry, i));
    return {
      records,
      cursor: null,
      complete: true,
      turnCount: Math.min(records.length, requestedTurns),
    };
  }

  throw new SessionMessagesError('session messages: records must be an array');
};

export type LoadSessionMessagesInput = {
  sessionId: string;
  directory?: string | null;
  turns?: number;
  before?: string;
  signal?: AbortSignal;
};

/**
 * GET /api/openchamber/sessions/:id/messages?turns=6
 * Failure throws — never coerce to empty success.
 */
export const loadSessionMessages = async (
  active: ActiveRuntime,
  input: LoadSessionMessagesInput,
): Promise<SessionMessagesPage> => {
  const sessionId = input.sessionId.trim();
  if (!sessionId) {
    throw new SessionMessagesError('session messages: sessionId required');
  }
  const turns = input.turns ?? CHAT_INITIAL_TURNS;
  const params = new URLSearchParams();
  params.set('turns', String(turns));
  if (input.directory) params.set('directory', input.directory);
  if (input.before) params.set('before', input.before);

  const path = `/api/openchamber/sessions/${encodeURIComponent(sessionId)}/messages?${params.toString()}`;

  let response;
  try {
    response = await openchamberFetch(active, path, {
      method: 'GET',
      signal: input.signal,
    });
  } catch (error) {
    throw new SessionMessagesError(
      error instanceof Error ? error.message : 'session messages request failed',
      null,
    );
  }

  if (!response.ok) {
    throw new SessionMessagesError(
      `session messages request failed (${response.status})`,
      response.status,
    );
  }

  const payload = await response.json();
  return parseSessionMessagesPage(payload, turns);
};
