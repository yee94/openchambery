export type AssistantMode = 'continuous' | 'stateless';
export type AssistantSource = 'composer' | 'ios-share' | 'android-share';
export type AssistantPart = { type: 'text'; text: string } | { type: 'file'; mime: string; url: string };

export interface AssistantCapabilityDTO { supported: boolean; enabled: boolean; revision: number; serverInstanceID: string | null; }
export interface AssistantDTO { id: string; revision: number; enabled: boolean; name: string; defaultPrompt: string; workspacePath: string | null; skillRoots: string[]; providerID: string; modelID: string; agent: string | null; mode: AssistantMode; inboxTopicID: string; createdAt: number | null; updatedAt: number; tombstoneAt: number | null; }
export interface AssistantSnapshotDTO { revision: number; enabled: boolean; assistants: AssistantDTO[]; }
export interface AssistantTopicDTO { id: string; assistantID: string; title: string; sessionID: string | null; revision: number; createdAt: number; updatedAt: number; tombstoneAt: number | null; }
export type AssistantTurnDTO =
  | { id: string; topicID: string; ordinal: number; role: 'user'; parentMessageID: null; phase: string; kind: string; source: AssistantSource; parts: AssistantPart[]; assistantRevision: number; sessionID: string | null; messageID: string | null; operationID: string; createdAt: number; completedAt: null; error: null }
  | { id: string; topicID: string; ordinal: number; role: 'assistant'; parentMessageID: string | null; phase: string; parts: AssistantPart[]; sessionID: string | null; messageID: string | null; operationID: string; createdAt: number | null; completedAt: number | null; error: unknown | null };
export interface AssistantOperationDTO { operationID: string; topicID: string | null; type: 'message' | 'new' | 'compact'; state: 'admitted' | 'running' | 'completed' | 'failed'; phase: string; sessionID: string | null; messageID: string | null; admission: { admitted: true; attempt: number; leaseExpiresAt: number | null }; result: unknown | null; errorCode: string | null; payloadHash: string; createdAt: number; updatedAt: number; }

export class AssistantAPIError extends Error {
  constructor(public readonly code: string, public readonly status: number, public readonly resource?: string) { super(code); }
}

const invalid = (resource: string, status = 200): never => { throw new AssistantAPIError(`invalid_${resource}_response`, status, resource); };
const record = (value: unknown, resource: string): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid(resource);
const string = (value: unknown, resource: string): string => typeof value === 'string' ? value : invalid(resource);
const nullableString = (value: unknown, resource: string): string | null => value === null || typeof value === 'string' ? value : invalid(resource);
const number = (value: unknown, resource: string): number => typeof value === 'number' && Number.isFinite(value) ? value : invalid(resource);
const nullableNumber = (value: unknown, resource: string): number | null => value === null ? null : number(value, resource);
const bool = (value: unknown, resource: string): boolean => typeof value === 'boolean' ? value : invalid(resource);
const nullableUnknown = (value: unknown, resource: string): unknown | null => value === null ? null : value === undefined ? invalid(resource) : value;
const nullableEnum = <T extends string>(value: unknown, choices: readonly T[], resource: string): T | null => value === null ? null : choices.includes(value as T) ? value as T : invalid(resource);

const parsePart = (value: unknown): AssistantPart => {
  const part = record(value, 'turn');
  if (part.type === 'text') return { type: 'text', text: string(part.text, 'turn') };
  if (part.type === 'file') return { type: 'file', mime: string(part.mime, 'turn'), url: string(part.url, 'turn') };
  return invalid('turn');
};

export const parseAssistantCapabilityDTO = (payload: unknown): AssistantCapabilityDTO => {
  const value = record(payload, 'capability');
  return { supported: bool(value.supported, 'capability'), enabled: bool(value.enabled, 'capability'), revision: number(value.revision, 'capability'), serverInstanceID: nullableString(value.serverInstanceID, 'capability') };
};

export const parseAssistantDTO = (payload: unknown): AssistantDTO => {
  const value = record(payload, 'assistant');
  const skillRoots = Array.isArray(value.skillRoots) ? value.skillRoots.map((item) => string(item, 'assistant')) : invalid('assistant');
  const mode = nullableEnum(value.mode, ['continuous', 'stateless'] as const, 'assistant');
  if (!mode) return invalid('assistant');
  return { id: string(value.id, 'assistant'), revision: number(value.revision, 'assistant'), enabled: bool(value.enabled, 'assistant'), name: string(value.name, 'assistant'), defaultPrompt: string(value.defaultPrompt, 'assistant'), workspacePath: nullableString(value.workspacePath, 'assistant'), skillRoots, providerID: string(value.providerID, 'assistant'), modelID: string(value.modelID, 'assistant'), agent: nullableString(value.agent, 'assistant'), mode, inboxTopicID: string(value.inboxTopicID, 'assistant'), createdAt: nullableNumber(value.createdAt, 'assistant'), updatedAt: number(value.updatedAt, 'assistant'), tombstoneAt: nullableNumber(value.tombstoneAt, 'assistant') };
};

export const parseAssistantSnapshotDTO = (payload: unknown): AssistantSnapshotDTO => {
  const value = record(payload, 'snapshot');
  return { revision: number(value.revision, 'snapshot'), enabled: bool(value.enabled, 'snapshot'), assistants: Array.isArray(value.assistants) ? value.assistants.map(parseAssistantDTO) : invalid('snapshot') };
};

export const parseAssistantTopicDTO = (payload: unknown): AssistantTopicDTO => {
  const value = record(payload, 'topic');
  return { id: string(value.id, 'topic'), assistantID: string(value.assistantID, 'topic'), title: string(value.title, 'topic'), sessionID: nullableString(value.sessionID, 'topic'), revision: number(value.revision, 'topic'), createdAt: number(value.createdAt, 'topic'), updatedAt: number(value.updatedAt, 'topic'), tombstoneAt: nullableNumber(value.tombstoneAt, 'topic') };
};
export const parseAssistantTopicsDTO = (payload: unknown): AssistantTopicDTO[] => Array.isArray(payload) ? payload.map(parseAssistantTopicDTO) : invalid('topic');

export const parseAssistantTurnDTO = (payload: unknown): AssistantTurnDTO => {
  const value = record(payload, 'turn');
  const base = { id: string(value.id, 'turn'), topicID: string(value.topicID, 'turn'), ordinal: number(value.ordinal, 'turn'), parts: Array.isArray(value.parts) ? value.parts.map(parsePart) : invalid('turn') };
  if (value.role === 'user') { if (value.parentMessageID !== null || value.completedAt !== null || value.error !== null) return invalid('turn'); return { ...base, role: 'user', parentMessageID: null, phase: string(value.phase, 'turn'), kind: string(value.kind, 'turn'), source: nullableEnum(value.source, ['composer', 'ios-share', 'android-share'] as const, 'turn') ?? invalid('turn'), assistantRevision: number(value.assistantRevision, 'turn'), sessionID: nullableString(value.sessionID, 'turn'), messageID: nullableString(value.messageID, 'turn'), operationID: string(value.operationID, 'turn'), createdAt: number(value.createdAt, 'turn'), completedAt: null, error: null }; }
  if (value.role === 'assistant') return { ...base, role: 'assistant', parentMessageID: nullableString(value.parentMessageID, 'turn'), phase: string(value.phase, 'turn'), sessionID: nullableString(value.sessionID, 'turn'), messageID: nullableString(value.messageID, 'turn'), operationID: string(value.operationID, 'turn'), createdAt: nullableNumber(value.createdAt, 'turn'), completedAt: nullableNumber(value.completedAt, 'turn'), error: nullableUnknown(value.error, 'turn') };
  return invalid('turn');
};
export const parseAssistantTurnsDTO = (payload: unknown): AssistantTurnDTO[] => Array.isArray(payload) ? payload.map(parseAssistantTurnDTO) : invalid('turn');

export const parseAssistantOperationDTO = (payload: unknown, status: number): AssistantOperationDTO => {
  const value = record(payload, 'operation');
  const state = nullableEnum(value.state, ['admitted', 'running', 'completed', 'failed'] as const, 'operation');
  const type = nullableEnum(value.type, ['message', 'new', 'compact'] as const, 'operation');
  const admission = record(value.admission, 'operation');
  if (!state || !type) return invalid('operation', status);
  return { operationID: string(value.operationID, 'operation'), topicID: nullableString(value.topicID, 'operation'), type, state, phase: string(value.phase, 'operation'), sessionID: nullableString(value.sessionID, 'operation'), messageID: nullableString(value.messageID, 'operation'), admission: { admitted: bool(admission.admitted, 'operation') === true ? true : invalid('operation', status), attempt: number(admission.attempt, 'operation'), leaseExpiresAt: nullableNumber(admission.leaseExpiresAt, 'operation') }, result: nullableUnknown(value.result, 'operation'), errorCode: nullableString(value.errorCode, 'operation'), payloadHash: string(value.payloadHash, 'operation'), createdAt: number(value.createdAt, 'operation'), updatedAt: number(value.updatedAt, 'operation') };
};
