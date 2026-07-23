import { useInfiniteQuery, useQuery, type QueryClient } from '@tanstack/react-query';
import { queryClient } from '@/lib/queryRuntime';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { AssistantAPIError, AssistantShareOperationError, parseAssistantCapabilityDTO, parseAssistantDTO, parseAssistantHistoryPage, parseAssistantSnapshotDTO, parseCompactResponse, parseMessageAdmission, parseSessionBinding, parseShareOperation, type AssistantCapabilityDTO, type AssistantDTO, type AssistantHistoryPage, type AssistantMode, type AssistantPart, type AssistantSnapshotDTO, type AssistantSource, type CompactResponse, type MessageAdmission, type SessionBinding, type ShareOperation } from './assistantDTO';
export type { AssistantDTO, AssistantHistoryEntry, AssistantHistoryPage, AssistantMode, AssistantPart, AssistantSource, CompactResponse, MessageAdmission, SessionBinding, ShareOperation } from './assistantDTO';
export type AssistantSnapshot = AssistantSnapshotDTO;
export type AssistantCapability = AssistantCapabilityDTO;
export interface AssistantDraft { enabled: boolean; name: string; defaultPrompt: string; workspacePath: string | null; providerID: string; modelID: string; agent: string | null; variant?: string | null; mode: AssistantMode; }
export { AssistantAPIError, AssistantShareOperationError, parseAssistantCapabilityDTO, parseShareOperation } from './assistantDTO';

const ASSISTANT_HISTORY_PAGE_SIZE = 30;
const key = {
  snapshot: (transport = getRuntimeTransportIdentity()) => [transport, 'assistants', 'snapshot'] as const,
  history: (assistantID: string, sessionID: string, sessionGeneration: number, transport = getRuntimeTransportIdentity(), runtimeGeneration = getRuntimeGeneration()) => [transport, runtimeGeneration, 'assistants', 'history', assistantID, sessionID, sessionGeneration] as const,
};
const requestJSON = async <T>(path: string, init: RequestInit = {}): Promise<T> => { const response = await runtimeFetch(path, init); const payload = await response.json().catch(() => null) as { error?: unknown } | T | null; if (!response.ok) throw new AssistantAPIError(payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string' ? payload.error : 'request_failed', response.status); return payload as T; };
const jsonInit = (method: string, body?: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const assertCurrent = (transport: string, generation: number) => { if (getRuntimeTransportIdentity() !== transport || getRuntimeGeneration() !== generation) throw new AssistantAPIError('runtime_stale', 409); };
const applyBinding = (assistantID: string, binding: SessionBinding, transport: string) => {
  queryClient.setQueryData<AssistantSnapshot>(key.snapshot(transport), (snapshot) => snapshot && ({ ...snapshot, assistants: snapshot.assistants.map((assistant) => {
    if (assistant.id !== assistantID) return assistant;
    return { ...assistant, sessionID: binding.sessionID, sessionGeneration: binding.sessionGeneration, effectiveWorkspacePath: binding.directory };
  }) }));
  void queryClient.invalidateQueries({ queryKey: key.snapshot(transport) });
};
const applyAssistant = (assistant: AssistantDTO, transport: string) => {
  queryClient.setQueryData<AssistantSnapshot>(key.snapshot(transport), (snapshot) => snapshot && ({ ...snapshot, assistants: snapshot.assistants.some((item) => item.id === assistant.id) ? snapshot.assistants.map((item) => item.id === assistant.id ? assistant : item) : [...snapshot.assistants, assistant] }));
  void queryClient.invalidateQueries({ queryKey: key.snapshot(transport) });
};
export const assistantSnapshotQueryOptions = (transport = getRuntimeTransportIdentity()) => ({ queryKey: key.snapshot(transport), queryFn: async ({ signal }: { signal: AbortSignal }) => parseAssistantSnapshotDTO(await requestJSON<unknown>('/api/openchamber/assistants/snapshot', { signal })), retry: 2 });
export const useAssistantSnapshotQuery = () => useQuery(assistantSnapshotQueryOptions());
export const assistantHistoryInfiniteQueryOptions = (
  assistantID: string,
  sessionID: string,
  sessionGeneration: number,
  transport = getRuntimeTransportIdentity(),
  runtimeGeneration = getRuntimeGeneration(),
) => ({
  queryKey: key.history(assistantID, sessionID, sessionGeneration, transport, runtimeGeneration),
  queryFn: async ({ signal, pageParam }: { signal: AbortSignal; pageParam: string | null }) => {
    assertCurrent(transport, runtimeGeneration);
    const query = new URLSearchParams({ limit: String(ASSISTANT_HISTORY_PAGE_SIZE) });
    if (pageParam) query.set('before', pageParam);
    const page = parseAssistantHistoryPage(await requestJSON<unknown>(`/api/openchamber/assistants/${encodeURIComponent(assistantID)}/messages?${query}`, { signal }));
    assertCurrent(transport, runtimeGeneration);
    return page;
  },
  initialPageParam: null as string | null,
  getNextPageParam: getNextAssistantHistoryPageParam,
  retry: 2,
});
export const getNextAssistantHistoryPageParam = (page: AssistantHistoryPage): string | undefined => page.complete ? undefined : page.nextCursor ?? undefined;
export const useAssistantHistoryInfiniteQuery = (
  assistantID: string,
  binding: Pick<SessionBinding, 'sessionID' | 'sessionGeneration'>,
  enabled = true,
) => useInfiniteQuery({
  ...assistantHistoryInfiniteQueryOptions(assistantID, binding.sessionID ?? '', binding.sessionGeneration),
  enabled: enabled && Boolean(assistantID && binding.sessionID),
});
export const fetchAssistantSnapshot = async (signal: AbortSignal): Promise<AssistantSnapshot> => parseAssistantSnapshotDTO(await requestJSON<unknown>('/api/openchamber/assistants/snapshot', { signal }));
export const assistantCapabilityQueryOptions = (transport = getRuntimeTransportIdentity()) => ({ queryKey: [transport, 'assistants', 'capability'] as const, queryFn: () => fetchAssistantCapability(), retry: false });
export const useAssistantCapabilityQuery = () => useQuery(assistantCapabilityQueryOptions());
export const readAssistantSnapshot = (client: Pick<QueryClient, 'getQueryData'> = queryClient, transport = getRuntimeTransportIdentity()): AssistantSnapshot | undefined => client.getQueryData<AssistantSnapshot>(key.snapshot(transport));
export const ensureAssistantSnapshot = (client: Pick<QueryClient, 'fetchQuery'> = queryClient, transport = getRuntimeTransportIdentity()) => client.fetchQuery(assistantSnapshotQueryOptions(transport));
export const forceRefreshAssistantSnapshot = async (client: Pick<QueryClient, 'invalidateQueries' | 'fetchQuery'> = queryClient): Promise<AssistantSnapshot> => { const transport = getRuntimeTransportIdentity(); const generation = getRuntimeGeneration(); await client.invalidateQueries({ queryKey: key.snapshot(transport), exact: true }); assertCurrent(transport, generation); const snapshot = await client.fetchQuery(assistantSnapshotQueryOptions(transport)); assertCurrent(transport, generation); return snapshot; };
export const ensureAssistantSession = async (assistantID: string): Promise<SessionBinding> => { const transport = getRuntimeTransportIdentity(); const generation = getRuntimeGeneration(); const binding = parseSessionBinding(await requestJSON<unknown>(`/api/openchamber/assistants/${encodeURIComponent(assistantID)}/session/ensure`, jsonInit('POST'))); assertCurrent(transport, generation); applyBinding(assistantID, binding, transport); return binding; };
export const newAssistantSession = async (assistantID: string): Promise<SessionBinding> => { const transport = getRuntimeTransportIdentity(); const generation = getRuntimeGeneration(); const binding = parseSessionBinding(await requestJSON<unknown>(`/api/openchamber/assistants/${encodeURIComponent(assistantID)}/session/new`, jsonInit('POST'))); assertCurrent(transport, generation); applyBinding(assistantID, binding, transport); return binding; };
export const compactAssistantSession = async (assistantID: string, binding: SessionBinding): Promise<CompactResponse> => { const transport = getRuntimeTransportIdentity(); const generation = getRuntimeGeneration(); const result = parseCompactResponse(await requestJSON<unknown>(`/api/openchamber/assistants/${encodeURIComponent(assistantID)}/session/compact`, jsonInit('POST', { sessionID: binding.sessionID, sessionGeneration: binding.sessionGeneration }))); assertCurrent(transport, generation); applyBinding(assistantID, result.binding, transport); return result; };
export const abortAssistantSession = async (assistantID: string, binding: SessionBinding): Promise<void> => { const transport = getRuntimeTransportIdentity(); const generation = getRuntimeGeneration(); await requestJSON<unknown>(`/api/openchamber/assistants/${encodeURIComponent(assistantID)}/session/abort`, jsonInit('POST', { sessionID: binding.sessionID, sessionGeneration: binding.sessionGeneration })); assertCurrent(transport, generation); };
export const sendAssistantMessage = async (assistantID: string, binding: SessionBinding, messageID: string, parts: AssistantPart[], source: AssistantSource = 'composer'): Promise<MessageAdmission> => { const transport = getRuntimeTransportIdentity(); const generation = getRuntimeGeneration(); const result = parseMessageAdmission(await requestJSON<unknown>(`/api/openchamber/assistants/${encodeURIComponent(assistantID)}/messages`, jsonInit('POST', { sessionID: binding.sessionID, sessionGeneration: binding.sessionGeneration, messageID, parts, source }))); assertCurrent(transport, generation); applyBinding(assistantID, result.binding, transport); return result; };
export const sendAssistantShare = async (assistantID: string, operationID: string, messageID: string, parts: AssistantPart[], source: Exclude<AssistantSource, 'composer'>): Promise<ShareOperation> => { const transport = getRuntimeTransportIdentity(); const generation = getRuntimeGeneration(); const operation = parseShareOperation(await requestJSON<unknown>(`/api/openchamber/assistants/${encodeURIComponent(assistantID)}/share`, jsonInit('POST', { operationID, payload: { messageID, parts, source } }))); assertCurrent(transport, generation); return operation; };
export const fetchAssistantShareOperation = async (operationID: string, transport = getRuntimeTransportIdentity(), generation = getRuntimeGeneration()): Promise<ShareOperation> => { assertCurrent(transport, generation); const operation = parseShareOperation(await requestJSON<unknown>(`/api/openchamber/assistants/share-operations/${encodeURIComponent(operationID)}`)); assertCurrent(transport, generation); return operation; };
export const waitForAssistantShare = async (operation: ShareOperation, transport = getRuntimeTransportIdentity(), generation = getRuntimeGeneration()): Promise<ShareOperation> => { let current = operation; for (let attempt = 0; attempt < 60 && (current.state === 'running' || current.state === 'submitting'); attempt += 1) { assertCurrent(transport, generation); await new Promise((resolve) => setTimeout(resolve, 750)); current = await fetchAssistantShareOperation(current.operationID, transport, generation); } assertCurrent(transport, generation); if (current.state === 'completed') return current; if (current.state === 'failed') throw new AssistantShareOperationError(current.errorCode ?? 'share_failed', 400, current); throw new AssistantShareOperationError('share_unresolved', 408, current); };
export const setAssistantsEnabled = async (enabled: boolean, expectedRevision: number): Promise<void> => { await requestJSON('/api/openchamber/assistants/settings', jsonInit('PUT', { enabled, expectedRevision })); await queryClient.invalidateQueries({ queryKey: key.snapshot(getRuntimeTransportIdentity()) }); };
export const createAssistant = async (draft: AssistantDraft): Promise<AssistantDTO> => { const transport = getRuntimeTransportIdentity(); const result = parseAssistantDTO(await requestJSON<unknown>('/api/openchamber/assistants', jsonInit('POST', draft))); applyAssistant(result, transport); return result; };
export const updateAssistant = async (assistant: AssistantDTO, draft: AssistantDraft): Promise<AssistantDTO> => { const transport = getRuntimeTransportIdentity(); const generation = getRuntimeGeneration(); const result = parseAssistantDTO(await requestJSON<unknown>(`/api/openchamber/assistants/${encodeURIComponent(assistant.id)}`, jsonInit('PATCH', { ...draft, expectedRevision: assistant.revision }))); assertCurrent(transport, generation); applyAssistant(result, transport); return result; };
export const deleteAssistant = async (assistant: AssistantDTO): Promise<void> => { await requestJSON(`/api/openchamber/assistants/${encodeURIComponent(assistant.id)}`, jsonInit('DELETE', { expectedRevision: assistant.revision })); await queryClient.invalidateQueries({ queryKey: key.snapshot(getRuntimeTransportIdentity()) }); };
export const fetchAssistantCapability = async (): Promise<AssistantCapability> => parseAssistantCapabilityDTO(await requestJSON<unknown>('/api/openchamber/assistants/capability'));
export const assistantQueryKeys = key;
