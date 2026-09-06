import { describe, expect, test } from 'vitest';

import { createLynxShareInbox } from './shareInbox';

describe('createLynxShareInbox', () => {
  test('accepts host share envelope and dispatches Cap assistants share', async () => {
    const inbox = createLynxShareInbox();
    const envelope = inbox.acceptOpenChamberShareIntent({
      operationID: 'op-1',
      serverInstanceID: 'srv',
      assistantID: 'asst-1',
      text: 'hello from share',
    });
    expect(inbox.listPending()).toHaveLength(1);
    const calls: Array<{ path: string; body?: string }> = [];
    const runtimeFetch = async (path: string, init?: { body?: string }) => {
      calls.push({ path, body: init?.body });
      return { ok: true, status: 200, json: async () => ({ operationID: 'op-1', state: 'completed' }) };
    };
    const result = await inbox.dispatchToAssistant(runtimeFetch, envelope);
    expect(result).toEqual({ status: 'ok', operationID: 'op-1' });
    expect(calls[0]?.path).toBe('/api/openchamber/assistants/asst-1/share');
    const body = JSON.parse(calls[0]!.body!);
    expect(body.operationID).toBe('op-1');
    expect(body.payload.parts).toEqual([{ type: 'text', text: 'hello from share' }]);
    expect(inbox.listPending()).toHaveLength(0);
  });

  test('empty / expired / no-runtime are not fake-success', async () => {
    const inbox = createLynxShareInbox();
    const empty = inbox.acceptOpenChamberShareIntent({
      operationID: 'op-empty',
      serverInstanceID: 'srv',
      assistantID: 'asst',
    });
    expect(await inbox.dispatchToAssistant(async () => ({ ok: true, status: 200, json: async () => ({}) }), empty)).toEqual({
      status: 'empty',
    });
    const expired = inbox.acceptOpenChamberShareIntent({
      operationID: 'op-exp',
      serverInstanceID: 'srv',
      assistantID: 'asst',
      text: 'x',
      expiresAt: Date.now() - 1000,
    });
    expect(await inbox.dispatchToAssistant(async () => ({ ok: true, status: 200, json: async () => ({}) }), expired)).toEqual({
      status: 'expired',
    });
    expect(await inbox.dispatchToAssistant(null, expired)).toEqual({ status: 'no-runtime' });
  });
});
