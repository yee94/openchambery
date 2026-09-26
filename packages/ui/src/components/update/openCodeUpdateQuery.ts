import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import type { OpenCodeUpgradeStatusLike } from './openCodeUpdateDedup';

export const openCodeUpdateQueryOptions = (transport: string, generation: number) => ({
  queryKey: [transport, 'opencode-update', generation] as const,
  queryFn: async ({ signal }: { signal: AbortSignal }): Promise<OpenCodeUpgradeStatusLike> => {
    const current = () => transport === getRuntimeTransportIdentity() && generation === getRuntimeGeneration();
    if (!current()) throw new Error('Stale OpenCode update check');
    const response = await runtimeFetch('/api/opencode/upgrade-status', { headers: { Accept: 'application/json' }, signal });
    if (!response.ok) throw new Error('OpenCode update check failed');
    const status = await response.json();
    if (signal.aborted || !current()) throw new Error('Stale OpenCode update check');
    if (!status || typeof status !== 'object' || Array.isArray(status)) throw new Error('Invalid OpenCode update status');
    return status;
  },
  staleTime: 30_000,
  refetchInterval: 5 * 60_000,
  refetchOnWindowFocus: true,
  refetchOnReconnect: true,
  retry: 1,
});
