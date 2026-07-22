import { useQuery, type QueryClient } from '@tanstack/react-query';
import { queryClient, queryKeys } from '@/lib/queryRuntime';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { opencodeClient } from '@/lib/opencode/client';
import type { DiscoveredSkill, SkillScope, SkillSource } from '@/stores/useSkillsStore';

type RawSkillResponse = {
  name: string;
  path: string;
  scope?: SkillScope;
  source?: SkillSource;
  description?: string;
};

const normalizeDirectory = (directory: string | null | undefined): string | null => directory?.trim() || null;

export const resolveInstalledSkillsQueryDirectory = (): string | null => {
  const activeProject = useProjectsStore.getState().getActiveProject?.();
  return normalizeDirectory(activeProject?.path) ?? normalizeDirectory(opencodeClient.getDirectory());
};

const parseSkillGroup = (path: string): string | undefined => {
  const normalizedPath = path.replace(/\\/g, '/');
  const index = normalizedPath.lastIndexOf('/skills/');
  if (index === -1) return undefined;
  const parts = normalizedPath.slice(index + '/skills/'.length).split('/');
  return parts.length >= 3 ? parts[0] : undefined;
};

const installedSkillsQueryKey = (directory: string | null, transport = getRuntimeTransportIdentity()) =>
  queryKeys.skills.list(directory, transport);

export const installedSkillsQueryOptions = (
  directory: string | null = resolveInstalledSkillsQueryDirectory(),
  transport = getRuntimeTransportIdentity(),
) => {
  const normalizedDirectory = normalizeDirectory(directory);
  return {
    queryKey: installedSkillsQueryKey(normalizedDirectory, transport),
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<DiscoveredSkill[]> => {
      const response = await runtimeFetch('/api/config/skills', {
        query: { summary: 'true', ...(normalizedDirectory ? { directory: normalizedDirectory } : {}) },
        signal,
      });
      if (!response.ok) throw new Error(`Failed to list skills: ${response.status}`);
      const data = await response.json() as { skills?: RawSkillResponse[] };
      return (data.skills ?? []).map((skill) => ({
        name: skill.name,
        path: skill.path,
        scope: skill.scope ?? 'user',
        source: skill.source ?? 'opencode',
        description: skill.description ?? '',
        group: parseSkillGroup(skill.path),
      }));
    },
    retry: 2,
  };
};

export const useInstalledSkillsQuery = (options: { enabled?: boolean; directory?: string | null } = {}) => {
  const activeProjectPath = useProjectsStore((state) => state.getActiveProject?.()?.path ?? null);
  const directory = normalizeDirectory(options.directory) ?? normalizeDirectory(activeProjectPath) ?? normalizeDirectory(opencodeClient.getDirectory());
  return useQuery({
    ...installedSkillsQueryOptions(directory),
    enabled: options.enabled,
  });
};

export const readInstalledSkillsSnapshot = (
  client: Pick<QueryClient, 'getQueryData'> = queryClient,
  directory: string | null = resolveInstalledSkillsQueryDirectory(),
  transport = getRuntimeTransportIdentity(),
): DiscoveredSkill[] => client.getQueryData<DiscoveredSkill[]>(installedSkillsQueryKey(normalizeDirectory(directory), transport)) ?? [];

export const refreshInstalledSkillsQuery = async (
  client: Pick<QueryClient, 'fetchQuery' | 'getQueryData'>,
  directory: string | null,
  transport = getRuntimeTransportIdentity(),
): Promise<DiscoveredSkill[]> => {
  const normalizedDirectory = normalizeDirectory(directory);
  if (getRuntimeTransportIdentity() !== transport) {
    return readInstalledSkillsSnapshot(client, normalizedDirectory, transport);
  }
  return client.fetchQuery({ ...installedSkillsQueryOptions(normalizedDirectory, transport), staleTime: 0 });
};
