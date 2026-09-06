/**
 * Official OpenCode session HTTP for Lynx chat.
 * Paths match @opencode-ai/sdk/v2: /session/{id}/message|prompt_async|abort.
 * Never treat transport/HTTP failure as empty success.
 */
import type { LynxRuntimeFetch } from '../runtime/fetch';
import { parseLynxMessageParts, textFromLynxParts } from './messageParts';
import type { LynxTimelineEntry, LynxTimelinePage, LynxTimelineRole } from './timelineModel';

export type LynxSessionApiDeps = {
  runtimeFetch: LynxRuntimeFetch;
};

export type LynxPromptPart =
  | { type: 'text'; text: string; synthetic?: boolean }
  | { type: 'file'; mime: string; url: string; filename?: string };

export type LynxPromptAsyncInput = {
  sessionId: string;
  directory?: string | null;
  text: string;
  providerID: string;
  modelID: string;
  agent?: string;
  variant?: string;
  messageId?: string;
  delivery?: 'steer';
  parts?: LynxPromptPart[];
};

export type LynxPromptAsyncResult =
  | { status: 'ok'; messageId: string }
  | { status: 'failed'; error: string; httpStatus: number };

export type LynxAbortResult =
  | { status: 'ok'; aborted: true }
  | { status: 'failed'; error: string; httpStatus: number };

export type LynxMessagesResult =
  | { status: 'ok'; page: LynxTimelinePage }
  | { status: 'failed'; error: string; httpStatus: number };

const ensureSessionId = (sessionId: string): string => {
  const id = sessionId.trim();
  if (!id) throw new Error('session id required');
  return id;
};

const directoryQuery = (directory?: string | null): string => {
  const value = directory?.trim();
  return value ? `directory=${encodeURIComponent(value)}` : '';
};

const joinQuery = (...parts: Array<string | false | null | undefined>): string => {
  const filtered = parts.filter((part): part is string => Boolean(part && part.length > 0));
  return filtered.length > 0 ? `?${filtered.join('&')}` : '';
};

const roleOf = (value: unknown): LynxTimelineRole => {
  if (value === 'user' || value === 'assistant' || value === 'system') return value;
  return 'unknown';
};

const readFiniteNumber = (value: unknown): number | undefined => (
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
);

const tokensFromInfo = (info: Record<string, unknown> | null): LynxTimelineEntry['tokens'] => {
  if (!info) return undefined;
  const tokens = info.tokens;
  if (!tokens || typeof tokens !== 'object') return undefined;
  const record = tokens as Record<string, unknown>;
  const cache = record.cache && typeof record.cache === 'object'
    ? record.cache as Record<string, unknown>
    : null;
  const parsed = {
    input: readFiniteNumber(record.input),
    output: readFiniteNumber(record.output),
    reasoning: readFiniteNumber(record.reasoning),
    cache: cache
      ? { read: readFiniteNumber(cache.read), write: readFiniteNumber(cache.write) }
      : undefined,
  };
  if (
    parsed.input === undefined
    && parsed.output === undefined
    && parsed.reasoning === undefined
    && !parsed.cache
  ) {
    return undefined;
  }
  return parsed;
};

const modelFromInfo = (info: Record<string, unknown> | null): LynxTimelineEntry['model'] => {
  if (!info) return undefined;
  const model = info.model;
  if (!model || typeof model !== 'object') return undefined;
  const record = model as Record<string, unknown>;
  const providerID = typeof record.providerID === 'string' && record.providerID.trim()
    ? record.providerID.trim()
    : typeof record.providerId === 'string' && record.providerId.trim()
      ? record.providerId.trim()
      : '';
  const modelID = typeof record.modelID === 'string' && record.modelID.trim()
    ? record.modelID.trim()
    : typeof record.modelId === 'string' && record.modelId.trim()
      ? record.modelId.trim()
      : '';
  if (!providerID || !modelID) return undefined;
  return { providerID, modelID };
};

const entryFromMessage = (raw: unknown, index: number): LynxTimelineEntry | null => {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as {
    info?: { id?: unknown; role?: unknown; time?: { created?: unknown }; tokens?: unknown; model?: unknown };
    id?: unknown;
    role?: unknown;
    parts?: unknown;
    tokens?: unknown;
    model?: unknown;
  };
  const info = record.info && typeof record.info === 'object'
    ? record.info as Record<string, unknown>
    : null;
  const messageId =
    (info && typeof info.id === 'string' && info.id)
    || (typeof record.id === 'string' && record.id)
    || '';
  if (!messageId) return null;
  const role = roleOf(info?.role ?? record.role);
  const createdRaw = info?.time && typeof info.time === 'object'
    ? (info.time as { created?: unknown }).created
    : undefined;
  const createdAt = typeof createdRaw === 'number' ? createdRaw : undefined;
  const parts = parseLynxMessageParts(record.parts);
  const tokens = tokensFromInfo(info)
    ?? tokensFromInfo(record as unknown as Record<string, unknown>);
  const model = modelFromInfo(info)
    ?? modelFromInfo(record as unknown as Record<string, unknown>);
  return {
    key: messageId,
    messageId,
    role,
    text: textFromLynxParts(parts),
    createdAt: createdAt ?? index,
    parts,
    ...(tokens ? { tokens } : {}),
    ...(model ? { model } : {}),
  };
};

/**
 * Parse OpenCode message list payloads. Accepts either a bare array or
 * `{ messages | items | data }` wrappers. Failure to parse is a failed page,
 * not an empty success — callers must pass through `status: 'failed'`.
 */
export function parseMessagesPayload(payload: unknown, options?: {
  requestedLimit?: number;
  before?: string | null;
}): LynxTimelinePage | null {
  if (payload == null) return null;
  let rows: unknown[] | null = null;
  let olderCursor: string | null = null;
  let canLoadEarlier: boolean | undefined;

  if (Array.isArray(payload)) {
    rows = payload;
  } else if (typeof payload === 'object') {
    const record = payload as {
      messages?: unknown;
      items?: unknown;
      data?: unknown;
      cursor?: { previous?: unknown; next?: unknown };
      hasMore?: unknown;
      canLoadEarlier?: unknown;
    };
    if (Array.isArray(record.messages)) rows = record.messages;
    else if (Array.isArray(record.items)) rows = record.items;
    else if (Array.isArray(record.data)) rows = record.data;
    if (typeof record.cursor?.previous === 'string') olderCursor = record.cursor.previous;
    if (typeof record.canLoadEarlier === 'boolean') canLoadEarlier = record.canLoadEarlier;
    else if (typeof record.hasMore === 'boolean') canLoadEarlier = record.hasMore;
  }

  if (!rows) return null;

  const entries = rows
    .map((row, index) => entryFromMessage(row, index))
    .filter((entry): entry is LynxTimelineEntry => entry !== null);

  const limit = options?.requestedLimit ?? 30;
  if (canLoadEarlier === undefined) {
    // Authoritative boundary unknown from payload shape: infer from page fullness
    // only when we got a full page; never invent earlier pages from a short page.
    canLoadEarlier = entries.length >= limit;
    if (canLoadEarlier && entries.length > 0) {
      olderCursor = olderCursor ?? entries[0]!.messageId;
    }
  } else if (canLoadEarlier && !olderCursor && entries.length > 0) {
    olderCursor = entries[0]!.messageId;
  }

  if (!canLoadEarlier) olderCursor = null;

  return {
    entries,
    olderCursor,
    canLoadEarlier,
  };
}

export async function fetchSessionMessages(
  deps: LynxSessionApiDeps,
  input: {
    sessionId: string;
    directory?: string | null;
    limit?: number;
    before?: string | null;
    signal?: AbortSignal;
  },
): Promise<LynxMessagesResult> {
  try {
    const sessionId = ensureSessionId(input.sessionId);
    const limit = input.limit ?? 30;
    const query = joinQuery(
      directoryQuery(input.directory),
      `limit=${limit}`,
      input.before ? `before=${encodeURIComponent(input.before)}` : null,
    );
    const response = await deps.runtimeFetch(
      `/session/${encodeURIComponent(sessionId)}/message${query}`,
      { method: 'GET', signal: input.signal },
    );
    if (!response.ok) {
      return {
        status: 'failed',
        error: `session messages failed (${response.status})`,
        httpStatus: response.status,
      };
    }
    const payload = await response.json();
    const page = parseMessagesPayload(payload, {
      requestedLimit: limit,
      before: input.before ?? null,
    });
    if (!page) {
      return {
        status: 'failed',
        error: 'session messages payload unparseable',
        httpStatus: response.status,
      };
    }
    return { status: 'ok', page };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      httpStatus: 0,
    };
  }
}

export async function promptAsync(
  deps: LynxSessionApiDeps,
  input: LynxPromptAsyncInput,
): Promise<LynxPromptAsyncResult> {
  try {
    const sessionId = ensureSessionId(input.sessionId);
    const messageId = input.messageId?.trim() || `msg_${Date.now().toString(36)}`;
    const parts: LynxPromptPart[] = input.parts?.length
      ? input.parts
      : [{ type: 'text', text: input.text }];
    const query = joinQuery(directoryQuery(input.directory));
    const body: Record<string, unknown> = {
      messageID: messageId,
      model: { providerID: input.providerID, modelID: input.modelID },
      parts,
    };
    if (input.agent) body.agent = input.agent;
    if (input.variant) body.variant = input.variant;
    if (input.delivery) body.delivery = input.delivery;

    const response = await deps.runtimeFetch(
      `/session/${encodeURIComponent(sessionId)}/prompt_async${query}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      return {
        status: 'failed',
        error: `prompt_async failed (${response.status})`,
        httpStatus: response.status,
      };
    }
    return { status: 'ok', messageId };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      httpStatus: 0,
    };
  }
}

export async function abortSession(
  deps: LynxSessionApiDeps,
  input: { sessionId: string; directory?: string | null },
): Promise<LynxAbortResult> {
  try {
    const sessionId = ensureSessionId(input.sessionId);
    const query = joinQuery(directoryQuery(input.directory));
    const response = await deps.runtimeFetch(
      `/session/${encodeURIComponent(sessionId)}/abort${query}`,
      { method: 'POST' },
    );
    if (!response.ok) {
      return {
        status: 'failed',
        error: `session abort failed (${response.status})`,
        httpStatus: response.status,
      };
    }
    return { status: 'ok', aborted: true };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      httpStatus: 0,
    };
  }
}
