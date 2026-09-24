import { useQuery, type QueryClient } from '@tanstack/react-query';
import { queryClient, queryKeys, normalizePluginRegistrySpecs } from '@/lib/queryRuntime';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { opencodeClient } from '@/lib/opencode/client';
import {
  checkPluginUpdates,
  listPluginRuntime,
  type PluginRuntimeInfo,
} from '@/lib/opencode/plugins';
import { useProjectsStore } from '@/stores/useProjectsStore';
import type { PluginEntry, PluginFile, PluginScope, RegistryResult } from '@/stores/usePluginsStore';
import { resolveConfigQueryDirectory } from './commandQueries';

export { resolveConfigQueryDirectory } from './commandQueries';

export type PluginsList = {
  entries: PluginEntry[];
  files: PluginFile[];
};

export type PluginFileContent = {
  fileName: string;
  scope: PluginScope;
  content: string;
};

const REGISTRY_SPECS_CHUNK_LIMIT = 1500;

const normalizeDirectory = (directory: string | null | undefined): string | null => directory?.trim() || null;

const pluginsListQueryKey = (directory: string | null, transport = getRuntimeTransportIdentity()) =>
  queryKeys.plugins.list(directory, transport);

const pluginRegistryQueryKey = (
  directory: string | null,
  specs: readonly string[],
  force = false,
  transport = getRuntimeTransportIdentity(),
) => queryKeys.plugins.registry(directory, specs, force, transport);

const pluginFileQueryKey = (directory: string | null, id: string, transport = getRuntimeTransportIdentity()) =>
  queryKeys.plugins.file(directory, id, transport);

const pluginRuntimeQueryKey = (directory: string | null, transport = getRuntimeTransportIdentity()) =>
  queryKeys.plugins.runtime(directory, transport);

/**
 * Only the newest runtime read may commit. A slower list must not replace a
 * check that already landed, and a failed read must not write an empty list.
 */
let runtimeReadGeneration = 0;

const beginRuntimeRead = (): number => {
  runtimeReadGeneration += 1;
  return runtimeReadGeneration;
};

const claimRuntimeRead = (): void => {
  runtimeReadGeneration += 1;
};

const currentRuntimeInventory = (
  client: Pick<QueryClient, 'getQueryData'>,
  directory: string | null,
  transport: string,
): PluginRuntimeInfo[] | undefined =>
  client.getQueryData<PluginRuntimeInfo[]>(pluginRuntimeQueryKey(directory, transport));

export const pluginsListQueryOptions = (
  directory: string | null = resolveConfigQueryDirectory(),
  transport = getRuntimeTransportIdentity(),
) => {
  const normalizedDirectory = normalizeDirectory(directory);
  return {
    queryKey: pluginsListQueryKey(normalizedDirectory, transport),
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<PluginsList> => {
      const response = await runtimeFetch(buildPluginsUrl('/api/config/plugins', normalizedDirectory), {
        headers: buildDirectoryHeaders(normalizedDirectory),
        signal,
      });
      if (!response.ok) throw new Error('Failed to load plugins');
      const data = await response.json() as Partial<PluginsList>;
      return { entries: data.entries ?? [], files: data.files ?? [] };
    },
    staleTime: 5_000,
    retry: 2,
  };
};

export const pluginRegistryQueryOptions = (
  directory: string | null,
  specs: readonly string[],
  force = false,
  transport = getRuntimeTransportIdentity(),
) => {
  const normalizedDirectory = normalizeDirectory(directory);
  const normalizedSpecs = normalizePluginRegistrySpecs(specs);
  return {
    queryKey: pluginRegistryQueryKey(normalizedDirectory, normalizedSpecs, force, transport),
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<Record<string, RegistryResult>> => {
      const results: Record<string, RegistryResult> = {};
      for (const chunk of chunkSpecs(normalizedSpecs)) {
        const response = await runtimeFetch(buildRegistryUrl(chunk, force, normalizedDirectory), {
          headers: buildDirectoryHeaders(normalizedDirectory),
          signal,
        });
        if (!response.ok) throw new Error('Failed to load plugin registry info');
        const data = await response.json() as { results?: RegistryResult[] };
        for (const result of data.results ?? []) {
          results[result.spec] = result;
        }
      }
      return results;
    },
    staleTime: force ? 0 : 5 * 60_000,
    retry: 2,
  };
};

export const pluginFileQueryOptions = (
  directory: string | null,
  id: string,
  transport = getRuntimeTransportIdentity(),
) => {
  const normalizedDirectory = normalizeDirectory(directory);
  return {
    queryKey: pluginFileQueryKey(normalizedDirectory, id, transport),
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<PluginFileContent> => {
      const response = await runtimeFetch(buildPluginsUrl(`/api/config/plugins/file/${encodeURIComponent(id)}`, normalizedDirectory), {
        headers: buildDirectoryHeaders(normalizedDirectory),
        signal,
      });
      if (!response.ok) throw new Error('Failed to read plugin file');
      return await response.json() as PluginFileContent;
    },
    retry: 2,
  };
};

export const pluginRuntimeQueryOptions = (
  directory: string | null = resolveConfigQueryDirectory(),
  transport = getRuntimeTransportIdentity(),
) => {
  const normalizedDirectory = normalizeDirectory(directory);
  return {
    queryKey: pluginRuntimeQueryKey(normalizedDirectory, transport),
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<PluginRuntimeInfo[]> => {
      const generation = beginRuntimeRead();
      const plugins = await listPluginRuntime(normalizedDirectory, signal);
      if (generation !== runtimeReadGeneration) {
        const current = currentRuntimeInventory(queryClient, normalizedDirectory, transport);
        if (current) return current;
        throw new Error('Stale plugin runtime read');
      }
      return plugins;
    },
    staleTime: 5_000,
    retry: false,
  };
};

export const pluginPackageUpdateKey = (
  directory: string | null,
  target: string,
  transport = getRuntimeTransportIdentity(),
): string => JSON.stringify([transport, normalizeDirectory(directory) ?? '', target]);

export const usePluginsQuery = (options: { enabled?: boolean } = {}) => {
  const activeProjectPath = useProjectsStore((state) => state.getActiveProject?.()?.path ?? null);
  return useQuery({
    ...pluginsListQueryOptions(normalizeDirectory(activeProjectPath) ?? normalizeDirectory(opencodeClient.getDirectory())),
    enabled: options.enabled,
  });
};

export const usePluginRegistryQuery = (
  specs: readonly string[],
  force = false,
) => {
  const activeProjectPath = useProjectsStore((state) => state.getActiveProject?.()?.path ?? null);
  return useQuery({
    ...pluginRegistryQueryOptions(normalizeDirectory(activeProjectPath) ?? normalizeDirectory(opencodeClient.getDirectory()), specs, force),
  });
};

export const usePluginConfigDirectory = (): string | null => {
  const activeProjectPath = useProjectsStore((state) => state.getActiveProject?.()?.path ?? null);
  return normalizeDirectory(activeProjectPath) ?? normalizeDirectory(opencodeClient.getDirectory());
};

export const usePluginRuntimeQuery = (options: { enabled?: boolean } = {}) => {
  const directory = usePluginConfigDirectory();
  return useQuery({
    ...pluginRuntimeQueryOptions(directory),
    enabled: options.enabled,
  });
};

export const usePluginFileQuery = (id: string, options: { enabled?: boolean } = {}) => {
  const activeProjectPath = useProjectsStore((state) => state.getActiveProject?.()?.path ?? null);
  return useQuery({
    ...pluginFileQueryOptions(normalizeDirectory(activeProjectPath) ?? normalizeDirectory(opencodeClient.getDirectory()), id),
    enabled: options.enabled,
  });
};

export const readPluginsSnapshot = (
  directory: string | null = resolveConfigQueryDirectory(),
  transport = getRuntimeTransportIdentity(),
): PluginsList => queryClient.getQueryData<PluginsList>(pluginsListQueryKey(normalizeDirectory(directory), transport)) ?? { entries: [], files: [] };

export const readPluginRegistrySnapshot = (
  directory: string | null,
  specs: readonly string[],
  force = false,
  transport = getRuntimeTransportIdentity(),
): Record<string, RegistryResult> =>
  queryClient.getQueryData<Record<string, RegistryResult>>(pluginRegistryQueryKey(normalizeDirectory(directory), specs, force, transport)) ?? {};

export const readPluginFileSnapshot = (
  directory: string | null,
  id: string,
  transport = getRuntimeTransportIdentity(),
): PluginFileContent | undefined => queryClient.getQueryData<PluginFileContent>(pluginFileQueryKey(normalizeDirectory(directory), id, transport));

export const refreshPluginsQuery = async (
  client: Pick<QueryClient, 'fetchQuery' | 'getQueryData'>,
  directory: string | null,
  transport: string,
): Promise<PluginsList> => {
  const normalizedDirectory = normalizeDirectory(directory);
  if (getRuntimeTransportIdentity() !== transport) {
    return client.getQueryData<PluginsList>(pluginsListQueryKey(normalizedDirectory, transport)) ?? { entries: [], files: [] };
  }
  return client.fetchQuery({ ...pluginsListQueryOptions(normalizedDirectory, transport), staleTime: 0 });
};

export const refreshPluginRegistryQuery = async (
  client: Pick<QueryClient, 'setQueryData'> = queryClient,
  directory: string | null,
  specs: readonly string[],
): Promise<Record<string, RegistryResult>> => {
  const normalizedDirectory = normalizeDirectory(directory);
  const transport = getRuntimeTransportIdentity();
  const data = await pluginRegistryQueryOptions(normalizedDirectory, specs, true, transport).queryFn({
    signal: new AbortController().signal,
  });
  client.setQueryData(pluginRegistryQueryKey(normalizedDirectory, specs, false, transport), data);
  return data;
};

export const refreshPluginFileQuery = async (
  client: Pick<QueryClient, 'fetchQuery' | 'getQueryData'>,
  directory: string | null,
  id: string,
  transport: string,
): Promise<PluginFileContent | undefined> => {
  const normalizedDirectory = normalizeDirectory(directory);
  if (getRuntimeTransportIdentity() !== transport) {
    return client.getQueryData<PluginFileContent>(pluginFileQueryKey(normalizedDirectory, id, transport));
  }
  return client.fetchQuery({ ...pluginFileQueryOptions(normalizedDirectory, id, transport), staleTime: 0 });
};

export const refreshPluginRuntimeQuery = async (
  client: Pick<QueryClient, 'setQueryData' | 'getQueryData'>,
  directory: string | null,
  transport: string,
): Promise<PluginRuntimeInfo[] | undefined> => {
  const normalizedDirectory = normalizeDirectory(directory);
  if (getRuntimeTransportIdentity() !== transport) {
    return currentRuntimeInventory(client, normalizedDirectory, transport);
  }
  const generation = beginRuntimeRead();
  const plugins = await listPluginRuntime(normalizedDirectory);
  if (generation !== runtimeReadGeneration || getRuntimeTransportIdentity() !== transport) {
    return currentRuntimeInventory(client, normalizedDirectory, transport);
  }
  client.setQueryData(pluginRuntimeQueryKey(normalizedDirectory, transport), plugins);
  return plugins;
};

/**
 * Writes a successful check over the runtime inventory. A failed check throws
 * and leaves the previous inventory in place.
 */
export const checkPluginRuntimeUpdates = async (
  directory: string | null = resolveConfigQueryDirectory(),
  client: Pick<QueryClient, 'setQueryData'> = queryClient,
): Promise<PluginRuntimeInfo[]> => {
  const normalizedDirectory = normalizeDirectory(directory);
  const transport = getRuntimeTransportIdentity();
  const plugins = await checkPluginUpdates(normalizedDirectory);
  claimRuntimeRead();
  if (getRuntimeTransportIdentity() === transport) {
    client.setQueryData(pluginRuntimeQueryKey(normalizedDirectory, transport), plugins);
  }
  return plugins;
};

export const fetchPluginsListQuery = (directory: string | null = resolveConfigQueryDirectory()) =>
  queryClient.fetchQuery(pluginsListQueryOptions(directory));

export const fetchPluginRegistryQuery = (directory: string | null, specs: readonly string[], force = false) =>
  queryClient.fetchQuery(pluginRegistryQueryOptions(directory, specs, force));

export const fetchPluginFileQuery = (directory: string | null, id: string) =>
  queryClient.fetchQuery(pluginFileQueryOptions(directory, id));

function buildPluginsUrl(path: string, directory: string | null): string {
  const queryParams = directory ? `?directory=${encodeURIComponent(directory)}` : '';
  return `${path}${queryParams}`;
}

function buildRegistryUrl(specs: readonly string[], force: boolean, directory: string | null): string {
  const params = new URLSearchParams();
  if (force) params.set('refresh', 'true');
  if (directory) params.set('directory', directory);
  const suffix = params.toString();
  const specsParam = `specs=${specs.map(encodeURIComponent).join(',')}`;
  return `/api/config/plugins/registry?${specsParam}${suffix ? `&${suffix}` : ''}`;
}

function chunkSpecs(specs: readonly string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentLength = 0;
  for (const spec of specs) {
    const encodedSpec = encodeURIComponent(spec);
    const nextLength = current.length === 0 ? encodedSpec.length : currentLength + 1 + encodedSpec.length;
    if (current.length > 0 && nextLength > REGISTRY_SPECS_CHUNK_LIMIT) {
      chunks.push(current);
      current = [spec];
      currentLength = encodedSpec.length;
      continue;
    }
    current.push(spec);
    currentLength = nextLength;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function buildDirectoryHeaders(directory: string | null): HeadersInit | undefined {
  return directory ? { 'x-opencode-directory': directory } : undefined;
}
