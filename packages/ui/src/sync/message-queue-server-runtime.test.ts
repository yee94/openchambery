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
  expect(payloads[0]).toEqual(payloads[1]);
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
  await Promise.resolve();
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

test('an acknowledged admission remains pending while its targeted scope read is unavailable', async () => {
  const runtime = createMessageQueueServerRuntime({
    capture: () => ({ transportIdentity: 'device-a', generation: 1 }), current: () => true,
    upload: async () => ({ attachments: [], totalBytes: 0 }), admit: async () => ({ revision: 2, scopeID: 'scope-a' }),
    scope: async () => new Promise<never>(() => {}),
  } as never);
  await runtime.admit({ requestID: 'ack-pending', scope: { directory: '/repo', sessionID: 'session-a' }, item: { queueItemID: 'queue-a', operationID: 'operation-a', messageID: 'msg_a', content: 'queued', attachmentIssues: [], createdAt: 1 } });
  expect(runtime.getPendingAdmissions({ transportIdentity: 'device-a', directory: '/repo', sessionID: 'session-a' })[0]?.phase).toBe('acknowledged');
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
