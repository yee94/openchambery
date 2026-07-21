import { useQuery, type QueryClient } from '@tanstack/react-query';
import { queryClient } from '@/lib/queryRuntime';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { AssistantAPIError, parseAssistantCapabilityDTO, parseAssistantDTO, parseAssistantOperationDTO, parseAssistantSnapshotDTO, parseAssistantTopicDTO, parseAssistantTopicsDTO, parseAssistantTurnsDTO, type AssistantCapabilityDTO, type AssistantDTO, type AssistantMode, type AssistantOperationDTO, type AssistantPart, type AssistantSnapshotDTO, type AssistantSource, type AssistantTopicDTO, type AssistantTurnDTO } from './assistantDTO';

export type { AssistantDTO, AssistantMode, AssistantOperationDTO, AssistantPart, AssistantSource, AssistantTopicDTO, AssistantTurnDTO } from './assistantDTO';
export type AssistantSnapshot = AssistantSnapshotDTO;
export type AssistantCapability = AssistantCapabilityDTO;

export interface AssistantDraft {
  enabled: boolean;
  name: string;
  defaultPrompt: string;
  workspacePath: string | null;
  skillRoots: string[];
  providerID: string;
  modelID: string;
  agent: string | null;
  mode: AssistantMode;
}

export { AssistantAPIError, parseAssistantCapabilityDTO, parseAssistantOperationDTO } from './assistantDTO';

const key = {
  snapshot: (transport = getRuntimeTransportIdentity()) => [transport, 'assistants', 'snapshot'] as const,
  topics: (assistantID: string, transport = getRuntimeTransportIdentity()) => [transport, 'assistants', assistantID, 'topics'] as const,
  turns: (topicID: string, transport = getRuntimeTransportIdentity()) => [transport, 'assistants', 'topics', topicID, 'turns'] as const,
};

const requestJSON = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const response = await runtimeFetch(path, init);
  const payload = await response.json().catch(() => null) as { error?: unknown } | T | null;
  if (!response.ok) {
    const code = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
      ? payload.error
      : 'request_failed';
    throw new AssistantAPIError(code, response.status);
  }
  return payload as T;
};

const requestOperation = async (path: string, init: RequestInit): Promise<AssistantOperationDTO> => {
  const response = await runtimeFetch(path, init);
  const payload = await response.json().catch(() => null) as { error?: unknown } | AssistantOperationDTO | null;
  if (!response.ok) {
    const code = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string' ? payload.error : 'request_failed';
    throw new AssistantAPIError(code, response.status);
  }
  return parseAssistantOperationDTO(payload, response.status);
};

const jsonInit = (method: string, body?: unknown, signal?: AbortSignal): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
  signal,
});

export const assistantSnapshotQueryOptions = (transport = getRuntimeTransportIdentity()) => ({
  queryKey: key.snapshot(transport),
  queryFn: async ({ signal }: { signal: AbortSignal }) => parseAssistantSnapshotDTO(await requestJSON<unknown>('/api/openchamber/assistants/snapshot', { signal })),
  retry: 2,
});

export const assistantTopicsQueryOptions = (assistantID: string, transport = getRuntimeTransportIdentity()) => ({
  queryKey: key.topics(assistantID, transport),
  queryFn: async ({ signal }: { signal: AbortSignal }) => parseAssistantTopicsDTO(await requestJSON<unknown>(`/api/openchamber/assistants/${encodeURIComponent(assistantID)}/topics`, { signal })),
  retry: 2,
});

export const assistantTurnsQueryOptions = (topicID: string, transport = getRuntimeTransportIdentity()) => ({
  queryKey: key.turns(topicID, transport),
  queryFn: async ({ signal }: { signal: AbortSignal }) => parseAssistantTurnsDTO(await requestJSON<unknown>(`/api/openchamber/assistants/topics/${encodeURIComponent(topicID)}/messages`, { signal })),
  retry: 2,
});

export const useAssistantSnapshotQuery = () => useQuery(assistantSnapshotQueryOptions());
export const assistantCapabilityQueryOptions = (transport = getRuntimeTransportIdentity()) => ({
  queryKey: [transport, 'assistants', 'capability'] as const,
  queryFn: () => fetchAssistantCapability(),
  retry: false,
});
export const useAssistantCapabilityQuery = () => useQuery(assistantCapabilityQueryOptions());
export const useAssistantTopicsQuery = (assistantID: string | null) => useQuery({
  ...assistantTopicsQueryOptions(assistantID ?? ''),
  enabled: Boolean(assistantID),
});
export const transcriptNeedsPolling = (turns: AssistantTurnDTO[] | undefined): boolean => Boolean(turns?.some((turn) => turn.role === 'assistant' && turn.completedAt === null && turn.error === null));
export const useAssistantTurnsQuery = (topicID: string | null) => useQuery({
  ...assistantTurnsQueryOptions(topicID ?? ''),
  enabled: Boolean(topicID),
  refetchInterval: (query) => transcriptNeedsPolling(query.state.data) ? 1200 : false,
});

export const readAssistantSnapshot = (
  client: Pick<QueryClient, 'getQueryData'> = queryClient,
  transport = getRuntimeTransportIdentity(),
): AssistantSnapshot | undefined => client.getQueryData<AssistantSnapshot>(key.snapshot(transport));

export const ensureAssistantSnapshot = (
  client: Pick<QueryClient, 'fetchQuery'> = queryClient,
  transport = getRuntimeTransportIdentity(),
) => client.fetchQuery(assistantSnapshotQueryOptions(transport));

const invalidateSnapshot = async (transport: string): Promise<void> => {
  await queryClient.invalidateQueries({ queryKey: key.snapshot(transport) });
};

export const setAssistantsEnabled = async (enabled: boolean, expectedRevision: number): Promise<void> => {
  const transport = getRuntimeTransportIdentity();
  await requestJSON('/api/openchamber/assistants/settings', jsonInit('PUT', { enabled, expectedRevision }));
  await invalidateSnapshot(transport);
};

export const createAssistant = async (draft: AssistantDraft): Promise<AssistantDTO> => {
  const transport = getRuntimeTransportIdentity();
  const result = parseAssistantDTO(await requestJSON<unknown>('/api/openchamber/assistants', jsonInit('POST', draft)));
  await invalidateSnapshot(transport);
  return result;
};

export const updateAssistant = async (assistant: AssistantDTO, draft: AssistantDraft): Promise<AssistantDTO> => {
  const transport = getRuntimeTransportIdentity();
  const result = parseAssistantDTO(await requestJSON<unknown>(`/api/openchamber/assistants/${encodeURIComponent(assistant.id)}`, jsonInit('PATCH', { ...draft, expectedRevision: assistant.revision })));
  await invalidateSnapshot(transport);
  return result;
};

export const deleteAssistant = async (assistant: AssistantDTO): Promise<void> => {
  const transport = getRuntimeTransportIdentity();
  await requestJSON(`/api/openchamber/assistants/${encodeURIComponent(assistant.id)}`, jsonInit('DELETE', { expectedRevision: assistant.revision }));
  await invalidateSnapshot(transport);
  queryClient.removeQueries({ queryKey: key.topics(assistant.id, transport) });
};

export const createAssistantTopic = async (assistantID: string, title: string): Promise<AssistantTopicDTO> => {
  const transport = getRuntimeTransportIdentity();
  const topic = parseAssistantTopicDTO(await requestJSON<unknown>(`/api/openchamber/assistants/${encodeURIComponent(assistantID)}/topics`, jsonInit('POST', { title })));
  await queryClient.invalidateQueries({ queryKey: key.topics(assistantID, transport) });
  return topic;
};

export const renameAssistantTopic = async (topic: AssistantTopicDTO, title: string): Promise<void> => {
  const transport = getRuntimeTransportIdentity();
  await requestJSON(`/api/openchamber/assistants/topics/${encodeURIComponent(topic.id)}`, jsonInit('PATCH', { title, expectedRevision: topic.revision }));
  await queryClient.invalidateQueries({ queryKey: key.topics(topic.assistantID, transport) });
};

export const archiveAssistantTopic = async (topic: AssistantTopicDTO): Promise<void> => {
  const transport = getRuntimeTransportIdentity();
  await requestJSON(`/api/openchamber/assistants/topics/${encodeURIComponent(topic.id)}`, jsonInit('DELETE', { expectedRevision: topic.revision }));
  await queryClient.invalidateQueries({ queryKey: key.topics(topic.assistantID, transport) });
  queryClient.removeQueries({ queryKey: key.turns(topic.id, transport) });
};

const operationFlights = new Map<string, Promise<AssistantOperationDTO>>();

const capturedRuntimeIsCurrent = (transport: string, generation: number): boolean => getRuntimeTransportIdentity() === transport && getRuntimeGeneration() === generation;

export const reconcileAssistantOperation = (operationID: string, captured = { transport: getRuntimeTransportIdentity(), generation: getRuntimeGeneration() }): Promise<AssistantOperationDTO> => {
  const flightKey = `${captured.transport}:${operationID}`;
  const existing = operationFlights.get(flightKey);
  if (existing) return existing;
  const flight = (async () => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (!capturedRuntimeIsCurrent(captured.transport, captured.generation)) throw new AssistantAPIError('runtime_stale', 409);
      const operation = await requestOperation(`/api/openchamber/assistants/operations/${encodeURIComponent(operationID)}`, {});
      if (!capturedRuntimeIsCurrent(captured.transport, captured.generation)) throw new AssistantAPIError('runtime_stale', 409);
      if (operation.state === 'completed') return operation;
      if (operation.state === 'failed') throw new AssistantAPIError(operation.errorCode ?? 'operation_failed', 400);
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
    throw new AssistantAPIError('operation_in_progress', 202);
  })();
  operationFlights.set(flightKey, flight);
  void flight.finally(() => { if (operationFlights.get(flightKey) === flight) operationFlights.delete(flightKey); }).catch(() => undefined);
  return flight;
};

export const runAssistantTopicOperation = async (
  topicID: string,
  operationID: string,
  operation: 'message' | 'new' | 'compact',
  parts: AssistantPart[] = [],
  source: AssistantSource = 'composer',
  options?: { onReconcile?: () => void },
): Promise<void> => {
  const transport = getRuntimeTransportIdentity();
  const generation = getRuntimeGeneration();
  const suffix = operation === 'message' ? 'messages' : operation;
  try {
    const result = await requestOperation(`/api/openchamber/assistants/topics/${encodeURIComponent(topicID)}/${suffix}`, jsonInit('POST', operation === 'message'
      ? { operationID, parts, source }
      : { operationID }));
    if (result.operationID !== operationID) throw new AssistantAPIError('operation_mismatch', 502);
    if (result.state === 'failed') throw new AssistantAPIError(result.errorCode ?? 'operation_failed', 400);
    if (result.state === 'admitted' || result.state === 'running') {
      options?.onReconcile?.();
      await reconcileAssistantOperation(operationID, { transport, generation });
    }
  } catch (error) {
    if (error instanceof AssistantAPIError) {
      if (!['operation_in_progress', 'request_failed'].includes(error.code)) throw error;
    }
    options?.onReconcile?.();
    await reconcileAssistantOperation(operationID, { transport, generation });
  }
  if (getRuntimeTransportIdentity() === transport && getRuntimeGeneration() === generation) {
    await queryClient.invalidateQueries({ queryKey: key.turns(topicID, transport) });
  }
};

export const fetchAssistantCapability = async (): Promise<AssistantCapability> => parseAssistantCapabilityDTO(await requestJSON<unknown>('/api/openchamber/assistants/capability'));

export const assistantQueryKeys = key;
