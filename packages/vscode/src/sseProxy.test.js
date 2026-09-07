import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { vi } from 'vitest';

const originalFetch = globalThis.fetch;
const { openSseProxy } = await import('./sseProxy');

const createManager = () => ({
  getStatus: () => 'connected',
  getApiUrl: () => 'http://127.0.0.1:4096/',
  getWorkingDirectory: () => '/repo',
  getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test-token' }),
  onStatusChange: () => ({ dispose() {} }),
});

const createSseResponse = (chunks) => {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
};

describe('VS Code SSE proxy', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('forwards upstream SSE chunks without reserializing event data', async () => {
    const upstreamChunks = [
      'id: evt-1\n',
      'data: {"type":"message.part.delta","properties":{"delta":"hi"}}\n\n',
    ];
    let fetchInput;
    let fetchInit;
    globalThis.fetch = mock((input, init) => {
      fetchInput = input;
      fetchInit = init;
      return Promise.resolve(createSseResponse(upstreamChunks));
    });

    const received = [];
    const controller = new AbortController();
    const proxy = await openSseProxy({
      manager: createManager(),
      path: '/global/event',
      headers: { 'Last-Event-ID': 'evt-0' },
      signal: controller.signal,
      onChunk: (chunk) => received.push(chunk),
    });

    await proxy.run;

    expect(fetchInput).toBe('http://127.0.0.1:4096/global/event');
    expect(fetchInit.headers.Authorization).toBe('Bearer test-token');
    expect(fetchInit.headers['Last-Event-ID']).toBe('evt-0');
    expect(proxy.headers['content-type']).toContain('text/event-stream');
    expect(received.join('')).toBe(upstreamChunks.join(''));
  });

  it('adds the active directory for directory-scoped event streams', async () => {
    let fetchInput;
    globalThis.fetch = mock((input) => {
      fetchInput = input;
      return Promise.resolve(createSseResponse(['data: {"type":"server.connected"}\n\n']));
    });

    const proxy = await openSseProxy({
      manager: createManager(),
      path: '/event?foo=bar',
      signal: new AbortController().signal,
      onChunk: () => {},
    });
    await proxy.run;

    const url = new URL(fetchInput);
    expect(url.pathname).toBe('/event');
    expect(url.searchParams.get('foo')).toBe('bar');
    expect(url.searchParams.get('directory')).toBe('/repo');
  });

  it('strips includeReasoning from upstream OpenCode URL and never forwards it', async () => {
    let fetchInput;
    globalThis.fetch = mock((input) => {
      fetchInput = input;
      return Promise.resolve(createSseResponse(['data: {"type":"server.connected"}\n\n']));
    });

    const proxy = await openSseProxy({
      manager: createManager(),
      path: '/global/event?includeReasoning=false&x=1',
      signal: new AbortController().signal,
      onChunk: () => {},
    });
    await proxy.run;

    const url = new URL(fetchInput);
    expect(url.pathname).toBe('/global/event');
    expect(url.searchParams.get('x')).toBe('1');
    expect(url.searchParams.has('includeReasoning')).toBe(false);
  });

  it('filters reasoning SSE events when includeReasoning=false before webview chunks', async () => {
    const upstreamChunks = [
      'id: evt-1\ndata: {"type":"message.part.updated","properties":{"part":{"id":"p_t","messageID":"m1","type":"text","text":"hi"}}}\n\n',
      'id: evt-2\ndata: {"type":"message.part.updated","properties":{"part":{"id":"p_r","messageID":"m1","type":"reasoning","text":"secret"}}}\n\n',
      'id: evt-3\ndata: {"type":"message.part.delta","properties":{"messageID":"m1","partID":"p_r","field":"text","delta":"nope"}}\n\n',
      'id: evt-4\ndata: {"type":"message.part.delta","properties":{"messageID":"m1","partID":"p_t","field":"text","delta":"world"}}\n\n',
      'id: evt-5\ndata: {"type":"session.next.reasoning.delta","properties":{"delta":"x"}}\n\n',
    ];
    globalThis.fetch = mock(() => Promise.resolve(createSseResponse(upstreamChunks)));

    const received = [];
    const proxy = await openSseProxy({
      manager: createManager(),
      path: '/global/event?includeReasoning=false',
      signal: new AbortController().signal,
      onChunk: (chunk) => received.push(chunk),
    });
    await proxy.run;

    const joined = received.join('');
    expect(joined).toContain('"type":"text"');
    expect(joined).toContain('"delta":"world"');
    expect(joined).not.toContain('secret');
    expect(joined).not.toContain('nope');
    expect(joined).not.toContain('session.next.reasoning');
    expect(joined).not.toContain('"type":"reasoning"');
  });

  it('keeps full SSE passthrough by default (includeReasoning missing)', async () => {
    const upstreamChunks = [
      'id: evt-1\ndata: {"type":"session.next.reasoning.delta","properties":{"delta":"keep-me"}}\n\n',
    ];
    globalThis.fetch = mock(() => Promise.resolve(createSseResponse(upstreamChunks)));

    const received = [];
    const proxy = await openSseProxy({
      manager: createManager(),
      path: '/global/event',
      signal: new AbortController().signal,
      onChunk: (chunk) => received.push(chunk),
    });
    await proxy.run;

    expect(received.join('')).toBe(upstreamChunks.join(''));
    expect(received.join('')).toContain('keep-me');
  });

  it('emits :heartbeat comment every 10s when filtered mode drops all upstream events', async () => {
    vi.useFakeTimers();
    try {
      const encoder = new TextEncoder();
      let streamController;
      globalThis.fetch = mock(() => Promise.resolve(new Response(new ReadableStream({
        start(controller) {
          streamController = controller;
          // Pure reasoning — every block is dropped by the filter.
          controller.enqueue(encoder.encode(
            'id: r1\ndata: {"type":"session.next.reasoning.delta","properties":{"delta":"secret-1"}}\n\n',
          ));
        },
      }), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })));

      const received = [];
      const abort = new AbortController();
      const proxy = await openSseProxy({
        manager: createManager(),
        path: '/global/event?includeReasoning=false',
        signal: abort.signal,
        onChunk: (chunk) => received.push(chunk),
      });

      // Let the first (dropped) read settle, then advance past UI 30s idle.
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.resolve();

      const heartbeats = received.filter((c) => c === ':heartbeat\n\n');
      expect(heartbeats.length).toBeGreaterThanOrEqual(3);
      expect(received.join('')).not.toContain('secret');
      expect(received.join('')).not.toContain('reasoning');

      // More pure-reasoning upstream still produces only heartbeats.
      streamController.enqueue(encoder.encode(
        'id: r2\ndata: {"type":"session.next.reasoning.delta","properties":{"delta":"secret-2"}}\n\n',
      ));
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.resolve();
      expect(received.join('')).not.toContain('secret-2');

      abort.abort();
      try { streamController.close(); } catch { /* abort may already cancel/close */ }
      await proxy.run.catch(() => {});
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears filtered heartbeat timer on abort so onChunk stops', async () => {
    vi.useFakeTimers();
    try {
      let streamController;
      globalThis.fetch = mock(() => Promise.resolve(new Response(new ReadableStream({
        start(controller) {
          streamController = controller;
        },
        cancel() {
          try { streamController?.close(); } catch { /* already closed */ }
        },
      }), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })));

      const received = [];
      const abort = new AbortController();
      const proxy = await openSseProxy({
        manager: createManager(),
        path: '/global/event?includeReasoning=false',
        signal: abort.signal,
        onChunk: (chunk) => received.push(chunk),
      });

      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.resolve();
      const afterFirst = received.filter((c) => c === ':heartbeat\n\n').length;
      expect(afterFirst).toBeGreaterThanOrEqual(1);

      abort.abort();
      await proxy.run.catch(() => {});
      const atAbort = received.length;

      await vi.advanceTimersByTimeAsync(30_000);
      await Promise.resolve();
      expect(received.length).toBe(atAbort);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not inject synthetic heartbeats on enabled passthrough path', async () => {
    vi.useFakeTimers();
    try {
      let streamController;
      globalThis.fetch = mock(() => Promise.resolve(new Response(new ReadableStream({
        start(controller) {
          streamController = controller;
        },
        cancel() {
          try { streamController?.close(); } catch { /* already closed */ }
        },
      }), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })));

      const received = [];
      const abort = new AbortController();
      const proxy = await openSseProxy({
        manager: createManager(),
        path: '/global/event',
        signal: abort.signal,
        onChunk: (chunk) => received.push(chunk),
      });

      await vi.advanceTimersByTimeAsync(30_000);
      await Promise.resolve();
      expect(received).toEqual([]);
      expect(received.some((c) => c.includes('heartbeat'))).toBe(false);

      abort.abort();
      await proxy.run.catch(() => {});
    } finally {
      vi.useRealTimers();
    }
  });
});
