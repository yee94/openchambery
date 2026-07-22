import React from 'react';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import type { GitBranch, GitRemote } from '@/lib/api/types';
import * as gitHttp from '@/lib/gitApiHttp';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { queryClient, queryKeys } from '@/lib/queryRuntime';
import { getRuntimeTransportIdentity, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';
import { normalizeGitBranchDirectory, readGitBranchStartupSnapshot, writeGitBranchStartupSnapshot, type GitBranchStartupStorage } from './gitBranchStartupCache';

export type GitBranchQueryAPI = {
  getGitBranches(directory: string, options?: { signal?: AbortSignal }): Promise<GitBranch>;
  getRemotes?(directory: string, options?: { signal?: AbortSignal }): Promise<GitRemote[]>;
};

const GIT_BRANCH_STALE_TIME = 30_000;
const normalizeDirectory = normalizeGitBranchDirectory;

const branchesKey = (directory: string | null | undefined, transport = getRuntimeTransportIdentity()) =>
  queryKeys.git.branches(normalizeDirectory(directory), transport);
const remotesKey = (directory: string | null | undefined, transport = getRuntimeTransportIdentity()) =>
  queryKeys.git.remotes(normalizeDirectory(directory), transport);

const fetchBranches = async (directory: string, git: GitBranchQueryAPI | undefined, signal: AbortSignal): Promise<GitBranch> => {
  signal.throwIfAborted();
  const runtimeGit = getRegisteredRuntimeAPIs()?.git;
  const result = git?.getGitBranches
    ? await git.getGitBranches(directory, { signal })
    : runtimeGit
      ? await runtimeGit.getGitBranches(directory, { signal })
      : await gitHttp.getGitBranches(directory, { signal });
  signal.throwIfAborted();
  return result;
};

const fetchRemotes = async (directory: string, git: GitBranchQueryAPI | undefined, signal: AbortSignal): Promise<GitRemote[]> => {
  signal.throwIfAborted();
  const runtimeGit = getRegisteredRuntimeAPIs()?.git;
  const result = git?.getRemotes
    ? await git.getRemotes(directory, { signal })
    : runtimeGit
      ? await runtimeGit.getRemotes(directory, { signal })
      : await gitHttp.getRemotes(directory, { signal });
  signal.throwIfAborted();
  return result;
};

export const gitBranchesQueryOptions = (
  directory: string | null | undefined,
  git?: GitBranchQueryAPI,
  transport = getRuntimeTransportIdentity(),
  startupStorage: GitBranchStartupStorage = getDeferredSafeStorage(),
) => {
  const normalizedDirectory = normalizeDirectory(directory);
  const capturedGit = git;
  return {
    queryKey: branchesKey(normalizedDirectory, transport),
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<GitBranch> => {
      if (!normalizedDirectory) throw new Error('Git branches require a directory');
      const branches = await fetchBranches(normalizedDirectory, capturedGit, signal);
      writeGitBranchStartupSnapshot(normalizedDirectory, transport, branches, startupStorage);
      return branches;
    },
    staleTime: GIT_BRANCH_STALE_TIME,
    gcTime: Infinity,
    initialData: () => readGitBranchStartupSnapshot(normalizedDirectory, transport, startupStorage) ?? undefined,
    initialDataUpdatedAt: 0,
  };
};

export const gitRemotesQueryOptions = (
  directory: string | null | undefined,
  git?: GitBranchQueryAPI,
  transport = getRuntimeTransportIdentity(),
) => {
  const normalizedDirectory = normalizeDirectory(directory);
  const capturedGit = git;
  return {
    queryKey: remotesKey(normalizedDirectory, transport),
    queryFn: ({ signal }: { signal: AbortSignal }): Promise<GitRemote[]> => {
      if (!normalizedDirectory) throw new Error('Git remotes require a directory');
      return fetchRemotes(normalizedDirectory, capturedGit, signal);
    },
    staleTime: GIT_BRANCH_STALE_TIME,
    gcTime: Infinity,
  };
};

export const useGitBranchesQuery = (directory: string | null | undefined, git?: GitBranchQueryAPI, enabled = true) => {
  const transport = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeTransportIdentity, getRuntimeTransportIdentity);
  const normalizedDirectory = normalizeDirectory(directory);
  return useQuery({
    ...gitBranchesQueryOptions(normalizedDirectory, git, transport),
    enabled: enabled && Boolean(normalizedDirectory),
  });
};

export const useGitRemotesQuery = (directory: string | null | undefined, git?: GitBranchQueryAPI, enabled = true) => {
  const transport = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeTransportIdentity, getRuntimeTransportIdentity);
  const normalizedDirectory = normalizeDirectory(directory);
  return useQuery({
    ...gitRemotesQueryOptions(normalizedDirectory, git, transport),
    enabled: enabled && Boolean(normalizedDirectory),
  });
};

export const readGitBranchesSnapshot = (directory: string | null | undefined, client: Pick<QueryClient, 'getQueryData'> = queryClient, transport = getRuntimeTransportIdentity()) =>
  client.getQueryData<GitBranch>(branchesKey(directory, transport)) ?? null;

export const readGitRemotesSnapshot = (directory: string | null | undefined, client: Pick<QueryClient, 'getQueryData'> = queryClient, transport = getRuntimeTransportIdentity()) =>
  client.getQueryData<GitRemote[]>(remotesKey(directory, transport)) ?? null;

export const ensureGitBranchesQuery = (directory: string, git?: GitBranchQueryAPI, client: Pick<QueryClient, 'fetchQuery'> = queryClient, transport = getRuntimeTransportIdentity()) =>
  client.fetchQuery(gitBranchesQueryOptions(directory, git, transport));

export const refreshGitBranchesQuery = (directory: string, git?: GitBranchQueryAPI, client: Pick<QueryClient, 'fetchQuery'> = queryClient, transport = getRuntimeTransportIdentity()) =>
  client.fetchQuery({ ...gitBranchesQueryOptions(directory, git, transport), staleTime: 0 });

export const invalidateGitBranchesQuery = (directory: string, client: Pick<QueryClient, 'invalidateQueries'> = queryClient, transport = getRuntimeTransportIdentity()) =>
  client.invalidateQueries({ queryKey: branchesKey(directory, transport), exact: true });

export const refreshGitRemotesQuery = (directory: string, git?: GitBranchQueryAPI, client: Pick<QueryClient, 'fetchQuery'> = queryClient, transport = getRuntimeTransportIdentity()) =>
  client.fetchQuery({ ...gitRemotesQueryOptions(directory, git, transport), staleTime: 0 });

export const ensureGitRemotesQuery = (directory: string, git?: GitBranchQueryAPI, client: Pick<QueryClient, 'fetchQuery'> = queryClient, transport = getRuntimeTransportIdentity()) =>
  client.fetchQuery(gitRemotesQueryOptions(directory, git, transport));

export const invalidateGitRemotesQuery = (directory: string, client: Pick<QueryClient, 'invalidateQueries'> = queryClient, transport = getRuntimeTransportIdentity()) =>
  client.invalidateQueries({ queryKey: remotesKey(directory, transport), exact: true });
