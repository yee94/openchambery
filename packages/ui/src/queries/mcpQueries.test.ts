import { beforeEach, describe, expect, mock, test } from 'bun:test';

let runtimeKey = 'runtime-a';
let activeProjectPath = '/workspace/project';
const fetchCalls: Array<{ input: string; init?: RequestInit }> = [];
const statusDirectories: Array<string | null> = [];
let fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = async () => new Response('[]');
let statusImpl: () => Promise<{ data?: Record<string, unknown> }> = async () => ({ data: {} });

const apiFor = (directory: string | null) => ({
  mcp: {
    status: async () => {
      statusDirectories.push(directory);
      return statusImpl();
    },
  },
});

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    getDirectory: () => '/fallback/project',
    getApiClient: () => apiFor(null),
    getScopedApiClient: (directory: string) => apiFor(directory),
  },
}));
mock.module('@/stores/useProjectsStore', () => ({
  useProjectsStore: Object.assign(() => null, {
    getState: () => ({ getActiveProject: () => ({ path: activeProjectPath }) }),
  }),
}));
mock.module('@/stores/useDirectoryStore', () => ({
  useDirectoryStore: Object.assign(() => null, {
    getState: () => ({ currentDirectory: activeProjectPath }),
  }),
}));
mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: (input: string, init?: RequestInit) => {
    fetchCalls.push({ input, init });
    return fetchImpl(input, init);
  },
}));
mock.module('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => runtimeKey,
  getRuntimeGeneration: () => 0,
  isRuntimeEndpointIdentityChange: () => false,
  subscribeRuntimeEndpointChanged: () => () => undefined,
}));

const {
  mcpConfigsQueryOptions,
  mcpStatusQueryOptions,
  normalizeMcpDirectory,
  readMcpConfigsSnapshot,
  readMcpStatusSnapshot,
  refreshMcpConfigsQuery,
  refreshMcpStatusQuery,
} = await import('./mcpQueries');
const { queryClient } = await import('@/lib/queryRuntime');

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

describe('mcpQueries', () => {
  beforeEach(() => {
    queryClient.clear();
    runtimeKey = 'runtime-a';
    activeProjectPath = '/workspace/project';
    fetchCalls.length = 0;
    statusDirectories.length = 0;
    fetchImpl = async () => jsonResponse([]);
    statusImpl = async () => ({ data: {} });
  });

  test('normalizes directory and scopes config request by transport', async () => {
    const controller = new AbortController();
    fetchImpl = async () => jsonResponse([{ name: 'server', type: 'local', command: ['server'], enabled: true }]);
    const options = mcpConfigsQueryOptions(' C:\\workspace\\project\\ ', 'runtime-b');

    await options.queryFn({ signal: controller.signal });

    expect(normalizeMcpDirectory(' C:\\workspace\\project\\ ')).toBe('C:/workspace/project');
    expect(options.queryKey).toEqual(['runtime-b', 'mcp', 'configs', 'C:/workspace/project']);
    expect(fetchCalls[0]?.input).toBe('/api/config/mcp?directory=C%3A%2Fworkspace%2Fproject');
    expect(fetchCalls[0]?.init?.headers).toEqual({ 'x-opencode-directory': 'C:/workspace/project' });
    expect(fetchCalls[0]?.init?.signal).toBe(controller.signal);
  });

  test('status uses the scoped official SDK client', async () => {
    statusImpl = async () => ({ data: { server: { status: 'connected' } } });
    const options = mcpStatusQueryOptions('/workspace/a/', 'runtime-b');

    const status = await options.queryFn();

    expect(options.queryKey).toEqual(['runtime-b', 'mcp', 'status', '/workspace/a']);
    expect(statusDirectories).toEqual(['/workspace/a']);
    expect(status.server?.status).toBe('connected');
  });

  test('matching config refreshes share one flight and inactive runtime does not request', async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    fetchImpl = async () => new Promise<Response>((resolve) => { resolveResponse = resolve; });
    const first = refreshMcpConfigsQuery(queryClient, activeProjectPath, runtimeKey);
    const second = refreshMcpConfigsQuery(queryClient, activeProjectPath, runtimeKey);
    resolveResponse?.(jsonResponse([]));
    await Promise.all([first, second]);

    runtimeKey = 'runtime-b';
    await refreshMcpConfigsQuery(queryClient, activeProjectPath, 'runtime-a');

    expect(fetchCalls).toHaveLength(1);
  });

  test('failed refresh preserves the prior complete config snapshot', async () => {
    fetchImpl = async () => jsonResponse([{ name: 'server', type: 'local', command: ['server'], enabled: true }]);
    await refreshMcpConfigsQuery(queryClient, activeProjectPath, runtimeKey);
    fetchImpl = async () => jsonResponse({}, 500);

    await expect(refreshMcpConfigsQuery(queryClient, activeProjectPath, runtimeKey)).rejects.toThrow('Failed to load MCP configs');

    expect(readMcpConfigsSnapshot(queryClient, activeProjectPath, runtimeKey)[0]?.name).toBe('server');
  });

  test('matching status refreshes dedupe by runtime and directory', async () => {
    let resolveStatus: ((value: { data: Record<string, unknown> }) => void) | undefined;
    statusImpl = async () => new Promise((resolve) => { resolveStatus = resolve; });
    const first = refreshMcpStatusQuery(queryClient, activeProjectPath, runtimeKey);
    const second = refreshMcpStatusQuery(queryClient, activeProjectPath, runtimeKey);
    resolveStatus?.({ data: {} });
    await Promise.all([first, second]);

    expect(statusDirectories).toHaveLength(1);
  });

  test('failed status refresh preserves the prior complete snapshot', async () => {
    statusImpl = async () => ({ data: { server: { status: 'connected' } } });
    await refreshMcpStatusQuery(queryClient, activeProjectPath, runtimeKey);
    statusImpl = async () => { throw new Error('status unavailable'); };

    await expect(refreshMcpStatusQuery(queryClient, activeProjectPath, runtimeKey)).rejects.toThrow('status unavailable');

    expect(readMcpStatusSnapshot(queryClient, activeProjectPath, runtimeKey).server?.status).toBe('connected');
  });
});