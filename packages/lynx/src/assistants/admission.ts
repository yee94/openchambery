/**
 * Cap Assistant continuous/stateless message admission.
 * POST /api/openchamber/assistants/:id/messages
 *   → { binding, messageID, admitted: true }
 * Cap body: { sessionID, sessionGeneration, messageID, parts, source? }
 * Mode is server-owned from AssistantDTO.mode — client does not invent ASR or session ids.
 */
import type { LynxRuntimeFetch } from '../runtime/fetch';
import type { LynxAssistantMode } from './types';

export type LynxSessionBinding = {
  sessionID: string | null;
  directory: string;
  sessionGeneration: number;
};

export type LynxMessageAdmission = {
  binding: LynxSessionBinding;
  messageID: string;
  admitted: true;
};

export type LynxAdmitAssistantMessageResult =
  | { status: 'ok'; admission: LynxMessageAdmission; mode: LynxAssistantMode | null }
  | { status: 'no-runtime' }
  | { status: 'unsupported' }
  | { status: 'revision-conflict' }
  | { status: 'failed'; error: Error; httpStatus?: number };

export type LynxAdmitAssistantMessageInput = {
  assistantId: string;
  text: string;
  /** Expected binding fence (continuous). Stateless still sends; server rotates. */
  sessionID?: string | null;
  sessionGeneration?: number;
  /** Cap requires messageID — generated when omitted. */
  messageID?: string;
  mode?: LynxAssistantMode | null;
  source?: 'composer' | 'ios-share' | 'android-share';
};

const asRecord = (data: unknown): Record<string, unknown> => (
  data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {}
);

const parseBinding = (value: unknown): LynxSessionBinding | null => {
  const record = asRecord(value);
  if (typeof record.directory !== 'string') return null;
  if (typeof record.sessionGeneration !== 'number') return null;
  return {
    sessionID: typeof record.sessionID === 'string' ? record.sessionID : null,
    directory: record.directory,
    sessionGeneration: record.sessionGeneration,
  };
};

export const parseLynxMessageAdmission = (payload: unknown): LynxMessageAdmission | null => {
  const record = asRecord(payload);
  if (record.admitted !== true) return null;
  if (typeof record.messageID !== 'string' || !record.messageID.trim()) return null;
  const binding = parseBinding(record.binding);
  if (!binding) return null;
  return { binding, messageID: record.messageID.trim(), admitted: true };
};

export const createLynxAssistantMessageId = (): string => (
  `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
);

/**
 * Admit a composer turn into an Assistant (continuous or stateless).
 * Stateless: server creates a fresh session per send — client must use returned binding.
 * Continuous: binding fence must match or server returns conflict.
 * Never fake-success (no-runtime / HTTP / parse failures stay explicit).
 */
export const admitLynxAssistantMessage = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  input: LynxAdmitAssistantMessageInput,
  options?: { signal?: AbortSignal },
): Promise<LynxAdmitAssistantMessageResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const id = input.assistantId.trim();
  const text = input.text.trim();
  if (!id || !text) {
    return { status: 'failed', error: new Error('assistant id and text required') };
  }
  try {
    const messageID = input.messageID?.trim() || createLynxAssistantMessageId();
    const body: Record<string, unknown> = {
      messageID,
      parts: [{ type: 'text', text }],
      source: input.source ?? 'composer',
    };
    // Cap continuous fence is top-level sessionID + sessionGeneration (not nested binding).
    if (input.sessionID !== undefined) body.sessionID = input.sessionID;
    if (input.sessionGeneration !== undefined) body.sessionGeneration = input.sessionGeneration;
    const response = await runtimeFetch(
      `/api/openchamber/assistants/${encodeURIComponent(id)}/messages`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: options?.signal,
      },
    );
    if (response.status === 0) return { status: 'no-runtime' };
    if (response.status === 404 || response.status === 501) return { status: 'unsupported' };
    if (response.status === 409) return { status: 'revision-conflict' };
    // Cap respond() defaults to 200; share uses 202. Accept any 2xx with admitted payload.
    if (!response.ok) {
      return {
        status: 'failed',
        error: new Error(`assistant admit failed (${response.status})`),
        httpStatus: response.status,
      };
    }
    const payload = await response.json();
    const admission = parseLynxMessageAdmission(payload);
    if (!admission) {
      return { status: 'failed', error: new Error('invalid message admission payload') };
    }
    return { status: 'ok', admission, mode: input.mode ?? null };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
};
