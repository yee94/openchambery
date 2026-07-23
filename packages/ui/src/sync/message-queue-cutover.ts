import { activateMessageQueueImport, commitLateMessageQueueImport, MessageQueueServerError, type MessageQueueServerStatus } from '@/lib/message-queue-server';
import { queryClient } from '@/lib/queryRuntime';
import { getRuntimeGeneration, getRuntimeTransportIdentity, subscribeRuntimeEndpointChanged, isRuntimeEndpointIdentityChange } from '@/lib/runtime-switch';
import { ensureMessageQueueStatus, refreshMessageQueueStatus } from '@/queries/messageQueueQueries';
import { getMessageQueueRuntime, type MessageQueueRuntime } from './message-queue-runtime';
import { createMessageQueueShadowImporter, type MessageQueueShadowImportState } from './message-queue-shadow-import';
import { getMessageQueueServerRuntime, type MessageQueueServerSurface } from './message-queue-server-runtime';
import { quiesceQueuedMessageAutoSend, setQueuedMessageOwnershipGate } from '@/hooks/useQueuedMessageAutoSend';
import { flushMessageQueuePersistence, markMessageQueueTransportRetired, prepareLegacyQueuesForCutover, setMessageQueueMutationFence } from '@/stores/messageQueueStore';
import { useSessionUIStore } from './session-ui-store';

export type MessageQueueOwnership = 'probing' | 'legacy-unsupported' | 'server-active' | 'server-paused' | 'blocked';
export type MessageQueueMigration = 'idle' | 'freezing' | 'staging' | 'activating' | 'late-importing' | 'complete' | 'error';
export type MessageQueueCutoverState = { ownership: MessageQueueOwnership; migration: MessageQueueMigration; frozen: boolean; admission: 'legacy' | 'server' | 'frozen'; status?: MessageQueueServerStatus; importState: MessageQueueShadowImportState; error?: unknown };
type Capture = { transportIdentity: string; generation: number };
type Dependencies = { server: MessageQueueServerSurface; queue: MessageQueueRuntime; status: (signal?: AbortSignal) => Promise<MessageQueueServerStatus>; activate: typeof activateMessageQueueImport; lateCommit: typeof commitLateMessageQueueImport; capture: () => Capture; current: (capture: Capture) => boolean; quiesce: () => Promise<void>; flush: () => Promise<void>; prepare: typeof prepareLegacyQueuesForCutover; resolveDirectory: (sessionID: string) => string | null | undefined };
/** Status reads share Query in-flight with server-runtime refresh so cutover does not double-GET. */
const defaults: Dependencies = {
  server: getMessageQueueServerRuntime(),
  queue: getMessageQueueRuntime(),
  status: (signal) => ensureMessageQueueStatus(queryClient).then((value) => { if (signal?.aborted) throw new DOMException('Aborted', 'AbortError'); return value; }),
  activate: activateMessageQueueImport,
  lateCommit: commitLateMessageQueueImport,
  capture: () => ({ transportIdentity: getRuntimeTransportIdentity(), generation: getRuntimeGeneration() }),
  current: (capture) => capture.transportIdentity === getRuntimeTransportIdentity() && capture.generation === getRuntimeGeneration(),
  quiesce: async () => { await quiesceQueuedMessageAutoSend(); },
  flush: async () => { flushMessageQueuePersistence(); },
  prepare: prepareLegacyQueuesForCutover,
  resolveDirectory: (sessionID) => useSessionUIStore.getState().getDirectoryForSession(sessionID),
};
const initial = (): MessageQueueCutoverState => ({ ownership: 'probing', migration: 'idle', frozen: true, admission: 'frozen', importState: { status: 'idle', imported: 0, total: 0, issues: [], canActivate: false } });

export type MessageQueueCutover = { subscribe(listener: () => void): () => void; getSnapshot(): MessageQueueCutoverState; start(): void; stop(): void; refresh(): Promise<MessageQueueCutoverState> };
export const createMessageQueueCutover = (overrides: Partial<Dependencies> = {}): MessageQueueCutover => {
  const deps = { ...defaults, ...overrides }; let state = initial(), users = 0, controller: AbortController | undefined, unsubscribe: (() => void) | undefined, retry: ReturnType<typeof setTimeout> | undefined, backoff = 500, flight: Promise<MessageQueueCutoverState> | undefined, refreshPending = false;
  const listeners = new Set<() => void>();
  const publish = (next: Partial<MessageQueueCutoverState>) => {
    state = { ...state, ...next };
    const legacy = state.ownership === 'legacy-unsupported';
    setQueuedMessageOwnershipGate(legacy ? 'legacy-enabled' : 'blocked');
    setMessageQueueMutationFence(legacy ? 'open' : state.migration === 'freezing' || state.ownership === 'probing' || state.ownership === 'blocked' ? 'quiescing' : 'recovery-read-only');
    if (state.ownership === 'server-active' || state.ownership === 'server-paused') markMessageQueueTransportRetired(deps.capture().transportIdentity);
    listeners.forEach((listener) => listener());
  };
  const schedule = () => { clearTimeout(retry); retry = setTimeout(() => { void refresh(); }, backoff); backoff = Math.min(30_000, backoff * 2); };
  const blocked = (error: unknown) => { publish({ ownership: 'blocked', migration: 'idle', frozen: true, admission: 'frozen', error }); schedule(); };
  const retryImport = (capture: Capture, status: MessageQueueServerStatus, kind: 'activation' | 'late', imported: MessageQueueShadowImportState, error?: unknown) => {
    if (!deps.current(capture)) return;
    if (status.authority === 'active' || status.authority === 'paused' || kind === 'late') {
      publish({ ownership: status.authority === 'paused' ? 'server-paused' : 'server-active', migration: 'late-importing', frozen: false, admission: 'server', status, importState: imported, error });
    } else {
      publish({ ownership: 'probing', migration: imported.status === 'error' || imported.status === 'degraded' ? 'error' : 'staging', frozen: true, admission: 'frozen', status, importState: imported, error });
    }
    schedule();
  };
  const prepare = async (capture: Capture): Promise<boolean> => {
    await deps.quiesce();
    const prepared = deps.prepare(capture.transportIdentity, deps.resolveDirectory);
    if (!prepared.ok) { blocked(new Error(`unresolved-legacy-queue-directories:${prepared.unresolvedSessionIDs.join(',')}`)); return false; }
    await deps.flush();
    return deps.current(capture);
  };
  const refreshInner = async (): Promise<MessageQueueCutoverState> => {
    const capture = deps.capture(); controller?.abort(); controller = new AbortController();
    try {
      // server.refresh already loads status into Query; ensureMessageQueueStatus
      // reuses that warm cache (staleTime) instead of issuing a second network GET.
      await deps.server.refresh();
      if (!deps.current(capture) || controller.signal.aborted) return state;
      const status = await deps.status(controller.signal);
      if (!deps.current(capture) || controller.signal.aborted) return state;
      if (!status.capability) { blocked(new Error('capability-unavailable')); return state; }
      if (status.protocol !== undefined && status.protocol !== 4) { blocked(new Error('protocol-unsupported')); return state; }
      publish({ ownership: 'probing', migration: 'freezing', frozen: true, admission: 'frozen', status, error: undefined });
      if (!await prepare(capture)) return state;
      if (status.authority === 'active' || status.authority === 'paused') {
        publish({ ownership: status.authority === 'active' ? 'server-active' : 'server-paused', migration: 'late-importing', frozen: false, admission: 'server', status, error: undefined });
        await runImport(capture, status, 'late'); return state;
      }
      publish({ migration: 'staging' }); await runImport(capture, status, 'activation'); return state;
    } catch (error) {
      if (!deps.current(capture) || controller?.signal.aborted) return state;
      if (error instanceof MessageQueueServerError && error.status === 501) { publish({ ownership: 'legacy-unsupported', migration: 'idle', frozen: false, admission: 'legacy', error: undefined }); return state; }
      blocked(error); return state;
    }
  };
  const refresh = (): Promise<MessageQueueCutoverState> => {
    if (flight) { refreshPending = true; return flight; }
    flight = refreshInner().finally(() => { flight = undefined; if (refreshPending) { refreshPending = false; void refresh(); } });
    return flight;
  };
  const runImport = async (capture: Capture, status: MessageQueueServerStatus, kind: 'activation' | 'late') => {
    const importer = createMessageQueueShadowImporter({ queue: deps.queue, capture: () => capture, current: deps.current, kind, authorityGeneration: () => status.generation ?? 0, publish: (importState) => publish({ importState }) });
    const imported = await importer.run(controller?.signal); if (!deps.current(capture)) return;
    publish({ importState: imported }); if (!imported.canActivate || !imported.importID || !imported.manifestHash) { retryImport(capture, status, kind, imported); return; }
    publish({ migration: kind === 'activation' ? 'activating' : 'late-importing' });
    try {
      const commit = kind === 'activation' ? await deps.activate(imported.importID, { requestID: `shadow-activate:${imported.manifestHash}`, expectedGeneration: status.generation ?? 0, manifestHash: imported.manifestHash, protocol: 4, signal: controller?.signal }) : await deps.lateCommit(imported.importID, { requestID: `shadow-late:${imported.manifestHash}`, expectedGeneration: status.generation ?? 0, manifestHash: imported.manifestHash, protocol: 4, signal: controller?.signal });
      if (!deps.current(capture)) return;
      backoff = 500;
      publish({ ownership: kind === 'activation' ? 'server-active' : status.authority === 'paused' ? 'server-paused' : 'server-active', migration: 'complete', frozen: false, admission: 'server', importState: { ...imported, activationEpoch: commit.activationEpoch } });
    } catch (error) {
      if (!deps.current(capture)) return;
      // A lost response is confirmed by the authority epoch and manifest on the next status read.
      const confirmed = await refreshMessageQueueStatus(queryClient).catch(() => undefined);
      if (confirmed?.manifestHash === imported.manifestHash && confirmed.activationEpoch !== undefined && (confirmed.authority === 'active' || confirmed.authority === 'paused')) { backoff = 500; publish({ ownership: confirmed.authority === 'paused' ? 'server-paused' : 'server-active', migration: 'complete', frozen: false, admission: 'server', status: confirmed, importState: { ...imported, activationEpoch: confirmed.activationEpoch } }); return; }
      if (confirmed?.authority === 'active' || confirmed?.authority === 'paused') {
        // Another client won activation. Re-capture the local ledger under server ownership and append it as late work.
        retryImport(capture, confirmed, 'late', imported, error);
        return;
      }
      retryImport(capture, status, kind, imported, error);
    }
  };
  /** Delay teardown so React StrictMode cleanup+remount reuses the in-flight refresh. */
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  const hardStop = () => {
    controller?.abort();
    controller = undefined;
    clearTimeout(retry);
    retry = undefined;
    unsubscribe?.();
    unsubscribe = undefined;
  };
  return {
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: () => state,
    start: () => {
      users++;
      if (stopTimer !== undefined) { clearTimeout(stopTimer); stopTimer = undefined; }
      if (users > 1) return;
      unsubscribe = subscribeRuntimeEndpointChanged((detail) => {
        if (isRuntimeEndpointIdentityChange(detail)) {
          controller?.abort();
          publish(initial());
          setTimeout(() => { void refresh(); }, 0);
        }
      });
      void refresh();
    },
    stop: () => {
      users = Math.max(0, users - 1);
      if (users) return;
      if (stopTimer !== undefined) clearTimeout(stopTimer);
      stopTimer = setTimeout(() => {
        stopTimer = undefined;
        if (!users) hardStop();
      }, 0);
    },
    refresh,
  };
};
let singleton: MessageQueueCutover | undefined;
export const getMessageQueueCutover = () => singleton ??= createMessageQueueCutover();
