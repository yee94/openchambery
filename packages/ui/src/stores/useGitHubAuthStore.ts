import { create } from 'zustand';
import type { GitHubAuthStatus, RuntimeAPIs } from '@/lib/api/types';
import { queryClient, queryKeys } from '@/lib/queryRuntime';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import {
  readGitHubAuthSnapshot,
  refreshGitHubAuthQuery,
  setGitHubAuthSnapshot,
} from '@/queries/githubAuthQueries';

type GitHubAuthStatusWithError = GitHubAuthStatus & { error?: string };

const isCancelledQueryError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'CancelledError';

type GitHubAuthStore = {
  setStatus: (status: GitHubAuthStatusWithError | null) => void;
  refreshStatus: (
    runtimeGitHub?: RuntimeAPIs['github'],
    options?: { force?: boolean }
  ) => Promise<GitHubAuthStatusWithError | null>;
};

export const useGitHubAuthStore = create<GitHubAuthStore>(() => ({
  setStatus: (status) => setGitHubAuthSnapshot(queryClient, status),
  refreshStatus: async (runtimeGitHub, options) => {
    const transport = getRuntimeTransportIdentity();
    if (options?.force) {
      await queryClient.cancelQueries({ queryKey: queryKeys.github.auth(transport), exact: true });
    }
    try {
      return await refreshGitHubAuthQuery(queryClient, runtimeGitHub, transport);
    } catch (error) {
      if (isCancelledQueryError(error)) {
        return readGitHubAuthSnapshot(queryClient, transport);
      }
      throw error;
    }
  },
}));
