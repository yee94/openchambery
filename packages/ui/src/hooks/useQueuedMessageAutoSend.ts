import React from 'react';
import { flushMessageQueuePersistence, useMessageQueueStore, queueScopeKey, type QueueItem, type QueueScope, type QueuedMessage } from '@/stores/messageQueueStore';
import { notifyConfirmedMessageSent, useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import { useConfigStore } from '@/stores/useConfigStore';
import { useAutoReviewStore } from '@/stores/useAutoReviewStore';
import { useChildStoreManager, useScopedSessionStatusReader, useScopedSessionStatusRevision } from '@/sync/sync-context';
import type { ScopedSessionStatus } from '@/sync/scoped-session-status';
import { getRuntimeGeneration, getRuntimeKey, getRuntimeTransportIdentity, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { fetchRecentSendConfirmationRecords, getSendFailureKind, releaseUnconfirmedQueueSend } from '@/sync/session-actions';
import { ascendingIdAfter } from '@/sync/message-id';
import { getSyncMessages } from '@/sync/sync-refs';
import { serializeComposerDocument } from '@/composer/document';
import { buildComposerSemanticParts, dedupeDeliveryAttachments } from '@/composer/delivery';
import { queryClient } from '@/lib/queryRuntime';
import { readInstalledSkillsSnapshot } from '@/queries/installedSkillsQueries';
import { compileChatComposerDelivery, legacyTextToAuthoredPlan } from '@/components/chat/chatComposerDelivery';
import { resolveQueueSendConfig } from '@/components/chat/queueAdmission';
type SessionStatusType = ScopedSessionStatus;
export type QueuedMessageOwnershipGate = 'blocked' | 'legacy-enabled';
let ownershipGate: QueuedMessageOwnershipGate = 'blocked';
const ownershipGateListeners = new Set<() => void>();
export const getQueuedMessageOwnershipGate = (): QueuedMessageOwnershipGate => ownershipGate;
export const setQueuedMessageOwnershipGate = (next: QueuedMessageOwnershipGate): void => {
  if (ownershipGate === next) return;
  ownershipGate = next;
  for (const listener of ownershipGateListeners) listener();
};
export const subscribeQueuedMessageOwnershipGate = (listener: () => void) => {
  ownershipGateListeners.add(listener);
  return () => ownershipGateListeners.delete(listener);
};
const legacyDispatchEnabled = () => ownershipGate === 'legacy-enabled';
const RETRY_BASE = 2000; const RETRY_MAX = 60000; const RECONCILIATION_QUERY_DEADLINE_MS = 5000; const MAX_RECONCILIATION_CHECKS = 3;
export const getQueuedAutoSendRetryDelayMs = (failures: number) => Math.min(RETRY_BASE * 2 ** Math.max(failures - 1, 0), RETRY_MAX);
const dispatchFlights = new Map<string, Promise<void>>();
const dispatchScopeFlights = new Map<string, Promise<void>>();
const reconciliationFlights = new Set<Promise<void>>();
const dispatchFlightListeners = new Set<() => void>();
let dispatchFlightRevision = 0;
const notifyDispatchFlightChanged = () => {
  dispatchFlightRevision += 1;
  for (const listener of dispatchFlightListeners) listener();
};
const dispatchFlightKey = (scope: BoundScope, identity: Pick<QueueItem, 'queueItemID' | 'operationID'>) => JSON.stringify([queueScopeKey(scope), identity.queueItemID, identity.operationID]);
const dispatchScopeFlightKey = (scope: BoundScope) => `scope:${queueScopeKey(scope)}`;
const getDispatchFlightKeys = () => new Set([...dispatchFlights.keys(), ...dispatchScopeFlights.keys()]);
const subscribeDispatchFlights = (listener: () => void) => {
  dispatchFlightListeners.add(listener);
  return () => dispatchFlightListeners.delete(listener);
};
export const useQueueScopeDispatchFlight = (scope: BoundScope | null): boolean => React.useSyncExternalStore(
  subscribeDispatchFlights,
  () => scope ? dispatchScopeFlights.has(dispatchScopeFlightKey(scope)) : false,
  () => false,
);
export const getQueuedMessageFinalLedger = () => structuredClone(useMessageQueueStore.getState().queuedMessages);
export const quiesceQueuedMessageAutoSend = async (): Promise<Record<string, QueueItem[]>> => {
  setQueuedMessageOwnershipGate('blocked');
  while (dispatchFlights.size || dispatchScopeFlights.size || reconciliationFlights.size) {
    await Promise.allSettled([...new Set([...dispatchFlights.values(), ...dispatchScopeFlights.values(), ...reconciliationFlights])]);
  }
  flushMessageQueuePersistence();
  return getQueuedMessageFinalLedger();
};
type QueueHeadPlan = { dispatch?: boolean; query?: boolean; resolve?: boolean; recover?: boolean; nextWakeAt?: number };
const isAuthoritativeIdle = (status: SessionStatusType): boolean => status === 'idle';
export type QueueTurnState = 'settled' | 'unsettled' | 'unknown';
type QueueTurnMessage = { role?: string; time?: { created?: number; completed?: number } };
export const getTrailingQueueTurnState = (messages: readonly QueueTurnMessage[] | undefined): QueueTurnState => {
  if (messages === undefined) return 'unknown';
  const last = messages[messages.length - 1];
  if (!last) return 'settled';
  // Trailing assistant: authoritative idle already means the prior turn finished.
  // Waiting for time.completed only adds a visible drain gap after session.idle.
  // Trailing user must stay unsettled so the next head cannot race the just-sent turn.
  if (last.role === 'assistant') return 'settled';
  return 'unsettled';
};

export const planQueueHead = (item: QueueItem | undefined, status: SessionStatusType, _previous: SessionStatusType | undefined, now: number, isInFlight = false, turnState: QueueTurnState = 'settled'): QueueHeadPlan => {
  if (!item) return {};
  // Abandoned in-flight POSTs must re-enter reconciliation; v4 does the same.
  if (item.status === 'sending') return isInFlight ? {} : { recover: true };
  if (item.status === 'queued') return isAuthoritativeIdle(status) && turnState !== 'unsettled' ? { dispatch: true } : {};
  if (item.status === 'retrying') {
    if (item.nextAttemptAt && item.nextAttemptAt > now) return { nextWakeAt: item.nextAttemptAt };
    return isAuthoritativeIdle(status) && turnState !== 'unsettled' ? { dispatch: true } : {};
  }
  if (item.status === 'reconciling') {
    const persistedChecks = item.reconciliationChecks ?? 0;
    if (persistedChecks >= MAX_RECONCILIATION_CHECKS || (item.reconciliationDeadlineAt ?? Infinity) <= now) return { resolve: true };
    if ((item.reconciliationNextCheckAt ?? 0) > now) return { nextWakeAt: item.reconciliationNextCheckAt };
    return isInFlight ? {} : { query: true };
  }
  return {};
};
export const shouldDispatchQueuedAutoSend = (previous: SessionStatusType | undefined, current: SessionStatusType, hasQueuedItems = false) => Boolean(planQueueHead(hasQueuedItems ? ({ status: 'queued' } as QueueItem) : undefined, current, previous, Date.now()).dispatch);
type PersistedAutoReviewRun = { status?: string; runtimeKey?: string };
export const getAutoReviewBlockedSessions = (runsByOriginalSessionID: Record<string, PersistedAutoReviewRun | undefined>, activeRuntimeKey: string): Set<string> => {
  const blockedSessions = new Set<string>();
  for (const [sessionID, run] of Object.entries(runsByOriginalSessionID)) {
    if (run?.status === 'running' && run.runtimeKey === activeRuntimeKey) blockedSessions.add(sessionID);
  }
  return blockedSessions;
};

type BoundScope = Extract<QueueScope, { state: 'bound' }>;
const latestMessageID = (sessionID: string, directory: string): string | undefined => {
  let latest: string | undefined;
  for (const message of getSyncMessages(sessionID, directory)) {
    const id = typeof message?.id === 'string' ? message.id : '';
    if (/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(id) && (!latest || id > latest)) latest = id;
  }
  return latest;
};
type QueryOperation = { scope: BoundScope; item: QueueItem; key: string };
type QueueSchedulerPlan = { dispatchScopes: BoundScope[]; queryOperations: QueryOperation[]; resolveOperations: QueryOperation[]; recoverOperations: QueryOperation[]; nextWakeAt?: number; inspectedScopeCount: number };
export const getQueueAbortBlockWakeAt = (blocks: Map<string, { expiresAt: number }>, now: number): number | undefined => {
  let nextWakeAt: number | undefined;
  for (const block of blocks.values()) if (block.expiresAt > now && (!nextWakeAt || block.expiresAt < nextWakeAt)) nextWakeAt = block.expiresAt;
  return nextWakeAt;
};
export const planQueueScheduler = ({ queuedMessages, activeTransportIdentity, getStatus, getTurnState = () => 'settled', previous, inFlight, dispatchInFlight = getDispatchFlightKeys(), blockedSessions, blockedScopeKeys = new Set<string>(), now }: { queuedMessages: Record<string, QueuedMessage[]>; activeTransportIdentity: string; getStatus: (scope: BoundScope) => SessionStatusType; getTurnState?: (scope: BoundScope) => QueueTurnState; previous: Map<string, SessionStatusType>; inFlight: Set<string>; dispatchInFlight?: Set<string>; blockedSessions: Set<string>; blockedScopeKeys?: Set<string>; now: number }): QueueSchedulerPlan => {
  const plan: QueueSchedulerPlan = { dispatchScopes: [], queryOperations: [], resolveOperations: [], recoverOperations: [], inspectedScopeCount: 0 };
  const liveKeys = new Set<string>();
  for (const [scopeKey, queue] of Object.entries(queuedMessages)) {
    const item = queue[0] as QueueItem | undefined; const scope = item?.owner;
    if (!item || scope?.state !== 'bound' || scope.transportIdentity !== activeTransportIdentity) continue;
    plan.inspectedScopeCount += 1;
    const key = `${scopeKey}:${item.queueItemID}`; const dispatchKey = dispatchFlightKey(scope, item); const scopeDispatchKey = dispatchScopeFlightKey(scope); liveKeys.add(key);
    const status = getStatus(scope); const headPlan = planQueueHead(item, status, previous.get(scopeKey), now, dispatchInFlight.has(dispatchKey), getTurnState(scope));
    previous.set(scopeKey, status);
    if (headPlan.nextWakeAt && (!plan.nextWakeAt || headPlan.nextWakeAt < plan.nextWakeAt)) plan.nextWakeAt = headPlan.nextWakeAt;
    if (headPlan.dispatch && !blockedSessions.has(scope.sessionID) && !blockedScopeKeys.has(queueScopeKey(scope)) && !dispatchInFlight.has(dispatchKey) && !dispatchInFlight.has(scopeDispatchKey)) plan.dispatchScopes.push(scope);
    if (headPlan.query && !inFlight.has(key)) plan.queryOperations.push({ scope, item, key });
    if (headPlan.resolve) plan.resolveOperations.push({ scope, item, key });
    if (headPlan.recover && !inFlight.has(key)) plan.recoverOperations.push({ scope, item, key });
  }
  for (const key of inFlight) if (!liveKeys.has(key)) inFlight.delete(key);
  for (const key of previous.keys()) if (!queuedMessages[key]) previous.delete(key);
  return plan;
};

export const buildQueuedAutoSendPayload = (queue: QueuedMessage[]) => {
  const queued = queue[0]; if (!queued) return null;
  const serialized = queued.composerDocument && serializeComposerDocument(queued.composerDocument, 'direct-send-display');
  const directory = queued.owner?.state === 'bound' ? queued.owner.directory : '';
  const compiled = compileChatComposerDelivery({
    plan: serialized?.ok ? { chunks: serialized.chunks ?? [], semantics: serialized.semantics ?? [] } : legacyTextToAuthoredPlan(queued.content),
    agents: useConfigStore.getState().getVisibleAgents(),
    installedSkillNames: new Set(readInstalledSkillsSnapshot(queryClient, directory).map((skill) => skill.name)),
    directory,
    root: directory,
    confirmedFilePaths: queued.composerMentions?.filter((mention) => mention.kind === 'file' || mention.kind === 'directory').map((mention) => mention.path || mention.value),
    confirmedDirectoryPaths: queued.composerMentions?.filter((mention) => mention.kind === 'directory').map((mention) => mention.path || mention.value),
    citationAttachments: queued.attachments,
  });
  const additionalParts = buildComposerSemanticParts(compiled.semantics, directory);
  return {
    queuedMessageId: queued.id,
    messageID: queued.messageID,
    operationID: queued.operationID,
    primaryText: compiled.text,
    primaryAttachments: dedupeDeliveryAttachments([...(queued.attachments ?? []), ...compiled.attachments]),
    agentMentionName: compiled.agent,
    additionalParts,
    sendConfig: queued.sendConfig,
  };
};
type Payload = NonNullable<ReturnType<typeof buildQueuedAutoSendPayload>>;
type Resolved = { providerID: string; modelID: string; agent?: string; variant?: string };
export const sendQueuedAutoSendPayload = (sessionId: string, payload: Payload, resolved: Resolved, options: { directory: string; delivery?: 'steer'; onSendConfirmed?: (messageID: string) => void }) => useSessionUIStore.getState().sendMessage(payload.primaryText, resolved.providerID, resolved.modelID, resolved.agent, payload.primaryAttachments, payload.agentMentionName, payload.additionalParts, resolved.variant, 'normal', { sessionId, directoryHint: options.directory, delivery: options.delivery, messageID: payload.messageID, preserveOptimisticOnAmbiguous: true, onSendConfirmed: options.onSendConfirmed });
const resolve = (sessionID: string, captured?: QueuedMessage['sendConfig']): Resolved => {
  if (captured) return { ...captured };
  return resolveQueueSendConfig({ currentConfig: useConfigStore.getState(), sessionID, selection: useSelectionStore.getState() }) ?? { providerID: '', modelID: '' };
};
export const queueScopeForSession = (sessionID: string): BoundScope | null => { const directory = useSessionUIStore.getState().getDirectoryForSession(sessionID); return directory ? { state: 'bound', transportIdentity: getRuntimeTransportIdentity(), directory, sessionID } : null; };

const canDispatchQueueStatus = (status: QueueItem['status'] | undefined, manual: boolean): boolean => {
  if (status === 'queued' || status === 'retrying') return true;
  if (manual && (status === 'failed' || status === 'unresolved')) return true;
  return false;
};
const isQueueItemLocked = (item: QueueItem): boolean => item.status === 'sending' || item.status === 'reconciling';

const findQueueItem = (store: ReturnType<typeof useMessageQueueStore.getState>, sessionID: string, queueItemID?: string, preferred?: BoundScope): { scope: BoundScope; item: QueueItem } | null => {
  if (!preferred || preferred.sessionID !== sessionID) return null;
  const queue = store.getQueueForScope(preferred) as QueueItem[];
  const item = queueItemID ? queue.find((candidate) => candidate.queueItemID === queueItemID || candidate.id === queueItemID) : queue[0];
  if (!item || item.owner?.state !== 'bound' || queueScopeKey(item.owner) !== queueScopeKey(preferred)) return null;
  return { scope: preferred, item };
};

export function dispatchQueuedMessage(sessionID: string, options: { delivery?: 'steer'; queueItemID?: string; scope?: BoundScope; manual?: boolean } = {}): Promise<void> {
  if (!legacyDispatchEnabled()) return Promise.resolve();
  const store = useMessageQueueStore.getState();
  const preferred = options.scope ?? queueScopeForSession(sessionID);
  const manual = options.manual === true || options.delivery === 'steer';
  if (!preferred || preferred.transportIdentity !== getRuntimeTransportIdentity()) return Promise.resolve();
  let located = findQueueItem(store, sessionID, options.queueItemID, preferred ?? undefined);
  if ((manual || !options.scope) && !dispatchScopeFlights.has(dispatchScopeFlightKey(preferred))) {
    const legacy = store.getQueueForScope({ state: 'unbound-legacy', sessionID }) as QueueItem[];
    const targetQueue = store.getQueueForScope(preferred) as QueueItem[];
    const legacyTarget = options.queueItemID ? legacy.find((item) => item.queueItemID === options.queueItemID || item.id === options.queueItemID) : legacy[0];
    if ((located || legacyTarget) && !legacy.some(isQueueItemLocked) && !targetQueue.some(isQueueItemLocked)) {
      store.bindLegacyQueue({ state: 'unbound-legacy', sessionID }, preferred);
      located = findQueueItem(store, sessionID, options.queueItemID, preferred);
    }
  }
  if (!located || located.scope.transportIdentity !== getRuntimeTransportIdentity()) return Promise.resolve();
  const scope = located.scope;
  if (scope.deliveryTarget?.kind === 'assistant') return Promise.resolve();
  let item = located.item;
  const identity = { queueItemID: item.queueItemID, operationID: item.operationID, messageID: item.messageID };
  const key = dispatchFlightKey(scope, identity); const existing = dispatchFlights.get(key);
  if (existing) return existing;
  if (dispatchScopeFlights.has(dispatchScopeFlightKey(scope))) return Promise.resolve();
  if (!canDispatchQueueStatus(item.status, manual)) return Promise.resolve();
  if (item.status === 'retrying' && !manual && (item.nextAttemptAt ?? 0) > Date.now()) return Promise.resolve();
  let settle: (() => void) | undefined;
  const flight = new Promise<void>((resolve) => { settle = resolve; });
  dispatchFlights.set(key, flight);
  dispatchScopeFlights.set(dispatchScopeFlightKey(scope), flight);
  notifyDispatchFlightChanged();
  void (async () => {
    try {
      const floorMessageID = latestMessageID(sessionID, scope.directory);
      const freshMessageID = ascendingIdAfter('msg', floorMessageID);
      const ready = store.beginQueueItemDispatch(scope, identity as Required<typeof identity>, freshMessageID, manual);
      if (!ready) return;
      item = ready;
      const freshIdentity = { queueItemID: ready.queueItemID, operationID: ready.operationID, messageID: ready.messageID };
      if (!flushMessageQueuePersistence()) {
        store.markQueueItemPreDispatchRetry(scope, freshIdentity, Date.now() + getQueuedAutoSendRetryDelayMs(ready.attemptCount + 1));
        return;
      }
      const generation = getRuntimeGeneration(); const payload = buildQueuedAutoSendPayload([ready]); if (!payload) return;
      const resolved = resolve(sessionID, ready.sendConfig);
      if (!resolved.providerID || !resolved.modelID) {
        store.markQueueItemPreDispatchRetry(scope, freshIdentity, Date.now() + getQueuedAutoSendRetryDelayMs(ready.attemptCount + 1));
        return;
      }
      if (!legacyDispatchEnabled()) { store.markQueueItemPreDispatchRetry(scope, freshIdentity, Date.now() + getQueuedAutoSendRetryDelayMs(ready.attemptCount + 1)); return; }
      const confirmationMatches = () => { const current = useMessageQueueStore.getState().getQueueForScope(scope)[0] as QueueItem | undefined; return getRuntimeTransportIdentity() === scope.transportIdentity && getRuntimeGeneration() === generation && current?.queueItemID === freshIdentity.queueItemID && current.operationID === freshIdentity.operationID && current.messageID === freshIdentity.messageID && queueScopeKey(current.owner) === queueScopeKey(scope); };
      const failureMatches = () => { const current = useMessageQueueStore.getState().getQueueForScope(scope)[0] as QueueItem | undefined; return current?.queueItemID === freshIdentity.queueItemID && current.operationID === freshIdentity.operationID && current.messageID === freshIdentity.messageID && queueScopeKey(current.owner) === queueScopeKey(scope); };
      const confirm = (messageID: string) => { if (confirmationMatches() && messageID === freshIdentity.messageID) useMessageQueueStore.getState().confirmQueueItem(scope, freshIdentity); };
      try { await sendQueuedAutoSendPayload(sessionID, payload, resolved, { directory: scope.directory, delivery: options.delivery, onSendConfirmed: confirm }); confirm(freshIdentity.messageID); }
      catch (error) { if (!failureMatches()) return; const kind = getSendFailureKind(error); if (kind === 'pre-dispatch') store.markQueueItemPreDispatchRetry(scope, freshIdentity, Date.now() + getQueuedAutoSendRetryDelayMs(ready.attemptCount + 1)); else if (kind === 'definitive-rejection') store.markQueueItemDefinitiveFailure(scope, freshIdentity); else store.markQueueItemReconciling(scope, freshIdentity); }
    } finally {
      let changed = false;
      if (dispatchFlights.get(key) === flight) {
        dispatchFlights.delete(key);
        changed = true;
      }
      if (dispatchScopeFlights.get(dispatchScopeFlightKey(scope)) === flight) {
        dispatchScopeFlights.delete(dispatchScopeFlightKey(scope));
        changed = true;
      }
      if (changed) {
        notifyDispatchFlightChanged();
      }
      settle?.();
    }
  })();
  return flight;
}

export async function reconcileQueuedMessage(operation: QueryOperation, generation = getRuntimeGeneration()): Promise<void> {
  if (!legacyDispatchEnabled()) return;
  const deadlineAt = Math.min(operation.item.reconciliationDeadlineAt ?? Infinity, Date.now() + RECONCILIATION_QUERY_DEADLINE_MS);
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), Math.max(0, deadlineAt - Date.now()));
  let records: Awaited<ReturnType<typeof fetchRecentSendConfirmationRecords>> = null;
  try { records = await fetchRecentSendConfirmationRecords(operation.scope.sessionID, operation.item.messageID, operation.scope.directory, { signal: controller.signal, timeoutMs: Math.max(0, deadlineAt - Date.now()) }); }
  catch { records = null; }
  finally { clearTimeout(timeout); }
  const current = useMessageQueueStore.getState().getQueueForScope(operation.scope)[0] as QueueItem | undefined;
  const matchesOperation = current?.queueItemID === operation.item.queueItemID
    && current.operationID === operation.item.operationID
    && current.messageID === operation.item.messageID
    && queueScopeKey(current.owner) === queueScopeKey(operation.scope)
    && getRuntimeTransportIdentity() === operation.scope.transportIdentity
    && getRuntimeGeneration() === generation;
  if (!matchesOperation) return;
  const matched = records?.some((record) => record.info.id === operation.item.messageID);
  if (matched) { notifyConfirmedMessageSent(operation.scope.sessionID, operation.item.messageID); useMessageQueueStore.getState().confirmQueueItem(operation.scope, { queueItemID: current.queueItemID, operationID: current.operationID, messageID: current.messageID }); }
  else useMessageQueueStore.getState().recordQueueItemReconciliationCheck(operation.scope, { queueItemID: operation.item.queueItemID, operationID: operation.item.operationID, messageID: operation.item.messageID });
}

const releaseUnresolvedQueueHead = (scope: BoundScope, item: QueueItem) => {
  releaseUnconfirmedQueueSend({
    sessionID: scope.sessionID,
    messageID: item.messageID,
    directory: scope.directory,
  });
  useMessageQueueStore.getState().resolveQueueItemReconciliation(scope, {
    queueItemID: item.queueItemID,
    operationID: item.operationID,
    messageID: item.messageID,
  });
};

export function useQueuedMessageAutoSend(enabledOrOptions?: boolean | { enabled?: boolean }) {
  const enabled = typeof enabledOrOptions === 'boolean' ? enabledOrOptions : enabledOrOptions?.enabled ?? true;
  const gate = React.useSyncExternalStore(subscribeQueuedMessageOwnershipGate, getQueuedMessageOwnershipGate, getQueuedMessageOwnershipGate);
  const queuedMessages = useMessageQueueStore((state) => state.queuedMessages); const runsByOriginalSessionID = useAutoReviewStore((state) => state.runsByOriginalSessionID);
  const queueAbortBlocks = useSessionUIStore((state) => state.queueAbortBlocks);
  const activeTransportIdentity = React.useSyncExternalStore(
    subscribeRuntimeEndpointChanged,
    getRuntimeTransportIdentity,
    getRuntimeTransportIdentity,
  );
  const activeRuntimeKey = React.useSyncExternalStore(
    subscribeRuntimeEndpointChanged,
    getRuntimeKey,
    getRuntimeKey,
  );
  const dispatchFlightState = React.useSyncExternalStore(subscribeDispatchFlights, () => dispatchFlightRevision, () => dispatchFlightRevision);
  const scopes = React.useMemo(() => Object.values(queuedMessages).flatMap((queue) => { const owner = queue[0]?.owner; return owner?.state === 'bound' && owner.transportIdentity === activeTransportIdentity ? [owner] : []; }), [activeTransportIdentity, queuedMessages]);
  const statusRevision = useScopedSessionStatusRevision(scopes);
  const getScopedStatus = useScopedSessionStatusReader();
  const childStores = useChildStoreManager();
  const scopeKey = React.useMemo(() => scopes.map((scope) => `${scope.directory}\n${scope.sessionID}`).join('\u0000'), [scopes]);
  const scopesRef = React.useRef(scopes);
  scopesRef.current = scopes;
  const messageCompletionRevision = React.useSyncExternalStore(
    React.useCallback((notify: () => void) => {
      if (!scopeKey) return () => undefined;
      const unsubs: Array<() => void> = [];
      const seen = new Set<string>();
      for (const scope of scopesRef.current) {
        if (seen.has(scope.directory)) continue;
        seen.add(scope.directory);
        const store = childStores.getChild(scope.directory);
        if (!store) continue;
        unsubs.push(store.subscribe((state, previous) => {
          for (const entry of scopesRef.current) {
            if (entry.directory !== scope.directory) continue;
            if (state.message?.[entry.sessionID] !== previous.message?.[entry.sessionID]) {
              notify();
              return;
            }
          }
        }));
      }
      const unsubRegistry = childStores.subscribeRegistry(() => notify());
      return () => {
        unsubRegistry();
        for (const unsub of unsubs) unsub();
      };
    }, [childStores, scopeKey]),
    React.useCallback(() => {
      if (!scopeKey) return '';
      return scopesRef.current.map((scope) => {
        const messages = childStores.getChild(scope.directory)?.getState().message?.[scope.sessionID] as Array<{ id?: string; role?: string; time?: { completed?: number } }> | undefined;
        const last = messages?.[messages.length - 1];
        return `${scope.sessionID}:${last?.id ?? ''}:${last?.role ?? ''}:${last?.time?.completed ?? ''}`;
      }).join('\u0000');
    }, [childStores, scopeKey]),
    () => '',
  );
  const getStatus = React.useCallback((scope: BoundScope): SessionStatusType => {
    return getScopedStatus(scope);
  }, [getScopedStatus]);
  const getTurnState = React.useCallback((scope: BoundScope): QueueTurnState => {
    return getTrailingQueueTurnState(childStores.getChild(scope.directory)?.getState().message?.[scope.sessionID]);
  }, [childStores]);
  const [wake, setWake] = React.useState(0); const previous = React.useRef(new Map<string, SessionStatusType>()); const reconciliationInFlight = React.useRef(new Set<string>());
  React.useEffect(() => {
    if (!enabled || gate !== 'legacy-enabled') return; const now = Date.now(); useSessionUIStore.getState().pruneQueueAbortBlocks(now); const blockedSessions = new Set<string>(); const blockedScopeKeys = new Set<string>();
    for (const [scopeKey, block] of queueAbortBlocks) if (block.expiresAt > now) blockedScopeKeys.add(scopeKey);
    // A running auto-review pauses only its matching stable runtime. Legacy
    // unkeyed records allow drain so persisted history cannot strand a queue.
    for (const sessionID of getAutoReviewBlockedSessions(runsByOriginalSessionID, activeRuntimeKey)) blockedSessions.add(sessionID);
    const schedule = planQueueScheduler({ queuedMessages, activeTransportIdentity, getStatus, getTurnState, previous: previous.current, inFlight: reconciliationInFlight.current, blockedSessions, blockedScopeKeys, now });
    for (const operation of schedule.recoverOperations) {
      useMessageQueueStore.getState().markQueueItemReconciling(operation.scope, {
        queueItemID: operation.item.queueItemID,
        operationID: operation.item.operationID,
        messageID: operation.item.messageID,
      });
    }
    for (const scope of schedule.dispatchScopes) {
      const head = useMessageQueueStore.getState().getQueueForScope(scope)[0] as QueueItem | undefined;
      if (!head) continue;
      void dispatchQueuedMessage(scope.sessionID, { scope }).finally(() => {
        setWake((value) => value + 1);
      });
    }
    for (const operation of schedule.resolveOperations) releaseUnresolvedQueueHead(operation.scope, operation.item);
    for (const operation of schedule.queryOperations) {
      reconciliationInFlight.current.add(operation.key);
      const generation = getRuntimeGeneration();
      const reconciliation = reconcileQueuedMessage(operation, generation).finally(() => {
        reconciliationInFlight.current.delete(operation.key);
        reconciliationFlights.delete(reconciliation);
        setWake((value) => value + 1);
      });
      reconciliationFlights.add(reconciliation);
    }
    const abortBlockWakeAt = getQueueAbortBlockWakeAt(queueAbortBlocks, now); const nextWakeAt = !schedule.nextWakeAt ? abortBlockWakeAt : !abortBlockWakeAt ? schedule.nextWakeAt : Math.min(schedule.nextWakeAt, abortBlockWakeAt);
    let timer: ReturnType<typeof setTimeout> | undefined; if (nextWakeAt) timer = setTimeout(() => { useSessionUIStore.getState().pruneQueueAbortBlocks(); setWake((value) => value + 1); }, Math.max(0, nextWakeAt - Date.now())); return () => { if (timer) clearTimeout(timer); };
  }, [activeRuntimeKey, activeTransportIdentity, childStores, dispatchFlightState, enabled, gate, queuedMessages, queueAbortBlocks, runsByOriginalSessionID, statusRevision, messageCompletionRevision, getStatus, getTurnState, wake]);
}
