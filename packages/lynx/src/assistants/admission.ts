/**
 * Cap Assistant continuous/stateless message admission.
 * POST /api/openchamber/assistants/:id/messages → { binding, messageID, admitted: true }
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
  clientMessageID?: string;
  mode?: LynxAssistantMode | null;
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

/**
 * Admit a composer turn into an Assistant (continuous or stateless).
 * Stateless: server creates a fresh session per send — client must use returned binding.
 * Continuous: binding fence must match or server returns conflict.
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
    const body: Record<string, unknown> = {
      parts: [{ type: 'text', text }],
    };
    if (input.clientMessageID) body.clientMessageID = input.clientMessageID;
    if (input.sessionID !== undefined || input.sessionGeneration !== undefined) {
      body.binding = {
        sessionID: input.sessionID ?? null,
        sessionGeneration: input.sessionGeneration ?? 0,
      };
    }
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
