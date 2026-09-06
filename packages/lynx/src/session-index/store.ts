import type { LynxKvStore } from '../connection/types';
import type { LynxRuntimeFetch } from '../runtime/fetch';
import {
  loadSessionIndexSnapshot,
  lookupSessionIndexById,
  pinSession,
  unpinSession,
} from './api';
import { readSessionIndexStartupSnapshot, writeSessionIndexStartupSnapshot } from './cache';
import type {
  SessionIndexLoadResult,
  SessionIndexLookupHit,
  SessionIndexState,
} from './types';

export type LynxSessionIndexStore = {
  getState: () => SessionIndexState;
  subscribe: (listener: () => void) => () => void;
  load: (options?: { signal?: AbortSignal }) => Promise<SessionIndexLoadResult>;
  refresh: (options?: { signal?: AbortSignal }) => Promise<SessionIndexLoadResult>;
  lookupById: (sessionId: string, options?: { signal?: AbortSignal }) => Promise<SessionIndexLookupHit | null>;
  pin: (sessionId: string, options?: { signal?: AbortSignal }) => Promise<void>;
  unpin: (sessionId: string, options?: { signal?: AbortSignal }) => Promise<void>;
  clearForRuntimeChange: () => void;
};

export type LynxSessionIndexStoreDeps = {
  runtimeFetch: LynxRuntimeFetch;
  getRuntimeKey: () => string | null;
  storage?: LynxKvStore;
};

/**
 * Runtime-scoped session-index cache. Failed refreshes keep the previous
 * snapshot. A runtime-key change drops in-memory state so LAN↔relay shares
 * the cold-start cache but a different instance cannot reuse rows.
 */
export const createLynxSessionIndexStore = (deps: LynxSessionIndexStoreDeps): LynxSessionIndexStore => {
  let state: SessionIndexState = {
    status: 'idle',
    snapshot: null,
    error: null,
    runtimeKey: deps.getRuntimeKey(),
  };
  const listeners = new Set<() => void>();

  const emit = () => {
    for (const listener of listeners) listener();
  };

  const setState = (next: SessionIndexState) => {
    state = next;
    emit();
  };

  const applyResult = (result: SessionIndexLoadResult, runtimeKey: string | null): SessionIndexLoadResult => {
    if (result.status === 'ok') {
      if (runtimeKey && deps.storage) writeSessionIndexStartupSnapshot(runtimeKey, result.snapshot, deps.storage);
      setState({ status: 'ready', snapshot: result.snapshot, error: null, runtimeKey });
      return result;
    }
    if (result.status === 'unsupported') {
      setState({ status: 'unsupported', snapshot: state.snapshot, error: null, runtimeKey });
      return result;
    }
    const previous = state.snapshot;
    setState({
      status: 'failed',
      snapshot: previous,
      error: result.error,
      runtimeKey,
    });
    return { ...result, previous };
  };

  const load = async (options?: { signal?: AbortSignal }): Promise<SessionIndexLoadResult> => {
    const runtimeKey = deps.getRuntimeKey();
    if (state.runtimeKey !== runtimeKey) {
      const seeded = runtimeKey && deps.storage
        ? readSessionIndexStartupSnapshot(runtimeKey, deps.storage)
        : null;
      setState({
        status: seeded ? 'ready' : 'loading',
        snapshot: seeded,
        error: null,
        runtimeKey,
      });
    } else if (state.status === 'idle') {
      const seeded = runtimeKey && deps.storage
        ? readSessionIndexStartupSnapshot(runtimeKey, deps.storage)
        : null;
      setState({
        status: 'loading',
        snapshot: seeded,
        error: null,
        runtimeKey,
      });
    }
    const result = await loadSessionIndexSnapshot(deps.runtimeFetch, options);
    return applyResult(result, runtimeKey);
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load,
    refresh: load,
    lookupById: (sessionId, options) => lookupSessionIndexById(deps.runtimeFetch, sessionId, options),
    pin: (sessionId, options) => pinSession(deps.runtimeFetch, sessionId, options),
    unpin: (sessionId, options) => unpinSession(deps.runtimeFetch, sessionId, options),
    clearForRuntimeChange: () => {
      setState({ status: 'idle', snapshot: null, error: null, runtimeKey: deps.getRuntimeKey() });
    },
  };
};

/**
 * Hook-shaped reader for Projects home. Lynx / ReactLynx can wrap this with
 * `useSyncExternalStore(store.subscribe, store.getState)`.
 */
export const createSessionIndexHomeBindings = (store: LynxSessionIndexStore) => ({
  subscribe: store.subscribe,
  getSnapshot: store.getState,
  load: store.load,
  refresh: store.refresh,
});
