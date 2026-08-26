import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { useEvent } from '@reactuses/core';
import type { Session } from '@opencode-ai/sdk/v2';
import { toast } from '@/components/ui';
import { formatMessage, useI18nStore, type I18nKey, type I18nParams } from '@/lib/i18n';
import {
  pinSession,
  unpinSession,
  type SessionIndexSession,
  type SessionIndexSnapshot,
} from '@/lib/session-index-api';
import { queryClient } from '@/lib/queryRuntime';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import {
  readSessionIndexSnapshotQuery,
  writeSessionIndexSnapshotQuery,
} from './sessionIndexQueries';

const EMPTY_PINNED_SESSION_IDS: ReadonlySet<string> = new Set();

/** Cache so useSyncExternalStore keeps a stable snapshot when membership is unchanged. */
let cachedPinnedSnapshot: SessionIndexSnapshot | null | undefined;
let cachedPinnedIds: ReadonlySet<string> = EMPTY_PINNED_SESSION_IDS;
let cachedPinnedTransport: string | null = null;

const t = (key: I18nKey, params?: I18nParams): string => (
  formatMessage(useI18nStore.getState().dictionary, key, params)
);

type SessionTimeWithPinned = Session['time'] & {
  pinned?: string | number | null;
};

/** Non-null `time.pinned` means the session is pinned (ISO string or numeric timestamp). */
export const isSessionIndexPinned = (
  session: { time?: SessionTimeWithPinned } | null | undefined,
): boolean => {
  const pinned = session?.time?.pinned;
  return pinned != null && pinned !== '';
};

export const derivePinnedSessionIdsFromSnapshot = (
  snapshot: SessionIndexSnapshot | null | undefined,
): ReadonlySet<string> => {
  if (!snapshot) return EMPTY_PINNED_SESSION_IDS;
  const ids = new Set<string>();
  if (Array.isArray(snapshot.pinnedSessionIds)) {
    for (const id of snapshot.pinnedSessionIds) {
      if (typeof id === 'string' && id) ids.add(id);
    }
  }
  for (const directory of snapshot.directories) {
    for (const session of directory.sessions) {
      if (isSessionIndexPinned(session)) {
        ids.add(session.id);
      }
    }
  }
  return ids.size === 0 ? EMPTY_PINNED_SESSION_IDS : ids;
};

const samePinnedMembership = (left: ReadonlySet<string>, right: ReadonlySet<string>): boolean => {
  if (left === right) return true;
  if (left.size !== right.size) return false;
  for (const id of left) {
    if (!right.has(id)) return false;
  }
  return true;
};

export const readPinnedSessionIds = (
  client: Pick<QueryClient, 'getQueryData'> = queryClient,
  transport = getRuntimeTransportIdentity(),
): ReadonlySet<string> => {
  const snapshot = readSessionIndexSnapshotQuery(client, transport);
  if (snapshot === cachedPinnedSnapshot && transport === cachedPinnedTransport) {
    return cachedPinnedIds;
  }
  const next = derivePinnedSessionIdsFromSnapshot(snapshot);
  cachedPinnedSnapshot = snapshot;
  cachedPinnedTransport = transport;
  cachedPinnedIds = samePinnedMembership(cachedPinnedIds, next) ? cachedPinnedIds : next;
  return cachedPinnedIds;
};

export const patchSessionIndexPinned = (
  snapshot: SessionIndexSnapshot,
  sessionId: string,
  pinned: string | null,
): SessionIndexSnapshot => {
  let changed = false;
  const directories = snapshot.directories.map((directory) => {
    let directoryChanged = false;
    const sessions = directory.sessions.map((session: SessionIndexSession) => {
      if (session.id !== sessionId) return session;
      const current = session.time?.pinned ?? null;
      const normalizedCurrent = current == null || current === '' ? null : current;
      if (normalizedCurrent === pinned) return session;
      directoryChanged = true;
      changed = true;
      return {
        ...session,
        time: {
          ...session.time,
          pinned,
        },
      };
    });
    return directoryChanged ? { ...directory, sessions } : directory;
  });
  const currentIds = derivePinnedSessionIdsFromSnapshot(snapshot);
  const nextIds = new Set(currentIds);
  if (pinned == null || pinned === '') nextIds.delete(sessionId);
  else nextIds.add(sessionId);
  if (!samePinnedMembership(currentIds, nextIds)) changed = true;
  if (!changed) return snapshot;
  return {
    ...snapshot,
    directories,
    pinnedSessionIds: [...nextIds],
  };
};

type SessionPinMutationVariables = {
  sessionId: string;
  nextPinned: boolean;
  transport: string;
};

type SessionPinMutationContext = {
  previous: SessionIndexSnapshot | null;
  transport: string;
};

const applyOptimisticPin = (
  client: Pick<QueryClient, 'getQueryData' | 'setQueryData'>,
  transport: string,
  sessionId: string,
  nextPinned: boolean,
): SessionIndexSnapshot | null => {
  const previous = readSessionIndexSnapshotQuery(client, transport);
  if (!previous) return null;
  const pinnedValue = nextPinned ? new Date().toISOString() : null;
  const next = patchSessionIndexPinned(previous, sessionId, pinnedValue);
  if (next !== previous) {
    writeSessionIndexSnapshotQuery(next, { client, transport, persist: false });
  }
  return previous;
};

/**
 * Toggle pin via session-index. No-op when the snapshot is null/unsupported.
 * Network failures roll back the optimistic patch and surface a toast.
 */
export const togglePinnedSession = async (
  sessionId: string,
  options?: {
    client?: Pick<QueryClient, 'getQueryData' | 'setQueryData'>;
    transport?: string;
  },
): Promise<void> => {
  const id = sessionId.trim();
  if (!id) return;
  const client = options?.client ?? queryClient;
  const transport = options?.transport ?? getRuntimeTransportIdentity();
  const snapshot = readSessionIndexSnapshotQuery(client, transport);
  // Unsupported / unavailable: empty pins are legitimate; do not request or toast.
  if (!snapshot) return;

  const currentlyPinned = derivePinnedSessionIdsFromSnapshot(snapshot).has(id);
  const nextPinned = !currentlyPinned;
  const previous = applyOptimisticPin(client, transport, id, nextPinned);
  try {
    if (nextPinned) {
      await pinSession(id);
    } else {
      await unpinSession(id);
    }
  } catch (error) {
    if (previous) {
      writeSessionIndexSnapshotQuery(previous, { client, transport, persist: false });
    }
    toast.error(error instanceof Error
      ? error.message
      : t(nextPinned
        ? 'sessions.sidebar.session.pin.error'
        : 'sessions.sidebar.session.unpin.error'));
    throw error;
  }
};

const subscribePinnedSessionIds = (onStoreChange: () => void): (() => void) => {
  const cache = queryClient.getQueryCache();
  return cache.subscribe((event) => {
    if (event.type !== 'updated' && event.type !== 'removed') return;
    const key = event.query.queryKey;
    if (!Array.isArray(key) || key[1] !== 'sessionIndex' || key[2] !== 'snapshot') return;
    onStoreChange();
  });
};

const getPinnedSessionIdsSnapshot = (): ReadonlySet<string> => readPinnedSessionIds();

/** Reactive pinned-id set derived from the session-index snapshot Query cache. */
export const usePinnedSessionIds = (): ReadonlySet<string> => (
  useSyncExternalStore(subscribePinnedSessionIds, getPinnedSessionIdsSnapshot, () => EMPTY_PINNED_SESSION_IDS)
);

export const useTogglePinnedSession = (): ((sessionId: string) => void) => {
  const client = useQueryClient();
  const mutation = useMutation<void, Error, SessionPinMutationVariables, SessionPinMutationContext>({
    mutationKey: ['sessionIndex', 'pin'],
    mutationFn: async ({ sessionId, nextPinned }) => {
      if (nextPinned) {
        await pinSession(sessionId);
      } else {
        await unpinSession(sessionId);
      }
    },
    onMutate: ({ sessionId, nextPinned, transport: mutationTransport }) => {
      const previous = applyOptimisticPin(client, mutationTransport, sessionId, nextPinned);
      return { previous, transport: mutationTransport };
    },
    onError: (error, variables, context) => {
      if (context?.previous) {
        writeSessionIndexSnapshotQuery(context.previous, {
          client,
          transport: context.transport,
          persist: false,
        });
      }
      toast.error(error instanceof Error
        ? error.message
        : t(variables.nextPinned
          ? 'sessions.sidebar.session.pin.error'
          : 'sessions.sidebar.session.unpin.error'));
    },
  });

  return useEvent((sessionId: string) => {
    const id = sessionId.trim();
    if (!id) return;
    // Resolve transport at click time so a host switch cannot pin against a stale cache key.
    const transport = getRuntimeTransportIdentity();
    const snapshot = readSessionIndexSnapshotQuery(client, transport);
    if (!snapshot) return;
    const currentlyPinned = derivePinnedSessionIdsFromSnapshot(snapshot).has(id);
    mutation.mutate({
      sessionId: id,
      nextPinned: !currentlyPinned,
      transport,
    });
  });
};
