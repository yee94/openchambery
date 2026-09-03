import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

let runtimeKey = 'runtime-a';
let runtimeGeneration = 1;
let fetchCalls: string[] = [];
let barrierRelease: (() => void) | null = null;
let barrierPromise: Promise<void> = Promise.resolve();

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => runtimeKey,
  getRuntimeGeneration: () => runtimeGeneration,
  isRuntimeEndpointIdentityChange: () => false,
  subscribeRuntimeEndpointChanged: () => () => undefined,
}));

mock.module('@/lib/session-startup-barrier', () => ({
  waitForSessionStartupBarrier: async () => barrierPromise,
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: async (path: string) => {
    fetchCalls.push(path);
    if (path.includes('/session/ensure')) {
      return new Response(JSON.stringify({ sessionID: 'ses_1', directory: '/workspace', sessionGeneration: 1 }), { status: 200 });
    }
    if (path.includes('/messages')) {
      return new Response(JSON.stringify({ entries: [], nextCursor: null, complete: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
  },
}));

mock.module('@/lib/queryRuntime', () => ({
  queryClient: {
    setQueryData: () => undefined,
    invalidateQueries: async () => undefined,
    getQueryData: () => undefined,
    fetchQuery: async () => undefined,
  },
}));

mock.module('@/lib/openchamberEvents', () => ({
  subscribeOpenchamberEvents: () => () => undefined,
}));

const {
  assistantHistoryInfiniteQueryOptions,
  ensureAssistantSession,
  retainAssistantHistoryPlaceholder,
} = await import('./assistantQueries');

const holdBarrier = () => {
  barrierPromise = new Promise<void>((resolve) => { barrierRelease = resolve; });
};

const releaseBarrier = () => {
  const release = barrierRelease;
  barrierRelease = null;
  barrierPromise = Promise.resolve();
  release?.();
};

describe('Assistant history and ensure startup gate', () => {
  beforeEach(() => {
    runtimeKey = 'runtime-a';
    runtimeGeneration = 1;
    fetchCalls = [];
    barrierRelease = null;
    barrierPromise = Promise.resolve();
  });

  afterEach(() => {
    releaseBarrier();
  });

  test('history queryFn waits for the session startup barrier before requesting', async () => {
    holdBarrier();
    const options = assistantHistoryInfiniteQueryOptions('assistant_1', 'ses_1', 1, 'runtime-a', 1);
    let settled = false;
    let page: { entries: unknown[]; complete: boolean; nextCursor: string | null } | undefined;
    const flight = options.queryFn({ signal: new AbortController().signal, pageParam: null }).then((result) => {
      settled = true;
      page = result;
      return result;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(fetchCalls).toEqual([]);
    releaseBarrier();
    await flight;
    expect(page).toEqual({ entries: [], complete: true, nextCursor: null });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toContain('/api/openchamber/assistants/assistant_1/messages?');
  });

  test('ensureAssistantSession waits for the barrier and rejects when runtime goes stale', async () => {
    holdBarrier();
    let settled = false;
    let error: { code?: string; status?: number } | undefined;
    const flight = ensureAssistantSession('assistant_1').then((binding) => {
      settled = true;
      return binding;
    }, (caught) => {
      settled = true;
      error = caught;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(fetchCalls).toEqual([]);
    runtimeKey = 'runtime-b';
    releaseBarrier();
    await flight;
    expect(error?.code).toBe('runtime_stale');
    expect(error?.status).toBe(409);
    expect(fetchCalls).toEqual([]);
  });

  test('ensureAssistantSession requests after barrier release when runtime stays current', async () => {
    holdBarrier();
    let binding: { sessionID: string | null; directory: string; sessionGeneration: number } | undefined;
    const flight = ensureAssistantSession('assistant_1').then((result) => { binding = result; return result; });
    await Promise.resolve();
    expect(fetchCalls).toEqual([]);
    releaseBarrier();
    await flight;
    expect(binding).toEqual({ sessionID: 'ses_1', directory: '/workspace', sessionGeneration: 1 });
    expect(fetchCalls).toEqual(['/api/openchamber/assistants/assistant_1/session/ensure']);
  });

  test('history queryFn rejects runtime_stale after barrier when generation changes', async () => {
    holdBarrier();
    const options = assistantHistoryInfiniteQueryOptions('assistant_1', 'ses_1', 1, 'runtime-a', 1);
    let error: { code?: string; status?: number } | undefined;
    const flight = options.queryFn({ signal: new AbortController().signal, pageParam: null }).then(
      (page) => page,
      (caught) => { error = caught; },
    );
    await Promise.resolve();
    runtimeGeneration = 2;
    releaseBarrier();
    await flight;
    expect(error?.code).toBe('runtime_stale');
    expect(error?.status).toBe(409);
    expect(fetchCalls).toEqual([]);
  });
});

describe('Assistant query contract', () => {
  test('uses runtime-scoped snapshots and assistant session routes', async () => {
    const { readFile } = await import('node:fs/promises');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const directory = dirname(fileURLToPath(import.meta.url));
    const source = await readFile(join(directory, 'assistantQueries.ts'), 'utf8');
    expect(source).toContain("[transport, 'assistants', 'snapshot']");
    expect(source).toContain('/session/ensure');
    expect(source).toContain('/session/new');
    expect(source).toContain('/session/compact');
    expect(source).toContain('/messages');
    expect(source).toContain('/share');
    expect(source).toContain("share-operations");
    expect(source).toContain('payload: { messageID, parts, source }');
    expect(source).toContain('{ sessionID: binding.sessionID, sessionGeneration: binding.sessionGeneration, messageID, parts, source }');
    expect(source).toContain('waitForSessionStartupBarrier');
    expect(source).toContain('/contact/messages');
    expect(source).toContain('/contact/cards');
    expect(source).toContain('/contact/dm');
  });

  test('keys paged Assistant history by transport, Assistant, and binding', async () => {
    const { readFile } = await import('node:fs/promises');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const directory = dirname(fileURLToPath(import.meta.url));
    const source = await readFile(join(directory, 'assistantQueries.ts'), 'utf8');
    expect(source).toContain("[transport, runtimeGeneration, 'assistants', 'history', assistantID, sessionID, sessionGeneration]");
    expect(source).toContain('useInfiniteQuery');
    expect(source).toContain('initialPageParam: null as string | null');
    expect(source).toContain('getNextPageParam: getNextAssistantHistoryPageParam');
    expect(source).toContain('/messages?${query}');
    expect(source).toContain("query.set('before', pageParam)");
    expect(source).toContain('parseAssistantHistoryPage');
    expect(source).toContain('assertCurrent(transport, runtimeGeneration)');
    expect(source).toContain('retainAssistantHistoryPlaceholder');
    expect(source).toContain('placeholderData:');
  });

  test('retains same-assistant history placeholder across binding key advances only', () => {
    const previousData = {
      pages: [{ entries: [], nextCursor: null, complete: true }],
      pageParams: [null],
    };
    const sameAssistantKey = ['runtime-a', 1, 'assistants', 'history', 'assistant_1', 'ses_old', 1] as const;
    const next = { assistantID: 'assistant_1', transport: 'runtime-a', runtimeGeneration: 1 };

    expect(retainAssistantHistoryPlaceholder(previousData, { queryKey: [...sameAssistantKey] }, next)).toBe(previousData);
    expect(retainAssistantHistoryPlaceholder(previousData, {
      queryKey: ['runtime-a', 1, 'assistants', 'history', 'assistant_2', 'ses_old', 1],
    }, next)).toBeUndefined();
    expect(retainAssistantHistoryPlaceholder(previousData, {
      queryKey: ['runtime-b', 1, 'assistants', 'history', 'assistant_1', 'ses_old', 1],
    }, next)).toBeUndefined();
    expect(retainAssistantHistoryPlaceholder(previousData, {
      queryKey: ['runtime-a', 2, 'assistants', 'history', 'assistant_1', 'ses_old', 1],
    }, next)).toBeUndefined();
    expect(retainAssistantHistoryPlaceholder(undefined, { queryKey: [...sameAssistantKey] }, next)).toBeUndefined();
  });

  test('repairs worker-driven binding changes from shared revision tips and rejects older bindings', async () => {
    const { readFile } = await import('node:fs/promises');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const directory = dirname(fileURLToPath(import.meta.url));
    const source = await readFile(join(directory, 'assistantQueries.ts'), 'utf8');
    expect(source).toContain("event.type !== 'assistants-changed'");
    expect(source).toContain("event.type === 'event-stream-ready'");
    expect(source).toContain('event.revision > snapshot.revision');
    expect(source).toContain('assistant.sessionGeneration > binding.sessionGeneration');
  });

  test('uses one initial history request and follows only server cursors', async () => {
    const { readFile } = await import('node:fs/promises');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const directory = dirname(fileURLToPath(import.meta.url));
    const source = await readFile(join(directory, 'assistantQueries.ts'), 'utf8');
    const history = source.slice(source.indexOf('export const assistantHistoryInfiniteQueryOptions'), source.indexOf('export const useAssistantHistoryInfiniteQuery'));
    expect(history).toContain('initialPageParam: null as string | null');
    expect(history).toContain('getNextPageParam: getNextAssistantHistoryPageParam');
    expect(history).toContain('placeholderData:');
    expect(history.match(/queryFn:/g)).toHaveLength(1);
  });

  test('settles share delivery only from a completed operation in its captured runtime', async () => {
    const { readFile } = await import('node:fs/promises');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const directory = dirname(fileURLToPath(import.meta.url));
    const source = await readFile(join(directory, 'assistantQueries.ts'), 'utf8');
    expect(source).toContain("current.state === 'running' || current.state === 'submitting'");
    expect(source).toContain("if (current.state === 'completed') return current");
    expect(source).toContain("new AssistantShareOperationError('share_unresolved', 408, current)");
    expect(source).toContain('fetchAssistantShareOperation(current.operationID, transport, generation)');
  });

  test('updates the captured Assistant snapshot immediately after PATCH success', async () => {
    const { readFile } = await import('node:fs/promises');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const directory = dirname(fileURLToPath(import.meta.url));
    const source = await readFile(join(directory, 'assistantQueries.ts'), 'utf8');
    const update = source.slice(source.indexOf('export const updateAssistant'), source.indexOf('export const deleteAssistant'));
    expect(update).toContain("jsonInit('PATCH'");
    expect(update).toContain('expectedRevision: assistant.revision');
    expect(update).toContain('applyAssistant(result, transport)');
  });

  test('refreshes capability and snapshot after changing instance availability', async () => {
    const { readFile } = await import('node:fs/promises');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const directory = dirname(fileURLToPath(import.meta.url));
    const source = await readFile(join(directory, 'assistantQueries.ts'), 'utf8');
    const mutation = source.slice(source.indexOf('export const setAssistantsEnabled'), source.indexOf('export const createAssistant'));
    expect(mutation).toContain('key.snapshot(transport), exact: true');
    expect(mutation).toContain('key.capability(transport), exact: true');
  });

  test('provides an abortable direct snapshot fetch without Query cache operations or retries', async () => {
    const { readFile } = await import('node:fs/promises');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const directory = dirname(fileURLToPath(import.meta.url));
    const source = await readFile(join(directory, 'assistantQueries.ts'), 'utf8');
    const directFetch = source.slice(source.indexOf('export const fetchAssistantSnapshot'), source.indexOf('export const assistantCapabilityQueryOptions'));
    expect(directFetch).toContain('signal: AbortSignal');
    expect(directFetch).toContain("requestJSON<unknown>('/api/openchamber/assistants/snapshot', { signal })");
    expect(directFetch).toContain('parseAssistantSnapshotDTO');
    expect(directFetch).not.toContain('queryClient');
    expect(directFetch).not.toContain('retry');
  });

  test('forces an authoritative runtime-current snapshot refresh through its exact Query key', async () => {
    const { readFile } = await import('node:fs/promises');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const directory = dirname(fileURLToPath(import.meta.url));
    const source = await readFile(join(directory, 'assistantQueries.ts'), 'utf8');
    const refresh = source.slice(source.indexOf('export const forceRefreshAssistantSnapshot'), source.indexOf('export const ensureAssistantSession'));
    expect(refresh).toContain('const transport = getRuntimeTransportIdentity()');
    expect(refresh).toContain('const generation = getRuntimeGeneration()');
    expect(refresh).toContain('invalidateQueries({ queryKey: key.snapshot(transport), exact: true })');
    expect(refresh).toContain('fetchQuery(assistantSnapshotQueryOptions(transport))');
    expect(refresh.match(/assertCurrent\(transport, generation\)/g)).toHaveLength(2);
  });
});
