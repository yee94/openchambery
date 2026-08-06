import { afterEach, describe, expect, it } from 'bun:test';
import { createEventPipeline } from '../event-pipeline';
import { setRuntimeUrlAuthToken } from '../../lib/runtime-auth';

const originalDocument = globalThis.document;
const originalWindow = globalThis.window;
const originalWebSocket = globalThis.WebSocket;

function installDomStubs() {
  globalThis.document = {
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
  };

  globalThis.window = {
    location: {
      href: 'http://127.0.0.1:3000/',
      origin: 'http://127.0.0.1:3000',
    },
    addEventListener() {},
    removeEventListener() {},
  };
}

class FakeWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    FakeWebSocket.instances.push(this);
  }

  close() {
    this.readyState = 3;
  }

  emitOpen() {
    this.readyState = 1;
    this.onopen?.();
  }

  emitMessage(payload) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  emitClose() {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: '' });
  }
}

afterEach(() => {
  globalThis.document = originalDocument;
  globalThis.window = originalWindow;
  globalThis.WebSocket = originalWebSocket;
  setRuntimeUrlAuthToken(null, null);
  FakeWebSocket.instances = [];
});

function createSdkWithSingleEvent(event, hold) {
  return {
    global: {
      event: async () => ({
        stream: (async function* () {
          yield event;
          await hold;
        })(),
      }),
    },
  };
}

function withTimeout(promise, ms, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

// Helper to create an SDK that yields multiple events in sequence, then holds.
function createSdkWithEvents(events, hold) {
  return {
    global: {
      event: async () => ({
        stream: (async function* () {
          for (const event of events) {
            yield event;
          }
          await hold;
        })(),
      }),
    },
  };
}

function installFakeWebSocket() {
  globalThis.WebSocket = FakeWebSocket;
  setRuntimeUrlAuthToken('test-url-token', Date.now() + 60_000);
}

// Run a pipeline against a pre-seeded event stream, collect every dispatched
// event, wait long enough for the 16ms flush window to elapse, then tear it
// down. Returns the list of { directory, payload } that onEvent saw.
async function runPipelineWithEvents(events, waitMs = 80) {
  installDomStubs();

  let releaseStream;
  const hold = new Promise((resolve) => {
    releaseStream = resolve;
  });

  const received = [];
  const sdk = createSdkWithEvents(events, hold);
  const { cleanup } = createEventPipeline({
    sdk,
    transport: 'sse',
    onEvent: (directory, payload) => {
      received.push({ directory, payload });
    },
  });

  await new Promise((resolve) => setTimeout(resolve, waitMs));
  cleanup();
  releaseStream();

  return received;
}

describe('createEventPipeline', () => {
  it('falls back to payload.properties.directory when the SDK event omits top-level directory', async () => {
    installDomStubs();

    let releaseStream;
    const hold = new Promise((resolve) => {
      releaseStream = resolve;
    });

    const received = [];
    const sdk = createSdkWithSingleEvent({
      payload: {
        type: 'session.status',
        properties: {
          directory: 'C:/Users/daveotero/localdev/openchamber',
          sessionID: 'session-1',
          status: { type: 'busy' },
        },
      },
    }, hold);

    const delivered = new Promise((resolve) => {
      const { cleanup } = createEventPipeline({
        sdk,
        onEvent: (directory, payload) => {
          received.push({ directory, payload });
          cleanup();
          releaseStream();
          resolve();
        },
      });
    });

    await delivered;

    expect(received).toHaveLength(1);
    expect(received[0].directory).toBe('C:/Users/daveotero/localdev/openchamber');
    expect(received[0].payload.type).toBe('session.status');
  });

  it('prefers the explicit top-level event directory when present', async () => {
    installDomStubs();

    let releaseStream;
    const hold = new Promise((resolve) => {
      releaseStream = resolve;
    });

    const received = [];
    const sdk = createSdkWithSingleEvent({
      directory: 'C:/top-level',
      payload: {
        type: 'session.status',
        properties: {
          directory: 'C:/nested',
          sessionID: 'session-2',
          status: { type: 'busy' },
        },
      },
    }, hold);

    const delivered = new Promise((resolve) => {
      const { cleanup } = createEventPipeline({
        sdk,
        onEvent: (directory, payload) => {
          received.push({ directory, payload });
          cleanup();
          releaseStream();
          resolve();
        },
      });
    });

    await delivered;

    expect(received).toHaveLength(1);
    expect(received[0].directory).toBe('C:/top-level');
    expect(received[0].payload.type).toBe('session.status');
  });

  it('uses payload.properties.directory when the top-level directory is an empty string', async () => {
    installDomStubs();

    let releaseStream;
    const hold = new Promise((resolve) => {
      releaseStream = resolve;
    });

    const received = [];
    const sdk = createSdkWithSingleEvent({
      directory: '',
      payload: {
        type: 'message.part.updated',
        properties: {
          directory: 'C:/fallback-dir',
          part: {
            id: 'part-1',
            type: 'text',
            messageID: 'message-1',
          },
        },
      },
    }, hold);

    const delivered = new Promise((resolve) => {
      const { cleanup } = createEventPipeline({
        sdk,
        onEvent: (directory, payload) => {
          received.push({ directory, payload });
          cleanup();
          releaseStream();
          resolve();
        },
      });
    });

    await delivered;

    expect(received).toHaveLength(1);
    expect(received[0].directory).toBe('C:/fallback-dir');
    expect(received[0].payload.type).toBe('message.part.updated');
  });

  it('keeps truly global events on the global channel when no directory is present anywhere', async () => {
    installDomStubs();

    let releaseStream;
    const hold = new Promise((resolve) => {
      releaseStream = resolve;
    });

    const received = [];
    const sdk = createSdkWithSingleEvent({
      payload: {
        type: 'server.connected',
        properties: {},
      },
    }, hold);

    const delivered = new Promise((resolve) => {
      const { cleanup } = createEventPipeline({
        sdk,
        onEvent: (directory, payload) => {
          received.push({ directory, payload });
          cleanup();
          releaseStream();
          resolve();
        },
      });
    });

    await delivered;

    expect(received).toHaveLength(1);
    expect(received[0].directory).toBe('global');
    expect(received[0].payload.type).toBe('server.connected');
  });

  it('keeps message.part.delta events when a newer message.part.updated is queued for the same field', async () => {
    installDomStubs();

    let releaseStream;
    const hold = new Promise((resolve) => {
      releaseStream = resolve;
    });

    const received = [];

    // The pipeline only routes/coalesces events. Whether this delta is already
    // represented by the newer snapshot is reducer state, not queue state.
    const directory = '/test/dir';
    const sdk = createSdkWithEvents([
      // T0: message.part.updated for part-A
      {
        payload: {
          type: 'message.part.updated',
          properties: {
            directory,
            part: { id: 'part-A', type: 'text', messageID: 'msg-1' },
          },
        },
      },
      // T1: message.part.delta for part-A
      {
        payload: {
          type: 'message.part.delta',
          properties: {
            directory,
            messageID: 'msg-1',
            partID: 'part-A',
            field: 'text',
            delta: ' world',
          },
        },
      },
      // T2: a newer message.part.updated for part-A — delivered as its own
      // event (part.updated is never coalesced, ordering is preserved).
      {
        payload: {
          type: 'message.part.updated',
          properties: {
            directory,
            part: { id: 'part-A', type: 'text', messageID: 'msg-1' },
          },
        },
      },
    ], hold);

    const delivered = new Promise((resolve) => {
      const { cleanup } = createEventPipeline({
        sdk,
        onEvent: (dir, payload) => {
          received.push({ directory: dir, payload });
          if (received.length === 3) {
            cleanup();
            releaseStream();
            resolve();
          }
        },
      });
    });

    await delivered;

    expect(received.length).toBe(3);
    expect(received[0].payload.type).toBe('message.part.updated');
    expect(received[1].payload.type).toBe('message.part.delta');
    expect(received[1].payload.properties.delta).toBe(' world');
    expect(received[2].payload.type).toBe('message.part.updated');
  });

  it('keeps delta events for other fields on the same part', async () => {
    const received = await runPipelineWithEvents([
      {
        directory: 'dir-a',
        payload: {
          type: 'message.part.delta',
          properties: {
            messageID: 'msg-1',
            partID: 'part-1',
            field: 'reasoning',
            delta: 'before',
          },
        },
      },
      {
        directory: 'dir-a',
        payload: {
          type: 'message.part.updated',
          properties: {
            part: { id: 'part-1', type: 'text', messageID: 'msg-1' },
          },
        },
      },
    ]);

    expect(received).toHaveLength(2);
    expect(received[0].payload.type).toBe('message.part.delta');
    expect(received[0].payload.properties.field).toBe('reasoning');
    expect(received[1].payload.type).toBe('message.part.updated');
  });

  it('keeps text delta after an initial part.updated when no newer part.updated replaced it', async () => {
    const received = await runPipelineWithEvents([
      {
        directory: 'dir-a',
        payload: {
          type: 'message.part.updated',
          properties: {
            part: { id: 'part-1', type: 'text', messageID: 'msg-1' },
          },
        },
      },
      {
        directory: 'dir-a',
        payload: {
          type: 'message.part.delta',
          properties: {
            messageID: 'msg-1',
            partID: 'part-1',
            field: 'text',
            delta: 'hello',
          },
        },
      },
    ]);

    expect(received).toHaveLength(2);
    expect(received[0].payload.type).toBe('message.part.updated');
    expect(received[1].payload.type).toBe('message.part.delta');
    expect(received[1].payload.properties.delta).toBe('hello');
  });

  it('delivers every message.part.updated for the same part (never coalesced)', async () => {
    installDomStubs();

    let releaseStream;
    const hold = new Promise((resolve) => {
      releaseStream = resolve;
    });

    const received = [];
    const directory = '/test/dir';

    // part.updated snapshots must all reach the reducer in order — coalescing
    // them can drop intermediate states deltas depend on (see PR #1167).
    const sdk = createSdkWithEvents([
      {
        payload: {
          type: 'message.part.updated',
          properties: {
            directory,
            part: { id: 'part-A', type: 'text', messageID: 'msg-1' },
          },
        },
      },
      {
        payload: {
          type: 'message.part.updated',
          properties: {
            directory,
            part: { id: 'part-A', type: 'text', messageID: 'msg-1' },
          },
        },
      },
    ], hold);

    const delivered = new Promise((resolve) => {
      const { cleanup } = createEventPipeline({
        sdk,
        onEvent: (dir, payload) => {
          received.push({ directory: dir, payload });
          if (received.length === 2) {
            cleanup();
            releaseStream();
            resolve();
          }
        },
      });
    });

    await delivered;

    expect(received.length).toBe(2);
    expect(received[0].payload.type).toBe('message.part.updated');
    expect(received[1].payload.type).toBe('message.part.updated');
  });

  it('routes events before queueing so coalescing happens on the resolved directory', async () => {
    installDomStubs();

    let releaseStream;
    const hold = new Promise((resolve) => {
      releaseStream = resolve;
    });

    // Two coalescible session.status events for the same session arrive on
    // different transport directories; routing resolves both to the same
    // directory, so they must land in one queue and coalesce to the latest.
    const received = [];
    const sdk = createSdkWithEvents([
      {
        directory: 'global',
        payload: {
          type: 'session.status',
          properties: {
            sessionID: 'session-1',
            status: { type: 'busy' },
          },
        },
      },
      {
        directory: '/real-dir',
        payload: {
          type: 'session.status',
          properties: {
            sessionID: 'session-1',
            status: { type: 'idle' },
          },
        },
      },
    ], hold);

    const delivered = new Promise((resolve) => {
      const { cleanup } = createEventPipeline({
        sdk,
        routeDirectory: (directory, payload) => {
          if (payload.type === 'session.status') {
            return '/resolved-dir';
          }
          return directory;
        },
        onEvent: (dir, payload) => {
          received.push({ directory: dir, payload });
          cleanup();
          releaseStream();
          resolve();
        },
      });
    });

    await delivered;

    expect(received).toHaveLength(1);
    expect(received[0].directory).toBe('/resolved-dir');
    expect(received[0].payload.type).toBe('session.status');
    expect(received[0].payload.properties.status.type).toBe('idle');
  });

  it('consumes websocket message stream frames when transport is ws', async () => {
    installDomStubs();
    installFakeWebSocket();

    const received = [];
    const sdk = {
      global: {
        event: async () => {
          throw new Error('SSE should not be used in ws mode');
        },
      },
    };

    const delivered = new Promise((resolve) => {
      const { cleanup } = createEventPipeline({
        sdk,
        transport: 'ws',
        onEvent: (directory, payload) => {
          received.push({ directory, payload });
          cleanup();
          resolve();
        },
      });
    });

    await Promise.resolve();

    const socket = FakeWebSocket.instances[0];
    expect(socket?.url).toContain('/api/global/event/ws');

    socket.emitOpen();
    socket.emitMessage({ type: 'ready', scope: 'global' });
    socket.emitMessage({
      type: 'event',
      eventId: 'evt-1',
      directory: '/tmp/project',
      payload: {
        type: 'session.status',
        properties: {
          sessionID: 'session-1',
        },
      },
    });

    await delivered;

    expect(received).toEqual([
      {
        directory: '/tmp/project',
        payload: {
          type: 'session.status',
          properties: {
            sessionID: 'session-1',
          },
        },
      },
    ]);
  });

  it('falls back to SSE when websocket closes before ready in auto mode', async () => {
    installDomStubs();
    installFakeWebSocket();

    let releaseStream;
    const hold = new Promise((resolve) => {
      releaseStream = resolve;
    });

    const received = [];
    const sdk = createSdkWithSingleEvent({
      payload: {
        type: 'server.connected',
        properties: {},
      },
    }, hold);

    const delivered = new Promise((resolve) => {
      const { cleanup } = createEventPipeline({
        sdk,
        transport: 'auto',
        onEvent: (directory, payload) => {
          received.push({ directory, payload });
          cleanup();
          releaseStream();
          resolve();
        },
      });
    });

    await Promise.resolve();
    const socket = FakeWebSocket.instances[0];
    socket.emitClose();

    await delivered;

    expect(received).toEqual([
      {
        directory: 'global',
        payload: {
          type: 'server.connected',
          properties: {},
        },
      },
    ]);
  });

  it('falls back to SSE when websocket does not become ready in auto mode', async () => {
    installDomStubs();
    installFakeWebSocket();

    let releaseStream;
    const hold = new Promise((resolve) => {
      releaseStream = resolve;
    });

    const received = [];
    const sdk = createSdkWithSingleEvent({
      payload: {
        type: 'server.connected',
        properties: {},
      },
    }, hold);

    let cleanup;
    const delivered = new Promise((resolve) => {
      const pipeline = createEventPipeline({
        sdk,
        transport: 'auto',
        wsReadyTimeoutMs: 20,
        onEvent: (directory, payload) => {
          received.push({ directory, payload });
          resolve();
        },
      });
      cleanup = pipeline.cleanup;
    });

    await Promise.resolve();
    const socket = FakeWebSocket.instances[0];
    socket.emitOpen();

    try {
      await withTimeout(delivered, 500, 'timed out waiting for websocket-ready SSE fallback');
    } finally {
      cleanup?.();
      releaseStream();
    }

    expect(received).toEqual([
      {
        directory: 'global',
        payload: {
          type: 'server.connected',
          properties: {},
        },
      },
    ]);
  });

  it('passes the last websocket event id when falling back to SSE', async () => {
    installDomStubs();
    installFakeWebSocket();
    const originalConsoleError = console.error;
    console.error = () => {};

    let releaseStream;
    const hold = new Promise((resolve) => {
      releaseStream = resolve;
    });

    const eventOptions = [];
    const received = [];
    const sdk = {
      global: {
        event: async (options) => {
          eventOptions.push(options);
          return {
            stream: (async function* () {
              yield {
                payload: {
                  type: 'server.connected',
                  properties: {},
                },
              };
              await hold;
            })(),
          };
        },
      },
    };

    const delivered = new Promise((resolve) => {
      const { cleanup } = createEventPipeline({
        sdk,
        transport: 'auto',
        reconnectDelayMs: 0,
        wsReadyTimeoutMs: 20,
        onEvent: (directory, payload) => {
          received.push({ directory, payload });
          if (payload.type !== 'server.connected') {
            return;
          }
          cleanup();
          releaseStream();
          resolve();
        },
      });
    });

    try {
      await Promise.resolve();

      const firstSocket = FakeWebSocket.instances[0];
      firstSocket.emitOpen();
      firstSocket.emitMessage({ type: 'ready', scope: 'global' });
      firstSocket.emitMessage({
        type: 'event',
        eventId: 'evt-1',
        directory: '/tmp/project',
        payload: {
          type: 'session.status',
          properties: {
            sessionID: 'session-1',
          },
        },
      });
      firstSocket.emitClose();

      await new Promise((resolve) => setTimeout(resolve, 40));
      await delivered;

      expect(eventOptions[0]?.headers?.['Last-Event-ID']).toBe('evt-1');
      expect(received.some((entry) => entry.payload.type === 'server.connected')).toBe(true);
    } finally {
      console.error = originalConsoleError;
    }
  });

  it('marks the pipeline disconnected on heartbeat timeout and recovers on the next websocket connect', async () => {
    installDomStubs();
    installFakeWebSocket();

    const disconnectReasons = [];
    let reconnectCount = 0;

    const sdk = {
      global: {
        event: async () => {
          throw new Error('SSE should not be used in ws mode');
        },
      },
    };

    const recovered = new Promise((resolve) => {
      const { cleanup } = createEventPipeline({
        sdk,
        transport: 'ws',
        heartbeatTimeoutMs: 20,
        reconnectDelayMs: 0,
        wsReadyTimeoutMs: 20,
        onEvent: () => {},
        onDisconnect: (reason) => {
          disconnectReasons.push(reason);
        },
        onReconnect: () => {
          reconnectCount += 1;
          if (reconnectCount === 2) {
            cleanup();
            resolve();
          }
        },
      });
    });

    await Promise.resolve();

    const firstSocket = FakeWebSocket.instances[0];
    firstSocket.emitOpen();
    firstSocket.emitMessage({ type: 'ready', scope: 'global' });

    await new Promise((resolve) => setTimeout(resolve, 35));

    const secondSocket = FakeWebSocket.instances[1];
    expect(secondSocket).toBeDefined();

    secondSocket.emitOpen();
    secondSocket.emitMessage({ type: 'ready', scope: 'global' });

    await recovered;

    expect(disconnectReasons).toEqual(['ws_heartbeat_timeout']);
    expect(reconnectCount).toBe(2);
  });

  it('aborts a permanently pending SSE response on heartbeat timeout and retries', async () => {
    installDomStubs();
    let calls = 0;
    const disconnectReasons = [];
    let cleanup;
    const recovered = new Promise((resolve) => {
      const pipeline = createEventPipeline({
        sdk: {
          global: {
            event: () => {
              calls += 1;
              if (calls === 1) return new Promise(() => {});
              return Promise.resolve({ stream: (async function* () { await new Promise(() => {}); })() });
            },
          },
        },
        transport: 'sse',
        heartbeatTimeoutMs: 20,
        reconnectDelayMs: 0,
        onEvent: () => {},
        onDisconnect: (reason) => disconnectReasons.push(reason),
        onReconnect: () => {
          if (calls >= 2) resolve();
        },
      });
      cleanup = pipeline.cleanup;
    });

    try {
      await withTimeout(recovered, 500, 'timed out waiting for pending SSE retry');
      expect(disconnectReasons).toEqual(['sse_heartbeat_timeout']);
      expect(calls).toBeGreaterThanOrEqual(2);
    } finally {
      cleanup?.();
    }
  });

  it('reports natural SSE EOF as a disconnect before the next connection', async () => {
    installDomStubs();
    const originalConsoleError = console.error;
    console.error = () => {};
    const callbacks = [];
    let calls = 0;
    let cleanup;
    const secondConnected = new Promise((resolve) => {
      const pipeline = createEventPipeline({
        sdk: {
          global: {
            event: async () => {
              calls += 1;
              if (calls === 1) {
                return {
                  stream: (async function* () {
                    callbacks.push('eof');
                  })(),
                };
              }
              return { stream: (async function* () { await new Promise(() => {}); })() };
            },
          },
        },
        transport: 'sse',
        reconnectDelayMs: 0,
        onEvent: () => {},
        onReconnect: () => {
          callbacks.push('connected');
          if (calls === 2) resolve();
        },
        onDisconnect: (reason) => callbacks.push(`disconnected:${reason}`),
      });
      cleanup = pipeline.cleanup;
    });

    try {
      await withTimeout(secondConnected, 500, 'timed out waiting for SSE EOF reconnect');
      expect(callbacks).toEqual([
        'connected',
        'eof',
        'disconnected:sse_stream_closed',
        'connected',
      ]);
    } finally {
      cleanup?.();
      console.error = originalConsoleError;
    }
  });

  it('reports SSE heartbeats as transport activity without dispatching a domain event', async () => {
    installDomStubs();
    let cleanup;
    let activityCount = 0;
    const activity = new Promise((resolve) => {
      const pipeline = createEventPipeline({
        sdk: {
          global: {
            event: async (options) => {
              options.onSseEvent({ id: 'heartbeat-1' });
              return { stream: (async function* () { await new Promise(() => {}); })() };
            },
          },
        },
        transport: 'sse',
        onEvent: () => { throw new Error('heartbeat dispatched as domain event'); },
        onTransportActivity: () => {
          activityCount += 1;
          if (activityCount >= 2) resolve();
        },
      });
      cleanup = pipeline.cleanup;
    });

    try {
      await withTimeout(activity, 200, 'timed out waiting for SSE heartbeat activity');
      expect(activityCount).toBeGreaterThanOrEqual(2);
    } finally {
      cleanup?.();
    }
  });

  it('waits for fallback SSE connection before reporting reconnect after a transport switch', async () => {
    installDomStubs();
    installFakeWebSocket();
    let releaseStream;
    const hold = new Promise((resolve) => { releaseStream = resolve; });
    const callbacks = [];
    let cleanup;
    const connected = new Promise((resolve) => {
      const pipeline = createEventPipeline({
        sdk: { global: { event: async () => ({ stream: (async function* () { await hold; })() }) } },
        transport: 'auto',
        reconnectDelayMs: 0,
        onEvent: () => {},
        onTransportSwitch: () => callbacks.push('switch'),
        onReconnect: () => {
          callbacks.push('reconnect');
          if (callbacks.includes('switch')) resolve();
        },
      });
      cleanup = pipeline.cleanup;
    });

    try {
      await Promise.resolve();
      FakeWebSocket.instances[0].emitClose();
      await withTimeout(connected, 500, 'timed out waiting for fallback SSE connection');
      expect(callbacks).toEqual(['switch', 'reconnect']);
    } finally {
      cleanup?.();
      releaseStream();
    }
  });

  it('flushes replay events before the ready compensation trigger and publishes one trigger per ready', async () => {
    installDomStubs();
    installFakeWebSocket();

    const order = [];
    const compensations = [];
    let cleanup;
    const recovered = new Promise((resolve) => {
      const pipeline = createEventPipeline({
        sdk: {
          global: {
            event: async () => {
              throw new Error('SSE should not be used in ws mode');
            },
          },
        },
        transport: 'ws',
        reconnectDelayMs: 0,
        heartbeatTimeoutMs: 20,
        wsReadyTimeoutMs: 50,
        onEvent: (_directory, payload) => {
          order.push(`event:${payload.type}`);
        },
        onCompensation: (trigger) => {
          compensations.push(trigger);
          order.push(`compensation:${trigger.reason}`);
          if (compensations.length === 2) {
            cleanup();
            resolve();
          }
        },
      });
      cleanup = pipeline.cleanup;
    });

    try {
      await Promise.resolve();
      const firstSocket = FakeWebSocket.instances[0];
      firstSocket.emitOpen();
      // Server protocol: replay events first, then ready barrier.
      firstSocket.emitMessage({
        type: 'event',
        eventId: 'evt-replay-1',
        directory: '/tmp/project',
        payload: {
          type: 'session.updated',
          properties: {
            info: { id: 'session-1', directory: '/tmp/project' },
          },
        },
      });
      firstSocket.emitMessage({ type: 'ready', scope: 'global' });

      await new Promise((resolve) => setTimeout(resolve, 35));

      const secondSocket = FakeWebSocket.instances[1];
      expect(secondSocket).toBeDefined();
      secondSocket.emitOpen();
      secondSocket.emitMessage({
        type: 'event',
        eventId: 'evt-replay-2',
        directory: '/tmp/project',
        payload: {
          type: 'session.updated',
          properties: {
            info: { id: 'session-1', directory: '/tmp/project' },
          },
        },
      });
      secondSocket.emitMessage({ type: 'ready', scope: 'global' });

      await withTimeout(recovered, 500, 'timed out waiting for compensation triggers');

      expect(order[0]).toBe('event:session.updated');
      expect(order[1]).toBe('compensation:ready');
      expect(compensations).toHaveLength(2);
      expect(compensations[0]).toMatchObject({
        lastEventId: 'evt-replay-1',
        reason: 'ready',
        transport: 'ws',
        isReconnect: false,
      });
      expect(typeof compensations[0].runtimeGeneration).toBe('number');
      // Disconnect-time tip is preserved for the next ready compensation even
      // when reconnect replay advances the live lastEventId past that tip.
      expect(compensations[1].lastEventId).toBe('evt-replay-1');
      expect(compensations[1].reason).toBe('ws_heartbeat_timeout');
      expect(compensations[1].isReconnect).toBe(true);
      expect(typeof compensations[1].disconnectedAt).toBe('number');
    } finally {
      cleanup?.();
    }
  });

  it('marks first ready compensation as isReconnect false and real reconnect as true', async () => {
    installDomStubs();
    installFakeWebSocket();

    const compensations = [];
    let cleanup;
    const recovered = new Promise((resolve) => {
      const pipeline = createEventPipeline({
        sdk: {
          global: {
            event: async () => {
              throw new Error('SSE should not be used in ws mode');
            },
          },
        },
        transport: 'ws',
        reconnectDelayMs: 0,
        heartbeatTimeoutMs: 20,
        wsReadyTimeoutMs: 50,
        onEvent: () => {},
        onCompensation: (trigger) => {
          compensations.push(trigger);
          if (compensations.length === 2) {
            cleanup();
            resolve();
          }
        },
      });
      cleanup = pipeline.cleanup;
    });

    try {
      await Promise.resolve();
      const firstSocket = FakeWebSocket.instances[0];
      firstSocket.emitOpen();
      firstSocket.emitMessage({ type: 'ready', scope: 'global' });

      await new Promise((resolve) => setTimeout(resolve, 35));

      const secondSocket = FakeWebSocket.instances[1];
      expect(secondSocket).toBeDefined();
      secondSocket.emitOpen();
      secondSocket.emitMessage({ type: 'ready', scope: 'global' });

      await withTimeout(recovered, 500, 'timed out waiting for isReconnect compensation flags');

      expect(compensations).toHaveLength(2);
      expect(compensations[0]).toMatchObject({
        isReconnect: false,
        reason: 'ready',
        disconnectedAt: null,
        transport: 'ws',
      });
      expect(compensations[1]).toMatchObject({
        isReconnect: true,
        reason: 'ws_heartbeat_timeout',
        transport: 'ws',
      });
      expect(typeof compensations[1].disconnectedAt).toBe('number');
      expect(typeof compensations[1].runtimeGeneration).toBe('number');
    } finally {
      cleanup?.();
    }
  });

  it('captures recovery context on visibility hidden and reuses it on the next ready compensation', async () => {
    installDomStubs();
    installFakeWebSocket();

    const visibilityListeners = new Set();
    globalThis.document = {
      visibilityState: 'visible',
      addEventListener(event, handler) {
        if (event === 'visibilitychange') visibilityListeners.add(handler);
      },
      removeEventListener(event, handler) {
        if (event === 'visibilitychange') visibilityListeners.delete(handler);
      },
    };

    const compensations = [];
    const recoveryCaptures = [];
    let cleanup;
    const secondCompensation = new Promise((resolve) => {
      const pipeline = createEventPipeline({
        sdk: {
          global: {
            event: async () => {
              throw new Error('SSE should not be used in ws mode');
            },
          },
        },
        transport: 'ws',
        reconnectDelayMs: 0,
        // Short heartbeat so the post-hide disconnect retries without waiting
        // the full exponential backoff from a natural WS close path.
        heartbeatTimeoutMs: 20,
        wsReadyTimeoutMs: 50,
        onEvent: () => {},
        onRecoveryContextCaptured: (context) => {
          recoveryCaptures.push(context);
        },
        onCompensation: (trigger) => {
          compensations.push(trigger);
          if (compensations.length === 2) {
            cleanup();
            resolve();
          }
        },
      });
      cleanup = pipeline.cleanup;
    });

    try {
      await Promise.resolve();
      const firstSocket = FakeWebSocket.instances[0];
      firstSocket.emitOpen();
      firstSocket.emitMessage({
        type: 'event',
        eventId: 'evt-before-hide',
        directory: '/tmp/project',
        payload: {
          type: 'session.updated',
          properties: {
            info: { id: 'session-1', directory: '/tmp/project' },
          },
        },
      });
      firstSocket.emitMessage({ type: 'ready', scope: 'global' });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Capture the pre-hide tip before liveness is lost.
      globalThis.document.visibilityState = 'hidden';
      for (const handler of visibilityListeners) handler();

      // Checkpoint capture must fire immediately on visibility hide — even
      // though onDisconnect has not run yet.
      expect(recoveryCaptures).toHaveLength(1);
      expect(recoveryCaptures[0]).toMatchObject({
        reason: 'visibility_hidden',
        lastEventId: 'evt-before-hide',
      });
      expect(typeof recoveryCaptures[0].disconnectedAt).toBe('number');
      expect(typeof recoveryCaptures[0].runtimeGeneration).toBe('number');

      // Heartbeat timeout aborts the attempt (retryDelayMs=0 path) and
      // reconnects; the earliest recovery context remains visibility_hidden
      // and must not publish a second capture for the same gap.
      await new Promise((resolve) => setTimeout(resolve, 35));
      expect(recoveryCaptures).toHaveLength(1);

      const secondSocket = FakeWebSocket.instances[1];
      expect(secondSocket).toBeDefined();
      secondSocket.emitOpen();
      secondSocket.emitMessage({ type: 'ready', scope: 'global' });

      await withTimeout(secondCompensation, 500, 'timed out waiting for visibility recovery compensation');

      expect(compensations).toHaveLength(2);
      expect(compensations[0]).toMatchObject({
        reason: 'ready',
        isReconnect: false,
      });
      expect(compensations[1]).toMatchObject({
        reason: 'visibility_hidden',
        lastEventId: 'evt-before-hide',
        transport: 'ws',
        isReconnect: true,
      });
      expect(typeof compensations[1].disconnectedAt).toBe('number');
      expect(typeof compensations[1].runtimeGeneration).toBe('number');
      // Capture still once for the gap after ready consumed the context.
      expect(recoveryCaptures).toHaveLength(1);
    } finally {
      cleanup?.();
    }
  });

  it('publishes onRecoveryContextCaptured once per gap for transport error, pageshow, and system resume before ready', async () => {
    installDomStubs();
    installFakeWebSocket();

    const pageshowListeners = new Set();
    const winListeners = {};
    // Preserve location from installDomStubs; only wrap event registration.
    const baseWindow = globalThis.window;
    globalThis.window = {
      ...baseWindow,
      location: baseWindow.location ?? {
        href: 'http://127.0.0.1:3000/',
        origin: 'http://127.0.0.1:3000',
      },
      addEventListener(event, handler) {
        if (event === 'pageshow') {
          pageshowListeners.add(handler);
          return;
        }
        if (!winListeners[event]) winListeners[event] = [];
        winListeners[event].push(handler);
      },
      removeEventListener(event, handler) {
        if (event === 'pageshow') {
          pageshowListeners.delete(handler);
          return;
        }
        const list = winListeners[event];
        if (!list) return;
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      },
      dispatch(event) {
        for (const handler of winListeners[event] ?? []) handler();
      },
    };

    const recoveryCaptures = [];
    const compensations = [];
    const disconnectReasons = [];
    let cleanup;
    const secondCompensation = new Promise((resolve) => {
      const pipeline = createEventPipeline({
        sdk: {
          global: {
            event: async () => {
              throw new Error('SSE should not be used in ws mode');
            },
          },
        },
        transport: 'ws',
        reconnectDelayMs: 0,
        heartbeatTimeoutMs: 20,
        wsReadyTimeoutMs: 50,
        onEvent: () => {},
        onDisconnect: (reason) => {
          disconnectReasons.push(reason);
        },
        onRecoveryContextCaptured: (context) => {
          recoveryCaptures.push({
            ...context,
            phase: compensations.length === 0 ? 'before-first-ready' : `after-ready-${compensations.length}`,
          });
        },
        onCompensation: (trigger) => {
          compensations.push(trigger);
          if (compensations.length === 2) {
            cleanup();
            resolve();
          }
        },
      });
      cleanup = pipeline.cleanup;
    });

    try {
      await Promise.resolve();
      const firstSocket = FakeWebSocket.instances[0];
      firstSocket.emitOpen();
      firstSocket.emitMessage({
        type: 'event',
        eventId: 'evt-before-error',
        directory: '/tmp/project',
        payload: {
          type: 'session.updated',
          properties: {
            info: { id: 'session-1', directory: '/tmp/project' },
          },
        },
      });
      firstSocket.emitMessage({ type: 'ready', scope: 'global' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(compensations).toHaveLength(1);
      expect(recoveryCaptures).toHaveLength(0);

      // Transport error path: capture fires with disconnect, before next ready.
      firstSocket.emitClose();
      // Allow reconnect loop to observe closed socket and schedule a new attempt.
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(recoveryCaptures.length).toBeGreaterThanOrEqual(1);
      const errorCapture = recoveryCaptures[0];
      expect(errorCapture.lastEventId).toBe('evt-before-error');
      expect(errorCapture.phase).toBe('after-ready-1');
      expect(typeof errorCapture.disconnectedAt).toBe('number');
      expect(disconnectReasons.length).toBeGreaterThanOrEqual(1);

      // Same gap: pageshow / resume must not double-capture.
      for (const handler of pageshowListeners) {
        handler({ persisted: true });
      }
      if (typeof globalThis.window.dispatch === 'function') {
        globalThis.window.dispatch('openchamber:system-resume');
      }
      expect(recoveryCaptures).toHaveLength(1);

      // Wait until reconnect opens a second socket (retryDelayMs=0 after abort paths).
      let secondSocket;
      for (let i = 0; i < 40; i += 1) {
        secondSocket = FakeWebSocket.instances[1];
        if (secondSocket) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(secondSocket).toBeDefined();
      secondSocket.emitOpen();
      secondSocket.emitMessage({ type: 'ready', scope: 'global' });
      await withTimeout(secondCompensation, 500, 'timed out waiting for error recovery compensation');

      expect(compensations[1].isReconnect).toBe(true);
      expect(compensations[1].lastEventId).toBe('evt-before-error');
      // Still one capture for the gap (ready cleared context; no new capture until next gap).
      expect(recoveryCaptures).toHaveLength(1);
    } finally {
      cleanup?.();
    }
  });

  it('publishes recovery capture on pageshow_persisted without requiring onDisconnect first', async () => {
    installDomStubs();
    installFakeWebSocket();

    const pageshowListeners = new Set();
    const winListeners = {};
    const baseWindow = globalThis.window;
    globalThis.window = {
      ...baseWindow,
      location: baseWindow.location ?? {
        href: 'http://127.0.0.1:3000/',
        origin: 'http://127.0.0.1:3000',
      },
      addEventListener(event, handler) {
        if (event === 'pageshow') {
          pageshowListeners.add(handler);
          return;
        }
        if (!winListeners[event]) winListeners[event] = [];
        winListeners[event].push(handler);
      },
      removeEventListener(event, handler) {
        if (event === 'pageshow') {
          pageshowListeners.delete(handler);
          return;
        }
        const list = winListeners[event];
        if (!list) return;
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      },
    };

    const recoveryCaptures = [];
    let cleanup;
    const pipeline = createEventPipeline({
      sdk: {
        global: {
          event: async () => {
            throw new Error('SSE should not be used in ws mode');
          },
        },
      },
      transport: 'ws',
      reconnectDelayMs: 0,
      heartbeatTimeoutMs: 60_000,
      wsReadyTimeoutMs: 50,
      onEvent: () => {},
      onDisconnect: () => {},
      onRecoveryContextCaptured: (context) => {
        recoveryCaptures.push(context);
      },
      onCompensation: () => {},
    });
    cleanup = pipeline.cleanup;

    try {
      await Promise.resolve();
      const firstSocket = FakeWebSocket.instances[0];
      firstSocket.emitOpen();
      firstSocket.emitMessage({
        type: 'event',
        eventId: 'evt-bfcache',
        directory: '/tmp/project',
        payload: {
          type: 'session.updated',
          properties: {
            info: { id: 'session-1', directory: '/tmp/project' },
          },
        },
      });
      firstSocket.emitMessage({ type: 'ready', scope: 'global' });
      await new Promise((resolve) => setTimeout(resolve, 10));

      for (const handler of pageshowListeners) {
        handler({ persisted: true });
      }

      expect(recoveryCaptures).toHaveLength(1);
      expect(recoveryCaptures[0]).toMatchObject({
        reason: 'pageshow_persisted',
        lastEventId: 'evt-bfcache',
      });
    } finally {
      cleanup?.();
    }
  });
});

// ---------------------------------------------------------------------------
// P1 — Per-directory queue isolation
// ---------------------------------------------------------------------------

describe('createEventPipeline — per-directory isolation (P1)', () => {
  it('delivers events from two directories without losing either', async () => {
    const received = await runPipelineWithEvents([
      {
        directory: 'dir-a',
        payload: {
          type: 'session.status',
          properties: { sessionID: 's-a', status: { type: 'busy' } },
        },
      },
      {
        directory: 'dir-b',
        payload: {
          type: 'session.status',
          properties: { sessionID: 's-b', status: { type: 'idle' } },
        },
      },
    ]);

    const dirs = received.map((r) => r.directory).sort();
    expect(dirs).toEqual(['dir-a', 'dir-b']);
  });

  it('keeps distinct sessionIDs in the same directory as independent coalesce slots', async () => {
    const received = await runPipelineWithEvents([
      {
        directory: 'dir-a',
        payload: {
          type: 'session.status',
          properties: { sessionID: 's1', status: { type: 'busy' } },
        },
      },
      {
        directory: 'dir-a',
        payload: {
          type: 'session.status',
          properties: { sessionID: 's2', status: { type: 'busy' } },
        },
      },
    ]);

    expect(received).toHaveLength(2);
    const sessionIds = received.map((r) => r.payload.properties.sessionID).sort();
    expect(sessionIds).toEqual(['s1', 's2']);
  });

  it('collapses repeated session.status for the same session down to the latest', async () => {
    const received = await runPipelineWithEvents([
      {
        directory: 'dir-a',
        payload: {
          type: 'session.status',
          properties: { sessionID: 's1', status: { type: 'busy' } },
        },
      },
      {
        directory: 'dir-a',
        payload: {
          type: 'session.status',
          properties: { sessionID: 's1', status: { type: 'idle' } },
        },
      },
    ]);

    expect(received).toHaveLength(1);
    expect(received[0].payload.properties.status.type).toBe('idle');
  });
});

// ---------------------------------------------------------------------------
// Option C — message.part.delta coalescing
// ---------------------------------------------------------------------------

describe('createEventPipeline — delta coalescing (Option C)', () => {
  it('accumulates consecutive deltas for the same (messageID, partID, field) into one event', async () => {
    const events = ['Hello ', 'world', ', ', 'how ', 'are ', 'you?'].map((chunk) => ({
      directory: 'dir-a',
      payload: {
        type: 'message.part.delta',
        properties: {
          messageID: 'msg-1',
          partID: 'part-1',
          field: 'text',
          delta: chunk,
        },
      },
    }));

    const received = await runPipelineWithEvents(events);

    expect(received).toHaveLength(1);
    expect(received[0].payload.type).toBe('message.part.delta');
    expect(received[0].payload.properties.delta).toBe('Hello world, how are you?');
    expect(received[0].payload.properties.messageID).toBe('msg-1');
    expect(received[0].payload.properties.partID).toBe('part-1');
    expect(received[0].payload.properties.field).toBe('text');
  });

  it('does NOT merge deltas across different fields on the same part', async () => {
    const received = await runPipelineWithEvents([
      {
        directory: 'dir-a',
        payload: {
          type: 'message.part.delta',
          properties: {
            messageID: 'msg-1',
            partID: 'part-1',
            field: 'text',
            delta: 'A',
          },
        },
      },
      {
        directory: 'dir-a',
        payload: {
          type: 'message.part.delta',
          properties: {
            messageID: 'msg-1',
            partID: 'part-1',
            field: 'reasoning',
            delta: 'B',
          },
        },
      },
    ]);

    expect(received).toHaveLength(2);
    const fieldDelta = received.map((r) => [
      r.payload.properties.field,
      r.payload.properties.delta,
    ]).sort();
    expect(fieldDelta).toEqual([
      ['reasoning', 'B'],
      ['text', 'A'],
    ]);
  });

  it('does NOT merge deltas across different parts on the same message', async () => {
    const received = await runPipelineWithEvents([
      {
        directory: 'dir-a',
        payload: {
          type: 'message.part.delta',
          properties: {
            messageID: 'msg-1',
            partID: 'part-1',
            field: 'text',
            delta: 'AAA',
          },
        },
      },
      {
        directory: 'dir-a',
        payload: {
          type: 'message.part.delta',
          properties: {
            messageID: 'msg-1',
            partID: 'part-2',
            field: 'text',
            delta: 'BBB',
          },
        },
      },
    ]);

    expect(received).toHaveLength(2);
    const byPart = Object.fromEntries(
      received.map((r) => [r.payload.properties.partID, r.payload.properties.delta]),
    );
    expect(byPart['part-1']).toBe('AAA');
    expect(byPart['part-2']).toBe('BBB');
  });

  it('does NOT merge deltas across different directories (per-directory queues)', async () => {
    const received = await runPipelineWithEvents([
      {
        directory: 'dir-a',
        payload: {
          type: 'message.part.delta',
          properties: {
            messageID: 'msg-1',
            partID: 'part-1',
            field: 'text',
            delta: 'from-a',
          },
        },
      },
      {
        directory: 'dir-b',
        payload: {
          type: 'message.part.delta',
          properties: {
            messageID: 'msg-1',
            partID: 'part-1',
            field: 'text',
            delta: 'from-b',
          },
        },
      },
    ]);

    expect(received).toHaveLength(2);
    const byDir = Object.fromEntries(
      received.map((r) => [r.directory, r.payload.properties.delta]),
    );
    expect(byDir['dir-a']).toBe('from-a');
    expect(byDir['dir-b']).toBe('from-b');
  });

  it('does not touch non-delta events (session.status still replaced, not concatenated)', async () => {
    const received = await runPipelineWithEvents([
      {
        directory: 'dir-a',
        payload: {
          type: 'session.status',
          properties: { sessionID: 's1', status: { type: 'busy' } },
        },
      },
      {
        directory: 'dir-a',
        payload: {
          type: 'session.status',
          properties: { sessionID: 's1', status: { type: 'idle' } },
        },
      },
    ]);

    expect(received).toHaveLength(1);
    expect(received[0].payload.properties.status.type).toBe('idle');
  });
});
