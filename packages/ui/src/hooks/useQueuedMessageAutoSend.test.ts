import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { legacyQueueScope, queueScopeKey, setMessageQueueMutationFence, useMessageQueueStore, type QueueItem, type QueueScope } from '../stores/messageQueueStore';
let runtimeIdentity = 'runtime-a'; let runtimeKey = 'runtime-a'; let runtimeGeneration = 1; let send = () => Promise.resolve(); let calls = 0; let sendOptions: unknown; let confirmations = 0; let records: Array<{ info: { id: string } }> = []; let syncMessages: Array<{ id: string }> = []; let fetchRecords: (_sessionID: string, _messageID: string, _directory: string, options?: { signal?: AbortSignal; timeoutMs?: number }) => Promise<Array<{ info: { id: string } }> | null> = () => Promise.resolve(records); let failure: 'pre-dispatch' | 'ambiguous-dispatched' | 'definitive-rejection' = 'ambiguous-dispatched';
mock.module('@/sync/session-ui-store', () => ({ notifyConfirmedMessageSent: () => { confirmations += 1; }, useSessionUIStore: { getState: () => ({ sendMessage: (...args: unknown[]) => { calls += 1; sendOptions = args[9]; return send(); }, getDirectoryForSession: () => '/project', sessionAbortFlags: new Map() }) } }));
mock.module('@/lib/runtime-switch', () => ({ getRuntimeTransportIdentity: () => runtimeIdentity, getRuntimeKey: () => runtimeKey, getRuntimeGeneration: () => runtimeGeneration, subscribeRuntimeEndpointChanged: () => () => {} }));
mock.module('@/sync/session-actions', () => ({ getSendFailureKind: () => failure, fetchRecentSendConfirmationRecords: (...args: [_sessionID: string, _messageID: string, _directory: string, options?: { signal?: AbortSignal; timeoutMs?: number }]) => fetchRecords(...args) }));
mock.module('@/stores/useConfigStore', () => ({ useConfigStore: { getState: () => ({ getVisibleAgents: () => [{ name: 'worker', mode: 'subagent' }] }) } }));
mock.module('@/sync/sync-refs', () => ({ getSyncMessages: () => syncMessages, getSyncSessions: () => [], getAllSyncSessionMap: () => new Map() }));
import { buildQueuedAutoSendPayload, dispatchQueuedMessage, getAutoReviewBlockedSessions, getQueueAbortBlockWakeAt, getQueuedAutoSendRetryDelayMs, getTrailingQueueTurnState, planQueueHead, planQueueScheduler, reconcileQueuedMessage, setQueuedMessageOwnershipGate } from './useQueuedMessageAutoSend';
const scope = (): Extract<QueueScope, { state: 'bound' }> => ({ state: 'bound', transportIdentity: runtimeIdentity, directory: '/project', sessionID: 'session-a' });
const originalBeginQueueItemDispatch = useMessageQueueStore.getState().beginQueueItemDispatch;
const reset = () => useMessageQueueStore.setState({ queuedMessages: {}, followUpBehavior: 'queue' });
const admit = (target: QueueScope, content = 'queued'): QueueItem => {
  const result = useMessageQueueStore.getState().addToQueue(target, { content, sendConfig: { providerID: 'p', modelID: 'm' } });
  if (!result.ok) throw new Error(result.reason);
  return result.item;
};
const add = () => admit(scope());
describe('queued dispatch and scheduler', () => {
  beforeEach(() => { setMessageQueueMutationFence('open'); reset(); useMessageQueueStore.getState().beginQueueItemDispatch = originalBeginQueueItemDispatch; setQueuedMessageOwnershipGate('legacy-enabled'); runtimeIdentity = 'runtime-a'; runtimeKey = 'runtime-a'; runtimeGeneration = 1; calls = 0; confirmations = 0; records = []; syncMessages = []; fetchRecords = () => Promise.resolve(records); sendOptions = undefined; send = () => Promise.resolve(); failure = 'ambiguous-dispatched'; });
  test('auto payload compiles legacy queue delivery references', () => {
    const item = admit(scope(), '@worker inspect @src/file.ts');
    const payload = buildQueuedAutoSendPayload([item]);
    expect(payload?.primaryText).toBe('@worker inspect @src/file.ts');
    expect(payload?.agentMentionName).toBe('worker');
    expect(payload?.primaryAttachments.map((attachment) => attachment.serverPath)).toEqual(['/project/src/file.ts']);
  });
  test('sends one scoped head with a fresh message ID', async () => { const item = add(); await dispatchQueuedMessage('session-a', { scope: scope() }); expect(calls).toBe(1); expect((sendOptions as { messageID?: string }).messageID! > item.messageID).toBe(true); expect(useMessageQueueStore.getState().getQueueForScope(scope())).toEqual([]); });
  test('ownership gate blocks dispatch before begin', async () => { const item = add(); setQueuedMessageOwnershipGate('blocked'); await dispatchQueuedMessage('session-a', { scope: scope() }); expect(calls).toBe(0); expect(useMessageQueueStore.getState().getQueueForScope(scope())[0]).toBe(item); });
  test('ownership gate blocks POST after begin and retains a retryable row', async () => { add(); const begin = useMessageQueueStore.getState().beginQueueItemDispatch; useMessageQueueStore.getState().beginQueueItemDispatch = (...args) => { const item = begin(...args); setQueuedMessageOwnershipGate('blocked'); return item; }; await dispatchQueuedMessage('session-a', { scope: scope() }); expect(calls).toBe(0); expect(useMessageQueueStore.getState().getQueueForScope(scope())[0]?.status).toBe('retrying'); });
  test('uses a fresh message ID above the latest synced assistant message', async () => { add(); const latest = 'msg_fe0000000000ABCDEFGHIJKLMN'; syncMessages = [{ id: latest }]; await dispatchQueuedMessage('session-a', { scope: scope() }); expect((sendOptions as { messageID?: string }).messageID! > latest).toBe(true); });
  test('dispatch routes a duplicate session ID through its owner directory and fresh message identity', async () => { const first = add(); const owner = { ...scope(), directory: '/other-project' }; const second = admit(owner); await dispatchQueuedMessage('session-a', { scope: owner }); expect(useMessageQueueStore.getState().getQueueForScope(scope())).toEqual([first]); expect(useMessageQueueStore.getState().getQueueForScope(owner)).toEqual([]); const sent = sendOptions as { directoryHint?: string; messageID?: string }; expect(sent.directoryHint).toBe(owner.directory); expect(sent.messageID! > second.messageID).toBe(true); });
  test('late ambiguous failure reconciles runtime A while preserving runtime B references', async () => { const aScope = scope(); const a = add(); runtimeIdentity = 'runtime-b'; runtimeGeneration = 2; const bScope = scope(); const b = add(); const bQueue = useMessageQueueStore.getState().getQueueForScope(bScope); runtimeIdentity = 'runtime-a'; runtimeGeneration = 1; send = () => { runtimeIdentity = 'runtime-b'; runtimeGeneration = 2; return Promise.reject(new Error('late')); }; await dispatchQueuedMessage('session-a', { scope: aScope }); expect(useMessageQueueStore.getState().getQueueForScope(bScope)).toBe(bQueue); expect(bQueue[0]).toBe(b); expect(useMessageQueueStore.getState().getQueueForScope(aScope)[0]?.status).toBe('reconciling'); expect(useMessageQueueStore.getState().getQueueForScope(aScope)[0]?.operationID).toBe(a.operationID); });
  test('late pre-dispatch failure retries runtime A with a fresh message ID', async () => { const aScope = scope(); const a = add(); runtimeIdentity = 'runtime-b'; runtimeGeneration = 2; const bScope = scope(); const b = add(); const bQueue = useMessageQueueStore.getState().getQueueForScope(bScope); runtimeIdentity = 'runtime-a'; runtimeGeneration = 1; failure = 'pre-dispatch'; send = () => { runtimeIdentity = 'runtime-b'; runtimeGeneration = 2; return Promise.reject(new Error('late')); }; await dispatchQueuedMessage('session-a', { scope: aScope }); expect(useMessageQueueStore.getState().getQueueForScope(bScope)).toBe(bQueue); expect(bQueue[0]).toBe(b); const retrying = useMessageQueueStore.getState().getQueueForScope(aScope)[0] as QueueItem; expect(retrying.status).toBe('retrying'); expect(retrying.messageID > a.messageID).toBe(true); });
  test('late definitive failure marks runtime A failed while preserving runtime B references', async () => { const aScope = scope(); add(); runtimeIdentity = 'runtime-b'; runtimeGeneration = 2; const bScope = scope(); const b = add(); const bQueue = useMessageQueueStore.getState().getQueueForScope(bScope); runtimeIdentity = 'runtime-a'; runtimeGeneration = 1; failure = 'definitive-rejection'; send = () => { runtimeIdentity = 'runtime-b'; runtimeGeneration = 2; return Promise.reject(new Error('late')); }; await dispatchQueuedMessage('session-a', { scope: aScope }); expect(useMessageQueueStore.getState().getQueueForScope(bScope)).toBe(bQueue); expect(bQueue[0]).toBe(b); expect(useMessageQueueStore.getState().getQueueForScope(aScope)[0]?.status).toBe('failed'); });
  test('planner dispatches authoritative idle queues and schedules one persisted reconciliation wake', () => { const item = add(); const retry = { ...item, queueItemID: 'retry', operationID: 'retry-op', messageID: 'retry-message', owner: { ...scope(), directory: '/retry' }, status: 'retrying' as const, nextAttemptAt: 20 }; const reconciling = { ...item, queueItemID: 'reconcile', operationID: 'reconcile-op', messageID: 'reconcile-message', owner: { ...scope(), directory: '/reconcile' }, status: 'reconciling' as const, reconciliationNextCheckAt: 30 }; const queues = { a: [item], b: [retry], c: [reconciling] }; const plan = planQueueScheduler({ queuedMessages: queues, activeTransportIdentity: runtimeIdentity, getStatus: () => 'idle', previous: new Map(), inFlight: new Set<string>(), blockedSessions: new Set<string>(), now: 10 }); expect(plan.dispatchScopes).toEqual([item.owner]); expect(plan.queryOperations).toHaveLength(0); expect(plan.nextWakeAt).toBe(20); expect(planQueueHead({ ...reconciling, reconciliationChecks: 3 }, 'idle', undefined, 10).resolve).toBe(true); expect(planQueueHead({ ...reconciling, reconciliationChecks: 0, reconciliationDeadlineAt: 10 }, 'idle', undefined, 10).resolve).toBe(true); expect(planQueueHead({ ...item, status: 'sending' }, 'idle', undefined, 10)).toEqual({ recover: true }); expect(planQueueHead({ ...item, status: 'sending' }, 'idle', undefined, 10, true)).toEqual({}); expect(planQueueHead(item, 'unknown', undefined, 10).dispatch).toBe(undefined); expect(planQueueHead(item, 'busy', undefined, 10).dispatch).toBe(undefined); });
  test('future retrying heads schedule their due wake and dispatch only after idle at the due time', () => {
    const item = { ...add(), status: 'retrying' as const, nextAttemptAt: 20 };
    const args = { queuedMessages: { scope: [item] }, activeTransportIdentity: runtimeIdentity, getStatus: () => 'busy' as const, previous: new Map(), inFlight: new Set<string>(), blockedSessions: new Set<string>() };
    const future = planQueueScheduler({ ...args, now: 10 });
    expect(future.nextWakeAt).toBe(20); expect(future.dispatchScopes).toEqual([]);
    const due = planQueueScheduler({ ...args, now: 20 });
    expect(due.dispatchScopes).toEqual([]);
    expect(planQueueScheduler({ ...args, getStatus: () => 'idle' as const, now: 20 }).dispatchScopes).toEqual([item.owner]);
  });
  test('planner recovers abandoned sending heads and keeps failed heads terminal', () => {
    const sending = { ...add(), status: 'sending' as const };
    const failed = { ...add(), queueItemID: 'failed', operationID: 'failed-op', messageID: 'failed-message', owner: { ...scope(), directory: '/failed' }, status: 'failed' as const };
    const plan = planQueueScheduler({
      queuedMessages: { sending: [sending], failed: [failed] },
      activeTransportIdentity: runtimeIdentity,
      getStatus: () => 'idle',
      previous: new Map(),
      inFlight: new Set(),
      blockedSessions: new Set(),
      now: 0,
    });
    expect(plan.recoverOperations).toHaveLength(1);
    expect(plan.recoverOperations[0]?.item.queueItemID).toBe(sending.queueItemID);
    expect(plan.dispatchScopes).toEqual([]);
  });
  test('a manual dispatch flight keeps its sending head out of recovery and reconciliation queries', async () => {
    add();
    let complete: (() => void) | undefined;
    send = () => new Promise<void>((resolve) => { complete = resolve; });
    const flight = dispatchQueuedMessage('session-a', { scope: scope(), manual: true });
    const sending = useMessageQueueStore.getState().getQueueForScope(scope())[0] as QueueItem;
    expect(sending.status).toBe('sending');
    const plan = planQueueScheduler({ queuedMessages: { scope: [sending] }, activeTransportIdentity: runtimeIdentity, getStatus: () => 'idle', previous: new Map(), inFlight: new Set(), blockedSessions: new Set(), now: Date.now() });
    expect(plan.recoverOperations).toEqual([]);
    expect(plan.queryOperations).toEqual([]);
    complete?.();
    await flight;
  });
  test('manual and automatic calls share one exact dispatch promise and POST', async () => {
    add();
    let complete: (() => void) | undefined;
    send = () => new Promise<void>((resolve) => { complete = resolve; });
    const manual = dispatchQueuedMessage('session-a', { scope: scope(), manual: true });
    const automatic = dispatchQueuedMessage('session-a', { scope: scope() });
    expect(automatic).toBe(manual);
    expect(calls).toBe(1);
    expect((sendOptions as { directoryHint?: string }).directoryHint).toBe(scope().directory);
    complete?.();
    await manual;
  });
  test('manual Send posts a later bound row and keeps the original head queued behind it', async () => {
    const first = add(); const second = add();
    await dispatchQueuedMessage('session-a', { scope: scope(), queueItemID: second.queueItemID, manual: true });
    expect(calls).toBe(1);
    expect(useMessageQueueStore.getState().getQueueForScope(scope()).map((item) => item.queueItemID)).toEqual([first.queueItemID]);
  });
  test('two rapid manual rows in one scope create one POST and retain the second target', async () => {
    add(); const second = add();
    let complete: (() => void) | undefined;
    send = () => new Promise<void>((resolve) => { complete = resolve; });
    const firstFlight = dispatchQueuedMessage('session-a', { scope: scope(), manual: true });
    const secondFlight = dispatchQueuedMessage('session-a', { scope: scope(), queueItemID: second.queueItemID, manual: true });
    expect(calls).toBe(1);
    expect(useMessageQueueStore.getState().getQueueForScope(scope()).some((item) => item.queueItemID === second.queueItemID)).toBe(true);
    complete?.();
    await Promise.all([firstFlight, secondFlight]);
  });
  test('pre-dispatch and definitive completion clear the dispatch flight with their durable states', async () => {
    const item = add();
    const identity = { queueItemID: item.queueItemID, operationID: item.operationID, messageID: item.messageID };
    useMessageQueueStore.getState().markQueueItemSendAttempt(scope(), identity);
    useMessageQueueStore.getState().markQueueItemDefinitiveFailure(scope(), identity);
    failure = 'definitive-rejection';
    send = () => Promise.reject(new Error('rejected'));
    await dispatchQueuedMessage('session-a', { scope: scope(), manual: true });
    let current = useMessageQueueStore.getState().getQueueForScope(scope())[0] as QueueItem;
    expect(current.status).toBe('failed');
    expect(planQueueScheduler({ queuedMessages: { scope: [current] }, activeTransportIdentity: runtimeIdentity, getStatus: () => 'idle', previous: new Map(), inFlight: new Set(), blockedSessions: new Set(), now: Date.now() }).recoverOperations).toEqual([]);
    failure = 'pre-dispatch';
    send = () => Promise.reject(new Error('before send'));
    await dispatchQueuedMessage('session-a', { scope: scope(), manual: true });
    current = useMessageQueueStore.getState().getQueueForScope(scope())[0] as QueueItem;
    expect(current.status).toBe('retrying');
    expect(current.messageID > identity.messageID).toBe(true);
    expect(planQueueScheduler({ queuedMessages: { scope: [current] }, activeTransportIdentity: runtimeIdentity, getStatus: () => 'idle', previous: new Map(), inFlight: new Set(), blockedSessions: new Set(), now: current.nextAttemptAt! }).dispatchScopes).toEqual([current.owner]);
  });
  test('dispatch flights keep equal IDs isolated by scope', async () => {
    const first = add();
    const otherScope = { ...scope(), directory: '/other-project', sessionID: 'session-b' };
    const second = admit(otherScope, 'other');
    useMessageQueueStore.setState({ queuedMessages: {
      [queueScopeKey(scope())]: [{ ...first, queueItemID: 'same', operationID: 'same-operation', messageID: 'same-message' }],
      [queueScopeKey(otherScope)]: [{ ...second, queueItemID: 'same', operationID: 'same-operation', messageID: 'same-message' }],
    } });
    let completeFirst: (() => void) | undefined; let completeSecond: (() => void) | undefined;
    send = () => new Promise<void>((resolve) => { if (completeFirst) completeSecond = resolve; else completeFirst = resolve; });
    const firstFlight = dispatchQueuedMessage('session-a', { scope: scope(), manual: true });
    const secondFlight = dispatchQueuedMessage('session-b', { scope: otherScope, manual: true });
    expect(firstFlight).not.toBe(secondFlight);
    expect(calls).toBe(2);
    completeFirst?.(); completeSecond?.();
    await Promise.all([firstFlight, secondFlight]);
  });
  test('a scope flight blocks the planner after confirmation until the POST promise settles', async () => {
    const first = add(); const second = add();
    let complete: (() => void) | undefined;
    send = () => new Promise<void>((resolve) => { complete = resolve; });
    const flight = dispatchQueuedMessage('session-a', { scope: scope(), manual: true });
    const confirmation = (sendOptions as { onSendConfirmed?: (messageID: string) => void }).onSendConfirmed;
    confirmation?.((useMessageQueueStore.getState().getQueueForScope(scope())[0] as QueueItem).messageID);
    const plan = planQueueScheduler({ queuedMessages: { scope: useMessageQueueStore.getState().getQueueForScope(scope()) }, activeTransportIdentity: runtimeIdentity, getStatus: () => 'idle', previous: new Map(), inFlight: new Set(), blockedSessions: new Set(), now: Date.now() });
    expect(first.queueItemID).toBeTruthy(); expect(plan.dispatchScopes).toEqual([]);
    expect(useMessageQueueStore.getState().getQueueForScope(scope())[0]?.queueItemID).toBe(second.queueItemID);
    await dispatchQueuedMessage('session-a', { scope: scope(), queueItemID: second.queueItemID, manual: true });
    expect(calls).toBe(1); expect(useMessageQueueStore.getState().getQueueForScope(scope())[0]?.queueItemID).toBe(second.queueItemID);
    complete?.();
    await flight;
    expect(planQueueScheduler({ queuedMessages: { scope: useMessageQueueStore.getState().getQueueForScope(scope()) }, activeTransportIdentity: runtimeIdentity, getStatus: () => 'idle', previous: new Map(), inFlight: new Set(), blockedSessions: new Set(), now: Date.now() }).dispatchScopes).toEqual([second.owner]);
  });
  test('current-runtime running auto-review blocks its authoritative idle queue', () => {
    const item = add();
    const blockedSessions = getAutoReviewBlockedSessions({ 'session-a': { status: 'running', runtimeKey: 'runtime-a' } }, runtimeKey);
    const plan = planQueueScheduler({ queuedMessages: { scope: [item] }, activeTransportIdentity: runtimeIdentity, getStatus: () => 'idle', previous: new Map(), inFlight: new Set(), blockedSessions, now: 0 });
    expect(plan.dispatchScopes).toEqual([]);
  });
  test('other-runtime running auto-review allows an authoritative idle queue', () => {
    const item = add();
    const blockedSessions = getAutoReviewBlockedSessions({ 'session-a': { status: 'running', runtimeKey: 'runtime-b' } }, runtimeKey);
    const plan = planQueueScheduler({ queuedMessages: { scope: [item] }, activeTransportIdentity: runtimeIdentity, getStatus: () => 'idle', previous: new Map(), inFlight: new Set(), blockedSessions, now: 0 });
    expect(plan.dispatchScopes).toEqual([item.owner]);
  });
  test('an abort block pauses only its exact queue scope', () => {
    const first = add();
    const otherScope = { ...scope(), directory: '/other-project' };
    const second = admit(otherScope, 'other');
    const plan = planQueueScheduler({
      queuedMessages: { [queueScopeKey(first.owner)]: [first], [queueScopeKey(otherScope)]: [second] },
      activeTransportIdentity: runtimeIdentity,
      getStatus: () => 'idle',
      previous: new Map(),
      inFlight: new Set(),
      blockedSessions: new Set(),
      blockedScopeKeys: new Set([queueScopeKey(first.owner)]),
      now: 0,
    });
    expect(plan.dispatchScopes).toEqual([second.owner]);
  });
  test('abort block expiry supplies a scheduler wake and restores planner eligibility', () => {
    const item = add();
    const blocks = new Map([[queueScopeKey(item.owner), { expiresAt: 2000 }]]);
    expect(getQueueAbortBlockWakeAt(blocks, 1000)).toBe(2000);
    expect(getQueueAbortBlockWakeAt(blocks, 2000)).toBe(undefined);
    const args = { queuedMessages: { scope: [item] }, activeTransportIdentity: runtimeIdentity, getStatus: () => 'idle' as const, previous: new Map(), inFlight: new Set<string>(), blockedSessions: new Set<string>(), now: 2000 };
    expect(planQueueScheduler({ ...args, blockedScopeKeys: new Set([queueScopeKey(item.owner)]) }).dispatchScopes).toEqual([]);
    expect(planQueueScheduler({ ...args, blockedScopeKeys: new Set() }).dispatchScopes).toEqual([item.owner]);
  });
  test('completed, stopped, error, and legacy unkeyed auto-review records allow an authoritative idle queue', () => {
    const item = add();
    for (const run of [{ status: 'completed', runtimeKey }, { status: 'stopped', runtimeKey }, { status: 'error', runtimeKey }, { status: 'running' }]) {
      const blockedSessions = getAutoReviewBlockedSessions({ 'session-a': run }, runtimeKey);
      const plan = planQueueScheduler({ queuedMessages: { scope: [item] }, activeTransportIdentity: runtimeIdentity, getStatus: () => 'idle', previous: new Map(), inFlight: new Set(), blockedSessions, now: 0 });
      expect(plan.dispatchScopes).toEqual([item.owner]);
    }
  });
  test('manual dispatch re-sends unresolved heads after reset', async () => {
    const item = add();
    const identity = { queueItemID: item.queueItemID, operationID: item.operationID, messageID: item.messageID };
    const actions = useMessageQueueStore.getState();
    actions.markQueueItemSendAttempt(scope(), identity);
    actions.markQueueItemReconciling(scope(), identity);
    actions.resolveQueueItemReconciliation(scope(), identity);
    expect(actions.getQueueForScope(scope())[0]?.status).toBe('unresolved');
    await dispatchQueuedMessage('session-a', { scope: scope(), manual: true });
    expect(calls).toBe(1);
    expect(useMessageQueueStore.getState().getQueueForScope(scope())).toEqual([]);
  });
  test('scheduler examines one head per 1000 scopes', () => { const queues: Record<string, QueueItem[]> = {}; for (let index = 0; index < 1000; index += 1) { const owner = { ...scope(), directory: `/project-${index}` }; queues[String(index)] = [{ ...add(), owner }]; } const plan = planQueueScheduler({ queuedMessages: queues, activeTransportIdentity: runtimeIdentity, getStatus: () => 'idle', previous: new Map(), inFlight: new Set(), blockedSessions: new Set(), now: 0 }); expect(plan.inspectedScopeCount).toBe(1000); expect(plan.dispatchScopes).toHaveLength(1000); });
  test('reconciling in-flight heads create neither queries nor wake timers', () => { const item = { ...add(), status: 'reconciling' as const }; const key = `scope:${item.queueItemID}`; const plan = planQueueScheduler({ queuedMessages: { scope: [item] }, activeTransportIdentity: runtimeIdentity, getStatus: () => 'idle', previous: new Map(), inFlight: new Set([key]), blockedSessions: new Set(), now: 0 }); expect(plan.queryOperations).toEqual([]); expect(plan.nextWakeAt).toBe(undefined); });
  test('reconciliation misses persist one next check and resolves after three checks without POST operations', () => { const item = add(); const identity = { queueItemID: item.queueItemID, operationID: item.operationID, messageID: item.messageID }; const actions = useMessageQueueStore.getState(); actions.markQueueItemSendAttempt(scope(), identity); actions.markQueueItemReconciling(scope(), identity); actions.recordQueueItemReconciliationCheck(scope(), identity); let current = actions.getQueueForScope(scope())[0] as QueueItem; let plan = planQueueScheduler({ queuedMessages: { scope: [current] }, activeTransportIdentity: runtimeIdentity, getStatus: () => 'idle', previous: new Map(), inFlight: new Set(), blockedSessions: new Set(), now: current.reconciliationNextCheckAt! - 1 }); expect(plan.queryOperations).toEqual([]); expect(plan.nextWakeAt).toBe(current.reconciliationNextCheckAt); actions.recordQueueItemReconciliationCheck(scope(), identity); actions.recordQueueItemReconciliationCheck(scope(), identity); current = actions.getQueueForScope(scope())[0] as QueueItem; plan = planQueueScheduler({ queuedMessages: { scope: [current] }, activeTransportIdentity: runtimeIdentity, getStatus: () => 'idle', previous: new Map(), inFlight: new Set(), blockedSessions: new Set(), now: Date.now() }); expect(plan.resolveOperations).toHaveLength(1); expect(plan.dispatchScopes).toEqual([]); });
  test('manual dispatch bulk binds and sends a later legacy row with a fresh message ID', async () => { admit(legacyQueueScope('session-a'), 'legacy-first'); const legacy = admit(legacyQueueScope('session-a'), 'legacy-second'); add(); await dispatchQueuedMessage('session-a', { delivery: 'steer', queueItemID: legacy.queueItemID }); expect(calls).toBe(1); expect((sendOptions as { messageID?: string }).messageID! > legacy.messageID).toBe(true); });
  test('an obsolete runtime manual legacy dispatch preserves its legacy owner and avoids POST', async () => {
    const staleScope = scope(); const legacyScope = legacyQueueScope('session-a'); const legacy = admit(legacyScope, 'legacy');
    runtimeIdentity = 'runtime-b'; runtimeGeneration = 2;
    await dispatchQueuedMessage('session-a', { scope: staleScope, queueItemID: legacy.queueItemID, manual: true });
    expect(calls).toBe(0); expect(useMessageQueueStore.getState().getQueueForScope(legacyScope)).toEqual([legacy]); expect(useMessageQueueStore.getState().getQueueForScope(staleScope)).toEqual([]);
  });
  test('a reconciling bound row keeps a manual legacy target in its legacy scope', async () => {
    const bound = add(); const legacyScope = legacyQueueScope('session-a'); const legacy = admit(legacyScope, 'legacy'); const actions = useMessageQueueStore.getState();
    actions.markQueueItemSendAttempt(scope(), bound); actions.markQueueItemReconciling(scope(), bound);
    await dispatchQueuedMessage('session-a', { scope: scope(), queueItemID: legacy.queueItemID, manual: true });
    expect(calls).toBe(0); expect(useMessageQueueStore.getState().getQueueForScope(legacyScope)).toEqual([legacy]);
  });
  test('a main-queue dispatch without an explicit scope binds and sends the legacy head', async () => {
    const legacy = admit(legacyQueueScope('session-a'), 'legacy');
    await dispatchQueuedMessage('session-a');
    expect(calls).toBe(1); expect((sendOptions as { messageID?: string }).messageID! > legacy.messageID).toBe(true); expect(useMessageQueueStore.getState().getQueueForScope(legacyQueueScope('session-a'))).toEqual([]);
  });
  test('scheduler skips legacy scopes', () => { const item = admit(legacyQueueScope('session-a'), 'legacy'); const plan = planQueueScheduler({ queuedMessages: { legacy: [item] }, activeTransportIdentity: runtimeIdentity, getStatus: () => 'idle', previous: new Map(), inFlight: new Set(), blockedSessions: new Set(), now: 0 }); expect(plan.inspectedScopeCount).toBe(0); expect(plan.queryOperations).toEqual([]); });
  test('reconciliation notifies then confirms one matching scoped item', async () => { const item = add(); useMessageQueueStore.getState().markQueueItemSendAttempt(scope(), item); useMessageQueueStore.getState().markQueueItemReconciling(scope(), item); records = [{ info: { id: item.messageID } }]; await reconcileQueuedMessage({ scope: scope(), item: useMessageQueueStore.getState().getQueueForScope(scope())[0] as QueueItem, key: 'key' }); expect(confirmations).toBe(1); expect(useMessageQueueStore.getState().getQueueForScope(scope())).toEqual([]); });
  test('reconciliation queries receive an AbortSignal and stop at the persisted deadline', async () => { const item = add(); const identity = { queueItemID: item.queueItemID, operationID: item.operationID, messageID: item.messageID }; const actions = useMessageQueueStore.getState(); actions.markQueueItemSendAttempt(scope(), identity); actions.markQueueItemReconciling(scope(), identity); const reconciling = actions.getQueueForScope(scope())[0] as QueueItem; const expired = { ...reconciling, reconciliationDeadlineAt: Date.now() }; useMessageQueueStore.setState({ queuedMessages: { [queueScopeKey(scope())]: [expired] } }); let signal: AbortSignal | undefined; let timeoutMs: number | undefined; fetchRecords = (_sessionID, _messageID, _directory, options) => new Promise((resolve) => { signal = options?.signal; timeoutMs = options?.timeoutMs; options?.signal?.addEventListener('abort', () => resolve(null), { once: true }); }); await reconcileQueuedMessage({ scope: scope(), item: expired, key: 'key' }); expect(signal).toBeDefined(); expect(signal?.aborted).toBe(true); expect(timeoutMs).toBe(0); });
  test('stale generation reconciliation misses preserve the item reference and reconciliation fields', async () => { const item = add(); const identity = { queueItemID: item.queueItemID, operationID: item.operationID, messageID: item.messageID }; const actions = useMessageQueueStore.getState(); actions.markQueueItemSendAttempt(scope(), identity); actions.markQueueItemReconciling(scope(), identity); const before = actions.getQueueForScope(scope())[0] as QueueItem; const reconciliation = { reconciliationStartedAt: before.reconciliationStartedAt, reconciliationDeadlineAt: before.reconciliationDeadlineAt, reconciliationChecks: before.reconciliationChecks, reconciliationNextCheckAt: before.reconciliationNextCheckAt }; fetchRecords = () => { runtimeGeneration = 2; return Promise.resolve([]); }; await reconcileQueuedMessage({ scope: scope(), item: before, key: 'key' }, 1); const after = actions.getQueueForScope(scope())[0] as QueueItem; expect(after).toBe(before); expect({ reconciliationStartedAt: after.reconciliationStartedAt, reconciliationDeadlineAt: after.reconciliationDeadlineAt, reconciliationChecks: after.reconciliationChecks, reconciliationNextCheckAt: after.reconciliationNextCheckAt }).toEqual(reconciliation); });
  test('backoff remains bounded', () => { expect(getQueuedAutoSendRetryDelayMs(1)).toBe(2000); expect(getQueuedAutoSendRetryDelayMs(100)).toBe(60000); });
  test('completed historical messages keep live busy status blocked until authoritative idle', () => {
    const item = add();
    expect(planQueueHead(item, 'busy', undefined, Date.now()).dispatch).toBe(undefined);
    expect(planQueueHead(item, 'idle', undefined, Date.now()).dispatch).toBe(true);
  });
  test('authoritative idle may dispatch while a trailing assistant still lacks time.completed', () => {
    const item = add();
    expect(getTrailingQueueTurnState([{ role: 'assistant', time: { created: 1 } }])).toBe('settled');
    expect(planQueueHead(item, 'idle', undefined, 0, false, 'settled').dispatch).toBe(true);
    expect(planQueueHead(item, 'busy', undefined, 0, false, 'settled').dispatch).toBe(undefined);
    expect(getTrailingQueueTurnState([{ role: 'assistant', time: { created: 1, completed: 2 } }])).toBe('settled');
  });
  test('a confirmed first queue item keeps the next idle head behind its trailing user turn', () => {
    const item = add();
    const args = { queuedMessages: { scope: [item] }, activeTransportIdentity: runtimeIdentity, getStatus: () => 'idle' as const, previous: new Map(), inFlight: new Set<string>(), blockedSessions: new Set<string>(), now: 0 };
    expect(planQueueScheduler({ ...args, getTurnState: () => getTrailingQueueTurnState([{ role: 'user' }]) }).dispatchScopes).toEqual([]);
    expect(planQueueScheduler({ ...args, getTurnState: () => getTrailingQueueTurnState([{ role: 'assistant', time: { completed: 2 } }]) }).dispatchScopes).toEqual([item.owner]);
    expect(planQueueScheduler({ ...args, getTurnState: () => getTrailingQueueTurnState([{ role: 'assistant', time: { created: 1 } }]) }).dispatchScopes).toEqual([item.owner]);
  });
  test('unknown message materialization allows idle dispatch while busy remains blocked', () => {
    const item = add();
    expect(getTrailingQueueTurnState(undefined)).toBe('unknown');
    expect(planQueueHead(item, 'idle', undefined, 0, false, 'unknown').dispatch).toBe(true);
    expect(planQueueHead(item, 'busy', undefined, 0, false, 'unknown').dispatch).toBe(undefined);
  });
  test('automatic dispatch leaves failed and unresolved heads untouched while manual Send posts once', async () => {
    const item = add();
    const identity = { queueItemID: item.queueItemID, operationID: item.operationID, messageID: item.messageID };
    const actions = useMessageQueueStore.getState();
    actions.markQueueItemSendAttempt(scope(), identity);
    actions.markQueueItemDefinitiveFailure(scope(), identity);
    await dispatchQueuedMessage('session-a', { scope: scope() });
    expect(calls).toBe(0);
    await dispatchQueuedMessage('session-a', { scope: scope(), manual: true });
    expect(calls).toBe(1);
  });
  test('a failed manually promoted row remains at the queue head', async () => {
    add(); const second = add();
    failure = 'definitive-rejection'; send = () => Promise.reject(new Error('rejected'));
    await dispatchQueuedMessage('session-a', { scope: scope(), queueItemID: second.queueItemID, manual: true });
    const head = useMessageQueueStore.getState().getQueueForScope(scope())[0] as QueueItem;
    expect(head.queueItemID).toBe(second.queueItemID); expect(head.status).toBe('failed');
  });
  test('exact scope lookup prevents a same-session queue in another directory from posting', async () => {
    const otherScope = { ...scope(), directory: '/other-project' };
    add();
    await dispatchQueuedMessage('session-a', { scope: otherScope });
    expect(calls).toBe(0);
  });
  test('a flight completion unlocks the next narrow scheduler pass', () => {
    const item = add();
    const dispatchInFlight = new Set([JSON.stringify([queueScopeKey(scope()), item.queueItemID, item.operationID])]);
    const args = { queuedMessages: { scope: [item] }, activeTransportIdentity: runtimeIdentity, getStatus: () => 'idle' as const, previous: new Map(), inFlight: new Set<string>(), dispatchInFlight, blockedSessions: new Set<string>(), now: Date.now() };
    expect(planQueueScheduler(args).dispatchScopes).toEqual([]);
    dispatchInFlight.delete(JSON.stringify([queueScopeKey(scope()), item.queueItemID, item.operationID]));
    expect(planQueueScheduler(args).dispatchScopes).toEqual([item.owner]);
  });
});
