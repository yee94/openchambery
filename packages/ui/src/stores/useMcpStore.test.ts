import { beforeEach, describe, expect, vi, test } from 'vitest';

const mocks = vi.hoisted(() => ({
  runtimeKey: 'transport-a',
  generation: 1,
  list: vi.fn(),
  integration: vi.fn(),
  connect: vi.fn(),
  complete: vi.fn(),
  cancel: vi.fn(),
  status: vi.fn(),
  remove: vi.fn(),
  refresh: vi.fn(async () => ({})),
}));

vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => mocks.runtimeKey,
  getRuntimeGeneration: () => mocks.generation,
}));
vi.mock('@/lib/opencode/client', () => {
  const api = {
    mcp: { list: mocks.list },
    integration: { get: mocks.integration, oauth: { connect: mocks.connect, complete: mocks.complete, cancel: mocks.cancel, status: mocks.status } },
    credential: { remove: mocks.remove },
  };
  return {
  opencodeClient: {
    getApiClient: () => api,
    getScopedApiClient: () => api,
  },
  };
});
vi.mock('@/lib/queryRuntime', () => ({ queryClient: {} }));
vi.mock('@/stores/useDirectoryStore', () => ({
  useDirectoryStore: Object.assign(() => null, {
    getState: () => ({ currentDirectory: '/workspace/current' }),
  }),
}));
vi.mock('@/queries/mcpQueries', () => ({
  normalizeMcpDirectory: (directory: string | null | undefined) => directory?.trim().replace(/\\/g, '/').replace(/\/+$/, '') || null,
  readMcpStatusSnapshot: () => ({}),
  refreshMcpStatusQuery: mocks.refresh,
}));

const { useMcpStore } = await import('./useMcpStore');

describe('useMcpStore clearDiagnostic', () => {
  beforeEach(() => {
    mocks.runtimeKey = 'transport-a';
    useMcpStore.setState({
      diagnosticsByDirectory: {
        '["transport-a","/workspace/a"]': {
          target: { status: 'failed', error: 'target error' },
          sibling: { status: 'failed', error: 'sibling error' },
        },
        '["transport-a","/workspace/b"]': {
          target: { status: 'failed', error: 'other directory' },
        },
        '["transport-b","/workspace/a"]': {
          target: { status: 'failed', error: 'other transport' },
        },
      },
    });
  });

  test('clears only the exact transport, normalized directory, and server name', () => {
    useMcpStore.getState().clearDiagnostic('target', ' /workspace/a/ ', 'transport-a');

    expect(useMcpStore.getState().diagnosticsByDirectory).toEqual({
      '["transport-a","/workspace/a"]': {
        sibling: { status: 'failed', error: 'sibling error' },
      },
      '["transport-a","/workspace/b"]': {
        target: { status: 'failed', error: 'other directory' },
      },
      '["transport-b","/workspace/a"]': {
        target: { status: 'failed', error: 'other transport' },
      },
    });
  });
});

describe('useMcpStore auth', () => {
  const location = { directory: '/workspace/current' };
  const attempt = { attemptID: 'attempt-1', url: 'https://auth.example.com/authorize', mode: 'auto', instructions: '', time: { created: 0, expires: Date.now() + 600_000 } };
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.runtimeKey = 'transport-a';
    mocks.generation++;
    mocks.list.mockResolvedValue({ data: [{ name: 'server', integrationID: 'server-owned-id' }] });
    mocks.integration.mockResolvedValue({ data: { id: 'server-owned-id', methods: [{ type: 'oauth', id: 'login' }], connections: [{ type: 'credential', id: 'credential-1' }, { type: 'env', names: ['KEY'] }] } });
    mocks.connect.mockResolvedValue({ data: attempt });
    mocks.status.mockResolvedValue({ data: { status: 'pending', time: attempt.time } });
  });

  test('returns the browser URL using the server-owned integration and OAuth method', async () => {
    await expect(useMcpStore.getState().startAuth('server')).resolves.toEqual(attempt);
    expect(mocks.list).toHaveBeenCalledWith({ location });
    expect(mocks.integration).toHaveBeenCalledWith({ integrationID: 'server-owned-id', location });
    expect(mocks.connect).toHaveBeenCalledWith({ integrationID: 'server-owned-id', methodID: 'login', location });
  });

  test('tracks auto completion through OAuth attempt status, not MCP connectivity', async () => {
    await useMcpStore.getState().startAuth('server');
    await expect(useMcpStore.getState().authStatus('server')).resolves.toMatchObject({ status: 'pending' });
    mocks.status.mockResolvedValue({ data: { status: 'complete', time: attempt.time } });
    await expect(useMcpStore.getState().authStatus('server')).resolves.toMatchObject({ status: 'complete' });
    expect(mocks.status).toHaveBeenCalledWith({ integrationID: 'server-owned-id', attemptID: 'attempt-1', location });
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  test('completes code-mode attempts and refreshes the originating scope', async () => {
    mocks.connect.mockResolvedValue({ data: { ...attempt, mode: 'code' } });
    await useMcpStore.getState().startAuth('server', ' /workspace/a/ ');
    await useMcpStore.getState().completeAuth('server', ' code ', '/workspace/a');
    expect(mocks.complete).toHaveBeenCalledWith({ integrationID: 'server-owned-id', attemptID: 'attempt-1', code: 'code', location: { directory: '/workspace/a' } });
    expect(mocks.refresh).toHaveBeenCalledWith({}, '/workspace/a', 'transport-a');
  });

  test('clears only credentials attached to the MCP integration and cancels its attempt', async () => {
    await useMcpStore.getState().startAuth('server');
    await useMcpStore.getState().clearAuth('server');
    expect(mocks.cancel).toHaveBeenCalledWith({ integrationID: 'server-owned-id', attemptID: 'attempt-1', location });
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith({ credentialID: 'credential-1' });
  });

  test('does not guess integration IDs or fall back to same-named providers', async () => {
    mocks.list.mockResolvedValue({ data: [{ name: 'server' }] });
    await expect(useMcpStore.getState().startAuth('server')).rejects.toThrow('no authentication integration');
    expect(mocks.integration).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  test('does not carry attempts across directories or runtime lifetimes', async () => {
    await useMcpStore.getState().startAuth('server');
    await expect(useMcpStore.getState().completeAuth('server', 'code', '/other')).rejects.toThrow();
    mocks.generation++;
    await expect(useMcpStore.getState().authStatus('server')).rejects.toThrow('attempt not found');
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  test('cancels the previous attempt before authorizing again', async () => {
    await useMcpStore.getState().startAuth('server');
    await useMcpStore.getState().startAuth('server');
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith({ integrationID: 'server-owned-id', attemptID: 'attempt-1', location });
    expect(mocks.connect).toHaveBeenCalledTimes(2);
  });

  test('does not begin OAuth after the runtime changes during discovery', async () => {
    mocks.integration.mockImplementationOnce(async () => {
      mocks.generation++;
      return { data: { id: 'old', methods: [{ type: 'oauth', id: 'login' }] } };
    });
    await expect(useMcpStore.getState().startAuth('server')).rejects.toThrow('runtime changed');
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  test('propagates OAuth and credential errors instead of reporting success', async () => {
    mocks.connect.mockRejectedValueOnce(new Error('OAuth unavailable'));
    await expect(useMcpStore.getState().startAuth('server')).rejects.toThrow('OAuth unavailable');
    mocks.remove.mockRejectedValueOnce(new Error('Remove failed'));
    await expect(useMcpStore.getState().clearAuth('server')).rejects.toThrow('Remove failed');
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
