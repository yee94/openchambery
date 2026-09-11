import React from 'react';
import { parseAssistantReadPosition, parseAssistantReadResponse, type AssistantReadPosition } from './assistantDTO';
import { useInfiniteQuery, useQuery, type InfiniteData, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { queryClient } from '@/lib/queryRuntime';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { waitForSessionStartupBarrier } from '@/lib/session-startup-barrier';
import { fetchGlobalScheduledTasks } from '@/lib/scheduledTasksApi';
import { useI18nStore } from '@/lib/i18n/store';
import { AssistantAPIError, AssistantShareOperationError, isAbortError, parseAssistantCapabilityDTO, parseAssistantContactCardAdmission, parseAssistantContactPage, parseAssistantContactPeerAdmission, parseAssistantDTO, parseAssistantHistoryPage, parseAssistantScheduledTasksPage, parseAssistantSnapshotDTO, parseCompactResponse, parseMessageAdmission, parseSessionBinding, parseShareOperation, type AssistantCapabilityDTO, type AssistantContactCardPart, type AssistantContactFilePart, type AssistantContactMessage, type AssistantContactPage, type AssistantContactPeerAdmission, type AssistantContactSessionCardPart, type AssistantDTO, type AssistantHistoryPage, type AssistantMode, type AssistantPart, type AssistantSnapshotDTO, type AssistantSource, type CompactResponse, type MessageAdmission, type SessionBinding, type ShareOperation } from './assistantDTO';
import {
  applyContactGapPage,
  applyContactLatestPage,
  applyContactOlderPage,
  CONTACT_GAP_FILL_MAX_PAGES,
  CONTACT_MESSAGES_PAGE_DEFAULT,
  type ContactMessagesView,
} from './assistantContactMessages';
export type { AssistantActiveContactTurn, AssistantActiveContactTurnStatus, AssistantContactAssistantCardPart, AssistantContactCardAdmission, AssistantContactCardPart, AssistantContactFilePart, AssistantContactMessage, AssistantContactPage, AssistantContactPart, AssistantContactPeerAdmission, AssistantContactScheduleCardPart, AssistantContactSessionCardPart, AssistantDTO, AssistantHistoryEntry, AssistantHistoryPage, AssistantMode, AssistantPart, AssistantScheduledTaskEntry, AssistantScheduledTasksPage, AssistantSource, CompactResponse, MessageAdmission, SessionBinding, ShareOperation } from './assistantDTO';
export type { ContactMessagesView } from './assistantContactMessages';
export {
  CONTACT_GAP_FILL_MAX_PAGES,
  CONTACT_MESSAGES_PAGE_DEFAULT,
} from './assistantContactMessages';
export type AssistantSnapshot = AssistantSnapshotDTO;
export type AssistantCapability = AssistantCapabilityDTO;
export interface AssistantDraft { enabled: boolean; name: string; defaultPrompt: string; workspacePath: string | null; providerID: string; modelID: string; agent?: string | null; variant?: string | null; mode?: AssistantMode; }
export { AssistantAPIError, AssistantShareOperationError, parseAssistantCapabilityDTO, parseAssistantScheduledTasksPage, parseShareOperation } from './assistantDTO';

const ASSISTANT_HISTORY_PAGE_SIZE = 30;
const key = {
  snapshot: (transport = getRuntimeTransportIdentity()) => [transport, 'assistants', 'snapshot'] as const,
  capability: (transport = getRuntimeTransportIdentity()) => [transport, 'assistants', 'capability'] as const,
  history: (assistantID: string, sessionID: string, sessionGeneration: number, transport = getRuntimeTransportIdentity(), runtimeGeneration = getRuntimeGeneration()) => [transport, runtimeGeneration, 'assistants', 'history', assistantID, sessionID, sessionGeneration] as const,
  contact: (assistantID: string, transport = getRuntimeTransportIdentity(), runtimeGeneration = getRuntimeGeneration()) => [transport, runtimeGeneration, 'assistants', 'contact', assistantID] as const,
  scheduledTasks: (assistantID: string, transport = getRuntimeTransportIdentity(), runtimeGeneration = getRuntimeGeneration()) => [transport, runtimeGeneration, 'assistants', 'scheduled-tasks', assistantID] as const,
  globalScheduledTasks: (transport = getRuntimeTransportIdentity()) => [transport, 'scheduled-tasks'] as const,
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
/** Busy-path foreground reconcile (green dots / in-flight contact turns). */
export const CONTACT_WORKING_SNAPSHOT_POLL_MS = 2_500;
/** Idle-path foreground reconcile so missed SSE tips still pull completed replies. */
export const ASSISTANT_FOREGROUND_IDLE_RECONCILE_MS = 15_000;
export const snapshotHasContactWorking = (snapshot: AssistantSnapshot | undefined): boolean => (
  Boolean(snapshot?.assistants.some((assistant) => assistant.working || assistant.activeContactTurn))
);
const foregroundReconcileIntervalMs = (
  snapshot: AssistantSnapshot | undefined,
  options: { assistantID?: string } = {},
): number => {
  if (options.assistantID) {
    const assistant = snapshot?.assistants.find((item) => item.id === options.assistantID);
    return assistant?.working || assistant?.activeContactTurn
      ? CONTACT_WORKING_SNAPSHOT_POLL_MS
      : ASSISTANT_FOREGROUND_IDLE_RECONCILE_MS;
  }
  return snapshotHasContactWorking(snapshot)
    ? CONTACT_WORKING_SNAPSHOT_POLL_MS
    : ASSISTANT_FOREGROUND_IDLE_RECONCILE_MS;
};
export const assistantSnapshotQueryOptions = (transport = getRuntimeTransportIdentity()) => ({
  queryKey: key.snapshot(transport),
  queryFn: async ({ signal }: { signal: AbortSignal }) => parseAssistantSnapshotDTO(await requestJSON<unknown>('/api/openchamber/assistants/snapshot', { signal })),
  retry: 2,
  refetchInterval: (query: { state: { data: AssistantSnapshot | undefined } }) => (
    foregroundReconcileIntervalMs(query.state.data)
  ),
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: true,
  refetchOnReconnect: true,
});
const snapshotSubscriptions = new Map<string, { count: number; dispose: () => void }>();
const retainAssistantSnapshotEvents = (transport: string) => {
  const existing = snapshotSubscriptions.get(transport);
  if (existing) {
    existing.count += 1;
  } else {
    const dispose = subscribeOpenchamberEvents((event) => {
      if (getRuntimeTransportIdentity() !== transport) return;
      const snapshot = queryClient.getQueryData<AssistantSnapshot>(key.snapshot(transport));
      if (event.type === 'event-stream-ready' || event.type === 'contact-turn-start' || event.type === 'contact-turn-end'
        || (event.type === 'assistants-changed' && (!snapshot || event.revision > snapshot.revision))) {
        void queryClient.invalidateQueries({ queryKey: key.snapshot(transport), exact: true });
      }
    });
    snapshotSubscriptions.set(transport, { count: 1, dispose });
  }
  return () => {
    const subscription = snapshotSubscriptions.get(transport);
    if (subscription && --subscription.count === 0) {
      subscription.dispose();
      snapshotSubscriptions.delete(transport);
    }
  };
};
export const useAssistantSnapshotQuery = () => {
  const transport = getRuntimeTransportIdentity();
  const query = useQuery(assistantSnapshotQueryOptions(transport));
  React.useEffect(() => retainAssistantSnapshotEvents(transport), [transport]);
  return query;
};
const selectAssistantUnreadTotal = (snapshot: AssistantSnapshot) => snapshot.enabled
  ? snapshot.assistants.reduce((total, assistant) => total + (assistant.unreadCount ?? 0), 0) : 0;
export const useAssistantUnreadTotal = () => {
  const transport = getRuntimeTransportIdentity();
  const query = useQuery({ ...assistantSnapshotQueryOptions(transport), select: selectAssistantUnreadTotal });
  React.useEffect(() => retainAssistantSnapshotEvents(transport), [transport]);
  return query.data ?? 0;
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
const contactMessagesUrl = (
  assistantID: string,
  query: { limit?: number; before?: string; messageID?: string } = {},
) => {
  const params = new URLSearchParams();
  params.set('limit', String(query.limit ?? CONTACT_MESSAGES_PAGE_DEFAULT));
  if (query.before) params.set('before', query.before);
  if (query.messageID) params.set('messageID', query.messageID);
  return `/api/openchamber/assistants/${encodeURIComponent(assistantID)}/contact/messages?${params}`;
};

const fetchContactPage = async (
  assistantID: string,
  query: { limit?: number; before?: string; messageID?: string },
  signal?: AbortSignal,
): Promise<AssistantContactPage> => (
  parseAssistantContactPage(await requestJSON<unknown>(contactMessagesUrl(assistantID, query), signal ? { signal } : {}))
);

const sameContactView = (left: ContactMessagesView, right: ContactMessagesView) => (
  left.generation === right.generation
  && left.revision === right.revision
  && left.olderCursor === right.olderCursor
  && left.olderComplete === right.olderComplete
  && left.hasMessageGap === right.hasMessageGap
  && left.gapCursor === right.gapCursor
  && left.messages === right.messages
  && left.liveWindowIDs === right.liveWindowIDs
  && left.gapRequestIDs === right.gapRequestIDs
  && left.gapTargetIDs === right.gapTargetIDs
);

type GapFillResult = {
  view: ContactMessagesView;
  /** True when a page failed; auto-continue must stop until reconcile/explicit retry. */
  failed: boolean;
  /** True when cursor advanced or gap closed this batch. */
  progressed: boolean;
};

/** cacheKey join → gapCursor that auto-fill must not retry until explicit/latest progress. */
const contactGapAutoBlockCursor = new Map<string, string>();
/** One in-flight gap fill per contact cache key (queryFn + auto/explicit share). */
const contactGapFillInFlight = new Map<string, Promise<GapFillResult>>();
const contactCacheKeyString = (cacheKey: readonly unknown[]) => cacheKey.join('\u0001');

/** Test-only: drop auto-block + in-flight fill promises left by aborted suites. */
export const resetAssistantContactGapFillStateForTests = () => {
  contactGapAutoBlockCursor.clear();
  contactGapFillInFlight.clear();
};

/**
 * Fill slide gaps toward older. Commits each successful page immediately.
 * At most CONTACT_GAP_FILL_MAX_PAGES per call; stops on failure or no cursor progress.
 */
const fillContactGap = async (
  assistantID: string,
  cacheKey: ReturnType<typeof key.contact>,
  start: ContactMessagesView,
  fence: { transport: string; runtimeGeneration: number },
  signal?: AbortSignal,
): Promise<GapFillResult> => {
  const keyStr = contactCacheKeyString(cacheKey);
  const existing = contactGapFillInFlight.get(keyStr);
  if (existing) return existing;

  const run = (async (): Promise<GapFillResult> => {
    let current = queryClient.getQueryData<ContactMessagesView>(cacheKey) ?? start;
    let pages = 0;
    let progressed = false;
    let failed = false;
    // Capture request identity (not earliest targets) — only this session may advance the cursor.
    const sessionRequestIDs = current.gapRequestIDs ? [...current.gapRequestIDs] : null;
    const sessionCursor = current.gapCursor;
    while (current.hasMessageGap && current.gapCursor && pages < CONTACT_GAP_FILL_MAX_PAGES) {
      if (signal?.aborted) break;
      assertCurrent(fence.transport, fence.runtimeGeneration);
      pages += 1;
      const cursorBefore = current.gapCursor;
      try {
        const page = await fetchContactPage(assistantID, {
          limit: CONTACT_MESSAGES_PAGE_DEFAULT,
          before: cursorBefore,
        }, signal);
        assertCurrent(fence.transport, fence.runtimeGeneration);
        const base = queryClient.getQueryData<ContactMessagesView>(cacheKey) ?? current;
        if (page.generation !== base.generation) {
          current = base;
          break;
        }
        const identityHeld = !sessionRequestIDs || Boolean(
          base.hasMessageGap
          && base.gapRequestIDs
          && base.gapRequestIDs.length === sessionRequestIDs.length
          && base.gapRequestIDs.every((id, index) => id === sessionRequestIDs[index]),
        );
        // Always merge; cursor advance only when request identity still matches.
        current = applyContactGapPage(base, page, sessionRequestIDs
          ? { requestIDs: sessionRequestIDs, cursor: sessionCursor }
          : undefined);
        queryClient.setQueryData(cacheKey, current);
        if (!identityHeld) {
          // Full slide replaced request identity mid-flight — keep merge, end this session.
          break;
        }
        if (!current.hasMessageGap) {
          progressed = true;
          break;
        }
        if (current.gapCursor && current.gapCursor !== cursorBefore) {
          progressed = true;
        } else {
          break;
        }
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) break;
        failed = true;
        current = queryClient.getQueryData<ContactMessagesView>(cacheKey) ?? current;
        break;
      }
    }
    return {
      view: queryClient.getQueryData<ContactMessagesView>(cacheKey) ?? current,
      failed,
      progressed,
    };
  })();

  contactGapFillInFlight.set(keyStr, run);
  try {
    return await run;
  } finally {
    if (contactGapFillInFlight.get(keyStr) === run) contactGapFillInFlight.delete(keyStr);
  }
};

export const assistantContactQueryOptions = (
  assistantID: string,
  transport = getRuntimeTransportIdentity(),
  runtimeGeneration = getRuntimeGeneration(),
  options: { reconcileInForeground?: boolean } = {},
) => ({
  queryKey: key.contact(assistantID, transport, runtimeGeneration),
  queryFn: async ({ signal }: { signal: AbortSignal }) => {
    assertCurrent(transport, runtimeGeneration);
    await waitForSessionStartupBarrier();
    assertCurrent(transport, runtimeGeneration);
    const cacheKey = key.contact(assistantID, transport, runtimeGeneration);
    // Capture before the network wait so concurrent older commits are re-read at apply time.
    const previousAtStart = queryClient.getQueryData<ContactMessagesView>(cacheKey);
    const page = await fetchContactPage(assistantID, { limit: CONTACT_MESSAGES_PAGE_DEFAULT }, signal);
    assertCurrent(transport, runtimeGeneration);
    const base = queryClient.getQueryData<ContactMessagesView>(cacheKey) ?? previousAtStart ?? null;
    let next = applyContactLatestPage(base, page);
    queryClient.setQueryData(cacheKey, next);
    const keyStr = contactCacheKeyString(cacheKey);
    if (next.hasMessageGap && next.gapCursor) {
      // A successful latest pull may resume auto-fill from a prior failure.
      contactGapAutoBlockCursor.delete(keyStr);
      const filled = await fillContactGap(
        assistantID,
        cacheKey,
        next,
        { transport, runtimeGeneration },
        signal,
      );
      next = filled.view;
      if (filled.failed || (filled.view.hasMessageGap && !filled.progressed)) {
        if (filled.view.gapCursor) contactGapAutoBlockCursor.set(keyStr, filled.view.gapCursor);
      }
    } else {
      contactGapAutoBlockCursor.delete(keyStr);
    }
    assertCurrent(transport, runtimeGeneration);
    const committed = queryClient.getQueryData<ContactMessagesView>(cacheKey) ?? next;
    if (previousAtStart && sameContactView(previousAtStart, committed)) return previousAtStart;
    return committed;
  },
  retry: 2,
  refetchInterval: () => {
    if (!options.reconcileInForeground) return false as const;
    const snapshot = queryClient.getQueryData<AssistantSnapshot>(key.snapshot(transport));
    return foregroundReconcileIntervalMs(snapshot, { assistantID });
  },
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: true as const,
  refetchOnReconnect: true as const,
  structuralSharing: true,
});

export type AssistantContactMessagesQueryResult = {
  data: {
    messages: AssistantContactMessage[];
    generation: number;
    revision: number;
    nextCursor: string | null;
    complete: boolean;
  } | undefined;
  status: 'pending' | 'error' | 'success';
  fetchStatus: 'fetching' | 'paused' | 'idle';
  isError: boolean;
  isPending: boolean;
  isFetching: boolean;
  isSuccess: boolean;
  error: Error | null;
  refetch: () => Promise<unknown>;
  fetchPreviousPage: () => Promise<unknown>;
  hasPreviousPage: boolean;
  isFetchingPreviousPage: boolean;
  previousPageError: Error | null;
  hasMessageGap: boolean;
  isFillingMessageGap: boolean;
  retryMessageGap: () => Promise<unknown>;
};

export const useAssistantContactMessagesQuery = (assistantID: string, enabled = true): AssistantContactMessagesQueryResult => {
  const transport = getRuntimeTransportIdentity();
  const runtimeGeneration = getRuntimeGeneration();
  const [isFetchingPreviousPage, setIsFetchingPreviousPage] = React.useState(false);
  const [previousPageError, setPreviousPageError] = React.useState<Error | null>(null);
  const [isFillingMessageGap, setIsFillingMessageGap] = React.useState(false);
  const olderInFlight = React.useRef<Promise<unknown> | null>(null);
  const gapInFlight = React.useRef<Promise<unknown> | null>(null);
  const gapAbortRef = React.useRef<AbortController | null>(null);
  const olderAbortRef = React.useRef<AbortController | null>(null);
  const scopeRef = React.useRef({ assistantID, transport, runtimeGeneration, enabled });
  scopeRef.current = { assistantID, transport, runtimeGeneration, enabled };

  const query = useQuery({
    ...assistantContactQueryOptions(assistantID, transport, runtimeGeneration, { reconcileInForeground: true }),
    enabled: enabled && Boolean(assistantID),
  });

  React.useEffect(() => subscribeOpenchamberEvents((event) => {
    if (getRuntimeTransportIdentity() !== transport) return;
    if (
      event.type !== 'assistants-changed'
      && event.type !== 'event-stream-ready'
      && event.type !== 'contact-turn-end'
    ) return;
    if (
      (event.type === 'contact-turn-end')
      && 'assistantID' in event
      && event.assistantID !== assistantID
    ) return;
    void queryClient.invalidateQueries({ queryKey: key.contact(assistantID, transport, runtimeGeneration), exact: true });
  }), [assistantID, runtimeGeneration, transport]);

  // Drop in-flight older/gap work on assistant / runtime / disable so late responses cannot commit.
  React.useEffect(() => {
    const keyStr = contactCacheKeyString(key.contact(assistantID, transport, runtimeGeneration));
    return () => {
      gapAbortRef.current?.abort();
      olderAbortRef.current?.abort();
      gapAbortRef.current = null;
      olderAbortRef.current = null;
      olderInFlight.current = null;
      gapInFlight.current = null;
      contactGapAutoBlockCursor.delete(keyStr);
    };
  }, [assistantID, transport, runtimeGeneration, enabled]);

  const view = query.data;
  const cacheKey = key.contact(assistantID, transport, runtimeGeneration);

  const fetchPreviousPage = async () => {
    if (!assistantID || !enabled) return;
    if (olderInFlight.current) return olderInFlight.current;
    const current = queryClient.getQueryData<ContactMessagesView>(cacheKey) ?? view;
    if (!current || current.olderComplete || !current.olderCursor) return;
    setPreviousPageError(null);
    setIsFetchingPreviousPage(true);
    const controller = new AbortController();
    olderAbortRef.current?.abort();
    olderAbortRef.current = controller;
    const captured = { transport, runtimeGeneration, assistantID, cursor: current.olderCursor };
    const run = (async () => {
      try {
        assertCurrent(captured.transport, captured.runtimeGeneration);
        const page = await fetchContactPage(captured.assistantID, {
          limit: CONTACT_MESSAGES_PAGE_DEFAULT,
          before: captured.cursor,
        }, controller.signal);
        if (controller.signal.aborted) return;
        assertCurrent(captured.transport, captured.runtimeGeneration);
        if (
          scopeRef.current.assistantID !== captured.assistantID
          || scopeRef.current.transport !== captured.transport
          || scopeRef.current.runtimeGeneration !== captured.runtimeGeneration
        ) return;
        const base = queryClient.getQueryData<ContactMessagesView>(cacheKey) ?? current;
        // Older pages never open a new generation — discard mismatched gen.
        if (page.generation !== base.generation) return;
        queryClient.setQueryData(cacheKey, applyContactOlderPage(base, page));
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) return;
        const next = error instanceof Error ? error : new Error(String(error));
        setPreviousPageError(next);
        throw next;
      } finally {
        if (olderAbortRef.current === controller) olderAbortRef.current = null;
        setIsFetchingPreviousPage(false);
        olderInFlight.current = null;
      }
    })();
    olderInFlight.current = run;
    return run;
  };

  const retryMessageGap = async (origin: 'auto' | 'explicit' = 'explicit') => {
    if (!assistantID || !enabled) return;
    if (gapInFlight.current) return gapInFlight.current;
    const current = queryClient.getQueryData<ContactMessagesView>(cacheKey) ?? view;
    if (!current?.hasMessageGap || !current.gapCursor) return;
    const keyStr = contactCacheKeyString(cacheKey);
    if (origin === 'auto' && contactGapAutoBlockCursor.get(keyStr) === current.gapCursor) return;
    if (origin === 'explicit') contactGapAutoBlockCursor.delete(keyStr);
    setIsFillingMessageGap(true);
    const controller = new AbortController();
    gapAbortRef.current?.abort();
    gapAbortRef.current = controller;
    const captured = { transport, runtimeGeneration, assistantID, cursor: current.gapCursor };
    const run = (async () => {
      try {
        assertCurrent(captured.transport, captured.runtimeGeneration);
        const result = await fillContactGap(
          captured.assistantID,
          cacheKey,
          current,
          { transport: captured.transport, runtimeGeneration: captured.runtimeGeneration },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        assertCurrent(captured.transport, captured.runtimeGeneration);
        if (result.failed || !result.progressed) {
          if (result.view.gapCursor) contactGapAutoBlockCursor.set(keyStr, result.view.gapCursor);
          return;
        }
        if (!result.view.hasMessageGap) contactGapAutoBlockCursor.delete(keyStr);
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) return;
        contactGapAutoBlockCursor.set(keyStr, captured.cursor);
        throw error;
      } finally {
        if (gapAbortRef.current === controller) gapAbortRef.current = null;
        setIsFillingMessageGap(false);
        gapInFlight.current = null;
      }
    })();
    gapInFlight.current = run;
    return run;
  };

  // Auto-continue when cursor progressed; isFillingMessageGap is a real gate (avoid overlapping fills).
  React.useEffect(() => {
    if (!enabled || !assistantID || !view?.hasMessageGap || !view.gapCursor) return;
    if (query.isFetching || isFillingMessageGap) return;
    const keyStr = contactCacheKeyString(cacheKey);
    if (contactGapAutoBlockCursor.get(keyStr) === view.gapCursor) return;
    void retryMessageGap('auto').catch(() => undefined);
  }, [enabled, assistantID, view?.hasMessageGap, view?.gapCursor, query.isFetching, isFillingMessageGap, cacheKey]);

  const data = view
    ? {
      messages: view.messages,
      generation: view.generation,
      revision: view.revision,
      nextCursor: view.olderCursor,
      complete: view.olderComplete,
    }
    : undefined;

  return {
    data,
    status: query.status,
    fetchStatus: query.fetchStatus,
    isError: query.isError,
    isPending: query.isPending,
    isFetching: query.isFetching,
    isSuccess: query.isSuccess,
    error: query.error instanceof Error ? query.error : query.error ? new Error(String(query.error)) : null,
    refetch: () => query.refetch(),
    fetchPreviousPage,
    hasPreviousPage: Boolean(view && !view.olderComplete && view.olderCursor),
    isFetchingPreviousPage,
    previousPageError,
    hasMessageGap: Boolean(view?.hasMessageGap),
    isFillingMessageGap,
    retryMessageGap: () => retryMessageGap('explicit'),
  };
};

/**
 * Uncertain admission (client timeout): exact messageID lookup — not a full page scan.
 */
export const confirmContactAdmissionByMessageID = async (
  assistantID: string,
  messageID: string,
): Promise<{ admitted: true; messageID: string; revision: number | null } | null> => {
  const transport = getRuntimeTransportIdentity();
  const generation = getRuntimeGeneration();
  await waitForSessionStartupBarrier();
  assertCurrent(transport, generation);
  const page = await fetchContactPage(assistantID, { messageID, limit: 1 });
  assertCurrent(transport, generation);
  const found = page.messages.some((message) => message.messageID === messageID && message.role === 'user');
  if (!found) return null;
  void queryClient.invalidateQueries({ queryKey: key.contact(assistantID, transport, generation), exact: true });
  void queryClient.invalidateQueries({ queryKey: key.snapshot(transport), exact: true });
  const snapshot = queryClient.getQueryData<AssistantSnapshot>(key.snapshot(transport));
  return {
    admitted: true,
    messageID,
    revision: page.revision ?? snapshot?.revision ?? null,
  };
};
export const assistantScheduledTasksQueryOptions = (
  assistantID: string,
  transport = getRuntimeTransportIdentity(),
  runtimeGeneration = getRuntimeGeneration(),
) => ({
  queryKey: key.scheduledTasks(assistantID, transport, runtimeGeneration),
  queryFn: async ({ signal }: { signal: AbortSignal }) => {
    assertCurrent(transport, runtimeGeneration);
    const page = parseAssistantScheduledTasksPage(await requestJSON<unknown>(`/api/openchamber/assistants/${encodeURIComponent(assistantID)}/scheduled-tasks`, { signal }));
    assertCurrent(transport, runtimeGeneration);
    return page;
  },
  refetchOnMount: 'always' as const,
  retry: (failureCount: number, error: Error) => !(error instanceof AssistantAPIError && error.status === 404) && failureCount < 2,
});
export const useAssistantScheduledTasksQuery = (assistantID: string, enabled = true) => {
  const transport = getRuntimeTransportIdentity();
  const runtimeGeneration = getRuntimeGeneration();
  return useQuery({
    ...assistantScheduledTasksQueryOptions(assistantID, transport, runtimeGeneration),
    enabled: enabled && Boolean(assistantID),
  });
};
export const globalScheduledTasksQueryOptions = (transport = getRuntimeTransportIdentity()) => ({
  queryKey: key.globalScheduledTasks(transport),
  queryFn: fetchGlobalScheduledTasks,
  refetchOnMount: 'always' as const,
});
export const useGlobalScheduledTasksQuery = (enabled = true) => useQuery({
  ...globalScheduledTasksQueryOptions(),
  enabled,
});
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
export const abortAssistantSession = async (assistantID: string, binding: Pick<SessionBinding, 'sessionID' | 'sessionGeneration'>): Promise<void> => { const transport = getRuntimeTransportIdentity(); const generation = getRuntimeGeneration(); await requestJSON<unknown>(`/api/openchamber/assistants/${encodeURIComponent(assistantID)}/session/abort`, jsonInit('POST', { sessionID: binding.sessionID, sessionGeneration: binding.sessionGeneration })); assertCurrent(transport, generation); void queryClient.invalidateQueries({ queryKey: key.snapshot(transport), exact: true }); };
export const sendAssistantMessage = async (assistantID: string, binding: SessionBinding, messageID: string, parts: AssistantPart[], source: AssistantSource = 'composer'): Promise<MessageAdmission> => { const transport = getRuntimeTransportIdentity(); const generation = getRuntimeGeneration(); const result = parseMessageAdmission(await requestJSON<unknown>(`/api/openchamber/assistants/${encodeURIComponent(assistantID)}/messages`, jsonInit('POST', { sessionID: binding.sessionID, sessionGeneration: binding.sessionGeneration, messageID, parts, source, language: useI18nStore.getState().locale }))); assertCurrent(transport, generation); applyBinding(assistantID, result.binding, transport); invalidateContact(assistantID, transport); return result; };
/** Contact composer send parts: text or full file union (inline url or attachment descriptor). */
export type AssistantContactSendPart =
  | { type: 'text'; text: string }
  | AssistantContactFilePart;
/** Bounds message persistence/admission; generation continues after the 202 response. */
export const CONTACT_SEND_TIMEOUT_MS = 15_000;
export const mapContactSendFailure = (error: unknown): never => {
  if (error instanceof AssistantAPIError) throw error;
  if (isAbortError(error)) throw new AssistantAPIError('admission_timeout', 408);
  throw error;
};
export const sendAssistantContactMessage = async (
  assistantID: string,
  messageID: string,
  input: string | { text?: string; parts?: AssistantContactSendPart[] },
): Promise<MessageAdmission> => {
  const transport = getRuntimeTransportIdentity();
  const generation = getRuntimeGeneration();
  const parts = typeof input === 'string'
    ? [{ type: 'text' as const, text: input }]
    : Array.isArray(input.parts) && input.parts.length > 0
      ? input.parts
      : [{ type: 'text' as const, text: input.text ?? '' }];
  const signal = AbortSignal.timeout(CONTACT_SEND_TIMEOUT_MS);
  try {
    const result = parseMessageAdmission(await requestJSON<unknown>(`/api/openchamber/assistants/${encodeURIComponent(assistantID)}/messages`, { ...jsonInit('POST', { messageID, parts, language: useI18nStore.getState().locale }), signal }));
    assertCurrent(transport, generation);
    applyBinding(assistantID, result.binding, transport);
    invalidateContact(assistantID, transport);
    return result;
  } catch (error) {
    return mapContactSendFailure(error);
  }
};
export const appendAssistantContactCard = async (
  assistantID: string,
  card: Pick<AssistantContactSessionCardPart, 'sessionID' | 'directory'> & Partial<Pick<AssistantContactSessionCardPart, 'title' | 'status'>>,
): Promise<AssistantContactCardPart> => {
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

export const markAssistantContactRead = async (assistantID: string, position: AssistantReadPosition) => {
  const transport = getRuntimeTransportIdentity();
  const generation = getRuntimeGeneration();
  const captured = parseAssistantReadPosition(position);
  try {
    const result = parseAssistantReadResponse(await requestJSON<unknown>(
      `/api/openchamber/assistants/${encodeURIComponent(assistantID)}/contact/read`,
      { ...jsonInit('POST', captured), signal: AbortSignal.timeout(15_000) },
    ));
    assertCurrent(transport, generation);
    if (result.assistantID !== assistantID) throw new AssistantAPIError('invalid_assistant_read_response', 200);
    // Complete GET snapshots own catalog counts and revisions across concurrent reads.
    return result;
  } finally {
    if (getRuntimeTransportIdentity() === transport && getRuntimeGeneration() === generation) {
      void queryClient.invalidateQueries({ queryKey: key.snapshot(transport), exact: true });
    }
  }
};

export const markAllAssistantsRead = async (snapshot: AssistantSnapshot) => {
  const targets = snapshot.assistants.filter((assistant) => (assistant.unreadCount ?? 0) > 0 && assistant.readTip)
    .map((assistant) => ({ id: assistant.id, position: { ...assistant.readTip! } }));
  const transport = getRuntimeTransportIdentity();
  const generation = getRuntimeGeneration();
  const results: PromiseSettledResult<unknown>[] = [];
  // Bounded fanout; every target keeps its click-time watermark across batches.
  for (let index = 0; index < targets.length; index += 4) {
    results.push(...await Promise.allSettled(targets.slice(index, index + 4).map(async (target) => {
      assertCurrent(transport, generation);
      return markAssistantContactRead(target.id, target.position);
    })));
  }
  return { failed: results.filter((result) => result.status === 'rejected').length };
};
