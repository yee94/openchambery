import { describe, expect, test } from 'vitest';

import type { LynxRuntimeFetch } from '../runtime/fetch';
import {
  admitLynxTextQueueItem,
  fetchLynxMessageQueueScope,
  fetchLynxMessageQueueScopeForSession,
  flushLynxQueueScopeFirst,
  isLynxMessageQueueUnavailable,
  LYNX_MESSAGE_QUEUE_ROUTE,
  removeLynxQueueItem,
  reorderLynxQueueScope,
  sendLynxQueueItemNow,
} from './messageQueueServer';

const item = {
  queueItemID: 'item/a',
  operationID: 'operation/a',
  messageID: 'message/a',
  content: 'hello',
  status: 'queued',
  attemptCount: 0,
  position: 0,
  rowVersion: 2,
  createdAt: 1,
};

const scope = {
  scopeID: 'scope/a',
  revision: 4,
  directory: '/repo',
  sessionID: 'session/a',
  worktreeState: 'active',
  itemCount: 1,
  items: [item],
};

const snapshot = {
  revision: 4,
  scopes: [{
    scopeID: 'scope/a',
    revision: 4,
    directory: '/repo',
    sessionID: 'session/a',
    worktreeState: 'active',
    itemCount: 1,
  }],
  worktreeOrders: [],
};

type Call = { method: string; path: string; body?: string };

const mockFetch = (
  impl: (call: Call) => { ok: boolean; status: number; json: () => Promise<unknown> },
): { runtimeFetch: LynxRuntimeFetch; calls: Call[] } => {
  const calls: Call[] = [];
  const runtimeFetch: LynxRuntimeFetch = async (path, init) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      path,
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    return impl(call);
  };
  return { runtimeFetch, calls };
};

describe('Lynx messageQueueServer Cap client', () => {
  test('happy path: list scope for session + admit + reorder + remove + send-now + flush', async () => {
    const { runtimeFetch, calls } = mockFetch((call) => {
      if (call.method === 'GET' && call.path === LYNX_MESSAGE_QUEUE_ROUTE) {
        return { ok: true, status: 200, json: async () => snapshot };
      }
      if (call.method === 'GET' && call.path.includes('/scopes/')) {
        return { ok: true, status: 200, json: async () => scope };
      }
      if (call.method === 'POST' && call.path.endsWith('/items')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            revision: 5,
            scopeID: 'scope/a',
            queueItemID: 'item/a',
            rowVersion: 2,
          }),
        };
      }
      if (call.method === 'PUT' && call.path.includes('/order')) {
        return { ok: true, status: 200, json: async () => ({ revision: 6, scopeID: 'scope/a' }) };
      }
      if (call.method === 'DELETE' && call.path.includes('/items/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ revision: 7, removedQueueItemID: 'item/a' }),
        };
      }
      if (call.method === 'POST' && call.path.includes('/send')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ revision: 8, queueItemID: 'item/a', rowVersion: 3 }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    const listed = await fetchLynxMessageQueueScopeForSession(runtimeFetch, {
      directory: '/repo',
      sessionID: 'session/a',
    });
    expect(listed).toMatchObject({ status: 'ok', value: { scopeID: 'scope/a', revision: 4 } });
    expect(listed.status === 'ok' && listed.value?.items[0]?.content).toBe('hello');

    const admitted = await admitLynxTextQueueItem(runtimeFetch, {
      requestID: 'r1',
      expectedRevision: 4,
      scope: { directory: '/repo', sessionID: 'session/a' },
      item: {
        queueItemID: 'item/a',
        operationID: 'operation/a',
        messageID: 'message/a',
        content: 'hello',
        attachments: [],
        attachmentIssues: [],
        createdAt: 1,
      },
    });
    expect(admitted).toMatchObject({
      status: 'ok',
      value: { revision: 5, scopeID: 'scope/a', queueItemID: 'item/a' },
    });

    const reordered = await reorderLynxQueueScope(runtimeFetch, 'scope/a', {
      requestID: 'r2',
      expectedRevision: 5,
      queueItemIDs: ['item/a'],
    });
    expect(reordered).toMatchObject({ status: 'ok', value: { revision: 6 } });

    const removed = await removeLynxQueueItem(runtimeFetch, 'item/a', {
      requestID: 'r3',
      expectedRevision: 6,
      expectedRowVersion: 2,
    });
    expect(removed).toMatchObject({
      status: 'ok',
      value: { revision: 7, removedQueueItemID: 'item/a' },
    });

    const sent = await sendLynxQueueItemNow(runtimeFetch, 'item/a', {
      requestID: 'r4',
      expectedRevision: 7,
      expectedRowVersion: 2,
    });
    expect(sent).toMatchObject({ status: 'ok', value: { revision: 8, queueItemID: 'item/a' } });

    const flushed = await flushLynxQueueScopeFirst(runtimeFetch, scope, { requestID: 'r5' });
    expect(flushed).toMatchObject({ status: 'ok', value: { revision: 8 } });

    expect(calls.some((c) => c.path.includes('/scopes/scope%2Fa') || c.path.includes('/scopes/scope/a'))).toBe(true);
    expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/items'))).toBe(true);
    expect(calls.some((c) => c.method === 'PUT' && c.path.includes('/order'))).toBe(true);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
    expect(calls.filter((c) => c.path.includes('/send')).length).toBeGreaterThanOrEqual(2);
  });

  test('failure paths: no-runtime, HTTP error code, malformed success, empty session', async () => {
    expect(await fetchLynxMessageQueueScope(null, 'scope/a')).toMatchObject({
      status: 'failed',
      reason: 'unavailable',
      code: 'unavailable',
    });

    const { runtimeFetch: httpFetch } = mockFetch(() => ({
      ok: false,
      status: 409,
      json: async () => ({ code: 'revision_conflict' }),
    }));
    const conflict = await reorderLynxQueueScope(httpFetch, 'scope/a', {
      requestID: 'r',
      expectedRevision: 1,
      queueItemIDs: ['a'],
    });
    expect(conflict).toMatchObject({
      status: 'failed',
      reason: 'http',
      code: 'revision_conflict',
      httpStatus: 409,
    });
    expect(isLynxMessageQueueUnavailable(conflict as Extract<typeof conflict, { status: 'failed' }>)).toBe(false);

    const { runtimeFetch: badFetch } = mockFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({ revision: 1, unexpected: true }),
    }));
    const malformed = await admitLynxTextQueueItem(badFetch, {
      requestID: 'r',
      scope: { directory: '/repo', sessionID: 'ses' },
      item: {
        queueItemID: 'q',
        operationID: 'o',
        messageID: 'm',
        content: 'x',
        attachments: [],
        attachmentIssues: [],
        createdAt: 1,
      },
    });
    expect(malformed).toMatchObject({ status: 'failed', reason: 'unavailable', code: 'unavailable' });

    const { runtimeFetch: status501 } = mockFetch(() => ({
      ok: false,
      status: 501,
      json: async () => ({ code: 'unavailable' }),
    }));
    const unavailable = await fetchLynxMessageQueueScope(status501, 'scope/a');
    expect(unavailable).toMatchObject({ status: 'failed', reason: 'unavailable' });
    expect(isLynxMessageQueueUnavailable(unavailable as Extract<typeof unavailable, { status: 'failed' }>)).toBe(true);

    expect(await fetchLynxMessageQueueScopeForSession(status501, {
      directory: '/repo',
      sessionID: '  ',
    })).toMatchObject({ status: 'failed', reason: 'invalid' });

    const { runtimeFetch: malformedScope } = mockFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({ ...scope, items: [{ ...item, queueItemID: 1 }] }),
    }));
    expect(await fetchLynxMessageQueueScope(malformedScope, 'scope/a')).toMatchObject({
      status: 'failed',
      reason: 'unavailable',
    });
  });

  test('encodes scope id and posts Cap mutation bodies', async () => {
    const { runtimeFetch, calls } = mockFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({ revision: 1, scopeID: 'scope/a?' }),
    }));
    await fetchLynxMessageQueueScope(runtimeFetch, 'scope/a?', {
      offset: 2,
      limit: 8,
      expectedRevision: 4,
    });
    await reorderLynxQueueScope(runtimeFetch, 'scope/a?', {
      requestID: 'r4',
      expectedRevision: 5,
      queueItemIDs: ['item/a', 'item/b'],
    });
    expect(calls[0]?.path).toContain('/scopes/scope%2Fa%3F');
    expect(calls[0]?.path).toContain('offset=2');
    expect(calls[0]?.path).toContain('expectedRevision=4');
    expect(JSON.parse(calls[1]?.body ?? '{}')).toEqual({
      requestID: 'r4',
      expectedRevision: 5,
      queueItemIDs: ['item/a', 'item/b'],
    });
  });
});
