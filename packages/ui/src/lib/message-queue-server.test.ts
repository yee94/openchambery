import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// Clear sticky mocks from other suites before installing this file's doubles.
mock.restore();

type OpenChamberEvent = {
  type: string;
  revision?: number;
  occurredAt?: number;
};
const tipListeners = new Set<(event: OpenChamberEvent) => void>();
/** Deliver a tip (or ready) event to every active OpenChamber tip subscriber. */
const emitTip = (event: OpenChamberEvent) => {
  for (const listener of [...tipListeners]) listener(event);
};
const realOpenchamberEvents = await import('@/lib/openchamberEvents');
mock.module('@/lib/openchamberEvents', () => ({
  subscribeOpenchamberEvents: (listener: (event: OpenChamberEvent) => void) => {
    tipListeners.add(listener);
    return () => { tipListeners.delete(listener); };
  },
  // Keep the real parser so sibling suites can still assert envelope contracts.
  parseOpenchamberEventEnvelope: realOpenchamberEvents.parseOpenchamberEventEnvelope,
}));

import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from './runtime-url';

const api = await import('./message-queue-server');
const { buildAssistantQueueDeliveryParts } = await import('@/components/chat/chatComposerDelivery');

const item = { queueItemID: 'item/a', operationID: 'operation/a', messageID: 'message/a', content: 'hello', status: 'queued', attemptCount: 0, position: 0, rowVersion: 2, createdAt: 1 };
const scope = { scopeID: 'scope/a', revision: 4, directory: '/repo', sessionID: 'session/a', worktreeState: 'active', itemCount: 1, items: [item] };
const snapshot = { revision: 4, scopes: [{ ...scope, items: undefined }], worktreeOrders: [{ projectDirectory: '/repo', orderedPaths: ['/repo/w'], revision: 2 }] };

type FetchCall = { url: URL; method: string; body: string | null; headers: Headers; signal?: AbortSignal | null };
const fetchCalls: FetchCall[] = [];
let responseImplementation: (call: FetchCall) => Promise<Response>;
const originalFetch = globalThis.fetch;
let previousResolver: ReturnType<typeof getRuntimeUrlResolver>;

const pathnameOf = (call: FetchCall) => call.url.pathname;
const readCalls = () => fetchCalls.map((call) => {
  const query = Object.fromEntries(call.url.searchParams.entries());
  const numericQuery = Object.fromEntries(Object.entries(query).map(([key, value]) => {
    const asNumber = Number(value);
    return [key, Number.isFinite(asNumber) && String(asNumber) === value ? asNumber : value];
  }));
  return [
    pathnameOf(call),
    {
      ...(Object.keys(numericQuery).length > 0 ? { query: numericQuery } : {}),
      ...(call.method !== 'GET' ? { method: call.method } : {}),
      ...(call.body ? { body: call.body } : {}),
      ...(call.signal ? { signal: call.signal } : {}),
    },
  ] as const;
});

describe('message queue server adapter', () => {
  afterAll(() => {
    mock.restore();
  });
  beforeEach(() => {
    tipListeners.clear();
    fetchCalls.length = 0;
    previousResolver = getRuntimeUrlResolver();
    configureRuntimeUrlResolver({ apiBaseUrl: 'http://127.0.0.1:57123' });
    responseImplementation = async () => new Response(JSON.stringify(snapshot));
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const call: FetchCall = {
        url: new URL(request.url),
        method: request.method,
        body: init?.body == null ? null : (typeof init.body === 'string' ? init.body : '[binary]'),
        headers: request.headers,
        signal: request.signal,
      };
      fetchCalls.push(call);
      return responseImplementation(call);
    }) as typeof fetch;
  });
  afterEach(() => {
    tipListeners.clear();
    fetchCalls.length = 0;
    setRuntimeUrlResolver(previousResolver);
    globalThis.fetch = originalFetch;
  });

  test('uses exact encoded read paths, queries, and signals', async () => {
    const responses = [scope, snapshot.worktreeOrders[0]];
    responseImplementation = async () => new Response(JSON.stringify(responses.shift()));
    const controller = new AbortController();
    await api.fetchMessageQueueScope('scope/a?', { offset: 2, limit: 8, expectedRevision: 4, signal: controller.signal });
    const pending = api.waitForMessageQueueInvalidation(4, { signal: controller.signal });
    emitTip({ type: 'message-queue-changed', revision: 5, occurredAt: 1 });
    expect(await pending).toBe('tip');
    await api.fetchWorktreeOrder('/repo a', controller.signal);
    expect(readCalls()).toEqual([
      ['/api/openchamber/message-queue/scopes/scope%2Fa%3F', { query: { offset: 2, limit: 8, expectedRevision: 4 }, signal: controller.signal }],
      ['/api/openchamber/message-queue/worktrees/order', { query: { projectDirectory: '/repo a' }, signal: controller.signal }],
    ]);
  });

  test('resolves tip, ready, and aborted invalidation without long-poll HTTP', async () => {
    const tip = api.waitForMessageQueueInvalidation(3);
    emitTip({ type: 'message-queue-changed', revision: 4, occurredAt: 1 });
    expect(await tip).toBe('tip');

    const ready = api.waitForMessageQueueInvalidation(3);
    emitTip({ type: 'event-stream-ready' });
    expect(await ready).toBe('ready');

    const controller = new AbortController();
    const aborted = api.waitForMessageQueueInvalidation(3, { signal: controller.signal });
    controller.abort();
    expect(await aborted).toBe('aborted');
    expect(fetchCalls).toEqual([]);
  });

  test('sends the admission and mutation contracts without serializing signals', async () => {
    responseImplementation = async () => new Response(JSON.stringify({ revision: 5, scopeID: 'scope/a', queueItemID: 'item/a', rowVersion: 2 }));
    const controller = new AbortController();
    await api.admitTextQueueItem({ requestID: 'r1', expectedRevision: 4, scope: { directory: '/repo', sessionID: 'session/a' }, item: { queueItemID: 'item/a', operationID: 'operation/a', messageID: 'message/a', content: 'secret', attachments: [], attachmentIssues: [], createdAt: 1 }, signal: controller.signal });
    await api.editTextQueueItem('item/a', { requestID: 'r2', expectedRevision: 5, expectedRowVersion: 2, item: { content: 'updated' } });
    await api.removeQueueItem('item/a', { requestID: 'r3', expectedRevision: 5, expectedRowVersion: 3 });
    await api.reorderQueueScope('scope/a', { requestID: 'r4', expectedRevision: 5, queueItemIDs: ['item/a'] });
    await api.setWorktreeOrder({ requestID: 'r5', projectDirectory: '/repo', expectedRevision: 2, orderedPaths: ['/repo/w'] });
    expect(fetchCalls.map((call) => [pathnameOf(call), call.method, JSON.parse(String(call.body))])).toEqual([
      ['/api/openchamber/message-queue/items', 'POST', { requestID: 'r1', expectedRevision: 4, scope: { directory: '/repo', sessionID: 'session/a' }, item: { queueItemID: 'item/a', operationID: 'operation/a', messageID: 'message/a', content: 'secret', attachments: [], attachmentIssues: [], createdAt: 1 } }],
      ['/api/openchamber/message-queue/items/item%2Fa', 'PATCH', { requestID: 'r2', expectedRevision: 5, expectedRowVersion: 2, item: { content: 'updated' } }],
      ['/api/openchamber/message-queue/items/item%2Fa', 'DELETE', { requestID: 'r3', expectedRevision: 5, expectedRowVersion: 3 }],
      ['/api/openchamber/message-queue/scopes/scope%2Fa/order', 'PUT', { requestID: 'r4', expectedRevision: 5, queueItemIDs: ['item/a'] }],
      ['/api/openchamber/message-queue/worktrees/order', 'PUT', { requestID: 'r5', projectDirectory: '/repo', expectedRevision: 2, orderedPaths: ['/repo/w'] }],
    ]);
    expect(fetchCalls[0]?.signal).toBe(controller.signal);
  });

  test('accepts compact mutation acknowledgements and rejects item bodies', async () => {
    responseImplementation = async () => new Response(JSON.stringify({ revision: 5, projectDirectory: '/repo' }));
    await api.setWorktreeOrder({ requestID: 'r5', projectDirectory: '/repo', expectedRevision: 2, orderedPaths: ['/repo/w'] });
    responseImplementation = async () => new Response(JSON.stringify({ revision: 5, scope: scope }));
    try {
      await api.setWorktreeOrder({ requestID: 'r6', projectDirectory: '/repo', expectedRevision: 2, orderedPaths: ['/repo/w'] });
      throw new Error('expected malformed acknowledgement to fail');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('unavailable');
    }
  });

  test('maps stable route errors and rejects malformed authoritative success', async () => {
    const readError = async (): Promise<{ status?: number; code?: string }> => {
      try {
        await api.fetchMessageQueueSnapshot();
        throw new Error('expected request to fail');
      } catch (error) {
        const value = error as { status?: number; code?: string };
        return { status: value.status, code: value.code };
      }
    };
    responseImplementation = async () => new Response(JSON.stringify({ code: 'row_version_conflict', detail: 'secret' }), { status: 409 });
    expect(await readError()).toEqual({ status: 409, code: 'row_version_conflict' });
    responseImplementation = async () => new Response('', { status: 501 });
    expect(await readError()).toEqual({ status: 501, code: 'unavailable' });
    responseImplementation = async () => new Response(JSON.stringify({ revision: 1, scopes: [], worktreeOrders: 'invalid' }));
    expect(await readError()).toEqual({ status: 200, code: 'unavailable' });
  });

  test('accepts only canonical attachment DTOs and sends manual CAS', async () => {
    responseImplementation = async (call) => {
      if (call.method === 'POST') return new Response(JSON.stringify({ revision: 6, scopeID: 'scope/a', queueItemID: 'item/a', rowVersion: 3 }));
      return new Response(JSON.stringify({ ...scope, items: [{ ...item, attachments: [{ attachmentID: 'attachment/a', occurrenceRefID: ['root', 'attachment/a'], filename: 'a.txt', mimeType: 'text/plain', size: 1, source: 'local', locator: { kind: 'upload', uploadID: 'upload/a', storageKey: 'abc' } }] }] }));
    };
    const parsed = await api.fetchMessageQueueScope('scope/a');
    expect(parsed.items[0]?.attachments?.[0]?.locator).toEqual({ kind: 'upload', uploadID: 'upload/a' });
    await api.sendQueueItemNow('item/a', { requestID: 'manual-1', expectedRevision: 4, expectedRowVersion: 2 });
    expect(pathnameOf(fetchCalls.at(-1)!)).toBe('/api/openchamber/message-queue/items/item%2Fa/send');
    expect(fetchCalls.at(-1)?.method).toBe('POST');
    expect(fetchCalls.at(-1)?.body).toBe(JSON.stringify({ requestID: 'manual-1', expectedRevision: 4, expectedRowVersion: 2 }));
    responseImplementation = async () => new Response(JSON.stringify({ ...scope, items: [{ ...item, attachments: [{ uploadID: 'legacy' }] }] }));
    try { await api.fetchMessageQueueScope('scope/a'); throw new Error('expected canonical parser failure'); } catch (error) { expect((error as { code?: string }).code).toBe('unavailable'); }
  });

  test('uses reserved edit routes and normalizes downloaded attachment MIME parameters', async () => {
    const signal = new AbortController().signal;
    responseImplementation = async (call) => {
      const path = pathnameOf(call);
      if (path.includes('/reserved-remove')) return new Response(JSON.stringify({ revision: 6, scopeID: 'scope/a', removedQueueItemID: 'item/a' }));
      if (path.includes('/renew')) return new Response(JSON.stringify({ queueItemID: 'item/a', token: 'token', expiresAt: 20, generation: 1 }));
      if (path.includes('/reserve')) return new Response(JSON.stringify({ revision: 5, scopeID: 'scope/a', queueItemID: 'item/a', rowVersion: 2, token: 'token', expiresAt: 10, generation: 1 }));
      if (path.includes('/content')) return new Response(new Blob(['x'], { type: 'text/plain;charset=utf-8' }), { headers: { 'Content-Length': '1', 'Content-Type': 'text/plain; charset=utf-8' } });
      return new Response(JSON.stringify({ released: true }));
    };
    const reserved = await api.reserveMessageQueueItemForEdit('item/a', { requestID: 'reserve', expectedRevision: 4, rowVersion: 2, owner: 'ui-edit', ttlMs: 1_000, signal });
    const blob = await api.downloadMessageQueueAttachment('item/a', { attachmentID: 'attachment/a', size: 1, mimeType: 'text/plain' }, signal);
    await api.renewEditReservation('item/a', { token: reserved.token, generation: 1, ttlMs: 1_000, signal });
    await api.releaseMessageQueueItemEditReservation('item/a', { token: reserved.token, signal });
    await api.removeReservedMessageQueueItem('item/a', { requestID: 'remove', expectedRevision: 4, expectedRowVersion: 2, token: reserved.token, generation: 1, signal });
    expect(blob.size).toBe(1); expect(blob.type).toBe('text/plain'); expect(fetchCalls[1]?.signal).toBe(signal); expect(fetchCalls.map(pathnameOf)).toEqual([
      '/api/openchamber/message-queue/items/item%2Fa/reserve', '/api/openchamber/message-queue/items/item%2Fa/attachments/attachment%2Fa/content', '/api/openchamber/message-queue/items/item%2Fa/edit-reservations/token/renew', '/api/openchamber/message-queue/items/item%2Fa/release', '/api/openchamber/message-queue/items/item%2Fa/reserved-remove',
    ]);
  });

  test('admits and parses strict Assistant delivery DTOs with @session and /skill semantic text', async () => {
    const syntheticParts = [{ partID: 'context-1', text: 'conflict context', synthetic: true, attachmentIDs: [], deliveryPartIndexes: [3] }];
    const deliveryParts = buildAssistantQueueDeliveryParts({
      text: '@Prior work /review',
      attachments: [],
      semanticParts: [{ text: '[session:ses_1]', synthetic: true }, { text: '[skill:review]', synthetic: true }],
      syntheticParts: [{ text: 'conflict context' }],
    });
    responseImplementation = async (call) => pathnameOf(call).endsWith('/items')
      ? new Response(JSON.stringify({ revision: 5, scopeID: 'scope/a', queueItemID: 'item/a', rowVersion: 2 }))
      : new Response(JSON.stringify({ ...scope, items: [{ ...item, deliveryTarget: { kind: 'assistant', assistantID: 'assistant/a' }, deliveryParts, syntheticParts }] }));
    await api.admitTextQueueItem({
      requestID: 'assistant-request',
      scope: { directory: '/repo', sessionID: 'session/a' },
      item: {
        queueItemID: 'item/a',
        operationID: 'operation/a',
        messageID: 'message/a',
        content: 'queue display text',
        deliveryTarget: { kind: 'assistant', assistantID: 'assistant/a' },
        deliveryParts,
        syntheticParts,
        attachments: [],
        attachmentIssues: [],
        createdAt: 1,
      },
    });
    expect(JSON.parse(String(fetchCalls[0]?.body))).toEqual({
      requestID: 'assistant-request',
      scope: { directory: '/repo', sessionID: 'session/a' },
      item: {
        queueItemID: 'item/a',
        operationID: 'operation/a',
        messageID: 'message/a',
        content: 'queue display text',
        deliveryTarget: { kind: 'assistant', assistantID: 'assistant/a' },
        deliveryParts,
        syntheticParts,
        attachments: [],
        attachmentIssues: [],
        createdAt: 1,
      },
    });
    const parsed = await api.fetchMessageQueueScope('scope/a');
    expect(parsed.items[0]?.deliveryParts).toEqual(deliveryParts);
    expect(parsed.items[0]?.syntheticParts).toEqual(syntheticParts);
  });

  test('requires and preserves compiled delivery parts on Assistant queue rows', async () => {
    const assistantItem = { ...item, deliveryTarget: { kind: 'assistant', assistantID: 'assistant/a' } };
    responseImplementation = async () => new Response(JSON.stringify({ ...scope, items: [assistantItem] }));
    try {
      await api.fetchMessageQueueScope('scope/a', { limit: 8 });
      throw new Error('expected missing Assistant delivery parts to fail');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('unavailable');
    }

    responseImplementation = async () => new Response(JSON.stringify({
      ...scope,
      items: [{ ...assistantItem, deliveryParts: [{ type: 'text', text: 'compiled text' }, { type: 'file', mime: 'text/plain', url: 'file:///repo/a.ts' }] }],
    }));
    const parsed = await api.fetchMessageQueueScope('scope/a', { limit: 8 });
    expect(parsed.items[0]?.deliveryParts).toEqual([{ type: 'text', text: 'compiled text' }, { type: 'file', mime: 'text/plain', url: 'file:///repo/a.ts' }]);
  });

  test('requires the compact renew acknowledgement fields', async () => {
    responseImplementation = async () => new Response(JSON.stringify({ queueItemID: 'item/a', token: 'token', generation: 1 }));
    try { await api.renewEditReservation('item/a', { token: 'token', generation: 1, ttlMs: 1_000 }); throw new Error('expected malformed renewal to fail'); } catch (error) { expect((error as { code?: string }).code).toBe('unavailable'); }
  });

  test('sends relay-safe attachment upload size header', async () => {
    responseImplementation = async () => new Response(JSON.stringify({ uploadID: 'upload/a', uploadToken: 'token', expiresAt: 10 }), { status: 200 });
    const upload = await api.createMessageQueueAttachmentUpload();
    responseImplementation = async (call) => {
      expect(call.headers?.get('Content-Length')).toBe('4');
      expect(call.headers?.get('X-Message-Queue-Content-Length')).toBe('4');
      expect(call.headers?.get('X-Message-Queue-Upload-Token')).toBe('token');
      expect(call.headers?.get('X-Message-Queue-Sha256')).toBe('deadbeef');
      return new Response(JSON.stringify({ uploadID: 'upload/a', state: 'ready', objectHash: 'deadbeef', storageKey: 'deadbeef', sizeBytes: 4 }), { status: 200 });
    };
    await api.uploadMessageQueueAttachment(upload, new Blob(['abcd']), 'deadbeef');
  });

  test('downloads attachments when relay omits Content-Length', async () => {
    responseImplementation = async () => new Response(new Blob(['x'], { type: 'text/plain' }), { headers: { 'Content-Type': 'text/plain' } });
    const blob = await api.downloadMessageQueueAttachment('item/a', { attachmentID: 'attachment/a', size: 1, mimeType: 'text/plain' });
    expect(blob.size).toBe(1);
    expect(blob.type).toBe('text/plain');
  });

  test('rejects downloaded attachments with a different MIME base type or size', async () => {
    const attachment = { attachmentID: 'attachment/a', size: 1, mimeType: 'text/plain' };
    const downloadError = async (): Promise<{ status?: number; code?: string }> => {
      try { await api.downloadMessageQueueAttachment('item/a', attachment); } catch (error) { return error as { status?: number; code?: string }; }
      throw new Error('expected download to fail');
    };
    responseImplementation = async () => new Response(new Blob(['x'], { type: 'application/json' }), { headers: { 'Content-Length': '1', 'Content-Type': 'application/json; charset=utf-8' } });
    const mimeError = await downloadError();
    expect(mimeError.status).toBe(200); expect(mimeError.code).toBe('unavailable');
    responseImplementation = async () => new Response(new Blob(['xx'], { type: 'text/plain' }), { headers: { 'Content-Length': '2', 'Content-Type': 'text/plain' } });
    const sizeError = await downloadError();
    expect(sizeError.status).toBe(200); expect(sizeError.code).toBe('unavailable');
  });

  test('parseItem accepts a true manualDispatchRequested, omits it when absent, and rejects wrong types as malformed', async () => {
    responseImplementation = async () => new Response(JSON.stringify({ ...scope, items: [{ ...item, manualDispatchRequested: true }] }));
    const parsed = await api.fetchMessageQueueScope('scope/a');
    expect(parsed.items[0]?.manualDispatchRequested).toBe(true);
    responseImplementation = async () => new Response(JSON.stringify({ ...scope, items: [item] }));
    const omitted = await api.fetchMessageQueueScope('scope/a');
    expect(omitted.items[0]?.manualDispatchRequested).toBe(undefined);
    responseImplementation = async () => new Response(JSON.stringify({ ...scope, items: [{ ...item, manualDispatchRequested: 'yes' }] }));
    try { await api.fetchMessageQueueScope('scope/a'); throw new Error('expected malformed item to fail'); } catch (error) { expect((error as { code?: string }).code).toBe('unavailable'); }
    responseImplementation = async () => new Response(JSON.stringify({ ...scope, items: [{ ...item, manualDispatchRequested: 1 }] }));
    try { await api.fetchMessageQueueScope('scope/a'); throw new Error('expected number manualDispatchRequested to fail'); } catch (error) { expect((error as { code?: string }).code).toBe('unavailable'); }
  });
});
