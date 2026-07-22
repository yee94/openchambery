import { expect, it } from 'bun:test';
import http from 'node:http';

import { createPrivateRelayServer } from '../src/index.js';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const close = (server) => new Promise((resolve) => server.close(resolve));

it('rejects a port conflict and leaves a stable stopped snapshot', async () => {
  const blocker = http.createServer();
  await listen(blocker);
  const relay = createPrivateRelayServer({ host: '127.0.0.1', port: blocker.address().port });
  await expect(relay.start()).rejects.toBeDefined();
  expect(relay.getSnapshot()).toMatchObject({ state: 'stopped', sockets: 0, hosts: 0, queuedBytes: 0 });
  await relay.stop();
  await close(blocker);
});

it('shares concurrent startup and settles a start-stop race', async () => {
  const relay = createPrivateRelayServer({ host: '127.0.0.1', port: 0 });
  const first = relay.start();
  const second = relay.start();
  expect(first).toBe(second);
  await Promise.allSettled([first, relay.stop()]);
  expect(relay.getSnapshot()).toMatchObject({ state: 'stopped', sockets: 0, queuedBytes: 0 });
});
