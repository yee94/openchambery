/**
 * Cap Assistant contact transcript (stitched history) client.
 *
 * Real routes (Cap `packages/web/server/lib/assistants`):
 * - `GET  /api/openchamber/assistants/:id/messages?before=&limit=` — keyset pages
 * - `POST /api/openchamber/assistants/:id/messages` — admit (see `admission.ts`)
 * - `POST /api/openchamber/assistants/:id/session/abort` — stop in-flight turn
 *
 * Cap UI names this the Assistant conversation / hosted history; Lynx treats it
 * as the contact transcript (catalog open path), not project session ChatScreen.
 * Failure ≠ empty success. No invented session ids / ASR.
 */
import type { LynxRuntimeFetch } from '../runtime/fetch';
import type { LynxSessionBinding } from './admission';

export const LYNX_ASSISTANT_HISTORY_PAGE_SIZE = 30;

export type LynxAssistantHistoryPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
  [key: string]: unknown;
};

export type LynxAssistantHistoryInfo = {
  id: string;
  sessionID: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  time: { created: number; [key: string]: unknown };
  [key: string]: unknown;
};

export type LynxAssistantHistoryEntry = {
  sessionID: string;
  directory: string | null;
  info: LynxAssistantHistoryInfo;
  parts: LynxAssistantHistoryPart[];
};

export type LynxAssistantHistoryPage = {
  entries: LynxAssistantHistoryEntry[];
  nextCursor: string | null;
  complete: boolean;
};

export type LynxAssistantHistoryLoadResult =
  | { status: 'ok'; page: LynxAssistantHistoryPage }
  | { status: 'no-runtime' }
  | { status: 'unsupported' }
  | { status: 'failed'; error: Error; httpStatus?: number };

export type LynxAssistantAbortResult =
  | { status: 'ok'; binding: LynxSessionBinding; aborted: true }
  | { status: 'no-runtime' }
  | { status: 'unsupported' }
  | { status: 'revision-conflict' }
  | { status: 'failed'; error: Error; httpStatus?: number };

export class LynxAssistantHistoryParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LynxAssistantHistoryParseError';
  }
}

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

const requireString = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value) {
    throw new LynxAssistantHistoryParseError(`invalid_${label}`);
  }
  return value;
};

const requireFiniteNumber = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new LynxAssistantHistoryParseError(`invalid_${label}`);
  }
  return value;
};

const requireRole = (value: unknown): LynxAssistantHistoryInfo['role'] => {
  if (value === 'user' || value === 'assistant' || value === 'system' || value === 'tool') {
    return value;
  }
  throw new LynxAssistantHistoryParseError('invalid_assistant_history_role');
};

const parsePart = (
  raw: unknown,
  entrySessionID: string,
  messageID: string,
): LynxAssistantHistoryPart => {
  const record = asRecord(raw);
  if (!record) throw new LynxAssistantHistoryParseError('invalid_assistant_history_part');
  const id = requireString(record.id, 'assistant_history_part_id');
  const sessionID = requireString(record.sessionID, 'assistant_history_part_session');
  const partMessageID = requireString(record.messageID, 'assistant_history_part_message');
  const type = requireString(record.type, 'assistant_history_part_type');
  if (sessionID !== entrySessionID || partMessageID !== messageID) {
    throw new LynxAssistantHistoryParseError('invalid_assistant_history_part_scope');
  }
  return { ...record, id, sessionID, messageID: partMessageID, type };
};

const parseEntry = (raw: unknown): LynxAssistantHistoryEntry => {
  const record = asRecord(raw);
  if (!record) throw new LynxAssistantHistoryParseError('invalid_assistant_history_entry');
  const sessionID = requireString(record.sessionID, 'assistant_history_entry_session');
  const directory = record.directory === null || typeof record.directory === 'string'
    ? record.directory
    : (() => {
      throw new LynxAssistantHistoryParseError('invalid_assistant_history_directory');
    })();
  const infoRecord = asRecord(record.info);
  if (!infoRecord) throw new LynxAssistantHistoryParseError('invalid_assistant_history_info');
  const infoId = requireString(infoRecord.id, 'assistant_history_info_id');
  const infoSessionID = requireString(infoRecord.sessionID, 'assistant_history_info_session');
  if (infoSessionID !== sessionID) {
    throw new LynxAssistantHistoryParseError('invalid_assistant_history_info_session_mismatch');
  }
  const role = requireRole(infoRecord.role);
  const timeRecord = asRecord(infoRecord.time);
  if (!timeRecord) throw new LynxAssistantHistoryParseError('invalid_assistant_history_info_time');
  const created = requireFiniteNumber(timeRecord.created, 'assistant_history_info_created');
  if (!Array.isArray(record.parts)) {
    throw new LynxAssistantHistoryParseError('invalid_assistant_history_parts');
  }
  const parts = record.parts.map((part) => parsePart(part, sessionID, infoId));
  return {
    sessionID,
    directory,
    info: {
      ...infoRecord,
      id: infoId,
      sessionID: infoSessionID,
      role,
      time: { ...timeRecord, created },
    },
    parts,
  };
};

/**
 * Cap `parseAssistantHistoryPage` — `complete === (nextCursor === null)`.
 * Malformed cursor/complete combinations fail closed.
 */
export const parseLynxAssistantHistoryPage = (payload: unknown): LynxAssistantHistoryPage => {
  const record = asRecord(payload);
  if (!record) throw new LynxAssistantHistoryParseError('invalid_assistant_history');
  const nextCursor = record.nextCursor === null || typeof record.nextCursor === 'string'
    ? record.nextCursor
    : (() => {
      throw new LynxAssistantHistoryParseError('invalid_assistant_history_cursor');
    })();
  if (typeof record.complete !== 'boolean') {
    throw new LynxAssistantHistoryParseError('invalid_assistant_history_complete');
  }
  if (!record.complete && !nextCursor) {
    throw new LynxAssistantHistoryParseError('invalid_assistant_history_incomplete');
  }
  if (record.complete && nextCursor) {
    throw new LynxAssistantHistoryParseError('invalid_assistant_history_complete_cursor');
  }
  if (!Array.isArray(record.entries)) {
    throw new LynxAssistantHistoryParseError('invalid_assistant_history_entries');
  }
  return {
    entries: record.entries.map(parseEntry),
    nextCursor,
    complete: record.complete,
  };
};

/** Cap `getNextAssistantHistoryPageParam`. */
export const getNextLynxAssistantHistoryPageParam = (
  page: LynxAssistantHistoryPage,
): string | undefined => (page.complete ? undefined : page.nextCursor ?? undefined);

/**
 * Cap pages arrive newest-first; flatten reverses so the timeline is oldest→newest.
 */
export const flattenLynxAssistantHistoryPages = (
  pages: readonly Pick<LynxAssistantHistoryPage, 'entries'>[],
): LynxAssistantHistoryEntry[] => (
  pages.slice().reverse().flatMap((page) => page.entries)
);

/**
 * Cap `GET /api/openchamber/assistants/:id/messages`. Failure ≠ empty page.
 */
export const loadLynxAssistantContactMessages = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  assistantId: string,
  options?: {
    signal?: AbortSignal;
    before?: string | null;
    limit?: number;
  },
): Promise<LynxAssistantHistoryLoadResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const id = assistantId.trim();
  if (!id) {
    return { status: 'failed', error: new Error('assistant id required') };
  }
  try {
    const limit = options?.limit ?? LYNX_ASSISTANT_HISTORY_PAGE_SIZE;
    const query = new URLSearchParams({ limit: String(limit) });
    if (options?.before) query.set('before', options.before);
    const response = await runtimeFetch(
      `/api/openchamber/assistants/${encodeURIComponent(id)}/messages?${query}`,
      { signal: options?.signal },
    );
    if (response.status === 0) return { status: 'no-runtime' };
    if (response.status === 404 || response.status === 501) return { status: 'unsupported' };
    if (!response.ok) {
      return {
        status: 'failed',
        error: new Error(`assistant messages failed (${response.status})`),
        httpStatus: response.status,
      };
    }
    const page = parseLynxAssistantHistoryPage(await response.json());
    return { status: 'ok', page };
  } catch (error) {
    if (error instanceof LynxAssistantHistoryParseError) {
      return { status: 'failed', error };
    }
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
};

/**
 * Cap `POST …/session/abort` with binding fence. Never fake-success.
 */
export const abortLynxAssistantSession = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  assistantId: string,
  binding: Pick<LynxSessionBinding, 'sessionID' | 'sessionGeneration'>,
  options?: { signal?: AbortSignal },
): Promise<LynxAssistantAbortResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const id = assistantId.trim();
  if (!id) {
    return { status: 'failed', error: new Error('assistant id required') };
  }
  if (!binding.sessionID) {
    return { status: 'failed', error: new Error('assistant session binding required') };
  }
  try {
    const response = await runtimeFetch(
      `/api/openchamber/assistants/${encodeURIComponent(id)}/session/abort`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sessionID: binding.sessionID,
          sessionGeneration: binding.sessionGeneration,
        }),
        signal: options?.signal,
      },
    );
    if (response.status === 0) return { status: 'no-runtime' };
    if (response.status === 404 || response.status === 501) return { status: 'unsupported' };
    if (response.status === 409) return { status: 'revision-conflict' };
    if (!response.ok) {
      return {
        status: 'failed',
        error: new Error(`assistant abort failed (${response.status})`),
        httpStatus: response.status,
      };
    }
    const payload = asRecord(await response.json());
    if (!payload || payload.aborted !== true) {
      return { status: 'failed', error: new Error('invalid assistant abort payload') };
    }
    const nextBinding = asRecord(payload.binding);
    if (
      !nextBinding
      || typeof nextBinding.directory !== 'string'
      || typeof nextBinding.sessionGeneration !== 'number'
    ) {
      return { status: 'failed', error: new Error('invalid assistant abort binding') };
    }
    return {
      status: 'ok',
      aborted: true,
      binding: {
        sessionID: typeof nextBinding.sessionID === 'string' ? nextBinding.sessionID : null,
        directory: nextBinding.directory,
        sessionGeneration: nextBinding.sessionGeneration,
      },
    };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
};
