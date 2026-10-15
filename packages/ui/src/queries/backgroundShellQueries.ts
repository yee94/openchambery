import { queryOptions, useQuery } from '@tanstack/react-query';
import { opencodeClient } from '@/lib/opencode/client';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { normalizeDirectoryKey } from '@/lib/pathNormalization';

export const backgroundShellQueryOptions = (directory: string, ids: readonly string[]) => queryOptions({
    queryKey: [getRuntimeTransportIdentity(), 'backgroundShells', normalizeDirectoryKey(directory), ids],
    queryFn: async ({ signal }) => {
        const result = await opencodeClient.getScopedSdkClient(directory).shell.list({ location: { directory } }, { signal });
        if (!Array.isArray(result.data)) throw new Error('Invalid shell list response');
        const wanted = new Set(ids);
        return result.data.filter((shell) => wanted.has(shell.id));
    },
    staleTime: 1_000,
    retry: 1,
});

export function useBackgroundShells(directory: string, ids: readonly string[]) {
    return useQuery({
        ...backgroundShellQueryOptions(directory, ids),
        enabled: ids.length > 0,
        // Background shells have no terminal tool patch. Check live authority
        // while one is running; a successful terminal/empty result stops polling.
        refetchInterval: (query) => query.state.data?.some((shell) => shell.status === 'running') ? 3_000 : false,
    });
}

export const backgroundShellOutputQueryOptions = (directory: string, id: string) => queryOptions({
    queryKey: [getRuntimeTransportIdentity(), 'backgroundShellOutput', normalizeDirectoryKey(directory), id],
    queryFn: ({ signal }) => opencodeClient.getScopedSdkClient(directory).shell.output(
        { id, location: { directory }, limit: 65_536 }, { signal },
    ).then((result) => result.data),
    staleTime: 1_000,
    retry: 1,
});
