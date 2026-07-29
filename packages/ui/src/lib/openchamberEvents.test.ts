import { describe, expect, test } from 'bun:test';
import {
  getLatestOpenchamberEventRevision,
  parseOpenchamberEventEnvelope,
  subscribeOpenchamberEvents,
} from './openchamberEvents';

describe('parseOpenchamberEventEnvelope', () => {
  test('parses ready and valid topology envelopes', () => {
    expect(parseOpenchamberEventEnvelope({ type: 'openchamber:event-stream-ready', properties: {} })).toEqual({ type: 'event-stream-ready' });
    expect(parseOpenchamberEventEnvelope({ type: 'openchamber:worktree-topology-changed', properties: { projectDirectory: '/repo', directory: '/repo/feature', operation: 'added', occurredAt: 1 } })).toEqual({ type: 'worktree-topology-changed', projectDirectory: '/repo', directory: '/repo/feature', operation: 'added', occurredAt: 1 });
  });

  test('rejects malformed topology payloads', () => {
    expect(parseOpenchamberEventEnvelope({ type: 'openchamber:worktree-topology-changed', properties: { projectDirectory: '/repo', operation: 'added', occurredAt: 1 } })).toBeNull();
    expect(parseOpenchamberEventEnvelope({ type: 'openchamber:worktree-topology-changed', properties: { projectDirectory: '/repo', directory: '/repo/feature', operation: 'moved', occurredAt: '1' } })).toBeNull();
  });

  test('parses worktree bootstrap status envelopes', () => {
    expect(parseOpenchamberEventEnvelope({
      type: 'openchamber:worktree-bootstrap-status',
      properties: { directory: '/repo/feature', status: 'ready', error: null, updatedAt: 12 },
    })).toEqual({
      type: 'worktree-bootstrap-status',
      directory: '/repo/feature',
      status: 'ready',
      error: null,
      updatedAt: 12,
    });
    expect(parseOpenchamberEventEnvelope({
      type: 'openchamber:worktree-bootstrap-status',
      properties: { directory: '/repo/feature', status: 'failed', error: 'boom', updatedAt: 13 },
    })).toEqual({
      type: 'worktree-bootstrap-status',
      directory: '/repo/feature',
      status: 'failed',
      error: 'boom',
      updatedAt: 13,
    });
    expect(parseOpenchamberEventEnvelope({
      type: 'openchamber:worktree-bootstrap-status',
      properties: { directory: '/repo/feature', status: 'running', updatedAt: 1 },
    })).toBeNull();
  });

  test('parses session-index, message-queue, and Assistant tip envelopes', () => {
    expect(parseOpenchamberEventEnvelope({
      type: 'openchamber:session-index-changed',
      properties: { revision: 3, occurredAt: 10, sync: { active: true, enriching: false } },
    })).toEqual({
      type: 'session-index-changed',
      revision: 3,
      occurredAt: 10,
      sync: { active: true, enriching: false },
    });
    expect(parseOpenchamberEventEnvelope({
      type: 'openchamber:message-queue-changed',
      properties: { revision: 7, occurredAt: 20 },
    })).toEqual({ type: 'message-queue-changed', revision: 7, occurredAt: 20 });
    expect(parseOpenchamberEventEnvelope({
      type: 'openchamber:assistants-changed',
      properties: { revision: 8, occurredAt: 21 },
    })).toEqual({ type: 'assistants-changed', revision: 8, occurredAt: 21 });
  });

  test('rejects malformed session-index and message-queue tip payloads', () => {
    expect(parseOpenchamberEventEnvelope({ type: 'openchamber:session-index-changed', properties: { revision: -1, occurredAt: 1 } })).toBeNull();
    expect(parseOpenchamberEventEnvelope({ type: 'openchamber:session-index-changed', properties: { revision: 1 } })).toBeNull();
    expect(parseOpenchamberEventEnvelope({ type: 'openchamber:message-queue-changed', properties: { revision: '1', occurredAt: 1 } })).toBeNull();
    expect(parseOpenchamberEventEnvelope({ type: 'openchamber:message-queue-changed', properties: { revision: 1, occurredAt: Number.NaN } })).toBeNull();
    expect(parseOpenchamberEventEnvelope({ type: 'openchamber:session-index-changed', properties: { revision: 1.5, occurredAt: 1 } })).toBeNull();
    expect(parseOpenchamberEventEnvelope({ type: 'openchamber:message-queue-changed', properties: { revision: Number.MAX_SAFE_INTEGER + 1, occurredAt: 1 } })).toBeNull();
    expect(parseOpenchamberEventEnvelope({ type: 'openchamber:assistants-changed', properties: { revision: 2, occurredAt: 'later' } })).toBeNull();
  });
});

test('shares one runtime SSE request, isolates listeners, aborts the final subscription, and ignores stale runtime attempts', async () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const runtimeWindow = new EventTarget();
  let firstController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let secondController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const signals: AbortSignal[] = [];
  let requests = 0;
  const encoder = new TextEncoder();

  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: runtimeWindow });
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal as AbortSignal);
      requests += 1;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (requests === 1) firstController = controller;
          else secondController = controller;
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;

    const received: unknown[] = [];
    const removeThrowing = subscribeOpenchamberEvents(() => { throw new Error('listener failure'); });
    const removeReceiving = subscribeOpenchamberEvents((event) => received.push(event));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests).toBe(1);

    expect(signals[0]?.aborted).toBe(false);
    // Seed a tip on the first connection, then prove runtime switch clears it.
    firstController?.enqueue(encoder.encode('data: {"type":"openchamber:message-queue-changed","properties":{"revision":4,"occurredAt":1}}\n\n'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getLatestOpenchamberEventRevision('message-queue-changed')).toBe(4);

    runtimeWindow.dispatchEvent(new Event('openchamber:runtime-endpoint-changed'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(signals[0]?.aborted).toBe(true);
    expect(requests).toBe(2);
    expect(getLatestOpenchamberEventRevision('message-queue-changed')).toBe(undefined);
    expect(getLatestOpenchamberEventRevision('session-index-changed')).toBe(undefined);

    firstController?.error(new Error('late stale failure'));
    secondController?.enqueue(encoder.encode('data: {"type":"openchamber:message-queue-changed","properties":{"revision":9,"occurredAt":2}}\n\n'));
    secondController?.enqueue(encoder.encode('data: {"type":"openchamber:session-index-changed","properties":{"revision":3,"occurredAt":3}}\n\n'));
    secondController?.enqueue(encoder.encode('data: {"type":"openchamber:assistants-changed","properties":{"revision":2,"occurredAt":4}}\n\n'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received).toEqual([
      { type: 'message-queue-changed', revision: 4, occurredAt: 1 },
      { type: 'message-queue-changed', revision: 9, occurredAt: 2 },
      { type: 'session-index-changed', revision: 3, occurredAt: 3 },
      { type: 'assistants-changed', revision: 2, occurredAt: 4 },
    ]);
    expect(getLatestOpenchamberEventRevision('message-queue-changed')).toBe(9);
    expect(getLatestOpenchamberEventRevision('session-index-changed')).toBe(3);
    expect(getLatestOpenchamberEventRevision('assistants-changed')).toBe(2);

    removeThrowing();
    removeReceiving();
    expect(signals[1]?.aborted).toBe(true);
    expect(getLatestOpenchamberEventRevision('message-queue-changed')).toBe(undefined);
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    globalThis.fetch = originalFetch;
  }
});
