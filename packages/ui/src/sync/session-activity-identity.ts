import type { QueryClient } from '@tanstack/react-query';
import type { Session } from '@/lib/opencode/v2-types';
import { queryClient } from '@/lib/queryRuntime';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { sessionIdentityQueryOptions } from '@/queries/sessionIdentityQueries';
import type { ChildStoreManager } from './child-store';
import { useGlobalSessionStatusStore } from './global-session-status';
import { stripSessionDiffSnapshots } from './sanitize';

/** Recover only live sessions' missing ancestry, never their transcripts or a full catalog. */
export function mountSessionActivityIdentitySync(
  children: ChildStoreManager,
  options: {
    client?: QueryClient;
    loadSession?: (id: string, signal: AbortSignal) => Promise<Session>;
  } = {},
): () => void {
  const client = options.client ?? queryClient;
  const pending = new Set<string>();
  const failedUntil = new Map<string, number>();
  let disposed = false;
  let scheduled = false;

  const schedule = () => {
    if (disposed || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!disposed) drain();
    });
  };

  const drain = () => {
    const known = new Map<string, Session>();
    for (const session of useGlobalSessionsStore.getState().activeSessions) known.set(session.id, session);
    const active = new Set(useGlobalSessionStatusStore.getState().statusById.keys());
    for (const store of children.children.values()) {
      const state = store.getState();
      for (const session of state.session) known.set(session.id, session);
      for (const [id, status] of Object.entries(state.session_status)) {
        if (status.type === 'busy' || status.type === 'retry') active.add(id);
      }
    }
    const needed = new Set<string>();
    for (const id of active) {
      const visited = new Set<string>();
      let current: string | undefined = id;
      while (current && !visited.has(current)) {
        visited.add(current);
        const session = known.get(current);
        if (!session) { needed.add(current); break; }
        current = session.parentID;
      }
    }
    for (const id of failedUntil.keys()) if (!needed.has(id)) failedUntil.delete(id);
    for (const id of needed) {
      if (pending.size >= 2) break;
      if (pending.has(id) || (failedUntil.get(id) ?? 0) > Date.now()) continue;
      pending.add(id);
      const transport = getRuntimeTransportIdentity();
      const generation = getRuntimeGeneration();
      const current = () => !disposed && transport === getRuntimeTransportIdentity() && generation === getRuntimeGeneration();
      void client.fetchQuery(sessionIdentityQueryOptions(id, options.loadSession)).then((session) => {
        const directory = session.directory;
        if (!current() || !directory) return;
        // A live move/create in another directory supersedes this missing-identity read.
        for (const store of children.children.values()) {
          if (store.getState().session.some((item) => item.id === id)) return;
        }
        const store = children.ensureChild(directory, { bootstrap: false });
        store.setState((state) => {
          // A newer live identity may have arrived while GET was pending.
          if (state.session.some((item) => item.id === id)) return state;
          return { session: [...state.session, stripSessionDiffSnapshots(session)].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) };
        });
      }).catch(() => {
        // Preserve live status on failure; a later lifecycle/catalog change can retry.
        if (current()) failedUntil.set(id, Date.now() + 30_000);
      }).finally(() => {
        pending.delete(id);
        schedule();
      });
    }
  };

  const unsubscribes = [
    children.subscribeAllSelected((state) => state.session_status, schedule),
    children.subscribeAllSelected((state) => state.session, schedule),
    useGlobalSessionStatusStore.subscribe(schedule),
    useGlobalSessionsStore.subscribe((state, previous) => {
      if (state.activeSessions !== previous.activeSessions) schedule();
    }),
  ];
  schedule();
  return () => {
    disposed = true;
    unsubscribes.forEach((unsubscribe) => unsubscribe());
  };
}
