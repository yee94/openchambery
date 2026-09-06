import { describe, expect, it, vi } from 'vitest';

import type { ActiveRuntime } from '@/lib/connectionController';
import {
  applyChatEventToTranscript,
  startGlobalEventStream,
  type WebSocketLike,
} from '@/lib/eventStream';
import { createTranscriptController } from '@/lib/chatTranscript';

const activeDirect = (url = 'http://127.0.0.1:2606'): ActiveRuntime => ({
  connectionId: 'c1',
  label: 'local',
  candidates: [{ kind: 'direct', url }],
  transport: { kind: 'direct', url },
  clientToken: 'token-1',
});

class FakeWs implements WebSocketLike {
  readyState = 0;
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: { code?: number; reason?: string }) => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  });
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
}

describe('startGlobalEventStream', () => {
  it('prefers WS when it opens', async () => {
    const transports: string[] = [];
    const events: string[] = [];
    let ws: FakeWs | null = null;

    const handle = startGlobalEventStream(
      activeDirect(),
      {
        onTransport: (k) => transports.push(k),
        onEvent: (e) => events.push(e.type),
      },
      {
        transport: 'auto',
        openWs: () => {
          ws = new FakeWs();
          queueMicrotask(() => ws?.open());
          return ws;
        },
        wait: async (_ms, signal) => {
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, 20);
            signal.addEventListener(
              'abort',
              () => {
                clearTimeout(t);
                reject(new DOMException('Aborted', 'AbortError'));
              },
              { once: true },
            );
          });
        },
      },
    );

    await vi.waitFor(() => expect(transports).toContain('ws'));
    ws!.onmessage?.({
      data: JSON.stringify({ type: 'session.status', properties: { sessionID: 's1', status: 'busy' } }),
    });
    expect(events).toContain('session.status');
    handle.cleanup();
  });

  it('falls back to SSE when WS fails, poll only as reconnect fallback', async () => {
    const transports: string[] = [];
    let sseCalls = 0;

    const handle = startGlobalEventStream(
      activeDirect(),
      { onTransport: (k) => transports.push(k) },
      {
        transport: 'auto',
        wsReadyTimeoutMs: 10,
        openWs: () => {
          const ws = new FakeWs();
          // never opens → timeout → SSE
          return ws;
        },
        openSse: async ({ onLine, signal }) => {
          sseCalls += 1;
          onLine('data: {"type":"session.idle","properties":{}}');
          // hang until aborted so we don't immediately loop into poll
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          });
        },
        wait: async (ms, signal) => {
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, Math.min(ms, 5));
            signal.addEventListener(
              'abort',
              () => {
                clearTimeout(t);
                reject(new DOMException('Aborted', 'AbortError'));
              },
              { once: true },
            );
          });
        },
      },
    );

    await vi.waitFor(() => expect(sseCalls).toBeGreaterThan(0));
    expect(transports).toContain('sse');
    expect(transports.includes('poll')).toBe(false);
    handle.cleanup();
  });
});

describe('applyChatEventToTranscript', () => {
  it('updates live tail without requiring full reload', () => {
    const controller = createTranscriptController();
    controller.replaceFromRecords([
      { info: { id: 'u1', role: 'user' }, parts: [{ type: 'text', text: 'hi' }] },
    ]);
    controller.resetStats();
    applyChatEventToTranscript(
      {
        type: 'message.part.delta',
        properties: { sessionID: 'ses_1', messageID: 'a1', delta: 'Hel' },
      },
      'ses_1',
      {
        upsertLiveTail: (id, text, role) => controller.upsertLiveTail(id, text, role),
        finalizeLiveTail: (id, text) => controller.finalizeLiveTail(id, text),
        setBusy: (b) => controller.setBusy(b),
      },
    );
    const rows = controller.getRows();
    expect(rows.at(-1)?.id).toBe('a1');
    expect(rows.at(-1)?.text).toBe('Hel');
    expect(controller.getStats().liveOnlyUpdates).toBeGreaterThan(0);
  });
});
