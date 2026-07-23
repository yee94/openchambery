import React from 'react';

import { fetchWorktreeOrder, MessageQueueServerError, setWorktreeOrder, waitForMessageQueueInvalidation, type MessageQueueSnapshot, type WorktreeOrder } from '@/lib/message-queue-server';
import { queryClient } from '@/lib/queryRuntime';
import { getRuntimeGeneration, getRuntimeTransportIdentity, isRuntimeEndpointIdentityChange, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { ensureMessageQueueSnapshot, refreshMessageQueueSnapshot } from '@/queries/messageQueueQueries';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { registerWorktreeOrderWriter, useWorktreeOrderStore } from '@/stores/useWorktreeOrderStore';

const MAX_BACKOFF_MS = 30_000;
const normalizePath = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
export type WorktreeOrderRuntimeCapture = { transportIdentity: string; generation: number };
type WorktreeOrderProject = { id: string; path: string };
export type WorktreeOrderSyncDependencies = {
  fetchSnapshot: (signal?: AbortSignal) => Promise<MessageQueueSnapshot>;
  /** Tip-driven re-read; defaults force a network GET so warm Query cache cannot hide order advances. */
  refreshSnapshot?: (signal?: AbortSignal) => Promise<MessageQueueSnapshot>;
  fetchOrder: (directory: string, signal?: AbortSignal) => Promise<WorktreeOrder>;
  setOrder: (input: { requestID: string; projectDirectory: string; expectedRevision: number; orderedPaths: string[]; signal?: AbortSignal }) => Promise<{ revision: number; worktreeOrder?: WorktreeOrder }>;
  waitInvalidation: (revision: number, options: { signal?: AbortSignal }) => Promise<'tip' | 'ready' | 'aborted'>;
  captureRuntime: () => WorktreeOrderRuntimeCapture;
  isCurrent: (capture: WorktreeOrderRuntimeCapture) => boolean;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  createRequestID: () => string;
};

const classifyMessageQueueError = (error: unknown): 'unsupported' | 'permanent' | 'retry' => {
  if (!(error instanceof MessageQueueServerError)) return 'retry';
  if (error.status === 501) return 'unsupported';
  if (error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429 && error.code !== 'revision_conflict') return 'permanent';
  return 'retry';
};

const sleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  const onAbort = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); reject(new DOMException('Aborted', 'AbortError')); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
  if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
});

const withAbort = <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => promise.then((value) => {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  return value;
});

const defaults: WorktreeOrderSyncDependencies = {
  // Share snapshot GETs with message-queue-server-runtime via TanStack Query.
  fetchSnapshot: (signal) => withAbort(ensureMessageQueueSnapshot(queryClient), signal),
  refreshSnapshot: (signal) => withAbort(refreshMessageQueueSnapshot(queryClient), signal),
  fetchOrder: fetchWorktreeOrder,
  setOrder: setWorktreeOrder,
  waitInvalidation: waitForMessageQueueInvalidation,
  captureRuntime: () => ({ transportIdentity: getRuntimeTransportIdentity(), generation: getRuntimeGeneration() }),
  isCurrent: (capture) => capture.transportIdentity === getRuntimeTransportIdentity() && capture.generation === getRuntimeGeneration(),
  sleep,
  createRequestID: () => typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `worktree-order-${Date.now()}-${Math.random().toString(36).slice(2)}`,
};

type Intent = { projectDirectory: string; orderedPaths: string[]; capture: WorktreeOrderRuntimeCapture; controller: AbortController; requestID?: string; expectedRevision?: number; backoffMs: number; running: boolean };
const intents = new Map<string, Intent>();
const cancelIntents = () => { for (const intent of intents.values()) intent.controller.abort(); intents.clear(); };

const enqueue = (projectID: string, projectDirectory: string, orderedPaths: string[], dependencies = defaults): void => {
  const previous = intents.get(projectID);
  previous?.controller.abort();
  const intent: Intent = { projectDirectory: normalizePath(projectDirectory), orderedPaths: [...orderedPaths], capture: dependencies.captureRuntime(), controller: new AbortController(), backoffMs: 500, running: false };
  intents.set(projectID, intent);
  void drainIntent(projectID, dependencies);
};

const drainIntent = async (projectID: string, dependencies = defaults): Promise<void> => {
  const initial = intents.get(projectID);
  if (!initial || initial.running) return;
  initial.running = true;
  try {
    while (true) {
      const intent = intents.get(projectID);
      if (!intent || !dependencies.isCurrent(intent.capture) || intent.controller.signal.aborted) return;
      const expectedRevision = useWorktreeOrderStore.getState().serverRevisionByProject[projectID] ?? 0;
      if (intent.expectedRevision !== expectedRevision) { intent.expectedRevision = expectedRevision; intent.requestID = dependencies.createRequestID(); }
      try {
        const result = await dependencies.setOrder({ requestID: intent.requestID!, projectDirectory: intent.projectDirectory, expectedRevision, orderedPaths: intent.orderedPaths, signal: intent.controller.signal });
        if (!dependencies.isCurrent(intent.capture) || intents.get(projectID) !== intent) return;
        const order = result.worktreeOrder ?? { projectDirectory: intent.projectDirectory, orderedPaths: intent.orderedPaths, revision: result.revision };
        useWorktreeOrderStore.getState().setServerRevision(projectID, order.revision);
        useWorktreeOrderStore.getState().resolvePendingWorktreeOrder(projectID, order.revision);
        intents.delete(projectID);
        return;
      } catch (error) {
        if (intent.controller.signal.aborted || !dependencies.isCurrent(intent.capture) || intents.get(projectID) !== intent) return;
        if (error instanceof MessageQueueServerError && error.code === 'revision_conflict') {
          try {
            const remote = await dependencies.fetchOrder(intent.projectDirectory, intent.controller.signal);
            if (intents.get(projectID) !== intent || !dependencies.isCurrent(intent.capture)) return;
            useWorktreeOrderStore.getState().applyServerWorktreeOrder(projectID, remote.orderedPaths, remote.revision);
            intent.expectedRevision = undefined;
            intent.requestID = undefined;
            intent.backoffMs = 500;
            continue;
          } catch (fetchError) {
            if (classifyMessageQueueError(fetchError) !== 'retry') return;
          }
        } else if (classifyMessageQueueError(error) !== 'retry') return;
        await dependencies.sleep(intent.backoffMs, intent.controller.signal).catch(() => {});
        intent.backoffMs = Math.min(intent.backoffMs * 2, MAX_BACKOFF_MS);
        if (intent.controller.signal.aborted) return;
      }
    }
  } finally {
    if (intents.get(projectID) === initial && (!dependencies.isCurrent(initial.capture) || initial.controller.signal.aborted)) intents.delete(projectID);
    if (intents.get(projectID) === initial) initial.running = false;
  }
};

const applyOrders = (orders: WorktreeOrder[], projects: WorktreeOrderProject[], capture: WorktreeOrderRuntimeCapture, dependencies: WorktreeOrderSyncDependencies): void => {
  const ids = new Map(projects.map((project) => [normalizePath(project.path), project.id]));
  for (const order of orders) {
    const projectID = ids.get(normalizePath(order.projectDirectory));
    if (projectID && dependencies.isCurrent(capture)) useWorktreeOrderStore.getState().applyServerWorktreeOrder(projectID, order.orderedPaths, order.revision);
  }
};

export const createWorktreeOrderObserver = (projects: () => WorktreeOrderProject[], dependencies = defaults) => {
  let controller: AbortController | null = null;
  const stop = () => controller?.abort();
  const start = () => {
    stop(); controller = new AbortController();
    const signal = controller.signal, capture = dependencies.captureRuntime();
    void (async () => {
      let revision = 0, backoff = 500;
      while (!signal.aborted && dependencies.isCurrent(capture)) {
        try {
          const snapshot = await dependencies.fetchSnapshot(signal);
          if (signal.aborted || !dependencies.isCurrent(capture)) return;
          revision = snapshot.revision;
          const currentProjects = projects();
          applyOrders(snapshot.worktreeOrders, currentProjects, capture, dependencies);
          const remote = new Set(snapshot.worktreeOrders.map((order) => normalizePath(order.projectDirectory)));
          for (const project of currentProjects) {
            const state = useWorktreeOrderStore.getState();
            const local = state.orderByProject[project.id];
            if (state.pendingProjectIDs[project.id]) {
              enqueue(project.id, project.path, local ?? [], dependencies);
            } else if (local?.length && !remote.has(normalizePath(project.path))) {
              state.markPendingWorktreeOrder(project.id);
              enqueue(project.id, project.path, local, dependencies);
            }
          }
          break;
        } catch (error) {
          if (classifyMessageQueueError(error) !== 'retry') return;
          await dependencies.sleep(backoff, signal).catch(() => {}); backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        }
      }
      while (!signal.aborted && dependencies.isCurrent(capture)) {
        try {
          const reason = await dependencies.waitInvalidation(revision, { signal });
          if (signal.aborted || !dependencies.isCurrent(capture) || reason === 'aborted') return;
          const snapshot = await (dependencies.refreshSnapshot ?? dependencies.fetchSnapshot)(signal);
          if (signal.aborted || !dependencies.isCurrent(capture)) return;
          revision = snapshot.revision;
          applyOrders(snapshot.worktreeOrders, projects(), capture, dependencies);
          backoff = 500;
        } catch (error) {
          if (classifyMessageQueueError(error) !== 'retry') return;
          await dependencies.sleep(backoff, signal).catch(() => {}); backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        }
      }
    })();
  };
  return { start, stop };
};

export const useWorktreeOrderSync = (): void => {
  const projectSignature = useProjectsStore((state) => JSON.stringify(state.projects.map((project) => [project.id, normalizePath(project.path)])));
  React.useEffect(() => {
    const identity = getRuntimeTransportIdentity();
    useWorktreeOrderStore.getState().activateWorktreeOrderRuntime(identity);
    const unregister = registerWorktreeOrderWriter((projectID, directory, paths) => enqueue(projectID, directory, paths));
    const observer = createWorktreeOrderObserver(() => useProjectsStore.getState().projects);
    observer.start();
    const unsubscribe = subscribeRuntimeEndpointChanged((detail) => {
      if (!isRuntimeEndpointIdentityChange(detail)) return;
      cancelIntents();
      useWorktreeOrderStore.getState().activateWorktreeOrderRuntime(getRuntimeTransportIdentity());
      observer.start();
    });
    return () => { unregister(); unsubscribe(); observer.stop(); cancelIntents(); };
  }, [projectSignature]);
};

export const __worktreeOrderSyncTest = { applyOrders, cancelIntents, drainIntent, enqueue, intents, normalizePath };
