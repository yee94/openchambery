import { expect, test } from 'bun:test';
import { MessageQueueServerError, type MessageQueueScope } from '@/lib/message-queue-server';
import { createMessageQueueServerRuntime } from './message-queue-server-runtime';

const descriptor = { scopeID: 'scope-a', revision: 1, directory: '/repo', sessionID: 'session-a', worktreeState: 'active', itemCount: 1 };
const item = { queueItemID: 'queue-a', operationID: 'operation-a', messageID: 'msg_a', content: 'queued', status: 'queued', attemptCount: 0, position: 0, rowVersion: 1, createdAt: 1 };

test('writes successful status, catalog, and complete scope into transport Query keys', async () => {
  const cache = new Map<string, unknown>();
  const client = {
    setQueryData: (key: readonly unknown[], value: unknown) => cache.set(JSON.stringify(key), value),
    getQueryData: <T>(key: readonly unknown[]) => cache.get(JSON.stringify(key)) as T | undefined,
    removeQueries: ({ queryKey }: { queryKey: readonly unknown[] }) => { for (const key of cache.keys()) if (key.startsWith(JSON.stringify(queryKey).slice(0, -1))) cache.delete(key); },
    invalidateQueries: async () => {},
  };
  const runtime = createMessageQueueServerRuntime({ client: client as never, capture: () => ({ transportIdentity: 'device-a', generation: 1 }), current: () => true, status: async () => ({ capability: true, authority: 'shadow' }), snapshot: async () => ({ revision: 1, scopes: [descriptor], worktreeOrders: [] }), scope: async () => ({ ...descriptor, items: [item] }) });
  await runtime.refresh();
  expect(cache.get(JSON.stringify(['device-a', 'messageQueue', 'status']))).toEqual({ capability: true, authority: 'shadow' });
  expect(cache.get(JSON.stringify(['device-a', 'messageQueue', 'snapshot']))).toEqual({ revision: 1, scopes: [descriptor], worktreeOrders: [] });
  const first = runtime.getScope({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session-a' });
  expect(first?.items).toEqual([item]);
  expect(runtime.getScope({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session-a' })).toBe(first);
});

test('successful empty catalog clears descriptors while a failed refresh keeps the prior complete scope', async () => {
  let empty = false, fail = false;
  const cache = new Map<string, unknown>();
  const client = { setQueryData: (key: readonly unknown[], value: unknown) => cache.set(JSON.stringify(key), value), getQueryData: <T>(key: readonly unknown[]) => cache.get(JSON.stringify(key)) as T | undefined, removeQueries: () => {}, invalidateQueries: async () => {} };
  const runtime = createMessageQueueServerRuntime({ client: client as never, capture: () => ({ transportIdentity: 'device-a', generation: 1 }), current: () => true, status: async () => ({ capability: true }), snapshot: async () => { if (fail) throw new Error('offline'); return { revision: empty ? 2 : 1, scopes: empty ? [] : [descriptor], worktreeOrders: [] }; }, scope: async () => ({ ...descriptor, items: [item] }) });
  await runtime.refresh();
  fail = true; await runtime.refresh();
  expect(runtime.getScope({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session-a' })?.items).toEqual([item]);
  fail = false; empty = true; await runtime.refresh();
  expect(runtime.getState().scopes.size).toBe(0);
});

test('direct capture identity changes clear A descriptors and scope snapshots before restart', async () => {
  let identity = 'A', generation = 1;
  const cache = new Map<string, unknown>();
  const client = { setQueryData: (key: readonly unknown[], value: unknown) => cache.set(JSON.stringify(key), value), getQueryData: <T>(key: readonly unknown[]) => cache.get(JSON.stringify(key)) as T | undefined, removeQueries: () => {}, invalidateQueries: async () => {} };
  const runtime = createMessageQueueServerRuntime({ client: client as never, capture: () => ({ transportIdentity: identity, generation }), current: () => true, status: async () => ({ capability: true }), snapshot: async () => ({ revision: 1, scopes: [descriptor], worktreeOrders: [] }), scope: async () => ({ ...descriptor, items: [item] }) });
  await runtime.refresh();
  expect(runtime.getScope({ transportIdentity: 'A', directory: '/repo', sessionID: 'session-a' })?.items).toEqual([item]);
  identity = 'B'; generation++;
  expect(runtime.getScope({ transportIdentity: 'B', directory: '/repo', sessionID: 'session-a' })).toBe(undefined);
  expect(runtime.getState().transportIdentity).toBe('B');
  expect(runtime.getState().scopes.size).toBe(0);
});

test('restart reloads the active transport after an A to B switch', async () => {
  let identity = 'A', generation = 1;
  const cache = new Map<string, unknown>();
  const client = { setQueryData: (key: readonly unknown[], value: unknown) => cache.set(JSON.stringify(key), value), getQueryData: <T>(key: readonly unknown[]) => cache.get(JSON.stringify(key)) as T | undefined, removeQueries: () => {}, invalidateQueries: async () => {} };
  const runtime = createMessageQueueServerRuntime({ client: client as never, capture: () => ({ transportIdentity: identity, generation }), current: () => true, status: async () => ({ capability: true }), snapshot: async () => ({ revision: 1, scopes: [descriptor], worktreeOrders: [] }), scope: async () => ({ ...descriptor, items: [{ ...item, content: identity }] }) });
  await runtime.refresh(); identity = 'B'; generation++; runtime.restart(); await runtime.refresh();
  expect(runtime.getScope({ transportIdentity: 'B', directory: '/repo', sessionID: 'session-a' })?.items[0]?.content).toBe('B');
});

test('an A mutation completion cannot publish into B state', async () => {
  let identity = 'A', generation = 1, release: (() => void) | undefined;
  const cache = new Map<string, unknown>();
  const client = { setQueryData: (key: readonly unknown[], value: unknown) => cache.set(JSON.stringify(key), value), getQueryData: <T>(key: readonly unknown[]) => cache.get(JSON.stringify(key)) as T | undefined, removeQueries: () => {}, invalidateQueries: async () => {} };
  const runtime = createMessageQueueServerRuntime({ client: client as never, capture: () => ({ transportIdentity: identity, generation }), current: () => true, status: async () => ({ capability: true }), snapshot: async () => ({ revision: 1, scopes: [descriptor], worktreeOrders: [] }), scope: async () => ({ ...descriptor, items: [item] }), edit: async () => { await new Promise<void>((resolve) => { release = resolve; }); return { revision: 2 }; } });
  await runtime.refresh();
  const pending = runtime.edit({ requestID: 'edit', scopeID: descriptor.scopeID, revision: 1, item, patch: { content: 'edited' } });
  identity = 'B'; generation++; runtime.getState(); release?.();
  expect(await pending).toEqual({ status: 'stale' });
  expect(runtime.getScope({ transportIdentity: 'B', directory: '/repo', sessionID: 'session-a' })).toBe(undefined);
});

test('treats a mismatched renew acknowledgement as stale', async () => {
  const runtime = createMessageQueueServerRuntime({ capture: () => ({ transportIdentity: 'device-a', generation: 1 }), current: () => true, renew: async () => ({ queueItemID: 'queue-other', token: 'token', generation: 1, expiresAt: 2 }) } as never);
  expect(await runtime.renewEdit({ item, token: 'token', generation: 1, ttlMs: 1_000, runtime: { transportIdentity: 'device-a', generation: 1 } })).toBe(undefined);
});

test('sends paused authority through the server CAS and reserves legacy send for shadow authority', async () => {
  const cache = new Map<string, unknown>();
  const client = { setQueryData: (key: readonly unknown[], value: unknown) => cache.set(JSON.stringify(key), value), getQueryData: <T>(key: readonly unknown[]) => cache.get(JSON.stringify(key)) as T | undefined, removeQueries: () => {}, invalidateQueries: async () => {} };
  let scopeRevision = 1, serverCalls = 0, legacyCalls = 0;
  const paused = createMessageQueueServerRuntime({ client: client as never, capture: () => ({ transportIdentity: 'device-a', generation: 1 }), current: () => true, status: async () => ({ capability: true, authority: 'paused' }), snapshot: async () => ({ revision: scopeRevision, scopes: [{ ...descriptor, revision: scopeRevision }], worktreeOrders: [] }), scope: async () => ({ ...descriptor, revision: scopeRevision, items: [item] }), manualSend: async () => { serverCalls++; scopeRevision = 2; return { revision: 2 }; }, legacyManualSend: async () => { legacyCalls++; } });
  await paused.refresh();
  expect((await paused.manualSend({ requestID: 'paused-send', scopeID: descriptor.scopeID, revision: 1, item })).status).toBe('committed');
  expect({ serverCalls, legacyCalls }).toEqual({ serverCalls: 1, legacyCalls: 0 });

  const shadow = createMessageQueueServerRuntime({ capture: () => ({ transportIdentity: 'device-a', generation: 1 }), current: () => true, status: async () => ({ capability: true, authority: 'shadow' }), manualSend: async () => { serverCalls++; return { revision: 1 }; }, legacyManualSend: async () => { legacyCalls++; } });
  await shadow.refresh();
  expect((await shadow.manualSend({ requestID: 'shadow-send', scopeID: descriptor.scopeID, revision: 1, item })).status).toBe('committed');
  expect({ serverCalls, legacyCalls }).toEqual({ serverCalls: 1, legacyCalls: 1 });
});

test('does not repeat a committed mutation when the worker advances the scope before refresh', async () => {
  const cache = new Map<string, unknown>();
  const client = { setQueryData: (key: readonly unknown[], value: unknown) => cache.set(JSON.stringify(key), value), getQueryData: <T>(key: readonly unknown[]) => cache.get(JSON.stringify(key)) as T | undefined, removeQueries: () => {}, invalidateQueries: async () => {} };
  let scopeRevision = 1, mutationCalls = 0;
  const runtime = createMessageQueueServerRuntime({
    client: client as never,
    capture: () => ({ transportIdentity: 'device-a', generation: 1 }),
    current: () => true,
    status: async () => ({ capability: true, authority: 'paused' }),
    snapshot: async () => ({ revision: scopeRevision, scopes: [{ ...descriptor, revision: scopeRevision }], worktreeOrders: [] }),
    scope: async () => ({ ...descriptor, revision: scopeRevision, items: [{ ...item, rowVersion: scopeRevision }] }),
    manualSend: async () => { mutationCalls++; scopeRevision = 2; queueMicrotask(() => { scopeRevision = 3; }); return { revision: 2 }; },
  });
  await runtime.refresh();

  const result = await runtime.manualSend({ requestID: 'send-once', scopeID: descriptor.scopeID, revision: 1, item });

  expect(result.status).toBe('committed');
  expect(result.scope?.revision).toBe(3);
  expect(mutationCalls).toBe(1);
});

test('replays the exact receipt-backed manual send after an unavailable response', async () => {
  const cache = new Map<string, unknown>();
  const client = { setQueryData: (key: readonly unknown[], value: unknown) => cache.set(JSON.stringify(key), value), getQueryData: <T>(key: readonly unknown[]) => cache.get(JSON.stringify(key)) as T | undefined, removeQueries: () => {}, invalidateQueries: async () => {} };
  let revision = 1;
  const attempts: Array<{ queueItemID: string; requestID: string; expectedRevision: number; expectedRowVersion: number }> = [];
  const runtime = createMessageQueueServerRuntime({
    client: client as never,
    capture: () => ({ transportIdentity: 'device-a', generation: 1 }),
    current: () => true,
    status: async () => ({ capability: true, authority: 'active' }),
    snapshot: async () => ({ revision, scopes: [{ ...descriptor, revision }], worktreeOrders: [] }),
    scope: async () => ({ ...descriptor, revision, items: [{ ...item, rowVersion: revision, manualDispatchRequested: revision > 1 }] }),
    manualSend: async (queueItemID, input) => {
      attempts.push({ queueItemID, requestID: input.requestID, expectedRevision: input.expectedRevision, expectedRowVersion: input.expectedRowVersion });
      if (attempts.length === 1) {
        revision = 2;
        throw new MessageQueueServerError(0, 'unavailable');
      }
      return { revision: 2 };
    },
  });
  await runtime.refresh();

  const result = await runtime.manualSend({ requestID: 'lost-response', scopeID: descriptor.scopeID, revision: 1, item });

  expect(attempts).toEqual([
    { queueItemID: item.queueItemID, requestID: 'lost-response', expectedRevision: 1, expectedRowVersion: 1 },
    { queueItemID: item.queueItemID, requestID: 'lost-response', expectedRevision: 1, expectedRowVersion: 1 },
  ]);
  expect(result.status).toBe('committed');
  expect(result.scope?.revision).toBe(2);
});

test('keeps a durable manual-send acknowledgement committed when scope reconciliation fails', async () => {
  const cache = new Map<string, unknown>();
  let invalidations = 0, committed = false;
  const client = { setQueryData: (key: readonly unknown[], value: unknown) => cache.set(JSON.stringify(key), value), getQueryData: <T>(key: readonly unknown[]) => cache.get(JSON.stringify(key)) as T | undefined, removeQueries: () => {}, invalidateQueries: async () => { invalidations++; } };
  const runtime = createMessageQueueServerRuntime({
    client: client as never,
    capture: () => ({ transportIdentity: 'device-a', generation: 1 }),
    current: () => true,
    status: async () => ({ capability: true, authority: 'active' }),
    snapshot: async () => {
      if (committed) throw new MessageQueueServerError(0, 'unavailable');
      return { revision: 1, scopes: [descriptor], worktreeOrders: [] };
    },
    scope: async () => ({ ...descriptor, items: [item] }),
    manualSend: async () => { committed = true; return { revision: 2 }; },
  });
  await runtime.refresh();

  const result = await runtime.manualSend({ requestID: 'committed-before-refresh', scopeID: descriptor.scopeID, revision: 1, item });

  // Receipt is durable; keep committedRevision even when post-commit scope reload fails.
  expect(result).toEqual({ status: 'committed', committedRevision: 2 });
  expect(invalidations).toBe(1);
  expect(runtime.getScope({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session-a' })?.items).toEqual([item]);
  expect(runtime.getState().error).toBeInstanceOf(MessageQueueServerError);
  expect((runtime.getState().error as MessageQueueServerError).code).toBe('unavailable');
});

test('reloads authoritative scope before surfacing an exhausted unavailable replay', async () => {
  const cache = new Map<string, unknown>();
  const client = { setQueryData: (key: readonly unknown[], value: unknown) => cache.set(JSON.stringify(key), value), getQueryData: <T>(key: readonly unknown[]) => cache.get(JSON.stringify(key)) as T | undefined, removeQueries: () => {}, invalidateQueries: async () => {} };
  let revision = 1, attempts = 0;
  const runtime = createMessageQueueServerRuntime({
    client: client as never,
    capture: () => ({ transportIdentity: 'device-a', generation: 1 }),
    current: () => true,
    status: async () => ({ capability: true, authority: 'active' }),
    snapshot: async () => ({ revision, scopes: [{ ...descriptor, revision }], worktreeOrders: [] }),
    scope: async () => ({ ...descriptor, revision, items: [{ ...item, rowVersion: revision, manualDispatchRequested: revision > 1 }] }),
    manualSend: async () => {
      attempts++;
      revision = 2;
      throw new MessageQueueServerError(0, 'unavailable');
    },
  });
  await runtime.refresh();

  await expect(runtime.manualSend({ requestID: 'unknown-response', scopeID: descriptor.scopeID, revision: 1, item })).rejects.toThrow(MessageQueueServerError);

  expect(attempts).toBe(2);
  expect(runtime.getState().scopes.get(descriptor.scopeID)?.revision).toBe(2);
  expect(runtime.getScope({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session-a' })?.items[0]?.manualDispatchRequested).toBe(true);
});

test('manual send reconciles the latest snapshot so a worker bump cannot empty the chip list', async () => {
  const cache = new Map<string, unknown>();
  const client = { setQueryData: (key: readonly unknown[], value: unknown) => cache.set(JSON.stringify(key), value), getQueryData: <T>(key: readonly unknown[]) => cache.get(JSON.stringify(key)) as T | undefined, removeQueries: () => {}, invalidateQueries: async () => {} };
  const tail = { ...item, queueItemID: 'queue-b', operationID: 'operation-b', messageID: 'msg_b', content: 'tail', position: 1 };
  let revision = 1;
  const runtime = createMessageQueueServerRuntime({
    client: client as never,
    capture: () => ({ transportIdentity: 'device-a', generation: 1 }),
    current: () => true,
    status: async () => ({ capability: true, authority: 'active' }),
    snapshot: async () => ({ revision, scopes: [{ ...descriptor, revision, itemCount: 2 }], worktreeOrders: [] }),
    scope: async () => ({
      ...descriptor,
      revision,
      itemCount: 2,
      items: revision >= 2
        ? [{ ...tail, position: 0, status: 'sending' as const }, { ...item, position: 1 }]
        : [item, tail],
    }),
    manualSend: async () => {
      revision = 2;
      return { revision: 2 };
    },
  });
  await runtime.refresh();
  expect(runtime.getScope({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session-a' })?.items.map((entry) => entry.queueItemID)).toEqual(['queue-a', 'queue-b']);
  const result = await runtime.manualSend({ requestID: 'cut-in', scopeID: descriptor.scopeID, revision: 1, item: tail });
  expect(result.status).toBe('committed');
  expect(result.scope?.items.map((entry) => entry.queueItemID)).toEqual(['queue-b', 'queue-a']);
  expect(result.scope?.items[0]?.status).toBe('sending');
});

test('reorder overwrites the visible order and preserves rows appended by another client', async () => {
  const cache = new Map<string, unknown>();
  const client = { setQueryData: (key: readonly unknown[], value: unknown) => cache.set(JSON.stringify(key), value), getQueryData: <T>(key: readonly unknown[]) => cache.get(JSON.stringify(key)) as T | undefined, removeQueries: () => {}, invalidateQueries: async () => {} };
  const second = { ...item, queueItemID: 'queue-b', operationID: 'operation-b', messageID: 'msg_b', content: 'second', position: 1 };
  const remote = { ...item, queueItemID: 'queue-c', operationID: 'operation-c', messageID: 'msg_c', content: 'remote', position: 2 };
  let revision = 1;
  let serverItems = [item, second];
  const orders: string[][] = [];
  const runtime = createMessageQueueServerRuntime({
    client: client as never,
    capture: () => ({ transportIdentity: 'device-a', generation: 1 }),
    current: () => true,
    status: async () => ({ capability: true, authority: 'active' }),
    snapshot: async () => ({ revision, scopes: [{ ...descriptor, revision, itemCount: serverItems.length }], worktreeOrders: [] }),
    scope: async () => ({ ...descriptor, revision, itemCount: serverItems.length, items: serverItems }),
    reorder: async (_scopeID, payload) => {
      orders.push([...payload.queueItemIDs]);
      if (revision === 1) {
        revision = 2;
        serverItems = [item, second, remote];
        throw new MessageQueueServerError(409, 'revision_conflict');
      }
      revision = 3;
      serverItems = payload.queueItemIDs.map((id, position) => ({ ...serverItems.find((entry) => entry.queueItemID === id)!, position }));
      return { revision };
    },
  });
  await runtime.refresh();

  const result = await runtime.reorder({ requestID: 'visible-overwrite', scopeID: descriptor.scopeID, revision: 1, queueItemIDs: ['queue-b', 'queue-a'] });

  expect(orders).toEqual([['queue-b', 'queue-a'], ['queue-b', 'queue-a', 'queue-c']]);
  expect(result.status).toBe('committed');
  expect(result.scope?.items.map((entry) => entry.queueItemID)).toEqual(['queue-b', 'queue-a', 'queue-c']);
});

test('failed manual send reloads the authoritative scope instead of leaving an empty chip list', async () => {
  const cache = new Map<string, unknown>();
  const client = { setQueryData: (key: readonly unknown[], value: unknown) => cache.set(JSON.stringify(key), value), getQueryData: <T>(key: readonly unknown[]) => cache.get(JSON.stringify(key)) as T | undefined, removeQueries: () => {}, invalidateQueries: async () => {} };
  const tail = { ...item, queueItemID: 'queue-b', operationID: 'operation-b', messageID: 'msg_b', content: 'tail', position: 1 };
  let revision = 1;
  const runtime = createMessageQueueServerRuntime({
    client: client as never,
    capture: () => ({ transportIdentity: 'device-a', generation: 1 }),
    current: () => true,
    status: async () => ({ capability: true, authority: 'active' }),
    snapshot: async () => ({ revision, scopes: [{ ...descriptor, revision, itemCount: 2 }], worktreeOrders: [] }),
    scope: async () => ({ ...descriptor, revision, itemCount: 2, items: [item, tail] }),
    manualSend: async () => {
      revision = 2;
      throw new MessageQueueServerError(409, 'scope_locked');
    },
  });
  await runtime.refresh();
  await expect(runtime.manualSend({ requestID: 'cut-in-fail', scopeID: descriptor.scopeID, revision: 1, item: tail })).rejects.toThrow(MessageQueueServerError);
  // Failure still reloads from the latest snapshot so chips match the server.
  expect(runtime.getState().scopes.get(descriptor.scopeID)?.revision).toBe(2);
  expect(runtime.getScope({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session-a' })?.items.map((entry) => entry.queueItemID)).toEqual(['queue-a', 'queue-b']);
});

test('observer applies a newer snapshot after a tip without re-waiting mid-apply', async () => {
  const cache = new Map<string, unknown>();
  const client = { setQueryData: (key: readonly unknown[], value: unknown) => cache.set(JSON.stringify(key), value), getQueryData: <T>(key: readonly unknown[]) => cache.get(JSON.stringify(key)) as T | undefined, removeQueries: () => {}, invalidateQueries: async () => {} };
  let revision = 1;
  let waits = 0;
  let releaseWait = () => {};
  let gate = Promise.resolve();
  const runtime = createMessageQueueServerRuntime({
    client: client as never,
    capture: () => ({ transportIdentity: 'device-a', generation: 1 }),
    current: () => true,
    status: async () => ({ capability: true, authority: 'active' }),
    snapshot: async () => ({ revision, scopes: [{ ...descriptor, revision, itemCount: revision === 1 ? 1 : 0 }], worktreeOrders: [] }),
    scope: async () => ({ ...descriptor, revision, itemCount: revision === 1 ? 1 : 0, items: revision === 1 ? [item] : [] }),
    waitInvalidation: async () => {
      waits += 1;
      await gate;
      return waits === 1 ? 'tip' : 'aborted';
    },
  });
  await runtime.refresh();
  expect(runtime.getScope({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session-a' })?.items).toEqual([item]);
  gate = new Promise<void>((resolve) => { releaseWait = resolve; });
  runtime.start();
  for (let i = 0; i < 100 && waits < 1; i++) await Promise.resolve();
  expect(waits).toBe(1);
  // Server advanced while waiting on a tip; the post-tip snapshot GET must clear
  // the completed row when the wait unblocks.
  revision = 2;
  releaseWait();
  for (let i = 0; i < 100 && (runtime.getScope({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session-a' })?.items.length ?? -1) !== 0; i++) await Promise.resolve();
  expect(runtime.getScope({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session-a' })?.items).toEqual([]);
  runtime.stop();
});

test('observer recovers when a tip is dropped after the stable GET and before wait registers', async () => {
  // Missed-wakeup regression: shared openchamberEvents can deliver DELETE tips
  // while no queue waiter is subscribed. First wait returns timeout (tip lost);
  // the next lead GET must clear the reconciling/sending row permanently.
  const cache = new Map<string, unknown>();
  const client = { setQueryData: (key: readonly unknown[], value: unknown) => cache.set(JSON.stringify(key), value), getQueryData: <T>(key: readonly unknown[]) => cache.get(JSON.stringify(key)) as T | undefined, removeQueries: () => {}, invalidateQueries: async () => {} };
  let revision = 1;
  let waits = 0;
  const reconciling = { ...item, status: 'reconciling' as const, attemptCount: 1 };
  const runtime = createMessageQueueServerRuntime({
    client: client as never,
    capture: () => ({ transportIdentity: 'device-a', generation: 1 }),
    current: () => true,
    status: async () => ({ capability: true, authority: 'active' }),
    snapshot: async () => ({ revision, scopes: [{ ...descriptor, revision, itemCount: revision === 1 ? 1 : 0 }], worktreeOrders: [] }),
    scope: async () => ({
      ...descriptor,
      revision,
      itemCount: revision === 1 ? 1 : 0,
      items: revision === 1 ? [reconciling] : [],
    }),
    waitInvalidation: async () => {
      waits += 1;
      // Server advanced and deleted the row after the stable GET; the tip was
      // discarded before this waiter registered (shared SSE kept alive by peers).
      if (waits === 1) {
        revision = 2;
        return 'timeout';
      }
      return 'aborted';
    },
  });
  await runtime.refresh();
  expect(runtime.getScope({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session-a' })?.items).toEqual([reconciling]);
  runtime.start();
  for (let i = 0; i < 200 && (runtime.getScope({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session-a' })?.items.length ?? -1) !== 0; i++) await Promise.resolve();
  expect(runtime.getScope({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session-a' })?.items).toEqual([]);
  expect(runtime.getState().scopes.get(descriptor.scopeID)?.revision).toBe(2);
  expect(waits).toBeGreaterThanOrEqual(1);
  runtime.stop();
});

test('observer recovers a confirm deletion published while scope pages load', async () => {
  const cache = new Map<string, unknown>();
  const client = { setQueryData: (key: readonly unknown[], value: unknown) => cache.set(JSON.stringify(key), value), getQueryData: <T>(key: readonly unknown[]) => cache.get(JSON.stringify(key)) as T | undefined, removeQueries: () => {}, invalidateQueries: async () => {} };
  let revision = 1;
  let waits = 0;
  let postTipSnapshotReads = 0;
  let tipped = false;
  let releaseWait = () => {};
  let gate = Promise.resolve();
  const sending = { ...item, status: 'sending' as const, attemptCount: 1 };
  const runtime = createMessageQueueServerRuntime({
    client: client as never,
    capture: () => ({ transportIdentity: 'device-a', generation: 1 }),
    current: () => true,
    status: async () => ({ capability: true, authority: 'active' }),
    snapshot: async () => {
      if (tipped) {
        postTipSnapshotReads += 1;
        // First post-tip catalog still shows the in-flight row. confirmByMessage
        // deletes it while pages load; the stability re-GET must observe revision 3.
        if (postTipSnapshotReads === 1) revision = 2;
        if (postTipSnapshotReads >= 2) revision = 3;
      }
      return { revision, scopes: [{ ...descriptor, revision, itemCount: revision < 3 ? 1 : 0 }], worktreeOrders: [] };
    },
    scope: async () => ({
      ...descriptor,
      revision,
      itemCount: revision < 3 ? 1 : 0,
      items: revision < 3 ? [revision === 1 ? item : sending] : [],
    }),
    waitInvalidation: async () => {
      waits += 1;
      await gate;
      tipped = true;
      return waits === 1 ? 'tip' : 'aborted';
    },
  });
  await runtime.refresh();
  expect(runtime.getScope({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session-a' })?.items).toEqual([item]);
  gate = new Promise<void>((resolve) => { releaseWait = resolve; });
  runtime.start();
  for (let i = 0; i < 100 && waits < 1; i++) await Promise.resolve();
  expect(waits).toBe(1);
  releaseWait();
  for (let i = 0; i < 200 && (runtime.getScope({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session-a' })?.items.length ?? -1) !== 0; i++) await Promise.resolve();
  expect(runtime.getScope({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session-a' })?.items).toEqual([]);
  expect(runtime.getState().scopes.get(descriptor.scopeID)?.revision).toBe(3);
  runtime.stop();
});

test('remove treats authoritative not_found as committed after scope reload', async () => {
  const cache = new Map<string, unknown>();
  const client = { setQueryData: (key: readonly unknown[], value: unknown) => cache.set(JSON.stringify(key), value), getQueryData: <T>(key: readonly unknown[]) => cache.get(JSON.stringify(key)) as T | undefined, removeQueries: () => {}, invalidateQueries: async () => {} };
  let revision = 1;
  let removeCalls = 0;
  const runtime = createMessageQueueServerRuntime({
    client: client as never,
    capture: () => ({ transportIdentity: 'device-a', generation: 1 }),
    current: () => true,
    status: async () => ({ capability: true, authority: 'paused' }),
    snapshot: async () => ({ revision, scopes: [{ ...descriptor, revision, itemCount: revision === 1 ? 1 : 0 }], worktreeOrders: [] }),
    scope: async () => ({ ...descriptor, revision, itemCount: revision === 1 ? 1 : 0, items: revision === 1 ? [item] : [] }),
    remove: async () => {
      removeCalls++;
      revision = 2;
      throw new MessageQueueServerError(404, 'not_found');
    },
  });
  await runtime.refresh();
  const result = await runtime.remove({ requestID: 'remove-stale', scopeID: descriptor.scopeID, revision: 1, item });
  expect(result.status).toBe('committed');
  expect(result.scope?.items).toEqual([]);
  expect(removeCalls).toBe(1);
});

test('not_found remove reload preserves remaining items in the same scope', async () => {
  const cache = new Map<string, unknown>();
  const client = { setQueryData: (key: readonly unknown[], value: unknown) => cache.set(JSON.stringify(key), value), getQueryData: <T>(key: readonly unknown[]) => cache.get(JSON.stringify(key)) as T | undefined, removeQueries: () => {}, invalidateQueries: async () => {} };
  const kept = { ...item, queueItemID: 'queue-kept', operationID: 'operation-kept', messageID: 'msg_kept', content: 'kept' };
  let revision = 1;
  const runtime = createMessageQueueServerRuntime({
    client: client as never,
    capture: () => ({ transportIdentity: 'device-a', generation: 1 }),
    current: () => true,
    status: async () => ({ capability: true, authority: 'paused' }),
    snapshot: async () => ({ revision, scopes: [{ ...descriptor, revision, itemCount: revision === 1 ? 2 : 1 }], worktreeOrders: [] }),
    scope: async () => ({
      ...descriptor,
      revision,
      itemCount: revision === 1 ? 2 : 1,
      items: revision === 1 ? [item, kept] : [kept],
    }),
    remove: async () => {
      revision = 2;
      throw new MessageQueueServerError(404, 'not_found');
    },
  });
  await runtime.refresh();
  const result = await runtime.remove({ requestID: 'remove-gone', scopeID: descriptor.scopeID, revision: 1, item });
  expect(result.status).toBe('committed');
  expect(result.scope?.items).toEqual([kept]);
});

test('conflict reload keeps sibling scope pages while advancing only the mutated scope', async () => {
  const cache = new Map<string, unknown>();
  const client = {
    setQueryData: (key: readonly unknown[], value: unknown) => cache.set(JSON.stringify(key), value),
    getQueryData: <T>(key: readonly unknown[]) => cache.get(JSON.stringify(key)) as T | undefined,
    removeQueries: ({ queryKey }: { queryKey: readonly unknown[] }) => {
      const prefix = JSON.stringify(queryKey).slice(0, -1);
      for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
    },
    invalidateQueries: async () => {},
  };
  const sibling = { scopeID: 'scope-b', revision: 1, directory: '/repo', sessionID: 'session-b', worktreeState: 'active' as const, itemCount: 1 };
  const siblingItem = { ...item, queueItemID: 'queue-b', operationID: 'operation-b', messageID: 'msg_b', content: 'sibling' };
  let revisionA = 1;
  let revisionB = 1;
  let editCalls = 0;
  const runtime = createMessageQueueServerRuntime({
    client: client as never,
    capture: () => ({ transportIdentity: 'device-a', generation: 1 }),
    current: () => true,
    status: async () => ({ capability: true, authority: 'paused' }),
    snapshot: async () => ({
      revision: Math.max(revisionA, revisionB),
      scopes: [
        { ...descriptor, revision: revisionA, itemCount: 1 },
        { ...sibling, revision: revisionB, itemCount: 1 },
      ],
      worktreeOrders: [],
    }),
    scope: async (scopeID) => {
      if (scopeID === sibling.scopeID) return { ...sibling, revision: revisionB, items: [siblingItem] };
      return { ...descriptor, revision: revisionA, itemCount: 1, items: [{ ...item, content: `a-${revisionA}` }] };
    },
    edit: async () => {
      editCalls++;
      if (editCalls === 1) {
        revisionA = 2;
        revisionB = 2;
        throw new MessageQueueServerError(409, 'revision_conflict');
      }
      return { revision: revisionA };
    },
  });
  await runtime.refresh();
  expect(runtime.getScope({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session-b' })?.items).toEqual([siblingItem]);
  const result = await runtime.edit({ requestID: 'edit-a', scopeID: descriptor.scopeID, revision: 1, item, patch: { content: 'edited' } });
  expect(result.status).toBe('committed');
  expect(runtime.getScope({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session-b' })?.items).toEqual([siblingItem]);
  expect(runtime.getState().scopes.get(sibling.scopeID)?.revision).toBe(1);
  expect(runtime.getState().scopes.get(descriptor.scopeID)?.revision).toBe(2);
});

test('replays repeated revision conflicts internally until the client intent commits', async () => {
  const cache = new Map<string, unknown>();
  const client = { setQueryData: (key: readonly unknown[], value: unknown) => cache.set(JSON.stringify(key), value), getQueryData: <T>(key: readonly unknown[]) => cache.get(JSON.stringify(key)) as T | undefined, removeQueries: () => {}, invalidateQueries: async () => {} };
  let revision = 1, calls = 0;
  const runtime = createMessageQueueServerRuntime({
    client: client as never,
    capture: () => ({ transportIdentity: 'device-a', generation: 1 }),
    current: () => true,
    status: async () => ({ capability: true, authority: 'paused' }),
    snapshot: async () => ({ revision, scopes: [{ ...descriptor, revision }], worktreeOrders: [] }),
    scope: async () => ({ ...descriptor, revision, items: [{ ...item, rowVersion: revision }] }),
    edit: async () => {
      calls++;
      if (calls < 4) {
        revision++;
        throw new MessageQueueServerError(409, calls % 2 ? 'revision_conflict' : 'row_version_conflict');
      }
      return { revision };
    },
  });
  await runtime.refresh();

  const result = await runtime.edit({ requestID: 'edit-replay', scopeID: descriptor.scopeID, revision: 1, item, patch: { content: 'client-wins' } });

  expect(result.status).toBe('committed');
  expect(calls).toBe(4);
  expect(result.scope?.revision).toBe(4);
});

test('replays edit reservation and reserved removal conflicts without exposing a scope lock', async () => {
  const cache = new Map<string, unknown>();
  const client = { setQueryData: (key: readonly unknown[], value: unknown) => cache.set(JSON.stringify(key), value), getQueryData: <T>(key: readonly unknown[]) => cache.get(JSON.stringify(key)) as T | undefined, removeQueries: () => {}, invalidateQueries: async () => {} };
  let revision = 1, reserveCalls = 0, removeCalls = 0, removed = false;
  const reserveExpected: number[] = [], removeExpected: number[] = [];
  const runtime = createMessageQueueServerRuntime({
    client: client as never,
    capture: () => ({ transportIdentity: 'device-a', generation: 1 }),
    current: () => true,
    status: async () => ({ capability: true, authority: 'paused' }),
    snapshot: async () => ({ revision, scopes: [{ ...descriptor, revision, itemCount: removed ? 0 : 1 }], worktreeOrders: [] }),
    scope: async () => ({ ...descriptor, revision, itemCount: removed ? 0 : 1, items: removed ? [] : [{ ...item, rowVersion: revision }] }),
    reserve: async (_queueItemID, input) => {
      reserveCalls++;
      reserveExpected.push(input.expectedRevision);
      if (reserveCalls < 3) {
        revision++;
        throw new MessageQueueServerError(409, 'revision_conflict');
      }
      return { revision, scopeID: descriptor.scopeID, queueItemID: item.queueItemID, rowVersion: revision, token: 'token', expiresAt: Date.now() + 60_000, generation: 1 };
    },
    removeReserved: async (_queueItemID, input) => {
      removeCalls++;
      removeExpected.push(input.expectedRevision);
      if (removeCalls < 3) {
        revision++;
        throw new MessageQueueServerError(409, 'row_version_conflict');
      }
      revision++;
      removed = true;
      return { revision };
    },
  });
  await runtime.refresh();
  const capture = runtime.captureRuntime();

  const reservation = await runtime.reserveEdit({ requestID: 'reserve-replay', scopeID: descriptor.scopeID, revision: 1, item, owner: 'ui-edit', ttlMs: 60_000, runtime: capture });
  const didRemove = await runtime.removeReserved({ requestID: 'remove-replay', scopeID: descriptor.scopeID, revision: reservation!.revision, item: { ...item, rowVersion: reservation!.rowVersion }, token: reservation!.token, generation: reservation!.generation, runtime: capture });

  expect(reserveExpected).toEqual([1, 2, 3]);
  expect(removeExpected).toEqual([3, 4, 5]);
  expect(didRemove).toBe(true);
  expect(runtime.getScope({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session-a' })?.items).toEqual([]);
});

test('admission publishes an exact-scope uploading shadow before upload settles', async () => {
  let releaseUpload = () => {};
  const upload = new Promise<{ attachments: [] }>((resolve) => { releaseUpload = () => resolve({ attachments: [] }); });
  const runtime = createMessageQueueServerRuntime({ capture: () => ({ transportIdentity: 'device-a', generation: 1 }), current: () => true, upload: async () => upload, admit: async () => ({ revision: 2, scopeID: 'scope-a' }) } as never);
  const admission = runtime.admit({ requestID: 'request-a', scope: { directory: '/repo', sessionID: 'session-a' }, item: { queueItemID: 'queue-a', operationID: 'operation-a', messageID: 'msg_a', content: 'queued', attachmentIssues: [], createdAt: 1 } });
  const pending = runtime.getPendingAdmissions({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session-a' })[0];
  expect(pending?.kind).toBe('pending-admission');
  expect(pending?.phase).toBe('uploading');
  expect(pending?.attachmentCount).toBe(0);
  expect(runtime.getPendingAdmissions({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session-b' })).toEqual([]);
  releaseUpload();
  await admission;
});

test('stageAdmission is immediately readable and admit reuses the same identity without a duplicate chip', async () => {
  let releaseUpload = () => {};
  const upload = new Promise<{ attachments: [] }>((resolve) => { releaseUpload = () => resolve({ attachments: [] }); });
  const runtime = createMessageQueueServerRuntime({ capture: () => ({ transportIdentity: 'device-a', generation: 1 }), current: () => true, upload: async () => upload, admit: async () => ({ revision: 2, scopeID: 'scope-a' }) } as never);
  const scope = { directory: '/repo', sessionID: 'session-a' };
  runtime.stageAdmission({
    requestID: 'request-a',
    scope,
    item: { queueItemID: 'queue-a', operationID: 'operation-a', messageID: 'msg_a', content: 'staged body', createdAt: 1, attachmentCount: 2 },
  });
  const staged = runtime.getPendingAdmissions({ transportIdentity: 'device-a', ...scope });
  expect(staged).toHaveLength(1);
  expect(staged[0]?.kind).toBe('pending-admission');
  expect(staged[0]?.requestID).toBe('request-a');
  expect(staged[0]?.queueItemID).toBe('queue-a');
  expect(staged[0]?.phase).toBe('uploading');
  expect(staged[0]?.content).toBe('staged body');
  expect(staged[0]?.attachmentCount).toBe(2);

  const admission = runtime.admit({
    requestID: 'request-a',
    scope,
    item: { queueItemID: 'queue-a', operationID: 'operation-a', messageID: 'msg_a', content: 'staged body', attachmentIssues: [], createdAt: 1 },
    attachments: [],
  });
  const duringUpload = runtime.getPendingAdmissions({ transportIdentity: 'device-a', ...scope });
  expect(duringUpload).toHaveLength(1);
  expect(duringUpload[0]?.requestID).toBe('request-a');
  expect(duringUpload[0]?.queueItemID).toBe('queue-a');
  releaseUpload();
  await admission;
});

test('unstageAdmission clears a staged pending chip before admit', () => {
  const runtime = createMessageQueueServerRuntime({ capture: () => ({ transportIdentity: 'device-a', generation: 1 }), current: () => true } as never);
  const scope = { directory: '/repo', sessionID: 'session-a' };
  runtime.stageAdmission({
    requestID: 'request-a',
    scope,
    item: { queueItemID: 'queue-a', operationID: 'operation-a', messageID: 'msg_a', content: 'staged', createdAt: 1 },
  });
  expect(runtime.getPendingAdmissions({ transportIdentity: 'device-a', ...scope })).toHaveLength(1);
  runtime.unstageAdmission({ requestID: 'request-a', scope });
  expect(runtime.getPendingAdmissions({ transportIdentity: 'device-a', ...scope })).toEqual([]);
});

test('POST acknowledgement resolves before a blocked targeted scope read and replay uses the same request payload once', async () => {
  let releaseScope = () => {}, calls = 0;
  const scopeRead = new Promise<MessageQueueScope>((resolve) => { releaseScope = () => resolve({ ...descriptor, revision: 2, items: [item] }); });
  const payloads: unknown[] = [];
  const runtime = createMessageQueueServerRuntime({
    capture: () => ({ transportIdentity: 'device-a', generation: 1 }), current: () => true,
    upload: async () => ({ attachments: [], totalBytes: 0 }),
    admit: async (input: unknown) => { payloads.push(input); calls++; if (calls === 1) throw new MessageQueueServerError(0, 'unavailable'); return { revision: 2, scopeID: 'scope-a' }; },
    scope: async () => scopeRead,
  } as never);
  const result = await runtime.admit({ requestID: 'request-a', scope: { directory: '/repo', sessionID: 'session-a' }, item: { queueItemID: 'queue-a', operationID: 'operation-a', messageID: 'msg_a', content: 'queued', attachmentIssues: [], createdAt: 1 } });
  expect(result).toEqual({ status: 'committed' });
  expect(calls).toBe(2);
  const asJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;
  expect(asJson(payloads[0])).toEqual(asJson(payloads[1]));
  expect(runtime.getPendingAdmissions({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session-a' })[0]?.phase).toBe('acknowledged');
  releaseScope();
  for (let attempt = 0; attempt < 20 && runtime.getPendingAdmissions({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session-a' }).length; attempt++) await Promise.resolve();
  expect(runtime.getPendingAdmissions({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session-a' })).toEqual([]);
});

test('definitive admission failure removes its pending shadow', async () => {
  const runtime = createMessageQueueServerRuntime({ capture: () => ({ transportIdentity: 'device-a', generation: 1 }), current: () => true, upload: async () => ({ attachments: [], totalBytes: 0 }), admit: async () => { throw new MessageQueueServerError(400, 'validation_error'); } } as never);
  await expect(runtime.admit({ requestID: 'request-a', scope: { directory: '/repo', sessionID: 'session-a' }, item: { queueItemID: 'queue-a', operationID: 'operation-a', messageID: 'msg_a', content: 'queued', attachmentIssues: [], createdAt: 1 } })).rejects.toThrow(MessageQueueServerError);
  expect(runtime.getPendingAdmissions({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session-a' })).toEqual([]);
});

test('higher authoritative revision clears an acknowledged pending admission when the worker already removed its row', async () => {
  const cache = new Map<string, unknown>();
  const client = { setQueryData: (key: readonly unknown[], value: unknown) => cache.set(JSON.stringify(key), value), getQueryData: <T>(key: readonly unknown[]) => cache.get(JSON.stringify(key)) as T | undefined, removeQueries: () => {}, invalidateQueries: async () => {} };
  const runtime = createMessageQueueServerRuntime({ client: client as never, capture: () => ({ transportIdentity: 'device-a', generation: 1 }), current: () => true, upload: async () => ({ attachments: [], totalBytes: 0 }), admit: async () => ({ revision: 2, scopeID: 'scope-a' }), scope: async () => ({ ...descriptor, revision: 3, itemCount: 0, items: [] }) } as never);
  await runtime.admit({ requestID: 'request-a', scope: { directory: '/repo', sessionID: 'session-a' }, item: { queueItemID: 'queue-a', operationID: 'operation-a', messageID: 'msg_a', content: 'queued', attachmentIssues: [], createdAt: 1 } });
  for (let attempt = 0; attempt < 20 && runtime.getPendingAdmissions({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session-a' }).length; attempt++) await Promise.resolve();
  expect(runtime.getPendingAdmissions({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session-a' })).toEqual([]);
});

test('a durable acknowledgement without a scope ID cannot strand its pending shadow', async () => {
  const runtime = createMessageQueueServerRuntime({ capture: () => ({ transportIdentity: 'device-a', generation: 1 }), current: () => true, upload: async () => ({ attachments: [], totalBytes: 0 }), admit: async () => ({ revision: 2 }) } as never);
  expect(await runtime.admit({ requestID: 'scope-less', scope: { directory: '/repo', sessionID: 'session-a' }, item: { queueItemID: 'queue-a', operationID: 'operation-a', messageID: 'msg_a', content: 'queued', attachmentIssues: [], createdAt: 1 } })).toEqual({ status: 'committed' });
  expect(runtime.getPendingAdmissions({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session-a' })).toEqual([]);
});

test('transport reset notifies pending exact-scope subscribers', async () => {
  let identity = 'device-a', generation = 1;
  const runtime = createMessageQueueServerRuntime({
    capture: () => ({ transportIdentity: identity, generation }),
    current: (capture: { transportIdentity: string; generation: number }) => capture.transportIdentity === identity && capture.generation === generation,
    upload: async () => new Promise<never>(() => {}),
  } as never);
  void runtime.admit({ requestID: 'request-a', scope: { directory: '/repo', sessionID: 'session-a' }, item: { queueItemID: 'queue-a', operationID: 'operation-a', messageID: 'msg_a', content: 'queued', attachmentIssues: [], createdAt: 1 } });
  let notifications = 0;
  runtime.subscribeScope({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session-a' }, () => { notifications++; });
  identity = 'device-b'; generation++;
  runtime.getState();
  expect(notifications).toBe(1);
  expect(runtime.getPendingAdmissions({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session-a' })).toEqual([]);
});

test('stale upload and stale unavailable POST settle admission without replaying the old runtime request', async () => {
  let identity = 'device-a', generation = 1, postCalls = 0;
  const current = (capture: { transportIdentity: string; generation: number }) => capture.transportIdentity === identity && capture.generation === generation;
  const uploadStale = createMessageQueueServerRuntime({ capture: () => ({ transportIdentity: identity, generation }), current, upload: async () => { identity = 'device-b'; generation++; throw new Error('aborted'); } } as never);
  expect(await uploadStale.admit({ requestID: 'upload-stale', scope: { directory: '/repo', sessionID: 'session-a' }, item: { queueItemID: 'queue-a', operationID: 'operation-a', messageID: 'msg_a', content: 'queued', attachmentIssues: [], createdAt: 1 } })).toEqual({ status: 'stale' });

  identity = 'device-a'; generation = 1;
  const postStale = createMessageQueueServerRuntime({ capture: () => ({ transportIdentity: identity, generation }), current, upload: async () => ({ attachments: [], totalBytes: 0 }), admit: async () => { postCalls++; identity = 'device-b'; generation++; throw new MessageQueueServerError(0, 'unavailable'); } } as never);
  expect(await postStale.admit({ requestID: 'post-stale', scope: { directory: '/repo', sessionID: 'session-a' }, item: { queueItemID: 'queue-a', operationID: 'operation-a', messageID: 'msg_a', content: 'queued', attachmentIssues: [], createdAt: 1 } })).toEqual({ status: 'stale' });
  expect(postCalls).toBe(1);
});

test('durable acknowledgement remains committed across a runtime switch', async () => {
  let identity = 'device-a', generation = 1;
  const runtime = createMessageQueueServerRuntime({
    capture: () => ({ transportIdentity: identity, generation }),
    current: (capture: { transportIdentity: string; generation: number }) => capture.transportIdentity === identity && capture.generation === generation,
    upload: async () => ({ attachments: [], totalBytes: 0 }),
    admit: async () => { identity = 'device-b'; generation++; return { revision: 2, scopeID: 'scope-a' }; },
  } as never);
  expect(await runtime.admit({ requestID: 'ack-stale', scope: { directory: '/repo', sessionID: 'session-a' }, item: { queueItemID: 'queue-a', operationID: 'operation-a', messageID: 'msg_a', content: 'queued', attachmentIssues: [], createdAt: 1 } })).toEqual({ status: 'committed' });
});

test('SSE-authoritative scope before POST acknowledgement clears the pending shadow without another scope GET', async () => {
  const cache = new Map<string, unknown>();
  const client = { setQueryData: (key: readonly unknown[], value: unknown) => cache.set(JSON.stringify(key), value), getQueryData: <T>(key: readonly unknown[]) => cache.get(JSON.stringify(key)) as T | undefined, removeQueries: () => {}, invalidateQueries: async () => {} };
  let scopeCalls = 0;
  const runtime = createMessageQueueServerRuntime({ client: client as never, capture: () => ({ transportIdentity: 'device-a', generation: 1 }), current: () => true, status: async () => ({ capability: true, authority: 'active' }), snapshot: async () => ({ revision: 2, scopes: [{ ...descriptor, revision: 2, itemCount: 0 }], worktreeOrders: [] }), scope: async () => { scopeCalls++; return { ...descriptor, revision: 2, itemCount: 0, items: [] }; }, upload: async () => ({ attachments: [], totalBytes: 0 }), admit: async () => ({ revision: 2, scopeID: 'scope-a' }) } as never);
  await runtime.refresh();
  expect(await runtime.admit({ requestID: 'sse-first', scope: { directory: '/repo', sessionID: 'session-a' }, item: { queueItemID: 'queue-a', operationID: 'operation-a', messageID: 'msg_a', content: 'queued', attachmentIssues: [], createdAt: 1 } })).toEqual({ status: 'committed' });
  for (let attempt = 0; attempt < 20 && runtime.getPendingAdmissions({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session-a' }).length; attempt++) await Promise.resolve();
  expect(scopeCalls).toBe(1);
  expect(runtime.getPendingAdmissions({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session-a' })).toEqual([]);
});

test('pending-only new scope converges without an empty exact-scope snapshot', async () => {
  const cache = new Map<string, unknown>();
  const client = { setQueryData: (key: readonly unknown[], value: unknown) => cache.set(JSON.stringify(key), value), getQueryData: <T>(key: readonly unknown[]) => cache.get(JSON.stringify(key)) as T | undefined, removeQueries: () => {}, invalidateQueries: async () => {} };
  const runtime = createMessageQueueServerRuntime({ client: client as never, capture: () => ({ transportIdentity: 'device-a', generation: 1 }), current: () => true, upload: async () => ({ attachments: [], totalBytes: 0 }), admit: async () => ({ revision: 2, scopeID: 'scope-a' }), scope: async () => ({ ...descriptor, revision: 2, items: [item] }) } as never);
  const observations: Array<{ scope: boolean; pending: number }> = [];
  runtime.subscribeScope({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session-a' }, () => observations.push({ scope: Boolean(runtime.getScope({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session-a' })), pending: runtime.getPendingAdmissions({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session-a' }).length }));
  await runtime.admit({ requestID: 'new-scope', scope: { directory: '/repo', sessionID: 'session-a' }, item: { queueItemID: 'queue-a', operationID: 'operation-a', messageID: 'msg_a', content: 'queued', attachmentIssues: [], createdAt: 1 } });
  for (let attempt = 0; attempt < 20 && !observations.some((entry) => entry.scope && entry.pending === 0); attempt++) await Promise.resolve();
  expect(observations.every((entry) => entry.scope || entry.pending > 0)).toBe(true);
  expect(observations.some((entry) => entry.scope && entry.pending === 0)).toBe(true);
});

test('same-scope pending reads retain their reference until a pending transition', () => {
  const runtime = createMessageQueueServerRuntime({ capture: () => ({ transportIdentity: 'device-a', generation: 1 }), current: () => true, upload: async () => new Promise<never>(() => {}) } as never);
  const input = (requestID: string) => ({ requestID, scope: { directory: '/repo', sessionID: 'session-a' }, item: { queueItemID: `queue-${requestID}`, operationID: `operation-${requestID}`, messageID: `msg_${requestID}`, content: 'queued', attachmentIssues: [], createdAt: 1 } });
  void runtime.admit(input('a'));
  void runtime.admit(input('b'));
  const first = runtime.getPendingAdmissions({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session-a' });
  expect(first).toHaveLength(2);
  expect(runtime.getPendingAdmissions({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session-a' })).toBe(first);
});

test('an acknowledged admission drops its locked shadow when targeted reconciliation times out', async () => {
  const runtime = createMessageQueueServerRuntime({
    capture: () => ({ transportIdentity: 'device-a', generation: 1 }), current: () => true,
    upload: async () => ({ attachments: [], totalBytes: 0 }), admit: async () => ({ revision: 2, scopeID: 'scope-a' }),
    scope: async () => new Promise<never>(() => {}),
    admissionReconcileTimeoutMs: 5,
  } as never);
  await runtime.admit({ requestID: 'ack-pending', scope: { directory: '/repo', sessionID: 'session-a' }, item: { queueItemID: 'queue-a', operationID: 'operation-a', messageID: 'msg_a', content: 'queued', attachmentIssues: [], createdAt: 1 } });
  expect(runtime.getPendingAdmissions({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session-a' })[0]?.phase).toBe('acknowledged');
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(runtime.getPendingAdmissions({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session-a' })).toEqual([]);
});

test('a hung attachment upload times out and removes its locked shadow', async () => {
  const runtime = createMessageQueueServerRuntime({
    capture: () => ({ transportIdentity: 'device-a', generation: 1 }), current: () => true,
    upload: async () => new Promise<never>(() => {}),
    admissionUploadTimeoutMs: 5,
  } as never);
  await expect(runtime.admit({ requestID: 'hung-upload', scope: { directory: '/repo', sessionID: 'session-a' }, item: { queueItemID: 'queue-a', operationID: 'operation-a', messageID: 'msg_a', content: 'queued', attachmentIssues: [], createdAt: 1 } })).rejects.toThrow(MessageQueueServerError);
  expect(runtime.getPendingAdmissions({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session-a' })).toEqual([]);
});

test('a hung admission replay times out and removes its locked shadow', async () => {
  let calls = 0;
  const runtime = createMessageQueueServerRuntime({
    capture: () => ({ transportIdentity: 'device-a', generation: 1 }), current: () => true,
    upload: async () => ({ attachments: [], totalBytes: 0 }),
    admit: async () => {
      calls++;
      if (calls === 1) throw new MessageQueueServerError(0, 'unavailable');
      return new Promise<never>(() => {});
    },
    admissionRequestTimeoutMs: 5,
  } as never);
  await expect(runtime.admit({ requestID: 'hung-replay', scope: { directory: '/repo', sessionID: 'session-a' }, item: { queueItemID: 'queue-a', operationID: 'operation-a', messageID: 'msg_a', content: 'queued', attachmentIssues: [], createdAt: 1 } })).rejects.toThrow(MessageQueueServerError);
  expect(calls).toBe(2);
  expect(runtime.getPendingAdmissions({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session-a' })).toEqual([]);
});

test('an old multi-page catalog completion preserves newer scope and snapshot state', async () => {
  const cache = new Map<string, unknown>();
  const client = { setQueryData: (key: readonly unknown[], value: unknown) => cache.set(JSON.stringify(key), value), getQueryData: <T>(key: readonly unknown[]) => cache.get(JSON.stringify(key)) as T | undefined, removeQueries: () => {}, invalidateQueries: async () => {} };
  const sibling = { scopeID: 'scope-b', revision: 2, directory: '/repo', sessionID: 'session-b', worktreeState: 'active' as const, itemCount: 1 };
  let modern = false, requestedOldSecondPage = false, releaseOldSecondPage = () => {};
  const oldSecondPage = new Promise<MessageQueueScope>((resolve) => { releaseOldSecondPage = () => resolve({ ...descriptor, revision: 1, itemCount: 9, items: [{ ...item, queueItemID: 'queue-9' }] }); });
  const runtime = createMessageQueueServerRuntime({
    client: client as never, capture: () => ({ transportIdentity: 'device-a', generation: 1 }), current: () => true, status: async () => ({ capability: true }),
    snapshot: async () => modern ? { revision: 2, scopes: [{ ...descriptor, revision: 2 }, sibling], worktreeOrders: [] } : { revision: 1, scopes: [{ ...descriptor, itemCount: 9 }], worktreeOrders: [] },
    scope: async (scopeID, options) => {
      if (modern) return scopeID === sibling.scopeID ? { ...sibling, items: [{ ...item, queueItemID: 'queue-b' }] } : { ...descriptor, revision: 2, items: [{ ...item, content: 'new' }] };
      if (options?.offset === 8) { requestedOldSecondPage = true; return oldSecondPage; }
      return { ...descriptor, itemCount: 9, items: Array.from({ length: 8 }, (_, index) => ({ ...item, queueItemID: `queue-${index}` })), nextOffset: 8 };
    },
  });
  const oldRefresh = runtime.refresh();
  for (let attempt = 0; attempt < 20 && !requestedOldSecondPage; attempt++) await Promise.resolve();
  modern = true;
  await runtime.refresh();
  releaseOldSecondPage();
  await oldRefresh;
  expect(runtime.getState().scopes.get('scope-a')?.revision).toBe(2);
  expect(runtime.getScope({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session-a' })?.items[0]?.content).toBe('new');
  expect(runtime.getScope({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session-b' })?.items[0]?.queueItemID).toBe('queue-b');
  expect((cache.get(JSON.stringify(['device-a', 'messageQueue', 'snapshot'])) as { revision: number }).revision).toBe(2);
});

test('a late catalog snapshot cannot delete a targeted scope with a newer revision', async () => {
  const cache = new Map<string, unknown>();
  const client = { setQueryData: (key: readonly unknown[], value: unknown) => cache.set(JSON.stringify(key), value), getQueryData: <T>(key: readonly unknown[]) => cache.get(JSON.stringify(key)) as T | undefined, removeQueries: () => {}, invalidateQueries: async () => {} };
  let late = false, waiting = false, releaseScope = () => {};
  const blockedScope = new Promise<MessageQueueScope>((resolve) => { releaseScope = () => resolve({ ...descriptor, revision: 2, items: [item] }); });
  const runtime = createMessageQueueServerRuntime({
    client: client as never, capture: () => ({ transportIdentity: 'device-a', generation: 1 }), current: () => true, status: async () => ({ capability: true }),
    snapshot: async () => late ? { revision: 2, scopes: [{ ...descriptor, revision: 2 }], worktreeOrders: [] } : { revision: 1, scopes: [descriptor], worktreeOrders: [] },
    scope: async (scopeID: string) => {
      if (scopeID === 'scope-b') return { scopeID: 'scope-b', revision: 3, directory: '/repo', sessionID: 'session-b', worktreeState: 'active', itemCount: 1, items: [{ ...item, queueItemID: 'queue-b' }] };
      if (late) { waiting = true; return blockedScope; }
      return { ...descriptor, items: [item] };
    }, upload: async () => ({ attachments: [], totalBytes: 0 }), admit: async () => ({ revision: 3, scopeID: 'scope-b' }),
  } as never);
  await runtime.refresh();
  late = true;
  const oldRefresh = runtime.refresh();
  for (let attempt = 0; attempt < 20 && !waiting; attempt++) await Promise.resolve();
  await runtime.admit({ requestID: 'targeted-b', scope: { directory: '/repo', sessionID: 'session-b' }, item: { queueItemID: 'queue-b', operationID: 'operation-b', messageID: 'msg_b', content: 'new sibling', attachmentIssues: [], createdAt: 1 } });
  for (let attempt = 0; attempt < 20 && !runtime.getState().scopes.has('scope-b'); attempt++) await Promise.resolve();
  releaseScope();
  await oldRefresh;
  expect(runtime.getState().scopes.get('scope-b')?.revision).toBe(3);
  expect(runtime.getScope({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session-b' })?.items[0]?.queueItemID).toBe('queue-b');
  expect((cache.get(JSON.stringify(['device-a', 'messageQueue', 'snapshot'])) as { revision: number }).revision).toBe(1);
});
