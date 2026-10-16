import { queryOptions } from '@tanstack/react-query';
import { opencodeClient } from '@/lib/opencode/client';
import { projectSession, type Session } from '@/lib/opencode/v2-types';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';

export const sessionIdentityQueryOptions = (
  sessionID: string,
  loadSession: (id: string, signal: AbortSignal) => Promise<Session> = async (id, signal) =>
    projectSession(await opencodeClient.getSdkClient().session.get({ sessionID: id }, { signal })),
) => {
  const transport = getRuntimeTransportIdentity();
  const generation = getRuntimeGeneration();
  return queryOptions({
    queryKey: [transport, 'sessionIdentity', generation, sessionID],
    queryFn: async ({ signal }) => {
      const session = await loadSession(sessionID, signal);
      if (transport !== getRuntimeTransportIdentity() || generation !== getRuntimeGeneration()) {
        throw new Error('session identity runtime changed');
      }
      if (session.id !== sessionID || !session.directory) throw new Error('session identity is incomplete');
      return session;
    },
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: 1,
  });
};
