import { admitTextQueueItem, editTextQueueItem, fetchMessageQueueScope, fetchMessageQueueServerStatus, fetchMessageQueueSnapshot, MessageQueueServerError, pauseMessageQueueAuthority, releaseMessageQueueItemEditReservation, removeQueueItem, removeReservedMessageQueueItem, reorderQueueScope, reserveMessageQueueItemForEdit, renewEditReservation, resumeMessageQueueAuthority, sendQueueItemNow, waitForMessageQueueInvalidation, type MessageQueueAdmissionItem, type MessageQueueEditReservation, type MessageQueueEditReservationRenewal, type MessageQueueItem, type MessageQueueScope, type MessageQueueScopeDescriptor } from '@/lib/message-queue-server';
import { queryClient } from '@/lib/queryRuntime';
import { getRuntimeGeneration, getRuntimeTransportIdentity, subscribeRuntimeEndpointChanged, isRuntimeEndpointIdentityChange } from '@/lib/runtime-switch';
import { clearMessageQueueScope, clearMessageQueueScopes, invalidateMessageQueueScope, readMessageQueueScope, replaceMessageQueueScope, replaceMessageQueueSnapshot, replaceMessageQueueStatus } from '@/queries/messageQueueQueries';
import { uploadQueueAttachments, type QueueAttachmentCandidate } from './message-queue-server-attachment-adapter';
import { getMessageQueueRuntime } from './message-queue-runtime';
import { createMessageQueueShadowImporter, type MessageQueueShadowImportState } from './message-queue-shadow-import';

export type MessageQueueServerCapability = 'idle' | 'available' | 'unsupported' | 'error';
export type MessageQueueServerScopeState = MessageQueueScopeDescriptor;
export type MessageQueueServerSurfaceState = { transportIdentity: string; scopes: ReadonlyMap<string, MessageQueueServerScopeState>; hydration: 'idle' | 'hydrating' | 'ready' | 'error'; capability: MessageQueueServerCapability; authority: string | undefined; isFetching: boolean; error: unknown; importState: MessageQueueShadowImportState };
export type MessageQueueServerRuntimeCapture = { transportIdentity: string; generation: number };
export type MessageQueueServerMutationResult = { status: 'committed' | 'stale'; scope?: MessageQueueScope };
export type MessageQueuePendingAdmissionPhase = 'uploading' | 'admitting' | 'ambiguous' | 'acknowledged';
export type MessageQueuePendingAdmissionItem = {
  kind: 'pending-admission'; requestID: string; queueItemID: string; operationID: string; messageID: string; content: string; createdAt: number; phase: MessageQueuePendingAdmissionPhase; attachmentCount: number;
  composerDocument?: MessageQueueAdmissionItem['composerDocument']; composerMentions?: MessageQueueAdmissionItem['composerMentions']; sendConfig?: MessageQueueAdmissionItem['sendConfig'];
};
export type MessageQueueServerDisplayItem = MessageQueueItem | MessageQueuePendingAdmissionItem;
export const isMessageQueuePendingAdmissionItem = (value: unknown): value is MessageQueuePendingAdmissionItem => typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'pending-admission';
export type MessageQueueServerSurface = { subscribe(listener: () => void): () => void; subscribeScope(scope: { transportIdentity: string; directory: string; sessionID: string }, listener: () => void): () => void; getState(): MessageQueueServerSurfaceState; getScope(scope: { transportIdentity: string; directory: string; sessionID: string }): MessageQueueScope | undefined; getPendingAdmissions(scope: { transportIdentity: string; directory: string; sessionID: string }): readonly MessageQueuePendingAdmissionItem[]; captureRuntime(): MessageQueueServerRuntimeCapture; start(): void; stop(): void; restart(): void; runShadowImport(): Promise<MessageQueueShadowImportState>; pause?(expectedGeneration: number): Promise<void>; resume?(expectedGeneration: number): Promise<void>; admit(input: { requestID: string; scope: { directory: string; sessionID: string }; item: Omit<MessageQueueAdmissionItem, 'attachments'>; attachments?: readonly QueueAttachmentCandidate[] }): Promise<MessageQueueServerMutationResult>; edit(input: { requestID: string; scopeID: string; revision: number; item: MessageQueueItem; patch: Parameters<typeof editTextQueueItem>[1]['item'] }): Promise<MessageQueueServerMutationResult>; remove(input: { requestID: string; scopeID: string; revision: number; item: MessageQueueItem }): Promise<MessageQueueServerMutationResult>; reserveEdit(input: { requestID: string; scopeID: string; revision: number; item: MessageQueueItem; owner: string; ttlMs: number; runtime: MessageQueueServerRuntimeCapture }): Promise<MessageQueueEditReservation | undefined>; renewEdit(input: { item: MessageQueueItem; token: string; generation: number; ttlMs: number; runtime: MessageQueueServerRuntimeCapture; signal?: AbortSignal }): Promise<MessageQueueEditReservationRenewal | undefined>; releaseEdit(input: { item: MessageQueueItem; token: string; runtime: MessageQueueServerRuntimeCapture }): Promise<void>; removeReserved(input: { requestID: string; scopeID: string; revision: number; item: MessageQueueItem; token: string; generation: number; runtime: MessageQueueServerRuntimeCapture }): Promise<boolean>; reorder(input: { requestID: string; scopeID: string; revision: number; queueItemIDs: string[] }): Promise<MessageQueueServerMutationResult>; manualSend(input: { requestID: string; scopeID: string; revision: number; item: MessageQueueItem }): Promise<MessageQueueServerMutationResult>; refresh(): Promise<void> };
type Client = Pick<typeof queryClient, 'setQueryData' | 'getQueryData' | 'removeQueries' | 'invalidateQueries'>;
type Dependencies = { snapshot: typeof fetchMessageQueueSnapshot; status: typeof fetchMessageQueueServerStatus; scope: typeof fetchMessageQueueScope; waitInvalidation: typeof waitForMessageQueueInvalidation; admit: typeof admitTextQueueItem; edit: typeof editTextQueueItem; remove: typeof removeQueueItem; reserve: typeof reserveMessageQueueItemForEdit; renew: typeof renewEditReservation; release: typeof releaseMessageQueueItemEditReservation; removeReserved: typeof removeReservedMessageQueueItem; reorder: typeof reorderQueueScope; manualSend: typeof sendQueueItemNow; upload: typeof uploadQueueAttachments; client: Client; capture: () => MessageQueueServerRuntimeCapture; current: (capture: MessageQueueServerRuntimeCapture) => boolean; legacyManualSend: (item: MessageQueueItem) => Promise<void>; shadowQueue: () => ReturnType<typeof getMessageQueueRuntime> };
const defaults: Dependencies = { snapshot: fetchMessageQueueSnapshot, status: fetchMessageQueueServerStatus, scope: fetchMessageQueueScope, waitInvalidation: waitForMessageQueueInvalidation, admit: admitTextQueueItem, edit: editTextQueueItem, remove: removeQueueItem, reserve: reserveMessageQueueItemForEdit, renew: renewEditReservation, release: releaseMessageQueueItemEditReservation, removeReserved: removeReservedMessageQueueItem, reorder: reorderQueueScope, manualSend: sendQueueItemNow, upload: uploadQueueAttachments, client: queryClient, capture: () => ({ transportIdentity: getRuntimeTransportIdentity(), generation: getRuntimeGeneration() }), current: (capture) => capture.transportIdentity === getRuntimeTransportIdentity() && capture.generation === getRuntimeGeneration(), legacyManualSend: async () => {}, shadowQueue: getMessageQueueRuntime };
const isConflict = (error: unknown) => error instanceof MessageQueueServerError && (error.code === 'revision_conflict' || error.code === 'row_version_conflict');
const scopeKey = (scope: { transportIdentity: string; directory: string; sessionID: string }) => `${scope.transportIdentity}\u0000${scope.directory}\u0000${scope.sessionID}`;
const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => { const timer = setTimeout(resolve, ms); signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });

export const createMessageQueueServerRuntime = (dependencies: Partial<Dependencies> = {}): MessageQueueServerSurface => {
  const deps = { ...defaults, ...dependencies };
  let state: MessageQueueServerSurfaceState = { transportIdentity: deps.capture().transportIdentity, scopes: new Map(), hydration: 'idle', capability: 'idle', authority: undefined, isFetching: false, error: undefined, importState: { status: 'idle', imported: 0, total: 0, issues: [], canActivate: false } };
  let controller: AbortController | undefined, users = 0, importFlight: Promise<MessageQueueShadowImportState> | undefined;
  const listeners = new Set<() => void>(), scopeListeners = new Map<string, Set<() => void>>();
  const scopeSnapshots = new Map<string, { revision: number; scope: MessageQueueScope }>();
  type PendingAdmission = MessageQueuePendingAdmissionItem & { acknowledgedRevision?: number };
  const pendingAdmissions = new Map<string, readonly PendingAdmission[]>();
  const EMPTY_PENDING_ADMISSIONS: readonly MessageQueuePendingAdmissionItem[] = [];
  const notifyScope = (key: string) => scopeListeners.get(key)?.forEach((listener) => listener());
  const updatePendingAdmissions = (key: string, update: (items: readonly PendingAdmission[]) => readonly PendingAdmission[]) => {
    const previous = pendingAdmissions.get(key) ?? EMPTY_PENDING_ADMISSIONS, next = update(previous);
    if (next === previous) return;
    if (next.length) pendingAdmissions.set(key, next); else pendingAdmissions.delete(key);
    notifyScope(key);
  };
  const publish = (next: Partial<MessageQueueServerSurfaceState>) => { state = { ...state, ...next }; listeners.forEach((listener) => listener()); if (!('scopes' in next)) scopeListeners.forEach((entries) => entries.forEach((listener) => listener())); };
  const isCaptureCurrent = (capture: MessageQueueServerRuntimeCapture) => {
    const current = deps.capture();
    return state.transportIdentity === capture.transportIdentity && current.transportIdentity === capture.transportIdentity && current.generation === capture.generation && deps.current(capture);
  };
  const resetForTransport = (capture: MessageQueueServerRuntimeCapture) => {
    const pendingScopeKeys = [...pendingAdmissions.keys()];
    controller?.abort(); controller = undefined; importFlight = undefined; scopeSnapshots.clear(); pendingAdmissions.clear();
    publish({ transportIdentity: capture.transportIdentity, scopes: new Map(), hydration: 'idle', capability: 'idle', authority: undefined, isFetching: false, error: undefined, importState: { status: 'idle', imported: 0, total: 0, issues: [], canActivate: false } });
    pendingScopeKeys.forEach(notifyScope);
  };
  const synchronizeTransport = () => {
    const capture = deps.capture();
    if (state.transportIdentity !== capture.transportIdentity) resetForTransport(capture);
    return capture;
  };
  const notifyScopes = (previous: ReadonlyMap<string, MessageQueueServerScopeState>, next: ReadonlyMap<string, MessageQueueServerScopeState>, transportIdentity: string) => {
    const keys = new Set([...previous.keys(), ...next.keys()]);
    for (const id of keys) {
      const before = previous.get(id), after = next.get(id);
      if (before?.revision === after?.revision && before?.directory === after?.directory && before?.sessionID === after?.sessionID) continue;
      const key = after ? scopeKey({ transportIdentity, directory: after.directory, sessionID: after.sessionID }) : before ? scopeKey({ transportIdentity, directory: before.directory, sessionID: before.sessionID }) : '';
      scopeListeners.get(key)?.forEach((listener) => listener());
    }
  };
  const setDescriptors = (descriptors: readonly MessageQueueScopeDescriptor[], capture: MessageQueueServerRuntimeCapture) => {
    if (!isCaptureCurrent(capture)) return;
    const previous = state.scopes, next = new Map(descriptors.map((descriptor) => [descriptor.scopeID, descriptor]));
    for (const [key, cached] of scopeSnapshots) if (next.get(cached.scope.scopeID)?.revision !== cached.revision) scopeSnapshots.delete(key);
    publish({ scopes: next }); notifyScopes(previous, next, capture.transportIdentity);
  };
  const loadScope = async (descriptor: MessageQueueScopeDescriptor, capture: MessageQueueServerRuntimeCapture, signal: AbortSignal, initialPage?: MessageQueueScope): Promise<MessageQueueScope> => {
    let offset = 0, expectedRevision: number | undefined, first: MessageQueueScope | undefined;
    const items: MessageQueueItem[] = [];
    do {
      const page = initialPage ?? await deps.scope(descriptor.scopeID, { offset, limit: 8, expectedRevision, signal });
      initialPage = undefined;
      if (!first) first = page;
      if (page.revision !== descriptor.revision || page.scopeID !== descriptor.scopeID || (expectedRevision !== undefined && page.revision !== expectedRevision)) throw new MessageQueueServerError(409, 'revision_conflict');
      items.push(...page.items); expectedRevision = page.revision; offset = page.nextOffset ?? -1;
    } while (offset >= 0);
    if (!first || items.length !== first.itemCount) throw new MessageQueueServerError(200, 'unavailable');
    return { ...first, items };
  };
  const descriptorForScope = (scope: MessageQueueScope): MessageQueueScopeDescriptor => ({ scopeID: scope.scopeID, revision: scope.revision, directory: scope.directory, sessionID: scope.sessionID, worktreeState: scope.worktreeState, itemCount: scope.itemCount });
  const currentWatermark = (capture: MessageQueueServerRuntimeCapture) => Math.max(
    deps.client.getQueryData<Awaited<ReturnType<typeof fetchMessageQueueSnapshot>>>([capture.transportIdentity, 'messageQueue', 'snapshot'])?.revision ?? 0,
    ...[...state.scopes.values()].map((descriptor) => descriptor.revision),
  );
  const commitScope = (complete: MessageQueueScope, capture: MessageQueueServerRuntimeCapture): MessageQueueScope | undefined => {
    if (!isCaptureCurrent(capture)) return undefined;
    const current = state.scopes.get(complete.scopeID);
    if (current && current.revision > complete.revision) return undefined;
    replaceMessageQueueScope(deps.client, complete, capture.transportIdentity);
    const key = scopeKey({ transportIdentity: capture.transportIdentity, directory: complete.directory, sessionID: complete.sessionID });
    if (!current || current.revision !== complete.revision || current.directory !== complete.directory || current.sessionID !== complete.sessionID) {
      setDescriptors([...state.scopes.values()].filter((entry) => entry.scopeID !== complete.scopeID).concat(descriptorForScope(complete)), capture);
    }
    updatePendingAdmissions(key, (pending) => {
      const next = pending.filter((entry) => entry.phase !== 'acknowledged' || complete.revision < (entry.acknowledgedRevision ?? Number.MAX_SAFE_INTEGER));
      return next.length === pending.length ? pending : next;
    });
    return complete;
  };
  const commitSnapshot = (snapshot: Awaited<ReturnType<typeof fetchMessageQueueSnapshot>>, completeScopes: readonly MessageQueueScope[], capture: MessageQueueServerRuntimeCapture) => {
    if (!isCaptureCurrent(capture) || snapshot.revision < currentWatermark(capture)) return false;
    const incoming = new Map(snapshot.scopes.map((descriptor) => [descriptor.scopeID, descriptor]));
    if ([...state.scopes.values()].some((current) => {
      const next = incoming.get(current.scopeID);
      return next !== undefined && next.revision < current.revision;
    })) return false;
    const prior = state.scopes;
    for (const complete of completeScopes) replaceMessageQueueScope(deps.client, complete, capture.transportIdentity);
    replaceMessageQueueSnapshot(deps.client, snapshot, capture.transportIdentity);
    if (snapshot.scopes.length === 0) clearMessageQueueScopes(deps.client, capture.transportIdentity);
    else for (const scopeID of prior.keys()) if (!incoming.has(scopeID)) clearMessageQueueScope(deps.client, scopeID, capture.transportIdentity);
    setDescriptors(snapshot.scopes, capture);
    for (const complete of completeScopes) {
      const key = scopeKey({ transportIdentity: capture.transportIdentity, directory: complete.directory, sessionID: complete.sessionID });
      updatePendingAdmissions(key, (pending) => {
        const next = pending.filter((entry) => entry.phase !== 'acknowledged' || complete.revision < (entry.acknowledgedRevision ?? Number.MAX_SAFE_INTEGER));
        return next.length === pending.length ? pending : next;
      });
    }
    return true;
  };
  const refresh = async () => {
    const capture = synchronizeTransport(), signal = controller?.signal ?? new AbortController().signal;
    publish({ isFetching: true, hydration: 'hydrating', error: undefined });
    try {
      const status = await deps.status(signal); if (!isCaptureCurrent(capture)) return;
      replaceMessageQueueStatus(deps.client, status, capture.transportIdentity);
      publish({ capability: status.capability ? 'available' : 'unsupported', authority: status.authority });
      if (!status.capability) return;
      const snapshot = await deps.snapshot(signal); if (!isCaptureCurrent(capture)) return;
      const prior = state.scopes;
      const completeScopes = await Promise.all(snapshot.scopes.filter((descriptor) => prior.get(descriptor.scopeID)?.revision !== descriptor.revision).map((descriptor) => loadScope(descriptor, capture, signal)));
      if (commitSnapshot(snapshot, completeScopes, capture)) publish({ hydration: 'ready' });
    } catch (error) { if (!isCaptureCurrent(capture) || signal.aborted) return; publish({ capability: error instanceof MessageQueueServerError && error.status === 501 ? 'unsupported' : 'error', hydration: 'error', error }); }
    finally { if (isCaptureCurrent(capture)) publish({ isFetching: false }); }
  };
  // Tip waits miss advances that happen while paging a scope. Lead with GET, then
  // wait only after the cache already matches the authoritative snapshot.
  const observe = async () => {
    await refresh(); let failures = 0;
    const observer = controller;
    if (!observer) return;
    const signal = observer.signal;
    while (!signal.aborted && controller === observer) {
      const capture = deps.capture();
      try {
        const latest = await deps.snapshot(signal); if (!isCaptureCurrent(capture) || signal.aborted) return;
        const known = new Map(state.scopes);
        const cached = deps.client.getQueryData<Awaited<ReturnType<typeof fetchMessageQueueSnapshot>>>([capture.transportIdentity, 'messageQueue', 'snapshot']);
        const needsApply = cached?.revision !== latest.revision
          || latest.scopes.some((descriptor) => known.get(descriptor.scopeID)?.revision !== descriptor.revision)
          || [...known.keys()].some((scopeID) => !latest.scopes.some((scope) => scope.scopeID === scopeID));
        if (needsApply) {
          const completeScopes = await Promise.all(latest.scopes.filter((descriptor) => known.get(descriptor.scopeID)?.revision !== descriptor.revision).map((descriptor) => loadScope(descriptor, capture, signal)));
          if (commitSnapshot(latest, completeScopes, capture)) { publish({ hydration: 'ready', error: undefined }); failures = 0; }
          continue;
        }
        const reason = await deps.waitInvalidation(latest.revision, { signal });
        if (!isCaptureCurrent(capture) || signal.aborted || reason === 'aborted') return;
        failures = 0;
      } catch (error) {
        if (signal.aborted || controller !== observer || !isCaptureCurrent(capture)) return;
        // Mid-page worker bumps surface as revision_conflict; pull again immediately.
        if (error instanceof MessageQueueServerError && error.code === 'revision_conflict') { failures = 0; continue; }
        publish({ error, isFetching: false }); await pause(Math.min(30_000, 500 * 2 ** failures++), signal);
      }
    }
  };
  // Only advance the reloaded scope's descriptor. Bumping every catalog revision
  // here orphans sibling scope caches (new revision, no pages) and the UI shows
  // empty queues for unrelated sessions. Never regress when a tip already applied
  // a newer revision while this load was in flight (manual-send → worker claim).
  const reloadScope = async (scopeID: string, capture: MessageQueueServerRuntimeCapture, originalError: unknown): Promise<MessageQueueScope | undefined> => {
    const snapshot = await deps.snapshot(controller?.signal); if (!isCaptureCurrent(capture)) return undefined;
    const descriptor = snapshot.scopes.find((entry) => entry.scopeID === scopeID); if (!descriptor) throw originalError;
    const complete = await loadScope(descriptor, capture, controller?.signal ?? new AbortController().signal);
    return commitScope(complete, capture) ?? readMessageQueueScope(deps.client, scopeID, state.scopes.get(scopeID)?.revision ?? descriptor.revision, capture.transportIdentity);
  };
  const reconcileAcknowledgedAdmission = async (scopeID: string, revision: number, capture: MessageQueueServerRuntimeCapture) => {
    const descriptor = state.scopes.get(scopeID);
    const authoritative = descriptor && descriptor.revision >= revision
      ? readMessageQueueScope(deps.client, scopeID, descriptor.revision, capture.transportIdentity)
      : undefined;
    if (authoritative) return authoritative;
    const signal = controller?.signal ?? new AbortController().signal;
    const first = await deps.scope(scopeID, { offset: 0, limit: 8, signal });
    if (!isCaptureCurrent(capture) || first.scopeID !== scopeID || first.revision < revision) return;
    const known = state.scopes.get(scopeID);
    if (known && known.revision > first.revision) return;
    const complete = await loadScope({ scopeID, revision: first.revision, directory: first.directory, sessionID: first.sessionID, worktreeState: first.worktreeState, itemCount: first.itemCount }, capture, signal, first);
    return commitScope(complete, capture);
  };
  // After a committed mutation, always reconcile from the latest snapshot. Pinning
  // pages to the mutation revision races the worker after manual send and can leave
  // descriptors without matching pages (empty chip list). On mutation failure,
  // still best-effort reload so a raced tip cannot strand the UI.
  const mutate = async (scopeID: string, revision: number, action: (expectedRevision: number, scope: MessageQueueScope | undefined) => Promise<{ revision: number }>): Promise<MessageQueueServerMutationResult> => {
    const capture = synchronizeTransport(); let expected = revision;
    for (let attempt = 0; attempt < 2; attempt++) {
      const descriptor = state.scopes.get(scopeID); const current = descriptor ? readMessageQueueScope(deps.client, scopeID, descriptor.revision, capture.transportIdentity) : undefined;
      try { await action(expected, current); }
      catch (error) {
        if (isConflict(error) && !attempt) {
          const reloaded = await reloadScope(scopeID, capture, error); if (!reloaded) return { status: 'stale' };
          expected = reloaded.revision; continue;
        }
        await reloadScope(scopeID, capture, error).catch(() => undefined);
        throw error;
      }
      if (!isCaptureCurrent(capture)) return { status: 'stale' };
      for (let reconcileAttempt = 0; reconcileAttempt < 2; reconcileAttempt++) {
        try {
          const scope = await reloadScope(scopeID, capture, new MessageQueueServerError(409, 'revision_conflict'));
          if (!scope) return { status: 'stale' };
          await invalidateMessageQueueScope(deps.client, scopeID, capture.transportIdentity);
          const latest = state.scopes.get(scopeID);
          return { status: 'committed', scope: latest ? readMessageQueueScope(deps.client, scopeID, latest.revision, capture.transportIdentity) : scope };
        } catch (error) {
          if (!isConflict(error) || reconcileAttempt) throw error;
        }
      }
    }
    throw new MessageQueueServerError(409, 'revision_conflict');
  };
  const stopObserver = () => { controller?.abort(); controller = undefined; importFlight = undefined; };
  const startObserver = () => { if (controller) return; controller = new AbortController(); void observe(); };
  const runShadowImport = () => {
    if (importFlight) return importFlight;
    const flight = (async () => {
      const capture = synchronizeTransport();
      if (state.capability !== 'available' || state.authority !== 'shadow') { const importState = { status: 'pending', imported: 0, total: 0, issues: ['shadow-unavailable'], canActivate: false } as MessageQueueShadowImportState; publish({ importState }); return importState; }
      return createMessageQueueShadowImporter({ queue: deps.shadowQueue(), capture: () => capture, current: isCaptureCurrent, existing: () => [...state.scopes.values()].flatMap((scope) => readMessageQueueScope(deps.client, scope.scopeID, scope.revision, capture.transportIdentity)?.items ?? []), refresh, publish: (importState) => { if (isCaptureCurrent(capture)) publish({ importState }); } }).run(controller?.signal);
    })();
    const wrapped = flight.finally(() => { if (importFlight === wrapped) importFlight = undefined; }); importFlight = wrapped; return wrapped;
  };
  return {
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    subscribeScope: (scope, listener) => { const key = scopeKey(scope), entries = scopeListeners.get(key) ?? new Set(); entries.add(listener); scopeListeners.set(key, entries); return () => { entries.delete(listener); if (!entries.size) scopeListeners.delete(key); }; },
    getState: () => { synchronizeTransport(); return state; }, captureRuntime: () => synchronizeTransport(),
    getScope: (scope) => { const capture = synchronizeTransport(); if (scope.transportIdentity !== capture.transportIdentity || state.transportIdentity !== scope.transportIdentity) return undefined; const descriptor = [...state.scopes.values()].find((entry) => entry.directory === scope.directory && entry.sessionID === scope.sessionID); if (!descriptor) return undefined; const key = `${scope.transportIdentity}\u0000${descriptor.scopeID}`, cached = scopeSnapshots.get(key); if (cached?.revision === descriptor.revision) return cached.scope; const loaded = readMessageQueueScope(deps.client, descriptor.scopeID, descriptor.revision, scope.transportIdentity); if (loaded) scopeSnapshots.set(key, { revision: descriptor.revision, scope: loaded }); return loaded; },
    getPendingAdmissions: (scope) => {
      const capture = synchronizeTransport();
      return scope.transportIdentity === capture.transportIdentity && state.transportIdentity === scope.transportIdentity ? pendingAdmissions.get(scopeKey(scope)) ?? EMPTY_PENDING_ADMISSIONS : EMPTY_PENDING_ADMISSIONS;
    },
    start: () => { users++; synchronizeTransport(); startObserver(); }, stop: () => { users = Math.max(0, users - 1); if (!users) stopObserver(); }, restart: () => { stopObserver(); resetForTransport(deps.capture()); if (users) startObserver(); }, refresh, runShadowImport,
    pause: async (expectedGeneration) => { await pauseMessageQueueAuthority({ expectedGeneration, signal: controller?.signal }); await refresh(); }, resume: async (expectedGeneration) => { await resumeMessageQueueAuthority({ expectedGeneration, signal: controller?.signal }); await refresh(); },
    admit: async ({ requestID, scope, item, attachments = [] }) => {
      const capture = synchronizeTransport();
      const pendingScope = { transportIdentity: capture.transportIdentity, ...scope };
      const pendingKey = scopeKey(pendingScope);
      const pending: PendingAdmission = {
        kind: 'pending-admission', requestID, queueItemID: item.queueItemID, operationID: item.operationID, messageID: item.messageID, content: item.content, createdAt: item.createdAt, phase: 'uploading', attachmentCount: attachments.length,
        ...(item.composerDocument ? { composerDocument: item.composerDocument } : {}), ...(item.composerMentions ? { composerMentions: item.composerMentions } : {}), ...(item.sendConfig ? { sendConfig: item.sendConfig } : {}),
      };
      const replacePending = (next: PendingAdmission) => updatePendingAdmissions(pendingKey, (entries) => entries.map((entry) => entry.requestID === requestID ? next : entry));
      const removePending = () => updatePendingAdmissions(pendingKey, (entries) => entries.filter((entry) => entry.requestID !== requestID));
      updatePendingAdmissions(pendingKey, (entries) => [...entries, pending]);
      let uploaded;
      try {
        uploaded = await deps.upload(attachments, controller?.signal);
      } catch (error) { removePending(); if (!isCaptureCurrent(capture)) return { status: 'stale' }; throw error; }
      if (!isCaptureCurrent(capture)) { removePending(); return { status: 'stale' }; }
      const payload = { requestID, scope, item: { ...item, attachments: uploaded.attachments }, signal: controller?.signal };
      replacePending({ ...pending, phase: 'admitting' });
      let acknowledgement: Awaited<ReturnType<typeof admitTextQueueItem>>;
      try {
        acknowledgement = await deps.admit(payload);
      } catch (error) {
        if (!isCaptureCurrent(capture)) { removePending(); return { status: 'stale' }; }
        if (!(error instanceof MessageQueueServerError) || error.code !== 'unavailable') { removePending(); throw error; }
        replacePending({ ...pending, phase: 'ambiguous' });
        try { acknowledgement = await deps.admit(payload); }
        catch (replayError) { removePending(); if (!isCaptureCurrent(capture)) return { status: 'stale' }; throw replayError; }
      }
      const acknowledged = { ...pending, phase: 'acknowledged' as const, acknowledgedRevision: acknowledgement.revision };
      replacePending(acknowledged);
      if (acknowledgement.scopeID) {
        const authoritative = reconcileAcknowledgedAdmission(acknowledgement.scopeID, acknowledgement.revision, capture);
        void authoritative.then((scope) => { if (scope) removePending(); }).catch(() => undefined);
      }
      return { status: 'committed' };
    },
    edit: ({ requestID, scopeID, revision, item, patch }) => mutate(scopeID, revision, (expected, current) => { const latest = current?.items.find((entry) => entry.queueItemID === item.queueItemID) ?? item; return deps.edit(latest.queueItemID, { requestID, expectedRevision: expected, expectedRowVersion: latest.rowVersion, item: patch, signal: controller?.signal }); }),
    // Worker completion can delete a row before a stale chip DELETE arrives; treat
    // authoritative absence as a committed remove after reloading the scope.
    remove: ({ requestID, scopeID, revision, item }) => mutate(scopeID, revision, async (expected, current) => {
      const latest = current?.items.find((entry) => entry.queueItemID === item.queueItemID) ?? item;
      try {
        return await deps.remove(latest.queueItemID, { requestID, expectedRevision: expected, expectedRowVersion: latest.rowVersion, signal: controller?.signal });
      } catch (error) {
        if (!(error instanceof MessageQueueServerError) || error.code !== 'not_found') throw error;
        const reloaded = await reloadScope(scopeID, synchronizeTransport(), error);
        if (!reloaded) throw error;
        if (reloaded.items.some((entry) => entry.queueItemID === item.queueItemID)) throw error;
        return { revision: reloaded.revision, removedQueueItemID: item.queueItemID };
      }
    }),
    reserveEdit: async ({ requestID, scopeID, revision, item, owner, ttlMs, runtime }) => {
      if (!isCaptureCurrent(runtime)) return undefined;
      const current = readMessageQueueScope(deps.client, scopeID, revision, runtime.transportIdentity);
      const latest = current?.items.find((entry) => entry.queueItemID === item.queueItemID);
      if (!latest) return undefined;
      const reserved = await deps.reserve(latest.queueItemID, { requestID, expectedRevision: revision, rowVersion: latest.rowVersion, owner, ttlMs, signal: controller?.signal });
      if (!isCaptureCurrent(runtime)) { await deps.release(latest.queueItemID, { token: reserved.token, signal: controller?.signal }).catch(() => {}); return undefined; }
      return reserved;
    },
    renewEdit: async ({ item, token, generation, ttlMs, runtime, signal }) => {
      if (!isCaptureCurrent(runtime)) return undefined;
      const renewed = await deps.renew(item.queueItemID, { token, generation, ttlMs, signal: signal ?? controller?.signal });
      if (!isCaptureCurrent(runtime) || renewed.queueItemID !== item.queueItemID || renewed.token !== token || renewed.generation !== generation) return undefined;
      return renewed;
    },
    releaseEdit: async ({ item, token, runtime }) => { if (!isCaptureCurrent(runtime)) return; await deps.release(item.queueItemID, { token, signal: controller?.signal.aborted ? undefined : controller?.signal }); if (isCaptureCurrent(runtime)) await refresh(); },
    removeReserved: async ({ requestID, scopeID, revision, item, token, generation, runtime }) => {
      if (!isCaptureCurrent(runtime)) return false;
      const current = readMessageQueueScope(deps.client, scopeID, revision, runtime.transportIdentity);
      const latest = current?.items.find((entry) => entry.queueItemID === item.queueItemID);
      if (!latest) return false;
      await deps.removeReserved(latest.queueItemID, { requestID, expectedRevision: revision, expectedRowVersion: latest.rowVersion, token, generation, signal: controller?.signal });
      if (!isCaptureCurrent(runtime)) return false;
      await reloadScope(scopeID, runtime, new MessageQueueServerError(404, 'not_found')).catch(() => undefined);
      await refresh(); return true;
    },
    reorder: ({ requestID, scopeID, revision, queueItemIDs }) => mutate(scopeID, revision, (expected) => deps.reorder(scopeID, { requestID, expectedRevision: expected, queueItemIDs, signal: controller?.signal })),
    manualSend: async ({ requestID, scopeID, revision, item }) => {
      if (state.authority === 'active' || state.authority === 'paused') return mutate(scopeID, revision, (expected, current) => { const latest = current?.items.find((entry) => entry.queueItemID === item.queueItemID) ?? item; return deps.manualSend(latest.queueItemID, { requestID, expectedRevision: expected, expectedRowVersion: latest.rowVersion, signal: controller?.signal }); });
      if (state.authority === 'shadow' || state.capability === 'unsupported') { const capture = synchronizeTransport(); if (!isCaptureCurrent(capture)) return { status: 'stale' }; await deps.legacyManualSend(item); return isCaptureCurrent(capture) ? { status: 'committed' } : { status: 'stale' }; }
      throw new MessageQueueServerError(0, 'unavailable');
    },
  };
};

let defaultRuntime: MessageQueueServerSurface | undefined;
export const getMessageQueueServerRuntime = (): MessageQueueServerSurface => defaultRuntime ??= createMessageQueueServerRuntime();
const switchInstallations = new WeakMap<object, { refs: number; unsubscribe: () => void }>();
export const installMessageQueueServerRuntimeSwitch = (surface: Pick<MessageQueueServerSurface, 'restart'>): (() => void) => {
  const key = surface as object, installed = switchInstallations.get(key);
  if (installed) { installed.refs++; return () => { installed.refs--; if (!installed.refs) { installed.unsubscribe(); switchInstallations.delete(key); } }; }
  const entry = { refs: 1, unsubscribe: subscribeRuntimeEndpointChanged((detail) => { if (isRuntimeEndpointIdentityChange(detail)) surface.restart(); }) };
  switchInstallations.set(key, entry);
  return () => { entry.refs--; if (!entry.refs) { entry.unsubscribe(); switchInstallations.delete(key); } };
};
