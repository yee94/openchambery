import { type QueryClient } from '@tanstack/react-query';
import { loadSessionIndexSnapshot, type SessionIndexSnapshot } from '@/lib/session-index-api';
import { queryClient, queryKeys } from '@/lib/queryRuntime';
import {
  getRuntimeKey,
  getRuntimeTransportIdentity,
} from '@/lib/runtime-switch';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';
import {
  isSessionIndexSnapshot,
  readSessionIndexStartupSnapshot,
  writeSessionIndexStartupSnapshot,
  type SessionIndexStartupStorage,
} from './sessionIndexStartupCache';

type SessionIndexSnapshotLoader = (options?: { signal?: AbortSignal }) => Promise<SessionIndexSnapshot | null>;

const snapshotKey = (transport = getRuntimeTransportIdentity()) => queryKeys.sessionIndex.snapshot(transport);

/**
 * Session-index GET SWR options.
 * Memory key is transport-scoped; persistent cold-start cache is runtimeKey-scoped
 * so a paired host can reuse LAN↔relay paint data across transport switches.
 */
export const sessionIndexSnapshotQueryOptions = (
  transport = getRuntimeTransportIdentity(),
  runtimeKey = getRuntimeKey(),
  storage: SessionIndexStartupStorage = getDeferredSafeStorage(),
  load: SessionIndexSnapshotLoader = loadSessionIndexSnapshot,
) => {
  const capturedRuntimeKey = runtimeKey;
  const capturedStorage = storage;
  const capturedLoad = load;
  return {
    queryKey: snapshotKey(transport),
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<SessionIndexSnapshot | null> => {
      const snapshot = await capturedLoad({ signal });
      // null is a legitimate unsupported/501 result — never persist it as success.
      if (snapshot) {
        writeSessionIndexStartupSnapshot(capturedRuntimeKey, snapshot, capturedStorage);
      }
      return snapshot;
    },
    staleTime: 0,
    gcTime: Infinity,
    initialData: () => readSessionIndexStartupSnapshot(capturedRuntimeKey, capturedStorage) ?? undefined,
    initialDataUpdatedAt: 0,
  };
};

export const readSessionIndexSnapshotQuery = (
  client: Pick<QueryClient, 'getQueryData'> = queryClient,
  transport = getRuntimeTransportIdentity(),
): SessionIndexSnapshot | null => (
  client.getQueryData<SessionIndexSnapshot | null>(snapshotKey(transport)) ?? null
);

/**
 * Builds the query entry so `initialData` (runtimeKey storage) is visible immediately
 * without waiting for a network round-trip. Returns the seeded snapshot if any.
 */
export const seedSessionIndexSnapshotQuery = (
  client: Pick<QueryClient, 'getQueryCache' | 'getQueryData'> = queryClient,
  transport = getRuntimeTransportIdentity(),
  runtimeKey = getRuntimeKey(),
  storage: SessionIndexStartupStorage = getDeferredSafeStorage(),
): SessionIndexSnapshot | null => {
  const options = sessionIndexSnapshotQueryOptions(transport, runtimeKey, storage);
  client.getQueryCache().build(client as QueryClient, options);
  return client.getQueryData<SessionIndexSnapshot | null>(options.queryKey) ?? null;
};

/** Seeds Query memory + optional persistent cache without issuing a network request. */
export const writeSessionIndexSnapshotQuery = (
  snapshot: SessionIndexSnapshot,
  options?: {
    client?: Pick<QueryClient, 'setQueryData'>;
    transport?: string;
    runtimeKey?: string;
    storage?: SessionIndexStartupStorage;
    persist?: boolean;
  },
): void => {
  if (!isSessionIndexSnapshot(snapshot)) return;
  const client = options?.client ?? queryClient;
  const transport = options?.transport ?? getRuntimeTransportIdentity();
  const runtimeKey = options?.runtimeKey ?? getRuntimeKey();
  const storage = options?.storage ?? getDeferredSafeStorage();
  client.setQueryData(snapshotKey(transport), snapshot);
  if (options?.persist !== false) {
    writeSessionIndexStartupSnapshot(runtimeKey, snapshot, storage);
  }
};

/**
 * Ensures the query is present (cold storage seed + background fetch when stale).
 * Prefer for non-React consumers that need the latest authoritative snapshot.
 */
export const ensureSessionIndexSnapshotQuery = (
  client: Pick<QueryClient, 'fetchQuery' | 'getQueryCache'> = queryClient,
  transport = getRuntimeTransportIdentity(),
  runtimeKey = getRuntimeKey(),
  storage: SessionIndexStartupStorage = getDeferredSafeStorage(),
  load: SessionIndexSnapshotLoader = loadSessionIndexSnapshot,
): Promise<SessionIndexSnapshot | null> => {
  const options = sessionIndexSnapshotQueryOptions(transport, runtimeKey, storage, load);
  // Build first so initialData is visible immediately on cold cache.
  client.getQueryCache().build(client as QueryClient, options);
  return client.fetchQuery(options);
};

/** Forces a network revalidation; failures retain prior Query data (and storage seed). */
export const refreshSessionIndexSnapshotQuery = (
  client: Pick<QueryClient, 'fetchQuery' | 'getQueryCache'> = queryClient,
  transport = getRuntimeTransportIdentity(),
  runtimeKey = getRuntimeKey(),
  storage: SessionIndexStartupStorage = getDeferredSafeStorage(),
  load: SessionIndexSnapshotLoader = loadSessionIndexSnapshot,
): Promise<SessionIndexSnapshot | null> => {
  const options = {
    ...sessionIndexSnapshotQueryOptions(transport, runtimeKey, storage, load),
    staleTime: 0 as const,
  };
  client.getQueryCache().build(client as QueryClient, options);
  return client.fetchQuery(options);
};
