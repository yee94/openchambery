import React from 'react';
import { useInfiniteQuery, useQuery, type InfiniteData, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { queryClient } from '@/lib/queryRuntime';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { waitForSessionStartupBarrier } from '@/lib/session-startup-barrier';
import { AssistantAPIError, AssistantShareOperationError, parseAssistantCapabilityDTO, parseAssistantContactCardAdmission, parseAssistantContactPage, parseAssistantContactPeerAdmission, parseAssistantDTO, parseAssistantHistoryPage, parseAssistantSnapshotDTO, parseCompactResponse, parseMessageAdmission, parseSessionBinding, parseShareOperation, type AssistantCapabilityDTO, type AssistantContactPeerAdmission, type AssistantContactSessionCardPart, type AssistantDTO, type AssistantHistoryPage, type AssistantMode, type AssistantPart, type AssistantSnapshotDTO, type AssistantSource, type CompactResponse, type MessageAdmission, type SessionBinding, type ShareOperation } from './assistantDTO';
export type { AssistantContactCardAdmission, AssistantContactMessage, AssistantContactPage, AssistantContactPart, AssistantContactPeerAdmission, AssistantContactSessionCardPart, AssistantDTO, AssistantHistoryEntry, AssistantHistoryPage, AssistantMode, AssistantPart, AssistantSource, CompactResponse, MessageAdmission, SessionBinding, ShareOperation } from './assistantDTO';
export type AssistantSnapshot = AssistantSnapshotDTO;
export type AssistantCapability = AssistantCapabilityDTO;
export interface AssistantDraft { enabled: boolean; name: string; defaultPrompt: string; workspacePath: string | null; providerID: string; modelID: string; agent: string | null; variant?: string | null; mode: AssistantMode; }
export { AssistantAPIError, AssistantShareOperationError, parseAssistantCapabilityDTO, parseShareOperation } from './assistantDTO';

const ASSISTANT_HISTORY_PAGE_SIZE = 30;
const key = {
  snapshot: (transport = getRuntimeTransportIdentity()) => [transport, 'assistants', 'snapshot'] as const,
  capability: (transport = getRuntimeTransportIdentity()) => [transport, 'assistants', 'capability'] as const,
  history: (assistantID: string, sessionID: string, sessionGeneration: number, transport = getRuntimeTransportIdentity(), runtimeGeneration = getRuntimeGeneration()) => [transport, runtimeGeneration, 'assistants', 'history', assistantID, sessionID, sessionGeneration] as const,
  contact: (assistantID: string, transport = getRuntimeTransportIdentity(), runtimeGeneration = getRuntimeGeneration()) => [transport, runtimeGeneration, 'assistants', 'contact', assistantID] as const,
};

/**
 * Keep the prior Assistant transcript visible while a stateless/compact binding
 * advance changes the history query key. Never cross assistants or runtimes —
 * those must cold-start so one conversation cannot paint under another.
 */
export const retainAssistantHistoryPlaceholder = (
  previousData: InfiniteData<AssistantHistoryPage, string | null> | undefined,
  previousQuery: { queryKey: QueryKey } | undefined,
  next: {
    assistantID: string;
    transport: string;
    runtimeGeneration: number;
  },
): InfiniteData<AssistantHistoryPage, string | null> | undefined => {
  if (!previousData || !previousQuery) return undefined;
  const previousKey = previousQuery.queryKey;
  if (
    previousKey[0] !== next.transport
    || previousKey[1] !== next.runtimeGeneration
    || previousKey[2] !== 'assistants'
    || previousKey[3] !== 'history'
    || previousKey[4] !== next.assistantID
  ) {
    return undefined;
  }
  return previousData;
};
const requestJSON = async <T>(path: string, init: RequestInit = {}): Promise<T> => { const response = await runtimeFetch(path, init); const payload = await response.json().catch(() => null) as { error?: unknown; message?: unknown } | T | null; if (!response.ok) { const code = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string' ? payload.error : 'request_failed'; const message = payload && typeof payload === 'object' && 'message' in payload && typeof payload.message === 'string' ? payload.message : undefined; throw new AssistantAPIError(code, response.status, undefined, message); } return payload as T; };
const jsonInit = (method: string, body?: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const assertCurrent = (transport: string, generation: number) => { if (getRuntimeTransportIdentity() !== transport || getRuntimeGeneration() !== generation) throw new AssistantAPIError('runtime_stale', 409); };
const applyBinding = (assistantID: string, binding: SessionBinding, transport: string) => {
  queryClient.setQueryData<AssistantSnapshot>(key.snapshot(transport), (snapshot) => snapshot && ({ ...snapshot, assistants: snapshot.assistants.map((assistant) => {
    if (assistant.id !== assistantID) return assistant;
    if (assistant.sessionGeneration > binding.sessionGeneration) return assistant;
    return { ...assistant, sessionID: binding.sessionID, sessionGeneration: binding.sessionGeneration, effectiveWorkspacePath: binding.directory };
  }) }));
  void queryClient.invalidateQueries({ queryKey: key.snapshot(transport) });
  // Admission writes SQLite immediately; history infinite queries stay stale
  // until invalidated. Without a refetch, mergeHostedCurrentSessionHistory has
  // no admission parts for the new message when live SSE is incomplete.
  void queryClient.invalidateQueries({
    queryKey: [transport, getRuntimeGeneration(), 'assistants', 'history', assistantID],
  });
};
const applyAssistant = (assistant: AssistantDTO, transport: string) => {
  queryClient.setQueryData<AssistantSnapshot>(key.snapshot(transport), (snapshot) => snapshot && ({ ...snapshot, assistants: snapshot.assistants.some((item) => item.id === assistant.id) ? snapshot.assistants.map((item) => item.id === assistant.id ? assistant : item) : [...snapshot.assistants, assistant] }));
  void queryClient.invalidateQueries({ queryKey: key.snapshot(transport) });
};
export const assistantSnapshotQueryOptions = (transport = getRuntimeTransportIdentity()) => ({ queryKey: key.snapshot(transport), queryFn: async ({ signal }: { signal: AbortSignal }) => parseAssistantSnapshotDTO(await requestJSON<unknown>('/api/openchamber/assistants/snapshot', { signal })), retry: 2 });
export const useAssistantSnapshotQuery = () => {
  const transport = getRuntimeTransportIdentity();
  const query = useQuery(assistantSnapshotQueryOptions(transport));
  React.useEffect(() => subscribeOpenchamberEvents((event) => {
    if (getRuntimeTransportIdentity() !== transport) return;
    if (event.type === 'event-stream-ready') {
      void queryClient.invalidateQueries({ queryKey: key.snapshot(transport), exact: true });
      return;
    }
    if (event.type !== 'assistants-changed') return;
    const snapshot = queryClient.getQueryData<AssistantSnapshot>(key.snapshot(transport));
    if (!snapshot || event.revision > snapshot.revision) {
      void queryClient.invalidateQueries({ queryKey: key.snapshot(transport), exact: true });
    }
  }), [transport]);
  return query;
};
export const assistantHistoryInfiniteQueryOptions = (
  assistantID: string,
  sessionID: string,
  sessionGeneration: number,
  transport = getRuntimeTransportIdentity(),
  runtimeGeneration = getRuntimeGeneration(),
) => ({
  queryKey: key.history(assistantID, sessionID, sessionGeneration, transport, runtimeGeneration),
  queryFn: async ({ signal, pageParam }: { signal: AbortSignal; pageParam: string | null }) => {
    // Capture identity is fixed in the query key; re-assert after the startup
    // barrier so a runtime switch during boot cannot reuse a stale flight.
    assertCurrent(transport, runtimeGeneration);
    await waitForSessionStartupBarrier();
    assertCurrent(transport, runtimeGeneration);
    const query = new URLSearchParams({ limit: String(ASSISTANT_HISTORY_PAGE_SIZE) });
    if (pageParam) query.set('before', pageParam);
    const page = parseAssistantHistoryPage(await requestJSON<unknown>(`/api/openchamber/assistants/${encodeURIComponent(assistantID)}/messages?${query}`, { signal }));
    assertCurrent(transport, runtimeGeneration);
    return page;
  },
  initialPageParam: null as string | null,
  getNextPageParam: getNextAssistantHistoryPageParam,
  // Stateless turns bump sessionGeneration in the key. Without a same-assistant
  // placeholder the transcript blanks until the new key resolves, which also
  // drops SQLite admission rows the live binding has not mirrored yet.
  placeholderData: (
    previousData: InfiniteData<AssistantHistoryPage, string | null> | undefined,
    previousQuery: { queryKey: QueryKey } | undefined,
  ) => retainAssistantHistoryPlaceholder(previousData, previousQuery, {
    assistantID,
    transport,
    runtimeGeneration,
  }),
  retry: 2,
});
export const getNextAssistantHistoryPageParam = (page: AssistantHistoryPage): string | undefined => page.complete ? undefined : page.nextCursor ?? undefined;
export const useAssistantHistoryInfiniteQuery = (
  assistantID: string,
  binding: Pick<SessionBinding, 'sessionID' | 'sessionGeneration'>,
  enabled = true,
) => useInfiniteQuery<
  AssistantHistoryPage,
  Error,
  InfiniteData<AssistantHistoryPage, string | null>,
  ReturnType<typeof key.history>,
  string | null
>({
  ...assistantHistoryInfiniteQueryOptions(assistantID, binding.sessionID ?? '', binding.sessionGeneration),
  enabled: enabled && Boolean(assistantID && binding.sessionID),
});
export const assistantContactQueryOptions = (
  assistantID: string,
  transport = getRuntimeTransportIdentity(),
  runtimeGeneration = getRuntimeGeneration(),
) => ({
  queryKey: key.contact(assistantID, transport, runtimeGeneration),
  queryFn: async ({ signal }: { signal: AbortSignal }) => {
    assertCurrent(transport, runtimeGeneration);
    await waitForSessionStartupBarrier();
    assertCurrent(transport, runtimeGeneration);
    const page = parseAssistantContactPage(await requestJSON<unknown>(`/api/openchamber/assistants/${encodeURIComponent(assistantID)}/contact/messages?limit=100`, { signal }));
    assertCurrent(transport, runtimeGeneration);
    return page;
  },
  retry: 2,
});
export const useAssistantContactMessagesQuery = (assistantID: string, enabled = true) => {
  const transport = getRuntimeTransportIdentity();
  const runtimeGeneration = getRuntimeGeneration();
  const query = useQuery({
    ...assistantContactQueryOptions(assistantID, transport, runtimeGeneration),
    enabled: enabled && Boolean(assistantID),
  });
  React.useEffect(() => subscribeOpenchamberEvents((event) => {
    if (getRuntimeTransportIdentity() !== transport) return;
    if (event.type !== 'assistants-changed' && event.type !== 'event-stream-ready') return;
    void queryClient.invalidateQueries({ queryKey: key.contact(assistantID, transport, runtimeGeneration), exact: true });
  }), [assistantID, runtimeGeneration, transport]);
  return query;
};
const invalidateContact = (assistantID: string, transport = getRuntimeTransportIdentity()) => {
  void queryClient.invalidateQueries({
    queryKey: [transport, getRuntimeGeneration(), 'assistants', 'contact', assistantID],
  });
};
export const fetchAssistantSnapshot = async (signal: AbortSignal): Promise<AssistantSnapshot> => parseAssistantSnapshotDTO(await requestJSON<unknown>('/api/openchamber/assistants/snapshot', { signal }));
export const assistantCapabilityQueryOptions = (transport = getRuntimeTransportIdentity()) => ({ queryKey: key.capability(transport), queryFn: () => fetchAssistantCapability(), retry: false });
export const useAssistantCapabilityQuery = () => useQuery(assistantCapabilityQueryOptions());
export const readAssistantSnapshot = (client: Pick<QueryClient, 'getQueryData'> = queryClient, transport = getRuntimeTransportIdentity()): AssistantSnapshot | undefined => client.getQueryData<AssistantSnapshot>(key.snapshot(transport));
export const ensureAssistantSnapshot = (client: Pick<QueryClient, 'fetchQuery'> = queryClient, transport = getRuntimeTransportIdentity()) => client.fetchQuery(assistantSnapshotQueryOptions(transport));
export const forceRefreshAssistantSnapshot = async (client: Pick<QueryClient, 'invalidateQueries' | 'fetchQuery'> = queryClient): Promise<AssistantSnapshot> => { const transport = getRuntimeTransportIdentity(); const generation = getRuntimeGeneration(); await client.invalidateQueries({ queryKey: key.snapshot(transport), exact: true }); assertCurrent(transport, generation); const snapshot = await client.fetchQuery(assistantSnapshotQueryOptions(transport)); assertCurrent(transport, generation); return snapshot; };
export const ensureAssistantSession = async (assistantID: string): Promise<SessionBinding> => {
  // Capture transport/generation before the startup barrier so identity cannot
  // silently rewrite while boot work holds the gate.
  const transport = getRuntimeTransportIdentity();
  const generation = getRuntimeGeneration();
  await waitForSessionStartupBarrier();
  assertCurrent(transport, generation);
  const binding = parseSessionBinding(await requestJSON<unknown>(`/api/openchamber/assistants/${encodeURIComponent(assistantID)}/session/ensure`, jsonInit('POST')));
  assertCurrent(transport, generation);
  applyBinding(assistantID, binding, transport);
  return binding;
};
export const newAssistantSession = async (assistantID: string): Promise<SessionBinding> => { const transport = getRuntimeTransportIdentity(); const generation = getRuntimeGeneration(); const binding = parseSessionBinding(await requestJSON<unknown>(`/api/openchamber/assistants/${encodeURIComponent(assistantID)}/session/new`, jsonInit('POST'))); assertCurrent(transport, generation); applyBinding(assistantID, binding, transport); return binding; };
export const compactAssistantSession = async (assistantID: string, binding: SessionBinding): Promise<CompactResponse> => { const transport = getRuntimeTransportIdentity(); const generation = getRuntimeGeneration(); const result = parseCompactResponse(await requestJSON<unknown>(`/api/openchamber/assistants/${encodeURIComponent(assistantID)}/session/compact`, jsonInit('POST', { sessionID: binding.sessionID, sessionGeneration: binding.sessionGeneration }))); assertCurrent(transport, generation); applyBinding(assistantID, result.binding, transport); return result; };
export const abortAssistantSession = async (assistantID: string, binding: SessionBinding): Promise<void> => { const transport = getRuntimeTransportIdentity(); const generation = getRuntimeGeneration(); await requestJSON<unknown>(`/api/openchamber/assistants/${encodeURIComponent(assistantID)}/session/abort`, jsonInit('POST', { sessionID: binding.sessionID, sessionGeneration: binding.sessionGeneration })); assertCurrent(transport, generation); };
export const sendAssistantMessage = async (assistantID: string, binding: SessionBinding, messageID: string, parts: AssistantPart[], source: AssistantSource = 'composer'): Promise<MessageAdmission> => { const transport = getRuntimeTransportIdentity(); const generation = getRuntimeGeneration(); const result = parseMessageAdmission(await requestJSON<unknown>(`/api/openchamber/assistants/${encodeURIComponent(assistantID)}/messages`, jsonInit('POST', { sessionID: binding.sessionID, sessionGeneration: binding.sessionGeneration, messageID, parts, source }))); assertCurrent(transport, generation); applyBinding(assistantID, result.binding, transport); invalidateContact(assistantID, transport); return result; };
export const sendAssistantContactMessage = async (assistantID: string, messageID: string, text: string): Promise<MessageAdmission> => {
  const transport = getRuntimeTransportIdentity();
  const generation = getRuntimeGeneration();
  const result = parseMessageAdmission(await requestJSON<unknown>(`/api/openchamber/assistants/${encodeURIComponent(assistantID)}/messages`, jsonInit('POST', { messageID, parts: [{ type: 'text', text }] })));
  assertCurrent(transport, generation);
  applyBinding(assistantID, result.binding, transport);
  invalidateContact(assistantID, transport);
  return result;
};
export const appendAssistantContactCard = async (
  assistantID: string,
  card: Pick<AssistantContactSessionCardPart, 'sessionID' | 'directory'> & Partial<Pick<AssistantContactSessionCardPart, 'title' | 'status'>>,
): Promise<AssistantContactSessionCardPart> => {
  const transport = getRuntimeTransportIdentity();
  const generation = getRuntimeGeneration();
  const result = parseAssistantContactCardAdmission(await requestJSON<unknown>(`/api/openchamber/assistants/${encodeURIComponent(assistantID)}/contact/cards`, jsonInit('POST', { cardType: 'session', ...card })));
  assertCurrent(transport, generation);
  invalidateContact(assistantID, transport);
  return result.card;
};
export const deliverAssistantContactDm = async (
  fromAssistantID: string,
  input: { toAssistantID: string; text?: string; parts?: Array<{ type: 'text'; text: string } | AssistantContactSessionCardPart> },
): Promise<AssistantContactPeerAdmission> => {
  const transport = getRuntimeTransportIdentity();
  const generation = getRuntimeGeneration();
  const result = parseAssistantContactPeerAdmission(await requestJSON<unknown>(`/api/openchamber/assistants/${encodeURIComponent(fromAssistantID)}/contact/dm`, jsonInit('POST', input)));
  assertCurrent(transport, generation);
  invalidateContact(result.toAssistantID, transport);
  return result;
};
export const sendAssistantShare = async (assistantID: string, operationID: string, messageID: string, parts: AssistantPart[], source: Exclude<AssistantSource, 'composer'>): Promise<ShareOperation> => { const transport = getRuntimeTransportIdentity(); const generation = getRuntimeGeneration(); const operation = parseShareOperation(await requestJSON<unknown>(`/api/openchamber/assistants/${encodeURIComponent(assistantID)}/share`, jsonInit('POST', { operationID, payload: { messageID, parts, source } }))); assertCurrent(transport, generation); return operation; };
export const fetchAssistantShareOperation = async (operationID: string, transport = getRuntimeTransportIdentity(), generation = getRuntimeGeneration()): Promise<ShareOperation> => { assertCurrent(transport, generation); const operation = parseShareOperation(await requestJSON<unknown>(`/api/openchamber/assistants/share-operations/${encodeURIComponent(operationID)}`)); assertCurrent(transport, generation); return operation; };
export const waitForAssistantShare = async (operation: ShareOperation, transport = getRuntimeTransportIdentity(), generation = getRuntimeGeneration()): Promise<ShareOperation> => { let current = operation; for (let attempt = 0; attempt < 60 && (current.state === 'running' || current.state === 'submitting'); attempt += 1) { assertCurrent(transport, generation); await new Promise((resolve) => setTimeout(resolve, 750)); current = await fetchAssistantShareOperation(current.operationID, transport, generation); } assertCurrent(transport, generation); if (current.state === 'completed') return current; if (current.state === 'failed') throw new AssistantShareOperationError(current.errorCode ?? 'share_failed', 400, current); throw new AssistantShareOperationError('share_unresolved', 408, current); };
export const setAssistantsEnabled = async (enabled: boolean, expectedRevision: number): Promise<void> => {
  await requestJSON('/api/openchamber/assistants/settings', jsonInit('PUT', { enabled, expectedRevision }));
  const transport = getRuntimeTransportIdentity();
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: key.snapshot(transport), exact: true }),
    queryClient.invalidateQueries({ queryKey: key.capability(transport), exact: true }),
  ]);
};
export const createAssistant = async (draft: AssistantDraft): Promise<AssistantDTO> => { const transport = getRuntimeTransportIdentity(); const result = parseAssistantDTO(await requestJSON<unknown>('/api/openchamber/assistants', jsonInit('POST', draft))); applyAssistant(result, transport); return result; };
export const updateAssistant = async (assistant: AssistantDTO, draft: AssistantDraft): Promise<AssistantDTO> => { const transport = getRuntimeTransportIdentity(); const generation = getRuntimeGeneration(); const result = parseAssistantDTO(await requestJSON<unknown>(`/api/openchamber/assistants/${encodeURIComponent(assistant.id)}`, jsonInit('PATCH', { ...draft, expectedRevision: assistant.revision }))); assertCurrent(transport, generation); applyAssistant(result, transport); return result; };
export const deleteAssistant = async (assistant: AssistantDTO): Promise<void> => { await requestJSON(`/api/openchamber/assistants/${encodeURIComponent(assistant.id)}`, jsonInit('DELETE', { expectedRevision: assistant.revision })); await queryClient.invalidateQueries({ queryKey: key.snapshot(getRuntimeTransportIdentity()) }); };
export const fetchAssistantCapability = async (): Promise<AssistantCapability> => parseAssistantCapabilityDTO(await requestJSON<unknown>('/api/openchamber/assistants/capability'));
export const assistantQueryKeys = key;
