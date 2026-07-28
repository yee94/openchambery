import { queryOptions, type QueryClient } from '@tanstack/react-query';

import { opencodeClient } from '@/lib/opencode/client';
import { queryClient as defaultQueryClient, queryKeys } from '@/lib/queryRuntime';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';

export type DirectorySessionStatusSnapshot = NonNullable<
  Awaited<ReturnType<typeof opencodeClient.getSessionStatusForDirectory>>
>;

export type DirectorySessionStatusSnapshotObservation = {
  readonly snapshot: DirectorySessionStatusSnapshot;
  readonly requestedAt: number;
};

export type DirectorySessionStatusSnapshotLoader = (
  directory: string,
  signal?: AbortSignal,
) => Promise<DirectorySessionStatusSnapshot | null>;

export type SessionStatusRuntimeProbe = {
  getTransport?: () => string;
  getGeneration?: () => number;
};

type SessionStatusSnapshotQueryOptions = {
  transport?: string;
  loadSnapshot?: DirectorySessionStatusSnapshotLoader;
  now?: () => number;
  runtimeProbe?: SessionStatusRuntimeProbe;
};

type FetchDirectorySessionStatusSnapshotOptions = SessionStatusSnapshotQueryOptions & {
  client?: Pick<QueryClient, 'fetchQuery'>;
};

const normalizeDirectory = (directory: string): string => directory.trim();

const assertRuntimeCurrent = (
  transport: string,
  generation: number,
  probe: SessionStatusRuntimeProbe,
): void => {
  const currentTransport = (probe.getTransport ?? getRuntimeTransportIdentity)();
  const currentGeneration = (probe.getGeneration ?? getRuntimeGeneration)();
  if (currentTransport !== transport || currentGeneration !== generation) {
    throw new Error('session status runtime changed');
  }
};

export const sessionStatusSnapshotQueryOptions = (
  directory: string,
  options: SessionStatusSnapshotQueryOptions = {},
) => {
  const normalizedDirectory = normalizeDirectory(directory);
  const transport = options.transport ?? getRuntimeTransportIdentity();
  const loadSnapshot = options.loadSnapshot
    ?? ((targetDirectory: string, signal?: AbortSignal) => (
      opencodeClient.getSessionStatusForDirectory(targetDirectory, signal)
    ));
  const now = options.now ?? Date.now;
  const runtimeProbe = options.runtimeProbe ?? {};
  const generation = (runtimeProbe.getGeneration ?? getRuntimeGeneration)();

  return queryOptions({
    queryKey: queryKeys.sessionStatus.snapshot(normalizedDirectory, transport),
    queryFn: async ({ signal }): Promise<DirectorySessionStatusSnapshotObservation> => {
      assertRuntimeCurrent(transport, generation, runtimeProbe);
      const requestedAt = now();
      const snapshot = await loadSnapshot(normalizedDirectory, signal);
      assertRuntimeCurrent(transport, generation, runtimeProbe);
      if (snapshot === null) {
        throw new Error('session status snapshot unavailable');
      }
      return { snapshot, requestedAt };
    },
    staleTime: 0,
    gcTime: 5 * 60_000,
    retry: false,
  });
};

export const fetchDirectorySessionStatusSnapshot = (
  directory: string,
  options: FetchDirectorySessionStatusSnapshotOptions = {},
): Promise<DirectorySessionStatusSnapshotObservation> => {
  const { client = defaultQueryClient, ...queryOptionsInput } = options;
  return client.fetchQuery(sessionStatusSnapshotQueryOptions(directory, queryOptionsInput));
};
