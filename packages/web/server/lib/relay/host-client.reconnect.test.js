import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { WebSocketServer } from 'ws';

import { startRelayHost } from './host-client.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const startDroppingRelay = () => new Promise((resolve) => {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const openedAt = [];
  wss.on('connection', (ws) => {
    openedAt.push(Date.now());
    ws.close();
  });
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    resolve({
      openedAt,
      url: `ws://127.0.0.1:${port}`,
      stop: () => new Promise((done) => {
        wss.close();
        server.close(() => done());
      }),
    });
  });
});

describe('relay host-client control reconnect', () => {
  let relay;
  let host;

  afterEach(async () => {
    host?.stop();
    host = null;
    await relay?.stop();
    relay = null;
  });

  it('does not reset control reconnect backoff on a brief open', async () => {
    relay = await startDroppingRelay();
    host = startRelayHost({
      relayUrl: relay.url,
      identity: { serverId: 'test-server', hostEncPrivateKey: {}, signRelayAuth: () => ({ ts: 1, sig: 's', pk: 'p' }) },
      getLocalPort: () => 1,
      onStatus: () => {},
      logger: { warn() {}, info() {} },
      reconnectBaseDelayMs: 80,
      reconnectMaxDelayMs: 10_000,
      controlStableMs: 500,
    });

    const deadline = Date.now() + 1_500;
    while (relay.openedAt.length < 3 && Date.now() < deadline) await wait(10);
    expect(relay.openedAt.length).toBeGreaterThanOrEqual(3);

    const firstGap = relay.openedAt[1] - relay.openedAt[0];
    const secondGap = relay.openedAt[2] - relay.openedAt[1];
    expect(firstGap).toBeGreaterThanOrEqual(50);
    expect(secondGap).toBeGreaterThan(firstGap + 20);
  });
});
