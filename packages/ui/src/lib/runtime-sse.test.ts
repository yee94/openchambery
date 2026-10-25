import { describe, expect, test } from 'bun:test';
import { adoptRelayTunnel, deactivateRelayTunnel } from './relay/runtime-tunnel';
import type { RelayTunnelClient } from './relay/tunnel-client';
import { consumeRuntimeSse } from './runtime-sse';

const encoder = new TextEncoder();

const stream = (chunks: string[], error?: Error): ReadableStream<Uint8Array> => new ReadableStream({
  start(controller) {
    for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
    if (error) controller.error(error);
    else controller.close();
  },
});

const response = (chunks: string[], init: ResponseInit = {}, error?: Error): Response => new Response(stream(chunks, error), {
  status: 200,
  headers: { 'content-type': 'text/event-stream' },
  ...init,
});

describe('consumeRuntimeSse', () => {
  test('uses the relay runtimeFetch boundary with the exact SSE request and parses event data', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const relay = {
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ path: String(input), init });
        return response(['data: {"type":"yuri:message-queue-changed","properties":{"revision":8,"occurredAt":10}}\n\n']);
      },
      openWebSocket: () => { throw new Error('unused'); },
      getStatus: () => ({ state: 'connected' as const }),
      subscribeStatus: () => () => undefined,
      close: () => undefined,
    } satisfies RelayTunnelClient;
    const controller = new AbortController();
    const messages: string[] = [];

    try {
      adoptRelayTunnel({ relayUrl: 'wss://relay.example', serverId: 'server-a', hostEncPubJwk: {} }, relay);
      await consumeRuntimeSse('/api/yuri/events', {
        signal: controller.signal,
        onMessage: (data) => messages.push(data),
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].path).toBe('/api/yuri/events');
      expect(calls[0].init?.method).toBe('GET');
      expect(new Headers(calls[0].init?.headers).get('accept')).toBe('text/event-stream');
      expect(calls[0].init?.signal).toBe(controller.signal);
      expect(messages).toEqual(['{"type":"yuri:message-queue-changed","properties":{"revision":8,"occurredAt":10}}']);
    } finally {
      deactivateRelayTunnel();
    }
  });

  test('parses UTF-8, CR/LF/CRLF including split CR, multi-line data, comments, and BOM', async () => {
    const activity: number[] = [];
    const messages: string[] = [];
    await consumeRuntimeSse('/api/yuri/events', {
      fetch: async () => response([
        '\uFEFF: ping\r', '\ndata: 你\r\n', 'data: second\r', '\n\r', '\n',
      ]),
      onActivity: () => activity.push(1),
      onMessage: (data) => messages.push(data),
    });
    expect(messages).toEqual(['你\nsecond']);
    expect(activity).toHaveLength(2);
  });

  test('drops an unterminated EOF event and ignores unknown fields', async () => {
    const messages: string[] = [];
    await consumeRuntimeSse('/api/yuri/events', {
      fetch: async () => response(['event: note\nunknown: value\ndata: complete\n\ndata: dropped']),
      onMessage: (data) => messages.push(data),
    });
    expect(messages).toEqual(['complete']);
  });

  test('rejects oversized buffered lines and events', async () => {
    const exactBoundary = 'x'.repeat(1024 * 1024);
    const messages: string[] = [];
    await consumeRuntimeSse('/api/yuri/events', {
      fetch: async () => response([`data: ${exactBoundary}\n\n`]),
      onMessage: (data) => messages.push(data),
    });
    expect(messages).toEqual([exactBoundary]);
    await expect(consumeRuntimeSse('/api/yuri/events', {
      fetch: async () => response([`data: ${'x'.repeat(1024 * 1024 + 1)}\n\n`]),
    })).rejects.toThrow('SSE response exceeds buffer limit');
    await expect(consumeRuntimeSse('/api/yuri/events', {
      fetch: async () => response([`data: ${'x'.repeat(600 * 1024)}\ndata: ${'y'.repeat(600 * 1024)}\n\n`]),
    })).rejects.toThrow('SSE response exceeds buffer limit');
    await expect(consumeRuntimeSse('/api/yuri/events', {
      fetch: async () => response([`data: ${exactBoundary}\nunknown`]),
    })).rejects.toThrow('SSE response exceeds buffer limit');
  });

  test('treats a data field without a colon as an empty data line at the byte boundary', async () => {
    const prefix = 'x'.repeat(1024 * 1024 - 1);
    const messages: string[] = [];
    await consumeRuntimeSse('/api/yuri/events', {
      fetch: async () => response([`data: ${prefix}\ndata\n\n`]),
      onMessage: (data) => messages.push(data),
    });
    expect(messages).toEqual([`${prefix}\n`]);
  });

  test('reports stable errors for invalid responses and read failures', async () => {
    const cases: Array<{ response: Response }> = [
      { response: response([], { status: 401 }) },
      { response: response([], { status: 500 }) },
      { response: response([], { headers: { 'content-type': 'application/json' } }) },
      { response: new Response(null, { status: 200, headers: { 'content-type': 'text/event-stream' } }) },
      { response: response([], {}, new Error('sensitive reader detail')) },
    ];
    for (const entry of cases) {
      await expect(consumeRuntimeSse('/api/yuri/events', { fetch: async () => entry.response })).rejects.toThrow(/^SSE /);
    }
  });

  test('cancels invalid response bodies before surfacing a stable error', async () => {
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({ cancel: () => { cancelled += 1; } });
    await expect(consumeRuntimeSse('/api/yuri/events', {
      fetch: async () => new Response(body, { status: 401, headers: { 'content-type': 'text/event-stream' } }),
    })).rejects.toThrow('SSE response failed');
    expect(cancelled).toBe(1);

    const wrongTypeBody = new ReadableStream<Uint8Array>({ cancel: () => { cancelled += 1; } });
    await expect(consumeRuntimeSse('/api/yuri/events', {
      fetch: async () => new Response(wrongTypeBody, { status: 200, headers: { 'content-type': 'application/json' } }),
    })).rejects.toThrow('SSE response has invalid content type');
    expect(cancelled).toBe(2);

    const normalBody = new ReadableStream<Uint8Array>({
      start(controller) { controller.close(); },
      cancel: () => { cancelled += 1; },
    });
    await consumeRuntimeSse('/api/yuri/events', {
      fetch: async () => new Response(normalBody, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    });
    expect(cancelled).toBe(2);
  });

  test('cancels readers for parser, read, callback, and abort failures', async () => {
    const createResponse = (read: () => Promise<ReadableStreamReadResult<Uint8Array>>) => {
      let cancelled = 0;
      const reader = {
        read,
        cancel: async () => { cancelled += 1; },
        releaseLock: () => undefined,
      } as ReadableStreamDefaultReader<Uint8Array>;
      const fake = {
        ok: true,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: { getReader: () => reader },
      } as unknown as Response;
      return { fake, cancelled: () => cancelled };
    };

    const parser = createResponse(async () => ({ done: false, value: encoder.encode(`data: ${'x'.repeat(1024 * 1024 + 1)}\n`) }));
    await expect(consumeRuntimeSse('/api/yuri/events', { fetch: async () => parser.fake })).rejects.toThrow('SSE response exceeds buffer limit');
    expect(parser.cancelled()).toBe(1);

    const read = createResponse(async () => { throw new Error('sensitive read'); });
    await expect(consumeRuntimeSse('/api/yuri/events', { fetch: async () => read.fake })).rejects.toThrow('SSE response read failed');
    expect(read.cancelled()).toBe(1);

    const callback = createResponse(async () => ({ done: false, value: encoder.encode('data: callback\n\n') }));
    await expect(consumeRuntimeSse('/api/yuri/events', { fetch: async () => callback.fake, onMessage: () => { throw new Error('consumer detail'); } })).rejects.toThrow('SSE response read failed');
    expect(callback.cancelled()).toBe(1);

    const controller = new AbortController();
    const aborted = createResponse(async () => { throw new DOMException('aborted', 'AbortError'); });
    controller.abort();
    await expect(consumeRuntimeSse('/api/yuri/events', { signal: controller.signal, fetch: async () => aborted.fake })).rejects.toThrow('aborted');
    expect(aborted.cancelled()).toBe(1);
  });
});
