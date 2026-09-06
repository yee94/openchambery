import type { ActiveRuntime } from '@/lib/connectionController';
import { openchamberFetch } from '@/lib/openchamberClient';

export type AssistantMode = 'continuous' | 'stateless';

export type AssistantCapability = {
  supported: boolean;
  enabled: boolean;
  revision: number;
  serverInstanceID: string | null;
};

export type AssistantDTO = {
  id: string;
  revision: number;
  enabled: boolean;
  name: string;
  defaultPrompt: string;
  workspacePath: string | null;
  effectiveWorkspacePath: string;
  managedWorkspacePath: string | null;
  providerID: string;
  modelID: string;
  agent: string | null;
  variant: string | null;
  mode: AssistantMode;
  sessionID: string | null;
  sessionGeneration: number;
  historySessionIDs: string[];
  historySessionCount: number;
  createdAt: number | null;
  updatedAt: number;
  tombstoneAt: number | null;
};

export type AssistantSnapshot = {
  revision: number;
  enabled: boolean;
  assistants: AssistantDTO[];
};

export type SessionBinding = {
  sessionID: string | null;
  directory: string;
  sessionGeneration: number;
};

export type AssistantsSettingsResult = {
  enabled: boolean;
  revision: number;
};

export class AssistantsApiError extends Error {
  readonly status: number | null;
  readonly code: string;

  constructor(code: string, status: number | null = null) {
    super(code);
    this.name = 'AssistantsApiError';
    this.code = code;
    this.status = status;
  }
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const invalid = (resource: string, status = 200): never => {
  throw new AssistantsApiError(`invalid_${resource}_response`, status);
};

const requireString = (value: unknown, resource: string): string =>
  typeof value === 'string' ? value : invalid(resource);

const requireNullableString = (value: unknown, resource: string): string | null =>
  value === null || typeof value === 'string' ? value : invalid(resource);

const requireNumber = (value: unknown, resource: string): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : invalid(resource);

const requireNullableNumber = (value: unknown, resource: string): number | null =>
  value === null ? null : requireNumber(value, resource);

const requireBool = (value: unknown, resource: string): boolean =>
  typeof value === 'boolean' ? value : invalid(resource);

const requireMode = (value: unknown, resource: string): AssistantMode =>
  value === 'continuous' || value === 'stateless' ? value : invalid(resource);

export const parseAssistantCapability = (payload: unknown): AssistantCapability => {
  const value = asRecord(payload) ?? invalid('capability');
  return {
    supported: requireBool(value.supported, 'capability'),
    enabled: requireBool(value.enabled, 'capability'),
    revision: requireNumber(value.revision, 'capability'),
    serverInstanceID: requireNullableString(value.serverInstanceID, 'capability'),
  };
};

export const parseAssistantDTO = (payload: unknown): AssistantDTO => {
  const value = asRecord(payload) ?? invalid('assistant');
  const historySessionIDs = Array.isArray(value.historySessionIDs)
    ? value.historySessionIDs.map((item) => requireString(item, 'assistant'))
    : [];
  const historySessionCount =
    value.historySessionCount === undefined
      ? historySessionIDs.length
      : requireNumber(value.historySessionCount, 'assistant');
  if (!Number.isSafeInteger(historySessionCount) || historySessionCount < historySessionIDs.length) {
    return invalid('assistant');
  }
  return {
    id: requireString(value.id, 'assistant'),
    revision: requireNumber(value.revision, 'assistant'),
    enabled: requireBool(value.enabled, 'assistant'),
    name: requireString(value.name, 'assistant'),
    defaultPrompt: requireString(value.defaultPrompt, 'assistant'),
    workspacePath: requireNullableString(value.workspacePath, 'assistant'),
    effectiveWorkspacePath: requireString(value.effectiveWorkspacePath, 'assistant'),
    managedWorkspacePath: requireNullableString(value.managedWorkspacePath ?? null, 'assistant'),
    providerID: requireString(value.providerID, 'assistant'),
    modelID: requireString(value.modelID, 'assistant'),
    agent: requireNullableString(value.agent, 'assistant'),
    variant: requireNullableString(value.variant ?? null, 'assistant'),
    mode: requireMode(value.mode, 'assistant'),
    sessionID: requireNullableString(value.sessionID, 'assistant'),
    sessionGeneration: requireNumber(value.sessionGeneration, 'assistant'),
    historySessionIDs,
    historySessionCount,
    createdAt: requireNullableNumber(value.createdAt, 'assistant'),
    updatedAt: requireNumber(value.updatedAt, 'assistant'),
    tombstoneAt: requireNullableNumber(value.tombstoneAt, 'assistant'),
  };
};

export const parseAssistantSnapshot = (payload: unknown): AssistantSnapshot => {
  const value = asRecord(payload) ?? invalid('snapshot');
  if (!Array.isArray(value.assistants)) return invalid('snapshot');
  return {
    revision: requireNumber(value.revision, 'snapshot'),
    enabled: requireBool(value.enabled, 'snapshot'),
    assistants: value.assistants.map(parseAssistantDTO),
  };
};

export const parseSessionBinding = (payload: unknown): SessionBinding => {
  const value = asRecord(payload) ?? invalid('binding');
  return {
    sessionID: requireNullableString(value.sessionID, 'binding'),
    directory: requireString(value.directory, 'binding'),
    sessionGeneration: requireNumber(value.sessionGeneration, 'binding'),
  };
};

export const parseAssistantsSettingsResult = (payload: unknown): AssistantsSettingsResult => {
  const value = asRecord(payload) ?? invalid('settings');
  return {
    enabled: requireBool(value.enabled, 'settings'),
    revision: requireNumber(value.revision, 'settings'),
  };
};

const readErrorCode = async (response: {
  status: number;
  json: () => Promise<unknown>;
}): Promise<string> => {
  const payload = asRecord(await response.json().catch(() => null));
  return typeof payload?.error === 'string' ? payload.error : 'request_failed';
};

const jsonInit = (method: string, body?: unknown, signal?: AbortSignal): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
  signal,
});

/** GET /api/openchamber/assistants/capability */
export const fetchAssistantCapability = async (
  active: ActiveRuntime,
  options?: { signal?: AbortSignal },
): Promise<AssistantCapability> => {
  const response = await openchamberFetch(active, '/api/openchamber/assistants/capability', {
    method: 'GET',
    signal: options?.signal,
  });
  if (response.status === 404 || response.status === 501) {
    return {
      supported: false,
      enabled: false,
      revision: 0,
      serverInstanceID: null,
    };
  }
  if (!response.ok) {
    throw new AssistantsApiError(await readErrorCode(response), response.status);
  }
  return parseAssistantCapability(await response.json());
};

/** GET /api/openchamber/assistants/snapshot — failure must not look like empty success. */
export const fetchAssistantSnapshot = async (
  active: ActiveRuntime,
  options?: { signal?: AbortSignal },
): Promise<AssistantSnapshot> => {
  const response = await openchamberFetch(active, '/api/openchamber/assistants/snapshot', {
    method: 'GET',
    signal: options?.signal,
  });
  if (!response.ok) {
    throw new AssistantsApiError(await readErrorCode(response), response.status);
  }
  return parseAssistantSnapshot(await response.json());
};

/** PUT /api/openchamber/assistants/settings */
export const setAssistantsEnabled = async (
  active: ActiveRuntime,
  enabled: boolean,
  expectedRevision: number,
): Promise<AssistantsSettingsResult> => {
  const response = await openchamberFetch(
    active,
    '/api/openchamber/assistants/settings',
    jsonInit('PUT', { enabled, expectedRevision }),
  );
  if (!response.ok) {
    throw new AssistantsApiError(await readErrorCode(response), response.status);
  }
  return parseAssistantsSettingsResult(await response.json());
};

/** POST /api/openchamber/assistants/:id/session/new */
export const newAssistantSession = async (
  active: ActiveRuntime,
  assistantID: string,
): Promise<SessionBinding> => {
  const response = await openchamberFetch(
    active,
    `/api/openchamber/assistants/${encodeURIComponent(assistantID)}/session/new`,
    jsonInit('POST'),
  );
  if (!response.ok) {
    throw new AssistantsApiError(await readErrorCode(response), response.status);
  }
  return parseSessionBinding(await response.json());
};

/** DELETE /api/openchamber/assistants/:id with expectedRevision (official API). */
export const deleteAssistant = async (
  active: ActiveRuntime,
  assistant: Pick<AssistantDTO, 'id' | 'revision'>,
): Promise<void> => {
  const response = await openchamberFetch(
    active,
    `/api/openchamber/assistants/${encodeURIComponent(assistant.id)}`,
    jsonInit('DELETE', { expectedRevision: assistant.revision }),
  );
  if (!response.ok) {
    throw new AssistantsApiError(await readErrorCode(response), response.status);
  }
};


export type AssistantDraft = {
  enabled: boolean;
  name: string;
  defaultPrompt: string;
  workspacePath: string | null;
  providerID: string;
  modelID: string;
  agent: string | null;
  mode: AssistantMode;
  variant?: string | null;
};

/** POST /api/openchamber/assistants — create. */
export const createAssistant = async (
  active: ActiveRuntime,
  draft: AssistantDraft,
): Promise<AssistantDTO> => {
  const response = await openchamberFetch(
    active,
    '/api/openchamber/assistants',
    jsonInit('POST', draft),
  );
  if (!response.ok) {
    throw new AssistantsApiError(await readErrorCode(response), response.status);
  }
  return parseAssistantDTO(await response.json());
};

/** PATCH /api/openchamber/assistants/:id — update with expectedRevision. */
export const updateAssistant = async (
  active: ActiveRuntime,
  assistant: Pick<AssistantDTO, 'id' | 'revision'>,
  draft: AssistantDraft,
): Promise<AssistantDTO> => {
  const response = await openchamberFetch(
    active,
    `/api/openchamber/assistants/${encodeURIComponent(assistant.id)}`,
    jsonInit('PATCH', { ...draft, expectedRevision: assistant.revision }),
  );
  if (!response.ok) {
    throw new AssistantsApiError(await readErrorCode(response), response.status);
  }
  return parseAssistantDTO(await response.json());
};
