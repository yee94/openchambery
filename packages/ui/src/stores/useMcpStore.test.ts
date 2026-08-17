import { beforeEach, describe, expect, mock, test } from 'bun:test';

let runtimeKey = 'transport-a';

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => runtimeKey,
}));
mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    getApiClient: () => ({}),
    getScopedApiClient: () => ({}),
  },
}));
mock.module('@/lib/queryRuntime', () => ({ queryClient: {} }));
mock.module('@/stores/useDirectoryStore', () => ({
  useDirectoryStore: Object.assign(() => null, {
    getState: () => ({ currentDirectory: '/workspace/current' }),
  }),
}));
mock.module('@/queries/mcpQueries', () => ({
  normalizeMcpDirectory: (directory: string | null | undefined) => directory?.trim().replace(/\\/g, '/').replace(/\/+$/, '') || null,
  readMcpStatusSnapshot: () => ({}),
  refreshMcpStatusQuery: async () => ({}),
}));

const { useMcpStore } = await import('./useMcpStore');
const { v2CapabilityUnavailable } = await import('@/sync/v2-runtime');

describe('useMcpStore clearDiagnostic', () => {
  beforeEach(() => {
    runtimeKey = 'transport-a';
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
  test('MCP auth methods fail closed as unavailable on v2', async () => {
    const expected = v2CapabilityUnavailable('mcp.auth');
    await expect(useMcpStore.getState().startAuth('server')).rejects.toThrow(expected.message);
    await expect(useMcpStore.getState().completeAuth('server', 'code')).rejects.toThrow(expected.message);
    await expect(useMcpStore.getState().clearAuth('server')).rejects.toThrow(expected.message);
  });
});
