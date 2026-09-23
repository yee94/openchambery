import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const originalFetch = globalThis.fetch;
const {
  openSseProxy,
  __setSseMetadataReadyWaitForTests,
} = await import('./sseProxy');
const {
  __resetSessionMetadataRuntimeForTests,
  __setSessionMetadataDataRootForTests,
  startSessionMetadataRuntime,
  stopSessionMetadataRuntime,
} = await import('./session-metadata-runtime');

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
    __setSseMetadataReadyWaitForTests(null);
    stopSessionMetadataRuntime();
    __resetSessionMetadataRuntimeForTests();
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

    expect(fetchInput).toBe('http://127.0.0.1:4096/api/global/event');
    expect(fetchInit.headers.Authorization).toBe('Bearer test-token');
    expect(fetchInit.headers['Last-Event-ID']).toBe('evt-0');
    expect(proxy.headers['content-type']).toContain('text/event-stream');
    expect(received.join('')).toBe(upstreamChunks.join(''));
  });

  it('adds the active directory for directory-scoped event streams on /api/event', async () => {
    let fetchInput;
    globalThis.fetch = mock((input) => {
      fetchInput = input;
      return Promise.resolve(createSseResponse(['data: {"type":"server.connected"}\n\n']));
    });

    const proxy = await openSseProxy({
      manager: createManager(),
      path: '/api/event?foo=bar',
      signal: new AbortController().signal,
      onChunk: () => {},
    });
    await proxy.run;

    const url = new URL(fetchInput);
    expect(url.pathname).toBe('/api/event');
    expect(url.searchParams.get('foo')).toBe('bar');
    expect(url.searchParams.get('directory')).toBe('/repo');
  });

  it('restores /api for legacy root SSE paths', async () => {
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
    expect(url.pathname).toBe('/api/event');
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
      path: '/api/global/event?includeReasoning=false&x=1',
      signal: new AbortController().signal,
      onChunk: () => {},
    });
    await proxy.run;

    const url = new URL(fetchInput);
    expect(url.pathname).toBe('/api/global/event');
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

  describe('Host metadata readiness gate (per connect)', () => {
    it('does not fetch upstream while readiness is pending', async () => {
      let resolveReady;
      const readyPromise = new Promise((resolve) => {
        resolveReady = resolve;
      });
      let fetchCalls = 0;
      globalThis.fetch = mock(() => {
        fetchCalls += 1;
        return Promise.resolve(createSseResponse(['data: {"type":"server.connected"}\n\n']));
      });
      __setSseMetadataReadyWaitForTests(async ({ signal }) => {
        await readyPromise;
        if (signal?.aborted) return { ok: false, error: 'aborted', retryable: true };
        return { ok: true };
      });

      const abort = new AbortController();
      const openPromise = openSseProxy({
        manager: createManager(),
        path: '/global/event',
        signal: abort.signal,
        onChunk: () => {},
      });

      // Yield so connect reaches the readiness wait.
      await Promise.resolve();
      await Promise.resolve();
      expect(fetchCalls).toBe(0);

      resolveReady({ ok: true });
      const proxy = await openPromise;
      await proxy.run;
      expect(fetchCalls).toBe(1);
    });

    it('delivers first lifecycle event after readiness succeeds (not dropped)', async () => {
      const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-sse-meta-'));
      try {
        __setSessionMetadataDataRootForTests(dataRoot);
        startSessionMetadataRuntime(createManager());
        // Real ready wait (store empty but loadable).
        __setSseMetadataReadyWaitForTests(null);

        const lifecycle = 'data: {"type":"session.updated","properties":{"info":{"id":"ses_1","time":{"created":1,"updated":2}}}}\n\n';
        globalThis.fetch = mock(() => Promise.resolve(createSseResponse([lifecycle])));

        const received = [];
        const proxy = await openSseProxy({
          manager: createManager(),
          path: '/global/event',
          signal: new AbortController().signal,
          onChunk: (chunk) => received.push(chunk),
        });
        await proxy.run;

        const joined = received.join('');
        expect(joined).toContain('session.updated');
        expect(joined).toContain('ses_1');
      } finally {
        fs.rmSync(dataRoot, { recursive: true, force: true });
      }
    });

    it('retries connect when readiness fails, then succeeds (controlled retry)', async () => {
      let readyAttempts = 0;
      let fetchCalls = 0;
      __setSseMetadataReadyWaitForTests(async () => {
        readyAttempts += 1;
        if (readyAttempts < 2) {
          return { ok: false, error: 'session metadata is unavailable', retryable: true };
        }
        return { ok: true };
      });
      globalThis.fetch = mock(() => {
        fetchCalls += 1;
        return Promise.resolve(createSseResponse([
          'data: {"type":"session.created","properties":{"info":{"id":"ses_new","time":{}}}}\n\n',
        ]));
      });

      const received = [];
      // Real timers: BASE_RECONNECT_DELAY is 1s for first retry.
      const proxy = await openSseProxy({
        manager: createManager(),
        path: '/global/event',
        signal: new AbortController().signal,
        onChunk: (chunk) => received.push(chunk),
      });
      await proxy.run;

      expect(readyAttempts).toBeGreaterThanOrEqual(2);
      expect(fetchCalls).toBe(1);
      expect(received.join('')).toContain('session.created');
      expect(received.join('')).toContain('ses_new');
    });

    it('aborts during readiness wait without opening upstream (late cancel)', async () => {
      let fetchCalls = 0;
      globalThis.fetch = mock(() => {
        fetchCalls += 1;
        return Promise.resolve(createSseResponse(['data: {"type":"server.connected"}\n\n']));
      });
      __setSseMetadataReadyWaitForTests(async ({ signal }) => {
        await new Promise((resolve) => {
          if (signal?.aborted) {
            resolve(undefined);
            return;
          }
          signal?.addEventListener('abort', () => resolve(undefined), { once: true });
        });
        return { ok: false, error: 'aborted', retryable: true };
      });

      const abort = new AbortController();
      const openPromise = openSseProxy({
        manager: createManager(),
        path: '/global/event',
        signal: abort.signal,
        onChunk: () => {},
      });
      await Promise.resolve();
      abort.abort();
      await expect(openPromise).rejects.toBeTruthy();
      expect(fetchCalls).toBe(0);
    });
  });
});
