import { afterEach, describe, expect, test, vi } from 'vitest';
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

  test('parses contact turn streaming envelopes without revision watermarks', () => {
    expect(parseOpenchamberEventEnvelope({
      type: 'openchamber:contact-turn-start',
      properties: { assistantID: 'asst_1', turnID: 'oc_contact_1', messageID: 'oc_contact_1', occurredAt: 30, revision: 99 },
    })).toEqual({
      type: 'contact-turn-start',
      assistantID: 'asst_1',
      turnID: 'oc_contact_1',
      messageID: 'oc_contact_1',
      occurredAt: 30,
    });
    expect(parseOpenchamberEventEnvelope({
      type: 'openchamber:contact-bubble-delta',
      properties: { assistantID: 'asst_1', turnID: 'oc_contact_1', bubbleIndex: 0, delta: 'Hello', done: false, occurredAt: 31, revision: 100 },
    })).toEqual({
      type: 'contact-bubble-delta',
      assistantID: 'asst_1',
      turnID: 'oc_contact_1',
      bubbleIndex: 0,
      delta: 'Hello',
      done: false,
      occurredAt: 31,
    });
    expect(parseOpenchamberEventEnvelope({
      type: 'openchamber:contact-turn-end',
      properties: { assistantID: 'asst_1', turnID: 'oc_contact_1', status: 'error', error: 'upstream failed', occurredAt: 32, revision: 101 },
    })).toEqual({
      type: 'contact-turn-end',
      assistantID: 'asst_1',
      turnID: 'oc_contact_1',
      status: 'error',
      error: 'upstream failed',
      occurredAt: 32,
    });
  });

  test('rejects malformed contact turn streaming envelopes', () => {
    expect(parseOpenchamberEventEnvelope({ type: 'openchamber:contact-turn-start', properties: { assistantID: 'asst_1', turnID: 'turn_1', messageID: 'message_2', occurredAt: 1 } })).toBeNull();
    expect(parseOpenchamberEventEnvelope({ type: 'openchamber:contact-bubble-delta', properties: { assistantID: 'asst_1', turnID: 'turn_1', bubbleIndex: -1, delta: 'x', done: false, occurredAt: 1 } })).toBeNull();
    expect(parseOpenchamberEventEnvelope({ type: 'openchamber:contact-bubble-delta', properties: { assistantID: 'asst_1', turnID: 'turn_1', bubbleIndex: 0, delta: 'x', done: 'yes', occurredAt: 1 } })).toBeNull();
    expect(parseOpenchamberEventEnvelope({ type: 'openchamber:contact-turn-end', properties: { assistantID: 'asst_1', turnID: 'turn_1', status: 'running', occurredAt: 1 } })).toBeNull();
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

describe('openchamber events heartbeat reconnect', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('after 45s silence aborts the hung stream, reconnects, and delivers ready/revision on the new GET', async () => {
    vi.useFakeTimers();
    const originalWindow = globalThis.window;
    const originalFetch = globalThis.fetch;
    const encoder = new TextEncoder();
    const signals: AbortSignal[] = [];
    const controllers: Array<ReadableStreamDefaultController<Uint8Array>> = [];
    let requests = 0;
    const received: unknown[] = [];
    let unsubscribe: (() => void) | undefined;

    // runtimeFetch needs a window origin for absolute URL resolution.
    const runtimeWindow = Object.assign(new EventTarget(), {
      location: { origin: 'http://openchamber.test', href: 'http://openchamber.test/' },
    });

    try {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: runtimeWindow });
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        signals.push(init?.signal as AbortSignal);
        requests += 1;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controllers[requests - 1] = controller;
            // First connection: open and hang (no further frames → heartbeat silence).
            // Second connection: stay open for post-reconnect frames.
          },
        });
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }) as typeof fetch;

      unsubscribe = subscribeOpenchamberEvents((event) => {
        received.push(event);
      });

      // Allow connect() → consumeRuntimeSse → onOpen (arms heartbeat).
      await vi.advanceTimersByTimeAsync(0);
      expect(requests).toBe(1);
      expect(signals[0]?.aborted).toBe(false);
      expect(controllers[0]).toBeTruthy();

      // Seed a tip before silence so reconnect must still re-open a fresh GET.
      controllers[0]?.enqueue(
        encoder.encode('data: {"type":"openchamber:assistants-changed","properties":{"revision":5,"occurredAt":1}}\n\n'),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(getLatestOpenchamberEventRevision('assistants-changed')).toBe(5);
      expect(received).toEqual([{ type: 'assistants-changed', revision: 5, occurredAt: 1 }]);

      // Heartbeat timeout is 45s from last activity (the tip above re-armed it).
      await vi.advanceTimersByTimeAsync(44_999);
      expect(requests).toBe(1);
      expect(signals[0]?.aborted).toBe(false);

      // Fire heartbeat timeout → cleanupAttempt + scheduleReconnect (1s first delay).
      await vi.advanceTimersByTimeAsync(1);
      expect(signals[0]?.aborted).toBe(true);
      expect(requests).toBe(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(requests).toBe(2);
      expect(signals[1]?.aborted).toBe(false);

      // New stream delivers ready + a higher revision tip.
      controllers[1]?.enqueue(
        encoder.encode('data: {"type":"openchamber:event-stream-ready","properties":{}}\n\n'),
      );
      controllers[1]?.enqueue(
        encoder.encode('data: {"type":"openchamber:assistants-changed","properties":{"revision":9,"occurredAt":2}}\n\n'),
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(received).toEqual([
        { type: 'assistants-changed', revision: 5, occurredAt: 1 },
        { type: 'event-stream-ready' },
        { type: 'assistants-changed', revision: 9, occurredAt: 2 },
      ]);
      expect(getLatestOpenchamberEventRevision('assistants-changed')).toBe(9);

      // Unsubscribe clears attempt, heartbeat, and reconnect timers — no third request.
      unsubscribe();
      unsubscribe = undefined;
      expect(signals[1]?.aborted).toBe(true);
      expect(getLatestOpenchamberEventRevision('assistants-changed')).toBe(undefined);

      await vi.advanceTimersByTimeAsync(120_000);
      expect(requests).toBe(2);
    } finally {
      try { unsubscribe?.(); } catch { /* module-level cleanup */ }
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      globalThis.fetch = originalFetch;
      vi.useRealTimers();
    }
  });

  test('unsubscribe while a hung body is open clears the heartbeat timer without a reconnect storm', async () => {
    vi.useFakeTimers();
    const originalWindow = globalThis.window;
    const originalFetch = globalThis.fetch;
    const signals: AbortSignal[] = [];
    let requests = 0;
    let unsubscribe: (() => void) | undefined;
    const runtimeWindow = Object.assign(new EventTarget(), {
      location: { origin: 'http://openchamber.test', href: 'http://openchamber.test/' },
    });

    try {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: runtimeWindow });
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        signals.push(init?.signal as AbortSignal);
        requests += 1;
        const body = new ReadableStream<Uint8Array>({
          start() {
            // Hang open forever until abort.
          },
        });
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }) as typeof fetch;

      unsubscribe = subscribeOpenchamberEvents(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(requests).toBe(1);
      expect(signals[0]?.aborted).toBe(false);

      unsubscribe();
      unsubscribe = undefined;
      expect(signals[0]?.aborted).toBe(true);

      await vi.advanceTimersByTimeAsync(120_000);
      expect(requests).toBe(1);
    } finally {
      try { unsubscribe?.(); } catch { /* module-level cleanup */ }
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      globalThis.fetch = originalFetch;
      vi.useRealTimers();
    }
  });
});
