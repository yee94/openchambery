import { useQuery, type QueryClient } from '@tanstack/react-query';
import { opencodeClient } from '@/lib/opencode/client';
import { queryClient, queryKeys } from '@/lib/queryRuntime';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { useProjectsStore } from '@/stores/useProjectsStore';

export type CommandScope = 'user' | 'project';

export interface CommandConfig {
  name: string;
  description?: string;
  agent?: string | null;
  model?: string | null;
  source?: string;
  template?: string;
  scope?: CommandScope;
  reference?: string;
}

export interface Command extends CommandConfig {
  isBuiltIn: boolean;
}

const normalizeDirectory = (directory: string | null | undefined): string | null => directory?.trim() || null;

export const resolveConfigQueryDirectory = (): string | null => {
  const activeProject = useProjectsStore.getState().getActiveProject?.();
  return normalizeDirectory(activeProject?.path) ?? normalizeDirectory(opencodeClient.getDirectory());
};

const commandQueryKey = (directory: string | null, transport = getRuntimeTransportIdentity()) =>
  queryKeys.commands.list(directory, transport);

export const commandQueryOptions = (
  directory: string | null = resolveConfigQueryDirectory(),
  transport = getRuntimeTransportIdentity(),
) => {
  const normalizedDirectory = normalizeDirectory(directory);
  return {
    queryKey: commandQueryKey(normalizedDirectory, transport),
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<Command[]> => {
      const response = await runtimeFetch('/api/config/commands/metadata', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
          ...(normalizedDirectory ? { 'x-opencode-directory': normalizedDirectory } : {}),
        },
        body: JSON.stringify({ catalog: true }),
        query: normalizedDirectory ? { directory: normalizedDirectory } : undefined,
        signal,
      });
      if (!response.ok) {
        throw new Error('Failed to fetch command metadata');
      }
      const data = await response.json() as { commands?: Command[] };
      return Array.isArray(data.commands) ? data.commands : [];
    },
    retry: 2,
  };
};

export const useCommandsQuery = (options: { enabled?: boolean; directory?: string | null } = {}) => {
  const activeProjectPath = useProjectsStore((state) => state.getActiveProject?.()?.path ?? null);
  const directory = normalizeDirectory(options.directory) ?? normalizeDirectory(activeProjectPath) ?? normalizeDirectory(opencodeClient.getDirectory());
  return useQuery({
    ...commandQueryOptions(directory),
    enabled: options.enabled,
  });
};

export const readCommandsSnapshot = (
  directory: string | null = resolveConfigQueryDirectory(),
  transport = getRuntimeTransportIdentity(),
): Command[] => queryClient.getQueryData<Command[]>(commandQueryKey(normalizeDirectory(directory), transport)) ?? [];

export const refreshCommandsQuery = async (
  client: Pick<QueryClient, 'fetchQuery' | 'getQueryData'>,
  directory: string | null,
  transport: string,
): Promise<Command[]> => {
  const normalizedDirectory = normalizeDirectory(directory);
  if (getRuntimeTransportIdentity() !== transport) {
    return client.getQueryData<Command[]>(commandQueryKey(normalizedDirectory, transport)) ?? [];
  }
  const options = commandQueryOptions(normalizedDirectory, transport);
  return client.fetchQuery({ ...options, staleTime: 0 });
};
