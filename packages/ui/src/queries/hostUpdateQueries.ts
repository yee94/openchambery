import { useQuery } from '@tanstack/react-query';
import { queryClient } from '@/lib/queryRuntime';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';

export type UpdateChannel = 'stable' | 'beta';
export type HostUpdateOperation = {
  id: string; planId: string; version: string; channel: UpdateChannel;
  kind: 'ota' | 'installer' | 'cli-package';
  status: 'checking' | 'downloading' | 'installing' | 'restarting' | 'succeeded' | 'failed';
  progress: number | null; error: string | null;
};
export type HostUpdateSnapshot = {
  serverId: string; host: 'electron' | 'cli'; currentVersion: string; channel: UpdateChannel;
  supported: boolean; reason: string | null; checkError: string | null;
  update: null | { version: string; releaseNotes: string | null; kind: HostUpdateOperation['kind']; planId: string; rollback: boolean; restartRequired: boolean };
  operation: HostUpdateOperation | null;
};
export const isHostUpdateActive = (operation: HostUpdateOperation | null | undefined) => Boolean(operation && !['succeeded', 'failed'].includes(operation.status));

function assertScope(transport: string, generation: number) {
  if (transport !== getRuntimeTransportIdentity() || generation !== getRuntimeGeneration()) throw new Error('Stale update runtime');
}
export const hostUpdateQueryOptions = (transport = getRuntimeTransportIdentity(), generation = getRuntimeGeneration(), channel?: UpdateChannel) => ({
  queryKey: [transport, 'host-update', generation, channel ?? 'current'] as const,
  queryFn: async ({ signal }: { signal: AbortSignal }): Promise<HostUpdateSnapshot> => {
    assertScope(transport, generation);
    const response = await runtimeFetch(`/api/system/update${channel ? `?channel=${channel}` : ''}`, { headers: { Accept: 'application/json' }, signal });
    if ([404, 501].includes(response.status)) throw new Error('host_update_unsupported');
    const body = await response.json();
    assertScope(transport, generation);
    if ((!response.ok && response.status !== 502) || typeof body.serverId !== 'string' || typeof body.supported !== 'boolean' || !['cli', 'electron'].includes(body.host)) throw new Error('Host update check failed');
    return body;
  },
  staleTime: 60_000,
  retry: false,
});
const readHostUpdateSnapshot = (transport = getRuntimeTransportIdentity(), generation = getRuntimeGeneration(), channel?: UpdateChannel) =>
  queryClient.getQueryData<HostUpdateSnapshot>(hostUpdateQueryOptions(transport, generation, channel).queryKey);
export const ensureHostUpdateSnapshot = (transport = getRuntimeTransportIdentity(), generation = getRuntimeGeneration(), channel?: UpdateChannel) => {
  const previous = readHostUpdateSnapshot(transport, generation, channel);
  return queryClient.fetchQuery({ ...hostUpdateQueryOptions(transport, generation, channel),
    staleTime: previous?.checkError || isHostUpdateActive(previous?.operation) ? 0 : 60_000 });
};
export const refreshHostUpdateSnapshot = (transport = getRuntimeTransportIdentity(), generation = getRuntimeGeneration(), channel?: UpdateChannel) =>
  queryClient.fetchQuery({ ...hostUpdateQueryOptions(transport, generation, channel), staleTime: 0 });
export const useHostUpdate = (transport: string, generation: number, channel?: UpdateChannel) => useQuery({
  ...hostUpdateQueryOptions(transport, generation, channel),
  refetchInterval: (query) => query.state.error?.message === 'host_update_unsupported' ? false
    : query.state.error ? 15_000 : isHostUpdateActive(query.state.data?.operation) ? 2_000 : 5 * 60_000,
  refetchIntervalInBackground: false,
});

export async function startHostUpdate(snapshot: HostUpdateSnapshot, transport: string, generation: number): Promise<HostUpdateOperation> {
  assertScope(transport, generation);
  if (!snapshot.update) throw new Error('No update plan');
  const response = await runtimeFetch('/api/system/update', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ version: snapshot.update.version, channel: snapshot.channel, planId: snapshot.update.planId, allowDowngrade: snapshot.update.rollback === true }),
  });
  assertScope(transport, generation);
  if (!response.ok) throw new Error('Host update was not accepted');
  const body = await response.json();
  if (typeof body.operation?.id !== 'string') throw new Error('Invalid update operation');
  return body.operation;
}
