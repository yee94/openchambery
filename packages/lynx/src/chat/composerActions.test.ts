import { describe, expect, test } from 'vitest';

import { createLynxComposerActions } from './composerActions';
import { LYNX_MESSAGE_QUEUE_ROUTE } from './messageQueueServer';

describe('Lynx composer send/stop/queue', () => {
  test('without runtime never fake-succeeds', async () => {
    const actions = createLynxComposerActions({
      sessionId: 'ses_1',
      model: { providerID: 'anthropic', modelID: 'claude' },
      sessionApi: null,
    });
    expect(await actions.send('hi')).toMatchObject({ status: 'failed', reason: 'no-runtime' });
    expect(await actions.stop()).toMatchObject({ status: 'failed', reason: 'no-runtime' });
    expect(await actions.queue('hi')).toMatchObject({ status: 'failed', reason: 'no-runtime' });
  });

  test('send and stop call official APIs; unavailable MQ falls back to local queue', async () => {
    const calls: string[] = [];
    const runtimeFetch = async (path: string, init?: { method?: string; body?: string }) => {
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path.includes('prompt_async')) {
        return { ok: true, status: 204, json: async () => true };
      }
      if (path.includes('/abort')) {
        return { ok: true, status: 200, json: async () => true };
      }
      // Cap MQ unavailable → local queue path
      if (path.includes(LYNX_MESSAGE_QUEUE_ROUTE)) {
        return { ok: false, status: 501, json: async () => ({ code: 'unavailable' }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    let working = false;
    const actions = createLynxComposerActions({
      sessionId: 'ses_1',
      directory: '/repo',
      model: { providerID: 'anthropic', modelID: 'claude' },
      sessionApi: { runtimeFetch },
      sessionIsWorking: () => working,
      createId: () => 'q1',
    });

    expect(await actions.send('hello')).toMatchObject({ status: 'ok' });
    expect(calls.some((c) => c.includes('prompt_async'))).toBe(true);

    working = true;
    expect(await actions.send('follow')).toMatchObject({
      status: 'failed',
      reason: 'busy-steer-required',
    });
    expect(await actions.queue('later')).toMatchObject({ status: 'ok', queuedId: 'q1' });
    expect(actions.getQueue()).toHaveLength(1);
    expect(actions.getQueueMode()).toBe('local');

    expect(await actions.flushQueue()).toMatchObject({
      status: 'failed',
      reason: 'busy-steer-required',
    });
    working = false;
    expect(await actions.flushQueue()).toMatchObject({ status: 'ok' });
    expect(actions.getQueue()).toHaveLength(0);

    expect(await actions.stop()).toMatchObject({ status: 'ok', aborted: true });
    expect(calls.some((c) => c.includes('/abort'))).toBe(true);
  });
});

describe('Lynx queue chip remove / sendNow / reorder', () => {
  const makeLocal = () => {
    const calls: string[] = [];
    const runtimeFetch = async (path: string, init?: { method?: string }) => {
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path.includes('prompt_async')) {
        return { ok: true, status: 204, json: async () => true };
      }
      if (path.includes(LYNX_MESSAGE_QUEUE_ROUTE)) {
        return { ok: false, status: 501, json: async () => ({ code: 'unavailable' }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    let working = false;
    let n = 0;
    const actions = createLynxComposerActions({
      sessionId: 'ses_1',
      model: { providerID: 'anthropic', modelID: 'claude' },
      sessionApi: { runtimeFetch },
      sessionIsWorking: () => working,
      createId: () => `q${++n}`,
    });
    return { actions, calls, setWorking: (v: boolean) => { working = v; } };
  };

  test('remove / reorder / sendNow on local queue after MQ unavailable', async () => {
    const { actions, setWorking } = makeLocal();
    expect(await actions.queue('one')).toMatchObject({ status: 'ok', queuedId: 'q1' });
    expect(await actions.queue('two')).toMatchObject({ status: 'ok', queuedId: 'q2' });
    expect(await actions.queue('three')).toMatchObject({ status: 'ok', queuedId: 'q3' });
    expect(await actions.reorderQueue('q3', 'q1')).toMatchObject({ status: 'ok' });
    expect(actions.getQueue().map((q) => q.id)).toEqual(['q3', 'q1', 'q2']);
    expect(await actions.removeFromQueue('q1')).toMatchObject({ status: 'ok' });
    expect(actions.getQueue().map((q) => q.id)).toEqual(['q3', 'q2']);

    setWorking(true);
    expect(await actions.sendNow('q3')).toMatchObject({ status: 'failed', reason: 'busy-steer-required' });
    setWorking(false);
    expect(await actions.sendNow('q3')).toMatchObject({ status: 'ok' });
    expect(actions.getQueue().map((q) => q.id)).toEqual(['q2']);
  });

  test('chip ops without runtime fail honestly', async () => {
    const actions = createLynxComposerActions({
      sessionId: 'ses_1',
      model: { providerID: 'a', modelID: 'b' },
      sessionApi: null,
    });
    expect(await actions.removeFromQueue('x')).toMatchObject({ status: 'failed', reason: 'no-runtime' });
    expect(await actions.reorderQueue('a', 'b')).toMatchObject({ status: 'failed', reason: 'no-runtime' });
  });
});

describe('Lynx composer Cap server message-queue', () => {
  test('prefer server admit/list/reorder/remove/send-now; never fake on HTTP failure', async () => {
    const item = {
      queueItemID: 'queued-q1',
      operationID: 'operation-q1',
      messageID: 'msg_q1',
      content: 'hello',
      status: 'queued',
      attemptCount: 0,
      position: 0,
      rowVersion: 1,
      createdAt: 10,
    };
    let revision = 1;
    let items = [] as typeof item[];
    const calls: string[] = [];

    const runtimeFetch = async (path: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${path}`);
      if (method === 'GET' && path === LYNX_MESSAGE_QUEUE_ROUTE) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            revision,
            scopes: items.length
              ? [{
                scopeID: 'scope/a',
                revision,
                directory: '/repo',
                sessionID: 'ses_1',
                worktreeState: 'active',
                itemCount: items.length,
              }]
              : [],
            worktreeOrders: [],
          }),
        };
      }
      if (method === 'GET' && path.includes('/scopes/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            scopeID: 'scope/a',
            revision,
            directory: '/repo',
            sessionID: 'ses_1',
            worktreeState: 'active',
            itemCount: items.length,
            items,
          }),
        };
      }
      if (method === 'POST' && path.endsWith('/items')) {
        revision += 1;
        items = [{ ...item, rowVersion: 1, content: JSON.parse(init?.body ?? '{}').item.content }];
        return {
          ok: true,
          status: 200,
          json: async () => ({
            revision,
            scopeID: 'scope/a',
            queueItemID: item.queueItemID,
            rowVersion: 1,
          }),
        };
      }
      if (method === 'PUT' && path.includes('/order')) {
        const ids = JSON.parse(init?.body ?? '{}').queueItemIDs as string[];
        revision += 1;
        items = ids.map((id, index) => ({
          ...items.find((entry) => entry.queueItemID === id)!,
          position: index,
        }));
        return { ok: true, status: 200, json: async () => ({ revision, scopeID: 'scope/a' }) };
      }
      if (method === 'DELETE' && path.includes('/items/')) {
        revision += 1;
        items = [];
        return {
          ok: true,
          status: 200,
          json: async () => ({ revision, removedQueueItemID: item.queueItemID }),
        };
      }
      if (method === 'POST' && path.includes('/send')) {
        return { ok: false, status: 409, json: async () => ({ code: 'revision_conflict' }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    const actions = createLynxComposerActions({
      sessionId: 'ses_1',
      directory: '/repo',
      model: { providerID: 'anthropic', modelID: 'claude' },
      sessionApi: { runtimeFetch },
      createId: () => 'q1',
      now: () => 10,
    });

    expect(await actions.queue('hello')).toMatchObject({ status: 'ok', queuedId: 'queued-q1' });
    expect(actions.getQueueMode()).toBe('server');
    expect(actions.getQueue().map((q) => q.id)).toEqual(['queued-q1']);
    expect(calls.some((c) => c.includes(`${LYNX_MESSAGE_QUEUE_ROUTE}/items`))).toBe(true);

    // Second item for reorder
    items = [
      { ...item, queueItemID: 'queued-q1', position: 0 },
      { ...item, queueItemID: 'queued-q2', content: 'two', position: 1, operationID: 'operation-q2', messageID: 'msg_q2' },
    ];
    revision += 1;
    expect(await actions.refreshQueue()).toMatchObject({ status: 'ok' });
    expect(await actions.reorderQueue('queued-q2', 'queued-q1')).toMatchObject({ status: 'ok' });
    expect(calls.some((c) => c.startsWith('PUT ') && c.includes('/order'))).toBe(true);

    expect(await actions.sendNow('queued-q1')).toMatchObject({
      status: 'failed',
      reason: 'http',
    });
    expect(calls.some((c) => c.includes('/send'))).toBe(true);

    expect(await actions.removeFromQueue('queued-q1')).toMatchObject({ status: 'ok' });
  });
});
