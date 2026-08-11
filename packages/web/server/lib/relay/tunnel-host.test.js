// Regression: when a loopback WS emits a text message larger than
// MAX_TUNNEL_PAYLOAD_BYTES, the host fragments it across multiple tunnel frames.
// If a second WS text message arrives while those fragments are still being
// awaited through async sendFrame, the current implementation starts a second
// concurrent send loop. Fragment frames from both messages then interleave on
// the same streamId, and the client fragment assembler merges them into one
// corrupted payload. This test must stay red until send serialization is fixed.
// Production send path is intentionally not changed here.

import { describe, expect, it } from 'bun:test';

import {
  MAX_TUNNEL_PAYLOAD_BYTES,
  TunnelFrameType,
  createFragmentAssembler,
  decodeTunnelFrame,
  encodeJsonPayload,
  encodeTunnelFrame,
} from './tunnel-codec.js';
import { createTunnelHost } from './tunnel-host.js';

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
