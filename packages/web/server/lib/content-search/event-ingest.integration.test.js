import { expect, test, vi } from 'vitest';
import { createSessionIndexService } from '../session-index/service.js';
import { createMessageQueueService } from '../message-queue/service.js';
import { createGlobalMessageStreamHub } from '../event-stream/global-hub.js';
import { createContentSearchService } from './service.js';
import { createContentSearchRuntime } from './runtime.js';

test('real hub runtime identity admits completed replies into search and rejects a previous runtime', async () => {
  let config = { apiBaseUrl: 'http://runtime-a' };
  const getRuntimeConfig = () => config;
  const index = createSessionIndexService({ dbPath: ':memory:', getRuntimeConfig });
  const queue = createMessageQueueService({ dbPath: ':memory:', getRuntimeConfig });
  const service = createContentSearchService({ dbPath: ':memory:' });
  const key = index.getRuntimeKey();
  service.beginInitialization(key, 1);
  service.completeInitialization(key, 0, 2);
  const listSessions = vi.fn();
  const listMessages = vi.fn(async () => ({ data: [{
    id: 'reply', sessionID: 's', type: 'assistant', time: { created: 10, completed: 20 },
    finish: 'stop', content: [{ type: 'text', text: '卡顿和高资源占用属实' }],
  }], cursor: {} }));
  const runtime = createContentSearchRuntime({ service, getRuntimeKey: () => index.getRuntimeKey(),
    getEventRuntimeKey: () => queue.getRuntimeKey(), now: () => 100, listSessions, listMessages,
    getSession: async () => ({ id: 's', time: { updated: 20 } }),
  });
  let captured;
  let stream;
  const hub = createGlobalMessageStreamHub({
    buildOpenCodeUrl: (pathname) => `http://runtime-a${pathname}`, getOpenCodeAuthHeaders: () => ({}),
    getRuntimeIdentity: () => ({ runtimeKey: queue.getRuntimeKey() }),
    fetchImpl: async () => new Response(new ReadableStream({ start(controller) {
      stream = controller;
      controller.enqueue(new TextEncoder().encode('id: event-1\ndata: {"type":"session.execution.succeeded","data":{"sessionID":"s"}}\n\n'));
    } })),
  });
  hub.subscribeEvent((event) => { captured = event; runtime.observe(event); });
  try {
    hub.start();
    await vi.waitFor(() => expect(captured).toBeDefined());
    expect(queue.getRuntimeKey()).not.toBe(key);
    expect(service.pending(key)).toHaveLength(1);
    await runtime.sync({ incremental: true });
    expect(service.search(key, '卡顿和高资源占用属实')).toMatchObject([{ sessionID: 's', messageID: 'reply' }]);
    expect(listSessions).not.toHaveBeenCalled();
    expect(listMessages).toHaveBeenCalledTimes(1);
    config = { apiBaseUrl: 'http://runtime-b' };
    runtime.observe(captured);
    expect(service.pending(index.getRuntimeKey())).toEqual([]);
  } finally {
    hub.stop(); stream?.close(); await runtime.stop(); service.close(); index.close(); queue.close();
  }
});
