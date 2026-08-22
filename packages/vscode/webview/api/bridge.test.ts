import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import assert from 'node:assert/strict';

describe('VS Code webview bridge requests', () => {
  let originalWindow: typeof globalThis.window;
  let originalAcquire: unknown;
  let messages: unknown[];
  let target: EventTarget;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalAcquire = (globalThis as typeof globalThis & { acquireVsCodeApi?: unknown }).acquireVsCodeApi;
    messages = [];
    target = new EventTarget();

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: target,
    });
    Object.defineProperty(globalThis, 'acquireVsCodeApi', {
      configurable: true,
      value: () => ({
        postMessage: (message: unknown) => messages.push(message),
        getState: () => undefined,
        setState: () => undefined,
      }),
    });
    vi.resetModules();
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    Object.defineProperty(globalThis, 'acquireVsCodeApi', { configurable: true, value: originalAcquire });
  });

  test('rejects immediately when signal is already aborted', async () => {
    const { sendBridgeMessageWithOptions } = await import('./bridge');
    const controller = new AbortController();
    controller.abort();

    const result = await Promise.race([
      sendBridgeMessageWithOptions('api:proxy', undefined, { signal: controller.signal }).then(
        () => 'resolved',
        (error: unknown) => error,
      ),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 20)),
    ]);

    assert.ok(result instanceof DOMException);
    assert.equal((result as DOMException).name, 'AbortError');
    assert.equal(messages.length, 0);
  });

  test('failure Error carries structured BridgeResponse data code/status', async () => {
    const { sendBridgeMessageWithOptions, BridgeError } = await import('./bridge');
    const pending = sendBridgeMessageWithOptions('api:session-turn-changes', {
      sessionID: 'ses_1',
      messageID: 'msg_1',
    }, { timeoutMs: 5_000 });

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(messages.length, 1);
    const request = messages[0] as { id: string; type: string };
    assert.equal(request.type, 'api:session-turn-changes');
    assert.equal(typeof request.id, 'string');

    target.dispatchEvent(new MessageEvent('message', {
      data: {
        id: request.id,
        type: 'api:session-turn-changes',
        success: false,
        error: 'change file not found',
        data: { code: 'change_not_found', status: 404 },
      },
    }));

    const result = await pending.then(
      () => 'resolved',
      (error: unknown) => error,
    );

    assert.ok(result instanceof BridgeError);
    assert.equal((result as InstanceType<typeof BridgeError>).message, 'change file not found');
    assert.deepEqual((result as InstanceType<typeof BridgeError>).data, {
      code: 'change_not_found',
      status: 404,
    });
  });

  test('failure without structured data remains a plain Error', async () => {
    const { sendBridgeMessageWithOptions, BridgeError } = await import('./bridge');
    const pending = sendBridgeMessageWithOptions('api:other', {}, { timeoutMs: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const request = messages[0] as { id: string };

    target.dispatchEvent(new MessageEvent('message', {
      data: {
        id: request.id,
        type: 'api:other',
        success: false,
        error: 'plain failure',
      },
    }));

    const result = await pending.then(
      () => 'resolved',
      (error: unknown) => error,
    );

    assert.ok(result instanceof Error);
    assert.equal((result as Error).message, 'plain failure');
    assert.equal(result instanceof BridgeError, false);
  });
});
