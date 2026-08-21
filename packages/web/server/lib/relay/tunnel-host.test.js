// Regression: when a loopback WS emits a text message larger than
// MAX_TUNNEL_PAYLOAD_BYTES, the host fragments it across multiple tunnel frames.
// If a second WS text message arrives while those fragments are still being
// awaited through async sendFrame, the current implementation starts a second
// concurrent send loop. Fragment frames from both messages then interleave on
// the same streamId, and the client fragment assembler merges them into one
// corrupted payload. This test must stay red until send serialization is fixed.
// Production send path is intentionally not changed here.

import { afterEach, describe, expect, it } from 'bun:test';

import {
  MAX_TUNNEL_PAYLOAD_BYTES,
  TunnelFrameType,
  createFragmentAssembler,
  decodeJsonPayload,
  decodeTunnelFrame,
  encodeJsonPayload,
  encodeTunnelFrame,
} from './tunnel-codec.js';
import { createTunnelHost, resolveTargetPort } from './tunnel-host.js';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Minimal EventEmitter-shaped fake used only by createTunnelHost tests. */
class FakeWebSocket {
  static OPEN = 1;

  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.protocol = '';
    this.readyState = FakeWebSocket.OPEN;
    /** @type {Map<string, Function[]>} */
    this.handlers = new Map();
    FakeWebSocket.instances.push(this);
  }

  static instances = [];

  static reset() {
    FakeWebSocket.instances = [];
  }

  on(event, handler) {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  emit(event, ...args) {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...args);
    }
  }

  send() {}
  close() {}
  terminate() {}
}

const waitFor = async (predicate, { timeoutMs = 2000, intervalMs = 5 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitFor timed out');
};

describe('createTunnelHost WS fragment ordering', () => {
  it('keeps large then small WS text messages non-interleaved on one stream', async () => {
    FakeWebSocket.reset();

    /** @type {Uint8Array[]} */
    const outbound = [];
    // Async sendFrame is required to surface the race: each fragment awaits
    // before the next, so a second message handler can interleave.
    const sendFrame = async (frame) => {
      await Promise.resolve();
      outbound.push(frame);
    };

    const host = createTunnelHost({
      connectionId: 'test-conn',
      getLocalPort: () => 9,
      sendFrame,
      getBufferedAmount: () => 0,
      createWebSocket: (url, protocols) => new FakeWebSocket(url, protocols),
    });

    const streamId = 1;
    await host.handleFrame(encodeTunnelFrame(
      TunnelFrameType.WsOpen,
      streamId,
      encodeJsonPayload({
        path: '/api/event/ws',
        query: '',
      }),
    ));

    expect(FakeWebSocket.instances.length).toBe(1);
    const socket = FakeWebSocket.instances[0];

    socket.emit('open');
    await waitFor(() => outbound.some((frame) => decodeTunnelFrame(frame).frameType === TunnelFrameType.WsOpened));

    const largeMessage = 'L'.repeat(927_161);
    const secondMessage = 'second-message-after-large';

    // Fire both messages synchronously so the second handler starts while the
    // first fragment loop is still awaiting async sendFrame.
    socket.emit('message', Buffer.from(largeMessage, 'utf8'), false);
    socket.emit('message', Buffer.from(secondMessage, 'utf8'), false);

    const largeUtf8 = textEncoder.encode(largeMessage);
    const expectedFragmentFrames = Math.ceil(largeUtf8.length / MAX_TUNNEL_PAYLOAD_BYTES) + 1; // +1 for second msg
    await waitFor(() => {
      const wsTextFrames = outbound.filter((frame) => decodeTunnelFrame(frame).frameType === TunnelFrameType.WsText);
      return wsTextFrames.length >= expectedFragmentFrames;
    });

    // Drain any remaining microtasks from concurrent send loops.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const assembler = createFragmentAssembler();
    /** @type {string[]} */
    const reassembled = [];
    for (const raw of outbound) {
      const frame = decodeTunnelFrame(raw);
      if (frame.frameType !== TunnelFrameType.WsText || frame.streamId !== streamId) continue;
      const message = assembler.push(frame);
      if (message !== null) {
        reassembled.push(textDecoder.decode(message));
      }
    }

    expect(reassembled).toEqual([largeMessage, secondMessage]);

    host.close();
  });

  it('continues WS outbound after one sendFrame rejection without unhandled rejection', async () => {
    FakeWebSocket.reset();

    /** @type {Uint8Array[]} */
    const outbound = [];
    let rejectNextWsText = true;
    /** @type {unknown[]} */
    const unhandled = [];
    const onUnhandledRejection = (reason) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const sendFrame = async (frame) => {
        const decoded = decodeTunnelFrame(frame);
        if (decoded.frameType === TunnelFrameType.WsText && rejectNextWsText) {
          rejectNextWsText = false;
          throw new Error('simulated sendFrame failure');
        }
        outbound.push(frame);
      };

      const host = createTunnelHost({
        connectionId: 'test-conn',
        getLocalPort: () => 9,
        sendFrame,
        getBufferedAmount: () => 0,
        createWebSocket: (url, protocols) => new FakeWebSocket(url, protocols),
      });

      const streamId = 2;
      await host.handleFrame(encodeTunnelFrame(
        TunnelFrameType.WsOpen,
        streamId,
        encodeJsonPayload({
          path: '/api/event/ws',
          query: '',
        }),
      ));

      expect(FakeWebSocket.instances.length).toBe(1);
      const socket = FakeWebSocket.instances[0];

      socket.emit('open');
      await waitFor(() => outbound.some((frame) => decodeTunnelFrame(frame).frameType === TunnelFrameType.WsOpened));

      const firstMessage = 'first-will-fail-send';
      const secondMessage = 'second-must-still-outbound';
      socket.emit('message', Buffer.from(firstMessage, 'utf8'), false);
      socket.emit('message', Buffer.from(secondMessage, 'utf8'), false);

      await waitFor(() => {
        const texts = outbound
          .map((frame) => decodeTunnelFrame(frame))
          .filter((frame) => frame.frameType === TunnelFrameType.WsText && frame.streamId === streamId);
        return texts.some((frame) => textDecoder.decode(frame.payload) === secondMessage);
      });

      // Let any discarded rejecting promise surface as unhandledRejection if present.
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(unhandled).toEqual([]);

      const assembler = createFragmentAssembler();
      /** @type {string[]} */
      const reassembled = [];
      for (const raw of outbound) {
        const frame = decodeTunnelFrame(raw);
        if (frame.frameType !== TunnelFrameType.WsText || frame.streamId !== streamId) continue;
        const message = assembler.push(frame);
        if (message !== null) {
          reassembled.push(textDecoder.decode(message));
        }
      }
      expect(reassembled).toContain(secondMessage);

      host.close();
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });
});

const collectHttpExchange = async (outbound, streamId) => {
  await waitFor(() => outbound.some((frame) => {
    const decoded = decodeTunnelFrame(frame);
    return decoded.streamId === streamId
      && (decoded.frameType === TunnelFrameType.StreamEnd
        || decoded.frameType === TunnelFrameType.StreamAbort);
  }));
  let status = null;
  /** @type {Uint8Array[]} */
  const bodyChunks = [];
  for (const raw of outbound) {
    const frame = decodeTunnelFrame(raw);
    if (frame.streamId !== streamId) continue;
    if (frame.frameType === TunnelFrameType.HttpResponse) {
      status = decodeJsonPayload(frame.payload, (v) => v && typeof v.status === 'number').status;
    } else if (frame.frameType === TunnelFrameType.HttpBody) {
      bodyChunks.push(frame.payload);
    }
  }
  let body = null;
  if (bodyChunks.length > 0) {
    const total = bodyChunks.reduce((n, c) => n + c.length, 0);
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of bodyChunks) {
      merged.set(c, off);
      off += c.length;
    }
    body = JSON.parse(textDecoder.decode(merged));
  }
  return { status, body };
};

describe('createTunnelHost SSH target-port routing', () => {
  /** @type {typeof globalThis.fetch | undefined} */
  let originalFetch;

  afterEach(() => {
    if (originalFetch) {
      globalThis.fetch = originalFetch;
      originalFetch = undefined;
    }
  });

  const installFetchProbe = () => {
    /** @type {{ url: string, headers: Record<string, string> }[]} */
    const calls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      calls.push({
        url: String(url),
        headers: { ...(init?.headers || {}) },
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    return calls;
  };

  it('dials the routing-table port when x-openchamber-target-port is allowed', async () => {
    const fetchCalls = installFetchProbe();
    /** @type {Uint8Array[]} */
    const outbound = [];
    const host = createTunnelHost({
      connectionId: 'test-conn',
      getLocalPort: () => 3000,
      getSshRoutingTable: () => [{ id: 'ssh-1', localPort: 41234 }],
      sendFrame: (frame) => { outbound.push(frame); },
      getBufferedAmount: () => 0,
    });

    const streamId = 11;
    await host.handleFrame(encodeTunnelFrame(
      TunnelFrameType.HttpRequest,
      streamId,
      encodeJsonPayload({
        method: 'GET',
        path: '/health',
        query: '',
        headers: { 'x-openchamber-target-port': '41234', accept: 'application/json' },
      }),
    ));

    const exchange = await collectHttpExchange(outbound, streamId);
    expect(exchange.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe('http://127.0.0.1:41234/health');
    host.close();
  });

  it('returns 503 and does not fall back when target-port is unknown', async () => {
    const fetchCalls = installFetchProbe();
    /** @type {Uint8Array[]} */
    const outbound = [];
    const host = createTunnelHost({
      connectionId: 'test-conn',
      getLocalPort: () => 3000,
      getSshRoutingTable: () => [{ id: 'ssh-1', localPort: 41234 }],
      sendFrame: (frame) => { outbound.push(frame); },
      getBufferedAmount: () => 0,
    });

    const streamId = 12;
    await host.handleFrame(encodeTunnelFrame(
      TunnelFrameType.HttpRequest,
      streamId,
      encodeJsonPayload({
        method: 'GET',
        path: '/health',
        query: '',
        headers: { 'x-openchamber-target-port': '9999' },
      }),
    ));

    const exchange = await collectHttpExchange(outbound, streamId);
    expect(exchange.status).toBe(503);
    expect(exchange.body?.error).toBe('ssh-host-unreachable');
    expect(fetchCalls).toHaveLength(0);
    host.close();
  });

  it('strips x-openchamber-target-port before forwarding to loopback', async () => {
    const fetchCalls = installFetchProbe();
    /** @type {Uint8Array[]} */
    const outbound = [];
    const host = createTunnelHost({
      connectionId: 'test-conn',
      getLocalPort: () => 3000,
      getSshRoutingTable: () => [{ id: 'ssh-1', localPort: 41234 }],
      sendFrame: (frame) => { outbound.push(frame); },
      getBufferedAmount: () => 0,
    });

    const streamId = 13;
    await host.handleFrame(encodeTunnelFrame(
      TunnelFrameType.HttpRequest,
      streamId,
      encodeJsonPayload({
        method: 'GET',
        path: '/api/version',
        query: '',
        headers: {
          'x-openchamber-target-port': '41234',
          authorization: 'Bearer client-token',
        },
      }),
    ));

    await collectHttpExchange(outbound, streamId);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].headers['x-openchamber-target-port']).toBeUndefined();
    expect(fetchCalls[0].headers.authorization).toBe('Bearer client-token');
    expect(fetchCalls[0].headers['x-openchamber-relay-connection']).toBe('test-conn');
    host.close();
  });

  it('dials the default local port when target-port header is absent', async () => {
    const fetchCalls = installFetchProbe();
    /** @type {Uint8Array[]} */
    const outbound = [];
    const host = createTunnelHost({
      connectionId: 'test-conn',
      getLocalPort: () => 3000,
      getSshRoutingTable: () => [{ id: 'ssh-1', localPort: 41234 }],
      sendFrame: (frame) => { outbound.push(frame); },
      getBufferedAmount: () => 0,
    });

    const streamId = 14;
    await host.handleFrame(encodeTunnelFrame(
      TunnelFrameType.HttpRequest,
      streamId,
      encodeJsonPayload({
        method: 'GET',
        path: '/health',
        query: '',
        headers: { accept: 'application/json' },
      }),
    ));

    await collectHttpExchange(outbound, streamId);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe('http://127.0.0.1:3000/health');
    host.close();
  });

  it('WS open dials routing-table port and aborts on miss without fallback', async () => {
    FakeWebSocket.reset();
    /** @type {Uint8Array[]} */
    const outbound = [];
    const host = createTunnelHost({
      connectionId: 'test-conn',
      getLocalPort: () => 3000,
      getSshRoutingTable: () => [{ id: 'ssh-1', localPort: 41234 }],
      sendFrame: (frame) => { outbound.push(frame); },
      getBufferedAmount: () => 0,
      createWebSocket: (url, protocols) => new FakeWebSocket(url, protocols),
    });

    await host.handleFrame(encodeTunnelFrame(
      TunnelFrameType.WsOpen,
      21,
      encodeJsonPayload({
        path: '/api/event/ws',
        query: '',
        headers: { 'x-openchamber-target-port': '41234' },
      }),
    ));
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].url).toBe('ws://127.0.0.1:41234/api/event/ws');

    await host.handleFrame(encodeTunnelFrame(
      TunnelFrameType.WsOpen,
      22,
      encodeJsonPayload({
        path: '/api/event/ws',
        query: '',
        headers: { 'x-openchamber-target-port': '9999' },
      }),
    ));
    // Miss must not open another socket (no fallback to 3000).
    expect(FakeWebSocket.instances).toHaveLength(1);
    await waitFor(() => outbound.some((frame) => {
      const decoded = decodeTunnelFrame(frame);
      return decoded.streamId === 22 && decoded.frameType === TunnelFrameType.StreamAbort;
    }));
    const abort = outbound
      .map((frame) => decodeTunnelFrame(frame))
      .find((frame) => frame.streamId === 22 && frame.frameType === TunnelFrameType.StreamAbort);
    expect(decodeJsonPayload(abort.payload, () => true).reason).toBe('ssh-host-unreachable');
    host.close();
  });
});

describe('resolveTargetPort', () => {
  it('returns default when header is absent and null on table miss', () => {
    const table = () => [{ id: 'ssh-1', localPort: 41234 }];
    expect(resolveTargetPort({}, 3000, table)).toBe(3000);
    expect(resolveTargetPort({ 'x-openchamber-target-port': '41234' }, 3000, table)).toBe(41234);
    expect(resolveTargetPort({ 'X-OpenChamber-Target-Port': '41234' }, 3000, table)).toBe(41234);
    expect(resolveTargetPort({ 'x-openchamber-target-port': '9999' }, 3000, table)).toBeNull();
    expect(resolveTargetPort({ 'x-openchamber-target-port': 'not-a-port' }, 3000, table)).toBeNull();
  });
});
