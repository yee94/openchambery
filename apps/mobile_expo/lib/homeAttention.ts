/**
 * Home live attention: unread (turn-complete / error) + running session ids.
 * Cap parity: notification-store + global-session-status, without rebuilding plan/notes/Todo.
 */

import type { OpenChamberEvent } from '@/lib/eventStream';

export type HomeAttentionNotification = {
  session: string;
  directory?: string;
  time: number;
  viewed: boolean;
  type: 'turn-complete' | 'error';
};

export type HomeAttentionState = {
  notifications: HomeAttentionNotification[];
  /** sessionId → busy | retry */
  runningById: Record<string, 'busy' | 'retry'>;
  viewingSessionId: string | null;
};

export type HomeAttentionSnapshot = {
  unseenBySession: Record<string, number>;
  runningSessionIds: ReadonlySet<string>;
  viewingSessionId: string | null;
};

const MAX_NOTIFICATIONS = 500;

export const emptyHomeAttentionState = (): HomeAttentionState => ({
  notifications: [],
  runningById: {},
  viewingSessionId: null,
});

const prune = (list: HomeAttentionNotification[]): HomeAttentionNotification[] =>
  list.length <= MAX_NOTIFICATIONS ? list : list.slice(list.length - MAX_NOTIFICATIONS);

export const buildUnseenBySession = (
  notifications: readonly HomeAttentionNotification[],
): Record<string, number> => {
  const unseen: Record<string, number> = {};
  for (const n of notifications) {
    if (n.viewed) continue;
    unseen[n.session] = (unseen[n.session] ?? 0) + 1;
  }
  return unseen;
};

export const runningSessionIdsFromState = (
  runningById: Readonly<Record<string, 'busy' | 'retry'>>,
): ReadonlySet<string> => new Set(Object.keys(runningById));

export const snapshotHomeAttention = (state: HomeAttentionState): HomeAttentionSnapshot => ({
  unseenBySession: buildUnseenBySession(state.notifications),
  runningSessionIds: runningSessionIdsFromState(state.runningById),
  viewingSessionId: state.viewingSessionId,
});

const eventSessionId = (event: OpenChamberEvent): string | null => {
  const props = (event.properties ?? {}) as Record<string, unknown>;
  if (typeof props.sessionID === 'string' && props.sessionID) return props.sessionID;
  if (typeof props.sessionId === 'string' && props.sessionId) return props.sessionId;
  return null;
};

const eventDirectory = (event: OpenChamberEvent): string | undefined => {
  const props = (event.properties ?? {}) as Record<string, unknown>;
  if (typeof props.directory === 'string' && props.directory) return props.directory;
  return undefined;
};

const normalizeStatusType = (status: unknown): 'busy' | 'retry' | 'idle' => {
  if (status === 'busy' || status === 'running') return 'busy';
  if (status === 'retry') return 'retry';
  if (status && typeof status === 'object') {
    const type = (status as { type?: string }).type;
    if (type === 'busy' || type === 'running') return 'busy';
    if (type === 'retry') return 'retry';
  }
  return 'idle';
};

export const setViewingSession = (
  state: HomeAttentionState,
  sessionId: string | null,
): HomeAttentionState => {
  const nextView = sessionId && sessionId.trim() ? sessionId.trim() : null;
  if (state.viewingSessionId === nextView) return state;
  let notifications = state.notifications;
  if (nextView) {
    const hasUnseen = notifications.some((n) => n.session === nextView && !n.viewed);
    if (hasUnseen) {
      notifications = notifications.map((n) =>
        n.session === nextView && !n.viewed ? { ...n, viewed: true } : n,
      );
    }
  }
  return { ...state, viewingSessionId: nextView, notifications };
};

export const markSessionViewed = (
  state: HomeAttentionState,
  sessionId: string,
): HomeAttentionState => {
  if (!sessionId) return state;
  const hasUnseen = state.notifications.some((n) => n.session === sessionId && !n.viewed);
  if (!hasUnseen) return state;
  return {
    ...state,
    notifications: state.notifications.map((n) =>
      n.session === sessionId && !n.viewed ? { ...n, viewed: true } : n,
    ),
  };
};

/**
 * Apply a global OpenChamber event onto home attention state.
 * Cap: session.idle → turn-complete notification (viewed if currently open);
 * session.status busy/retry → running; idle/error → clear running.
 */
export const applyHomeAttentionEvent = (
  state: HomeAttentionState,
  event: OpenChamberEvent,
  options?: { now?: () => number },
): HomeAttentionState => {
  const now = options?.now ?? Date.now;
  const sessionID = eventSessionId(event);
  if (!sessionID) return state;

  if (event.type === 'session.status') {
    const props = (event.properties ?? {}) as Record<string, unknown>;
    const status = normalizeStatusType(props.status);
    if (status === 'idle') {
      if (!(sessionID in state.runningById)) return state;
      const runningById = { ...state.runningById };
      delete runningById[sessionID];
      return { ...state, runningById };
    }
    if (state.runningById[sessionID] === status) return state;
    return {
      ...state,
      runningById: { ...state.runningById, [sessionID]: status },
    };
  }

  if (event.type === 'session.idle' || event.type === 'session.error') {
    const runningById =
      sessionID in state.runningById
        ? (() => {
            const next = { ...state.runningById };
            delete next[sessionID];
            return next;
          })()
        : state.runningById;

    const viewed = state.viewingSessionId === sessionID;
    const notification: HomeAttentionNotification = {
      session: sessionID,
      directory: eventDirectory(event),
      time: now(),
      viewed,
      type: event.type === 'session.error' ? 'error' : 'turn-complete',
    };

    // Cap only notifies turn-complete on idle (errors are separate). Always append
    // for idle/error so home unread dots update without a session-index refetch.
    return {
      ...state,
      runningById,
      notifications: prune([...state.notifications, notification]),
    };
  }

  return state;
};

type Listener = (snapshot: HomeAttentionSnapshot) => void;

let storeState = emptyHomeAttentionState();
const listeners = new Set<Listener>();

const emit = () => {
  const snap = snapshotHomeAttention(storeState);
  for (const listener of listeners) listener(snap);
};

export const getHomeAttentionSnapshot = (): HomeAttentionSnapshot =>
  snapshotHomeAttention(storeState);

export const resetHomeAttentionStore = (): void => {
  storeState = emptyHomeAttentionState();
  emit();
};

export const subscribeHomeAttention = (listener: Listener): (() => void) => {
  listeners.add(listener);
  listener(snapshotHomeAttention(storeState));
  return () => {
    listeners.delete(listener);
  };
};

export const dispatchHomeAttentionEvent = (
  event: OpenChamberEvent,
  options?: { now?: () => number },
): void => {
  const next = applyHomeAttentionEvent(storeState, event, options);
  if (next === storeState) return;
  storeState = next;
  emit();
};

export const dispatchSetViewingSession = (sessionId: string | null): void => {
  const next = setViewingSession(storeState, sessionId);
  if (next === storeState) return;
  storeState = next;
  emit();
};

export const dispatchMarkSessionViewed = (sessionId: string): void => {
  const next = markSessionViewed(storeState, sessionId);
  if (next === storeState) return;
  storeState = next;
  emit();
};
