import { expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { createUiAuth } from '../ui-auth/ui-auth.js';
import { createNativeNotificationStream } from './native-stream.js';
import { registerNotificationRoutes } from './routes.js';
import { createTunnelHost } from '../relay/tunnel-host.js';
import { createHostHandshake, exportPublicKeyJwk, generateEcdhKeyPair } from '../relay/e2ee.js';
import { createRelayTunnelClient } from '../../../../ui/src/lib/relay/tunnel-client.ts';

it('carries notification SSE and its replay cursor through the real encrypted tunnel/auth gate with native-compatible framing', async () => {
  const stream = createNativeNotificationStream();
  const auth = createUiAuth({ requireClientAuth: true, clientAuthController: {
    authenticateBearerToken: async (token) => token === 'fixture-token'
      ? { ok: true, clientId: 'fixture', sessionToken: 'client:fixture' } : { ok: false },
  } });
  const app = express();
  app.use('/api', auth.requireAuth);
  registerNotificationRoutes(app, { uiAuthController: auth, connectNativeNotifications: stream.connect });
  const origin = http.createServer(app);
  await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve));
  const wire = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => wire.once('listening', resolve));
  const keys = await generateEcdhKeyPair();
  wire.on('connection', (socket) => {
    const handshake = createHostHandshake(keys.privateKey);
    let channel;
    let incoming = Promise.resolve();
    let outgoing = Promise.resolve();
    const host = createTunnelHost({
      connectionId: 'fixture', getLocalPort: () => origin.address().port, getBufferedAmount: () => socket.bufferedAmount,
      sendFrame: (frame) => {
        outgoing = outgoing.then(async () => socket.send(await channel.encryptor.encrypt(frame)));
        return outgoing;
      },
    });
    socket.on('message', (message, binary) => {
      incoming = incoming.then(async () => {
        if (!binary) {
          const result = await handshake.handleText(message.toString());
          expect(result.type).toBe('established');
          expect(result.batch).toBe(false);
          channel = result.channel;
          socket.send(result.replyText);
        } else await host.handleFrame(await channel.decryptor.decrypt(message));
      }).catch(() => socket.terminate());
    });
    socket.on('close', () => host.close());
  });
  const tunnel = createRelayTunnelClient({
    relayUrl: `ws://127.0.0.1:${wire.address().port}`, serverId: 'fixture', hostEncPubJwk: await exportPublicKeyJwk(keys.publicKey), batch: false,
    createWireSocket: (url) => { const socket = new WebSocket(url); socket.binaryType = 'arraybuffer'; return socket; },
  });
  try {
    expect((await tunnel.fetch('/api/notifications/native-stream', { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
    const first = await tunnel.fetch('/api/notifications/native-stream', { headers: { Authorization: 'Bearer fixture-token' } });
    expect(first.status).toBe(200);
    const reader = first.body.getReader();
    const ready = new TextDecoder().decode((await reader.read()).value);
    expect(ready).toContain('"type":"ready"');
    const cursor = ready.match(/id: ([^\n]+)/)[1];
    await reader.cancel();
    stream.publish({ title: 'Needs your answer', kind: 'question', body: '测试会话', sessionId: 'root' });
    const resumed = await tunnel.fetch('/api/notifications/native-stream', { headers: { Authorization: 'Bearer fixture-token', 'Last-Event-ID': cursor, 'Accept-Language': 'zh-CN' } });
    const resumedReader = resumed.body.getReader();
    let text = '';
    while (!text.includes('"type":"ready"')) text += new TextDecoder().decode((await resumedReader.read()).value);
    expect(text).toContain('"title":"需要你回答"');
    expect(text).toContain('"body":"测试会话"');
    expect(text).toContain('"gap":false');
    await resumedReader.cancel();
  } finally {
    tunnel.close();
    for (const socket of wire.clients) socket.terminate();
    await new Promise((resolve) => wire.close(resolve));
    origin.closeAllConnections();
    await new Promise((resolve) => origin.close(resolve));
    auth.dispose();
  }
}, 10_000);
