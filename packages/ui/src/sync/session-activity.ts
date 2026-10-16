import type { Session } from '@/lib/opencode/v2-types';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import type { ChildStoreManager } from './child-store';
import { useGlobalSessionStatusStore } from './global-session-status';
import { aggregateLiveSessionStatuses } from './live-aggregate';

export function collectRunningSessionIds(
  liveStatuses: Record<string, { type: string }>,
  fallbackStatusById: ReadonlyMap<string, unknown>,
): Set<string> {
  const ids = new Set<string>();
  for (const [id, status] of Object.entries(liveStatuses)) {
    if (status.type === 'busy' || status.type === 'retry') ids.add(id);
  }
  for (const id of fallbackStatusById.keys()) {
    if (liveStatuses[id] === undefined) ids.add(id);
  }
  return ids;
}

// Presentation only: never write descendant activity into execution/send/queue status.
function createSessionActivityReader(children: ChildStoreManager) {
  let snapshot: ReadonlySet<string> = new Set();
  let descendantCounts = new Map<string, number>();
  let dirty = true;
  let cleanup: (() => void) | undefined;
  const listeners = new Set<() => void>();

  const read = (): ReadonlySet<string> => {
    if (!dirty && cleanup) return snapshot;
    dirty = false;
    const states = Array.from(children.children.values(), (store) => store.getState());
    const sessions = new Map<string, Session>();
    for (const session of useGlobalSessionsStore.getState().activeSessions) sessions.set(session.id, session);
    for (const state of states) {
      for (const session of state.session) {
        const current = sessions.get(session.id);
        if (!current || (session.time?.updated ?? 0) >= (current.time?.updated ?? 0)) sessions.set(session.id, session);
      }
    }
    const statuses = aggregateLiveSessionStatuses(states);
    const active = collectRunningSessionIds(statuses, useGlobalSessionStatusStore.getState().statusById);
    const next = new Set<string>();
    const nextCounts = new Map<string, number>();
    for (const id of active) {
      const visited = new Set<string>();
      let ancestor: string | undefined = id;
      while (ancestor && !visited.has(ancestor)) {
        visited.add(ancestor);
        next.add(ancestor);
        if (ancestor !== id) nextCounts.set(ancestor, (nextCounts.get(ancestor) ?? 0) + 1);
        ancestor = sessions.get(ancestor)?.parentID;
      }
    }
    if (nextCounts.size !== descendantCounts.size
      || [...nextCounts].some(([id, count]) => descendantCounts.get(id) !== count)) descendantCounts = nextCounts;
    if (next.size !== snapshot.size || [...next].some((id) => !snapshot.has(id))) snapshot = next;
    return snapshot;
  };

  const invalidate = () => {
    dirty = true;
    const before = snapshot;
    const countsBefore = descendantCounts;
    if (read() !== before || descendantCounts !== countsBefore) for (const listener of listeners) listener();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    if (!cleanup) {
      const unsubscribeStatus = children.subscribeAllSelected((state) => state.session_status, invalidate);
      const unsubscribeSessions = children.subscribeAllSelected((state) => state.session, invalidate);
      const unsubscribeFallback = useGlobalSessionStatusStore.subscribe(invalidate);
      const unsubscribeCatalog = useGlobalSessionsStore.subscribe((state, previous) => {
        if (state.activeSessions !== previous.activeSessions) invalidate();
      });
      cleanup = () => {
        unsubscribeStatus();
        unsubscribeSessions();
        unsubscribeFallback();
        unsubscribeCatalog();
      };
      invalidate();
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        cleanup?.();
        cleanup = undefined;
        dirty = true;
      }
    };
  };
  const readDescendantCount = (sessionID: string) => {
    read();
    return descendantCounts.get(sessionID) ?? 0;
  };
  return { read, readDescendantCount, subscribe };
}

// One projection per runtime's child-store manager, not one tree scan per row.
const readers = new WeakMap<ChildStoreManager, ReturnType<typeof createSessionActivityReader>>();
export function getSessionActivityReader(children: ChildStoreManager) {
  let reader = readers.get(children);
  if (!reader) {
    reader = createSessionActivityReader(children);
    readers.set(children, reader);
  }
  return reader;
}
