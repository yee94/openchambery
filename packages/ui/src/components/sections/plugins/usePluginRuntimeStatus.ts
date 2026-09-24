import React from 'react';
import { useEvent } from '@reactuses/core';
import {
  pluginPackageUpdateKey,
  usePluginConfigDirectory,
  usePluginRuntimeQuery,
} from '@/queries/pluginQueries';
import { usePluginsStore, type PluginPackageUpdate } from '@/stores/usePluginsStore';
import {
  findRuntimeMatches,
  resolveLoadState,
  resolveUpdateFlag,
  type PluginLoadState,
  type PluginRuntimeTarget,
  type PluginUpdateFlag,
} from './pluginLoadState';

export type PluginRuntimeStatus =
  | { kind: 'loading' }
  | { kind: 'unknown' }
  | { kind: 'known'; load: PluginLoadState; update: PluginUpdateFlag; target: PluginRuntimeTarget };

export function usePluginRuntimeStatus(target: PluginRuntimeTarget | null): {
  status: PluginRuntimeStatus;
  retry: () => void;
  isRefreshing: boolean;
} {
  const query = usePluginRuntimeQuery();
  const retry = useEvent(() => {
    void query.refetch();
  });
  const status = React.useMemo((): PluginRuntimeStatus => {
    if (query.isPending && query.data === undefined) return { kind: 'loading' };
    if (query.data === undefined || !target) return { kind: 'unknown' };
    const matched = findRuntimeMatches(target, query.data);
    return { kind: 'known', load: resolveLoadState(matched), update: resolveUpdateFlag(matched), target };
  }, [query.data, query.isPending, target]);
  return { status, retry, isRefreshing: query.isFetching };
}

/** The update this client started for a package target in the current directory, if any. */
export function usePluginPackageUpdate(target: PluginRuntimeTarget | null): PluginPackageUpdate | null {
  const directory = usePluginConfigDirectory();
  const key = target?.kind === 'package' ? pluginPackageUpdateKey(directory, target.target) : null;
  return usePluginsStore((state) => (key ? state.packageUpdates[key] ?? null : null));
}
