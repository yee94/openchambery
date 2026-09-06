import type {
  LynxAssistantCapability,
  LynxAssistantDTO,
  LynxAssistantMode,
  LynxAssistantSnapshot,
} from './types';

export class LynxAssistantParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LynxAssistantParseError';
  }
}

const record = (value: unknown, resource: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LynxAssistantParseError(`invalid_${resource}_response`);
  }
  return value as Record<string, unknown>;
};

const string = (value: unknown, resource: string): string => {
  if (typeof value !== 'string') throw new LynxAssistantParseError(`invalid_${resource}_response`);
  return value;
};

const nullableString = (value: unknown, resource: string): string | null => {
  if (value === null || typeof value === 'string') return value;
  throw new LynxAssistantParseError(`invalid_${resource}_response`);
};

const number = (value: unknown, resource: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new LynxAssistantParseError(`invalid_${resource}_response`);
  }
  return value;
};

const nullableNumber = (value: unknown, resource: string): number | null =>
  value === null ? null : number(value, resource);

const bool = (value: unknown, resource: string): boolean => {
  if (typeof value !== 'boolean') throw new LynxAssistantParseError(`invalid_${resource}_response`);
  return value;
};

const mode = (value: unknown, resource: string): LynxAssistantMode => {
  if (value === 'continuous' || value === 'stateless') return value;
  throw new LynxAssistantParseError(`invalid_${resource}_response`);
};

/** Cap `parseAssistantDTO` contract — fail closed, never invent rows. */
export const parseLynxAssistantDTO = (payload: unknown): LynxAssistantDTO => {
  const value = record(payload, 'assistant');
  const historySessionIDs = Array.isArray(value.historySessionIDs)
    ? value.historySessionIDs.map((item) => string(item, 'assistant'))
    : [];
  const historySessionCount = value.historySessionCount === undefined
    ? historySessionIDs.length
    : number(value.historySessionCount, 'assistant');
  if (!Number.isSafeInteger(historySessionCount) || historySessionCount < historySessionIDs.length) {
    throw new LynxAssistantParseError('invalid_assistant_response');
  }
  return {
    id: string(value.id, 'assistant'),
    revision: number(value.revision, 'assistant'),
    enabled: bool(value.enabled, 'assistant'),
    name: string(value.name, 'assistant'),
    defaultPrompt: string(value.defaultPrompt, 'assistant'),
    workspacePath: nullableString(value.workspacePath, 'assistant'),
    effectiveWorkspacePath: string(value.effectiveWorkspacePath, 'assistant'),
    managedWorkspacePath: nullableString(value.managedWorkspacePath ?? null, 'assistant'),
    providerID: string(value.providerID, 'assistant'),
    modelID: string(value.modelID, 'assistant'),
    agent: nullableString(value.agent, 'assistant'),
    variant: nullableString(value.variant ?? null, 'assistant'),
    mode: mode(value.mode, 'assistant'),
    sessionID: nullableString(value.sessionID, 'assistant'),
    sessionGeneration: number(value.sessionGeneration, 'assistant'),
    historySessionIDs,
    historySessionCount,
    createdAt: nullableNumber(value.createdAt, 'assistant'),
    updatedAt: number(value.updatedAt, 'assistant'),
    tombstoneAt: nullableNumber(value.tombstoneAt, 'assistant'),
  };
};

export const parseLynxAssistantSnapshot = (payload: unknown): LynxAssistantSnapshot => {
  const value = record(payload, 'snapshot');
  if (!Array.isArray(value.assistants)) throw new LynxAssistantParseError('invalid_snapshot_response');
  return {
    revision: number(value.revision, 'snapshot'),
    enabled: bool(value.enabled, 'snapshot'),
    assistants: value.assistants.map(parseLynxAssistantDTO),
  };
};

export const parseLynxAssistantCapability = (payload: unknown): LynxAssistantCapability => {
  const value = record(payload, 'capability');
  return {
    supported: bool(value.supported, 'capability'),
    enabled: bool(value.enabled, 'capability'),
    revision: number(value.revision, 'capability'),
    serverInstanceID: nullableString(value.serverInstanceID, 'capability'),
  };
};
