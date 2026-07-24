import { beforeEach, describe, expect, mock, test } from 'bun:test';

const refreshError = new Error('GitHub status unavailable');
const cancelledError = Object.assign(new Error('CancelledError'), { name: 'CancelledError' });
let cachedStatus: { authenticated: boolean } | null = null;
let refreshImpl: () => Promise<{ authenticated: boolean } | null> = async () => null;

mock.module('@/lib/queryRuntime', () => ({
  queryClient: {
    cancelQueries: async () => undefined,
    getQueryData: () => cachedStatus,
  },
  queryKeys: {
    github: {
      auth: (transport: string) => [transport, 'github', 'auth'],
    },
  },
}));
mock.module('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => 'transport-a',
}));
mock.module('@/queries/githubAuthQueries', () => ({
  readGitHubAuthSnapshot: () => cachedStatus,
  refreshGitHubAuthQuery: () => refreshImpl(),
  setGitHubAuthSnapshot: () => undefined,
}));

const { useGitHubAuthStore } = await import('./useGitHubAuthStore');

describe('useGitHubAuthStore refreshStatus', () => {
  beforeEach(() => {
    cachedStatus = null;
    refreshImpl = async () => null;
  });

  test('returns the current snapshot when a superseded refresh is cancelled', async () => {
    cachedStatus = { authenticated: true };
    refreshImpl = async () => { throw cancelledError; };

    const result = await useGitHubAuthStore.getState().refreshStatus(undefined, { force: true });
    expect(result).toEqual(cachedStatus);
  });

  test('propagates refresh failures to the caller', async () => {
    refreshImpl = async () => { throw refreshError; };

    await expect(useGitHubAuthStore.getState().refreshStatus()).rejects.toThrow('GitHub status unavailable');
  });
});
