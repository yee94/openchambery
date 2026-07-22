import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';

import { createPrivateRelayServer } from '../src/index.js';

const once = (emitter, name) => new Promise((resolve) => emitter.once(name, (...args) => resolve(args)));
const eventually = async (check) => {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(check(), true);
};

const relay = createPrivateRelayServer({ host: '127.0.0.1', port: 0, limits: { maxRawSockets: 1, maxRawSocketsPerIp: 1, handshakeMs: 1_000 } });
await relay.start();
const port = relay.address().port;
try {
  const first = net.connect(port, '127.0.0.1'); await once(first, 'connect'); await eventually(() => relay.getSnapshot().rawSockets === 1);
  const excess = net.connect(port, '127.0.0.1'); await once(excess, 'connect'); await once(excess, 'close'); assert.ok(relay.getSnapshot().rawSockets <= 1);
  first.destroy(); await once(first, 'close'); await eventually(() => relay.getSnapshot().rawSockets === 0);
  const third = net.connect(port, '127.0.0.1'); await once(third, 'connect'); await eventually(() => relay.getSnapshot().rawSockets === 1);
  third.destroy(); await once(third, 'close');
} finally {
  await relay.stop();
}
assert.equal(relay.getSnapshot().rawSockets, 0);
const replacement = http.createServer();
await new Promise((resolve) => replacement.listen(port, '127.0.0.1', resolve));
await new Promise((resolve) => replacement.close(resolve));
