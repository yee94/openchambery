import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createUiAuth } from '../ui-auth/ui-auth.js';
import { createRemoteClientAuthRuntime } from '../client-auth/remote-clients.js';
import * as fsPromises from 'node:fs/promises';
import { createHostUpdateRuntime } from './runtime.js';
import { registerHostUpdateRoutes } from './routes.js';
import { createTunnelHost } from '../relay/tunnel-host.js';
import { TunnelFrameType, encodeTunnelFrame, encodeJsonPayload, decodeTunnelFrame } from '../relay/tunnel-codec.js';

let directory;
let app;
let runtime;
let adapter;
let token;
let uiAuth;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'host-update-auth-'));
  const clients = createRemoteClientAuthRuntime({ fsPromises, path, crypto, storePath: path.join(directory, 'clients.json') });
  const created = await clients.createClient({ label: 'Test phone', clientKind: 'mobile' });
  token = created.token;
  uiAuth = createUiAuth({ password: null, clientAuthController: clients, readSettingsFromDiskMigrated: async () => ({}) });
  adapter = { host: 'electron', supported: true, inspect: vi.fn(async () => ({ version: '2.0.1', kind: 'ota', releaseNotes: 'Notes', rollback: false })), execute: vi.fn() };
  runtime = createHostUpdateRuntime({ adapter, stateFile: path.join(directory, 'state.json'), currentVersion: '2.0.0', getServerId: async () => 'host-a' });
  app = express();
  registerHostUpdateRoutes(app, { express, runtime, uiAuthController: uiAuth });
});
afterEach(async () => { uiAuth.dispose(); vi.useRealTimers(); await rm(directory, { recursive: true, force: true }); });

it('rejects unauthenticated loopback, forged cookies and URL credentials', async () => {
  for (const url of ['/api/system/update', `/api/system/update?yuri_url_token=${token}`]) {
    expect((await request(app).get(url).set('Cookie', 'yuri_ui_session=forged')).status).toBe(401);
  }
  expect(adapter.inspect).not.toHaveBeenCalled();
});

it('allows paired mobile bearer updates, but rejects malformed, stale and conflicting plans', async () => {
  const plan = await request(app).get('/api/system/update?channel=beta').set('Authorization', `Bearer ${token}`);
  expect(plan.status).toBe(200);
  expect(plan.body).toMatchObject({ channel: 'beta', serverId: 'host-a', update: { kind: 'ota' } });
  expect(plan.headers['cache-control']).toBe('no-store');
  const body = { version: plan.body.update.version, channel: 'beta', planId: plan.body.update.planId };
  expect((await request(app).post('/api/system/update').set('Authorization', `Bearer ${token}`).send({ ...body, version: 'x;evil' })).status).toBe(400);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const accepted = await request(app).post('/api/system/update').set('Authorization', `Bearer ${token}`).send(body);
  expect(accepted.status).toBe(202);
  const duplicate = await request(app).post('/api/system/update').set('Authorization', `Bearer ${token}`).send(body);
  expect(duplicate.body.operation.id).toBe(accepted.body.operation.id);
  const conflict = await request(app).post('/api/system/update').set('Authorization', `Bearer ${token}`).send({ ...body, version: '2.0.2' });
  expect(conflict.status).toBe(409);
  expect(conflict.body.operation.status).toBe('checking');
});

it('keeps the current task visible when update discovery fails', async () => {
  adapter.inspect.mockRejectedValue(new Error('offline'));
  const response = await request(app).get('/api/system/update').set('Authorization', `Bearer ${token}`);
  expect(response.status).toBe(502);
  expect(response.body).toMatchObject({ checkError: 'update_check_failed', operation: null });
});

it('rejects cross-site cookie sessions even with a syntactically valid but unverified bearer', async () => {
  const fake = { enabled: true, resolveAuthContext: vi.fn(async () => ({ type: 'session' })) };
  const secured = express();
  registerHostUpdateRoutes(secured, { express, runtime, uiAuthController: fake });
  const response = await request(secured).post('/api/system/update').set('Origin', 'https://attacker.example').set('Authorization', 'Bearer invalid').send({});
  expect(response.status).toBe(403);
});

it('uses the real Relay dispatcher without injecting credentials for GET and POST', async () => {
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const frames = [];
  const tunnel = createTunnelHost({ connectionId: 'host-update', getLocalPort: () => server.address().port,
    sendFrame: (frame) => { frames.push(decodeTunnelFrame(frame)); }, getBufferedAmount: () => 0 });
  const call = async (stream, method, headers, body) => {
    await tunnel.handleFrame(encodeTunnelFrame(TunnelFrameType.HttpRequest, stream, encodeJsonPayload({ method, path: '/api/system/update', query: '', headers })));
    if (body) await tunnel.handleFrame(encodeTunnelFrame(TunnelFrameType.HttpBody, stream, Buffer.from(JSON.stringify(body))));
    await tunnel.handleFrame(encodeTunnelFrame(TunnelFrameType.StreamEnd, stream, new Uint8Array()));
    await vi.waitFor(() => expect(frames.some((frame) => frame.streamId === stream && frame.frameType === TunnelFrameType.StreamEnd)).toBe(true));
    const own = frames.filter((frame) => frame.streamId === stream);
    const head = JSON.parse(new TextDecoder().decode(own.find((frame) => frame.frameType === TunnelFrameType.HttpResponse).payload));
    const data = JSON.parse(Buffer.concat(own.filter((frame) => frame.frameType === TunnelFrameType.HttpBody).map((frame) => Buffer.from(frame.payload))).toString());
    return { head, data };
  };
  try {
    expect((await call(1, 'GET', {})).head.status).toBe(401);
    const plan = await call(3, 'GET', { authorization: `Bearer ${token}` });
    expect(plan.head.status).toBe(200);
    const accepted = await call(5, 'POST', { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, {
      version: plan.data.update.version, channel: plan.data.channel, planId: plan.data.update.planId,
    });
    expect(accepted.head.status).toBe(202);
    expect((await call(7, 'GET', { authorization: `Bearer ${token}` })).data.operation.id).toBe(accepted.data.operation.id);
    await new Promise((resolve) => setTimeout(resolve, 550));
  } finally { tunnel.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
