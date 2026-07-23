import type { Message, Part } from '@opencode-ai/sdk/v2';

export type AssistantSource = 'composer' | 'ios-share' | 'android-share';
export type AssistantMode = 'continuous' | 'stateless';
export type AssistantPart = { type: 'text'; text: string; synthetic?: boolean } | { type: 'file'; mime: string; url: string };

export interface AssistantCapabilityDTO { supported: boolean; enabled: boolean; revision: number; serverInstanceID: string | null; }
export interface AssistantDTO { id: string; revision: number; enabled: boolean; name: string; defaultPrompt: string; workspacePath: string | null; effectiveWorkspacePath: string; managedWorkspacePath: string | null; providerID: string; modelID: string; agent: string | null; variant: string | null; mode: AssistantMode; sessionID: string | null; sessionGeneration: number; historySessionIDs: string[]; historySessionCount: number; createdAt: number | null; updatedAt: number; tombstoneAt: number | null; }
export interface AssistantSnapshotDTO { revision: number; enabled: boolean; assistants: AssistantDTO[]; }
export interface SessionBinding { sessionID: string | null; directory: string; sessionGeneration: number; }
export interface CompactResponse { binding: SessionBinding; summarized: true; }
export interface MessageAdmission { binding: SessionBinding; messageID: string; admitted: true; }
export interface ShareOperation { operationID: string; assistantID: string; sessionID: string | null; messageID: string | null; state: 'submitting' | 'running' | 'completed' | 'failed' | 'unresolved'; phase: string; attempt: number; leaseExpiresAt: number | null; errorCode: string | null; }
export interface AssistantHistoryEntry { sessionID: string; directory: string | null; info: Message; parts: Part[]; }
export interface AssistantHistoryPage { entries: AssistantHistoryEntry[]; nextCursor: string | null; complete: boolean; }

export class AssistantAPIError extends Error { constructor(public readonly code: string, public readonly status: number, public readonly resource?: string) { super(code); } }
export class AssistantShareOperationError extends AssistantAPIError { constructor(code: string, status: number, public readonly operation: ShareOperation) { super(code, status, 'share_operation'); } }
const invalid = (resource: string, status = 200): never => { throw new AssistantAPIError(`invalid_${resource}_response`, status, resource); };
const record = (value: unknown, resource: string): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid(resource);
const string = (value: unknown, resource: string): string => typeof value === 'string' ? value : invalid(resource);
const nullableString = (value: unknown, resource: string): string | null => value === null || typeof value === 'string' ? value : invalid(resource);
const number = (value: unknown, resource: string): number => typeof value === 'number' && Number.isFinite(value) ? value : invalid(resource);
const nullableNumber = (value: unknown, resource: string): number | null => value === null ? null : number(value, resource);
const bool = (value: unknown, resource: string): boolean => typeof value === 'boolean' ? value : invalid(resource);
const enumValue = <T extends string>(value: unknown, choices: readonly T[], resource: string): T => choices.includes(value as T) ? value as T : invalid(resource);

export const parseAssistantCapabilityDTO = (payload: unknown): AssistantCapabilityDTO => { const value = record(payload, 'capability'); return { supported: bool(value.supported, 'capability'), enabled: bool(value.enabled, 'capability'), revision: number(value.revision, 'capability'), serverInstanceID: nullableString(value.serverInstanceID, 'capability') }; };
export const parseAssistantDTO = (payload: unknown): AssistantDTO => { const value = record(payload, 'assistant'); const historySessionIDs = Array.isArray(value.historySessionIDs) ? value.historySessionIDs.map((item) => string(item, 'assistant')) : []; const historySessionCount = value.historySessionCount === undefined ? historySessionIDs.length : number(value.historySessionCount, 'assistant'); if (!Number.isSafeInteger(historySessionCount) || historySessionCount < historySessionIDs.length) return invalid('assistant'); return { id: string(value.id, 'assistant'), revision: number(value.revision, 'assistant'), enabled: bool(value.enabled, 'assistant'), name: string(value.name, 'assistant'), defaultPrompt: string(value.defaultPrompt, 'assistant'), workspacePath: nullableString(value.workspacePath, 'assistant'), effectiveWorkspacePath: string(value.effectiveWorkspacePath, 'assistant'), managedWorkspacePath: nullableString(value.managedWorkspacePath ?? null, 'assistant'), providerID: string(value.providerID, 'assistant'), modelID: string(value.modelID, 'assistant'), agent: nullableString(value.agent, 'assistant'), variant: nullableString(value.variant ?? null, 'assistant'), mode: enumValue(value.mode, ['continuous', 'stateless'] as const, 'assistant'), sessionID: nullableString(value.sessionID, 'assistant'), sessionGeneration: number(value.sessionGeneration, 'assistant'), historySessionIDs, historySessionCount, createdAt: nullableNumber(value.createdAt, 'assistant'), updatedAt: number(value.updatedAt, 'assistant'), tombstoneAt: nullableNumber(value.tombstoneAt, 'assistant') }; };
export const parseAssistantSnapshotDTO = (payload: unknown): AssistantSnapshotDTO => { const value = record(payload, 'snapshot'); return { revision: number(value.revision, 'snapshot'), enabled: bool(value.enabled, 'snapshot'), assistants: Array.isArray(value.assistants) ? value.assistants.map(parseAssistantDTO) : invalid('snapshot') }; };
export const parseSessionBinding = (payload: unknown): SessionBinding => { const value = record(payload, 'binding'); return { sessionID: nullableString(value.sessionID, 'binding'), directory: string(value.directory, 'binding'), sessionGeneration: number(value.sessionGeneration, 'binding') }; };
export const parseCompactResponse = (payload: unknown): CompactResponse => { const value = record(payload, 'compact'); if (value.summarized !== true) return invalid('compact'); return { binding: parseSessionBinding(value.binding), summarized: true }; };
export const parseMessageAdmission = (payload: unknown): MessageAdmission => { const value = record(payload, 'message_admission'); if (value.admitted !== true) return invalid('message_admission'); return { binding: parseSessionBinding(value.binding), messageID: string(value.messageID, 'message_admission'), admitted: true }; };
export const parseShareOperation = (payload: unknown): ShareOperation => { const value = record(payload, 'share_operation'); return { operationID: string(value.operationID, 'share_operation'), assistantID: string(value.assistantID, 'share_operation'), sessionID: nullableString(value.sessionID, 'share_operation'), messageID: nullableString(value.messageID, 'share_operation'), state: enumValue(value.state, ['submitting', 'running', 'completed', 'failed', 'unresolved'] as const, 'share_operation'), phase: string(value.phase, 'share_operation'), attempt: number(value.attempt, 'share_operation'), leaseExpiresAt: nullableNumber(value.leaseExpiresAt, 'share_operation'), errorCode: nullableString(value.errorCode, 'share_operation') }; };
export const parseAssistantHistoryPage = (payload: unknown): AssistantHistoryPage => {
  const value = record(payload, 'assistant_history');
  const nextCursor = nullableString(value.nextCursor, 'assistant_history');
  const complete = bool(value.complete, 'assistant_history');
  if (!complete && !nextCursor) return invalid('assistant_history');
  if (complete && nextCursor) return invalid('assistant_history');
  if (!Array.isArray(value.entries)) return invalid('assistant_history');
  return {
    entries: value.entries.map((entry) => {
      const item = record(entry, 'assistant_history_entry');
      const entrySessionID = string(item.sessionID, 'assistant_history_entry');
      const info = record(item.info, 'assistant_history_info');
      const time = record(info.time, 'assistant_history_info');
      string(info.id, 'assistant_history_info');
      if (string(info.sessionID, 'assistant_history_info') !== entrySessionID) return invalid('assistant_history_entry');
      enumValue(info.role, ['user', 'assistant', 'system', 'tool'] as const, 'assistant_history_info');
      number(time.created, 'assistant_history_info');
      if (!Array.isArray(item.parts)) return invalid('assistant_history_entry');
      const parts = item.parts.map((part) => {
        const parsed = record(part, 'assistant_history_part');
        string(parsed.id, 'assistant_history_part');
        if (string(parsed.sessionID, 'assistant_history_part') !== entrySessionID) return invalid('assistant_history_part');
        if (string(parsed.messageID, 'assistant_history_part') !== info.id) return invalid('assistant_history_part');
        string(parsed.type, 'assistant_history_part');
        return parsed as Part;
      });
      return { sessionID: entrySessionID, directory: nullableString(item.directory, 'assistant_history_entry'), info: info as Message, parts };
    }),
    nextCursor,
    complete,
  };
};
