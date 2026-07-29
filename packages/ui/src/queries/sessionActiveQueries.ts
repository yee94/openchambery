import { queryOptions, type QueryClient } from '@tanstack/react-query';

import {
  opencodeClient,
  type SessionActiveResult,
} from '@/lib/opencode/client';
import { queryClient as defaultQueryClient, queryKeys } from '@/lib/queryRuntime';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';

type SessionActiveSnapshotObservation = {
  readonly result: SessionActiveResult;
  readonly requestedAt: number;
};

export type SessionActiveSnapshotLoader = (
  signal?: AbortSignal,
) => Promise<SessionActiveResult>;

export type SessionActiveRuntimeProbe = {
  getTransport?: () => string;
  getGeneration?: () => number;
};

type SessionActiveSnapshotQueryOptions = {
  transport?: string;
  loadActive?: SessionActiveSnapshotLoader;
  now?: () => number;
  runtimeProbe?: SessionActiveRuntimeProbe;
};

type FetchSessionActiveSnapshotOptions = SessionActiveSnapshotQueryOptions & {
  client?: Pick<QueryClient, 'fetchQuery'>;
};

const assertRuntimeCurrent = (
  transport: string,
  generation: number,
  probe: SessionActiveRuntimeProbe,
): void => {
  const currentTransport = (probe.getTransport ?? getRuntimeTransportIdentity)();
  const currentGeneration = (probe.getGeneration ?? getRuntimeGeneration)();
  if (currentTransport !== transport || currentGeneration !== generation) {
    throw new Error('session active runtime changed');
  }
};

/**
 * Transport- and generation-scoped single-flight for `v2.session.active`.
 * Process-global membership is shared across all directory reconnect callers
 * on the same transport+generation — only one HTTP request is issued per key.
 * A new runtime generation never reuses an older in-flight request or cache
 * entry even when transport identity is unchanged.
 */
export const sessionActiveSnapshotQueryOptions = (
  options: SessionActiveSnapshotQueryOptions = {},
) => {
  const transport = options.transport ?? getRuntimeTransportIdentity();
  const loadActive = options.loadActive
    ?? ((signal?: AbortSignal) => opencodeClient.getSessionActive(signal));
  const now = options.now ?? Date.now;
  const runtimeProbe = options.runtimeProbe ?? {};
  // Capture generation once so the Query key and both assertRuntimeCurrent
  // checks share the same generation-scoped identity.
  const generation = (runtimeProbe.getGeneration ?? getRuntimeGeneration)();

  return queryOptions({
    queryKey: queryKeys.sessionActive.snapshot(transport, generation),
    queryFn: async ({ signal }): Promise<SessionActiveSnapshotObservation> => {
      assertRuntimeCurrent(transport, generation, runtimeProbe);
      const requestedAt = now();
      const result = await loadActive(signal);
      assertRuntimeCurrent(transport, generation, runtimeProbe);
      return { result, requestedAt };
    },
    staleTime: 0,
    gcTime: 5 * 60_000,
    retry: false,
  });
};

export const fetchSessionActiveSnapshot = (
  options: FetchSessionActiveSnapshotOptions = {},
): Promise<SessionActiveSnapshotObservation> => {
  const { client = defaultQueryClient, ...queryOptionsInput } = options;
  return client.fetchQuery(sessionActiveSnapshotQueryOptions(queryOptionsInput));
};
