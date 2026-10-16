import type { Session } from '@/lib/opencode/v2-types'
import { queryOptions } from '@tanstack/react-query';
import { queryClient } from '@/lib/queryRuntime';
import { normalizeDirectoryKey } from '@/lib/pathNormalization';

type LoadSessionChildrenInput = {
  transport: string;
  generation: number;
  directory: string;
  sessionID: string;
  request: (signal: AbortSignal) => Promise<Session[]>;
};

const sessionChildrenQueryOptions = (input: LoadSessionChildrenInput) => queryOptions({
  queryKey: [input.transport, 'sessionChildren', input.generation, normalizeDirectoryKey(input.directory), input.sessionID],
  queryFn: ({ signal }) => input.request(signal),
  staleTime: 0,
  gcTime: 60_000,
  retry: false,
});

export const loadSessionChildrenOnDemand = (input: LoadSessionChildrenInput): Promise<Session[]> => {
  return queryClient.fetchQuery(sessionChildrenQueryOptions(input));
};

const compareSessionId = (left: Session, right: Session): number => (
  left.id < right.id ? -1 : left.id > right.id ? 1 : 0
);

export const mergeSessionChildren = (
  existing: Session[],
  incoming: Session[],
  parentSessionId: string,
): Session[] => {
  const existingIds = new Set(existing.map((session) => session.id));
  const additions = incoming.filter((session) => {
    if (!session?.id || existingIds.has(session.id) || session.parentID !== parentSessionId) return false;
    existingIds.add(session.id);
    return true;
  });
  if (additions.length === 0) return existing;
  return [...existing, ...additions].sort(compareSessionId);
};
