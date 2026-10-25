import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { gzipSync, gunzipSync } from 'node:zlib';

import { createRelayTunnelClient } from '../../../../ui/src/lib/relay/tunnel-client.ts';
import { startRelayHost } from './host-client.js';
import { exportPublicKeyJwk, generateEcdhKeyPair, importEcdhPrivateKey } from './e2ee.js';
import { createRequestSecurityRuntime } from '../security/request-security.js';
import { createUiAuth } from '../ui-auth/ui-auth.js';
import { registerOpenCodeProxy } from '../opencode/proxy.js';
import { createGlobalUiEventBroadcaster } from '../event-stream/runtime.js';
import { opencodeClient } from '../../../../ui/src/lib/opencode/client.ts';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '../../../../ui/src/lib/runtime-url.ts';
import { setRuntimeBearerToken } from '../../../../ui/src/lib/runtime-auth.ts';
import { adoptRelayTunnel, deactivateRelayTunnel } from '../../../../ui/src/lib/relay/runtime-tunnel.ts';
import { acquireRuntimeImage } from '../../../../ui/src/lib/runtime-image-cache.ts';
import { materializeImageBlob } from '../../../../ui/src/components/chat/imageSave.ts';
import { NATIVE_RELAY_ASSET_BRIDGE_KEY } from '../../../../ui/src/lib/relay/native-asset-bridge.ts';
import { readRelayImageDisplayBlob, resetRelayImageStreamForTests } from '../../../../ui/src/lib/relay/relay-image-stream.ts';
import { registerFsRoutes } from '../fs/routes.js';
import { runtimeFetch } from '../../../../ui/src/lib/runtime-fetch.ts';
import { registerTtsRoutes } from '../tts/routes.js';
import { createDictationRuntime } from '../dictation/runtime.js';
import { VolcengineTranscriptionSession } from '../dictation/volcengine-session.js';
import { openRuntimeWebSocket } from '../../../../ui/src/lib/relay/runtime-socket.ts';
import { refreshRuntimeUrlAuthToken } from '../../../../ui/src/lib/runtime-auth.ts';
import { requestSpeechSession } from '../../../../ui/src/lib/voice/direct-session.ts';

const timeoutMs = 10_000;
const previewPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
const initializationSnapshot = { sessions: Array.from({ length: 4000 }, (_, id) => ({
  id: `session-${id}`, title: `Session ${id}`, directory: '/repo/project', time: { created: 1000, updated: 2000 },
})) };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const eventually = async (predicate: () => boolean | Promise<boolean>, message: string, timeout = timeoutMs) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await wait(25);
  }
  throw new Error(message);
};

const freePort = () => new Promise<number>((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close((error) => error ? reject(error) : resolve((address as net.AddressInfo).port));
  });
});

const exited = (child: ChildProcess) => {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return once(child, 'exit').then(([code]) => code as number | null);
};

const readStartup = async (child: ChildProcess, stderr: { text: string }) => {
  const stdout = child.stdout;
  if (!stdout) throw new Error(`relay stdout is not available; stderr: ${stderr.text}`);
  let text = '';
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const startupTimeout = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`relay did not report startup within ${timeoutMs}ms; stderr: ${stderr.text}`)), timeoutMs);
    });
    const reading = (async () => {
      for await (const chunk of stdout) {
        text += Buffer.from(chunk).toString('utf8');
        const newline = text.indexOf('\n');
        if (newline !== -1) return JSON.parse(text.slice(0, newline)) as { status: string; url: string };
      }
      throw new Error(`relay closed stdout before startup; stderr: ${stderr.text}`);
    })();
    return await Promise.race([
      reading,
      exited(child).then((code) => Promise.reject(new Error(`relay exited before startup with code ${code}; stderr: ${stderr.text}`))),
      startupTimeout,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

const startCompiledRelay = async (binary: string, port: number) => {
  const process = spawn(binary, ['--host', '127.0.0.1', '--port', String(port), '--json'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr = { text: '' };
  process.stderr?.on('data', (chunk: Buffer | string) => {
    stderr.text += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  });
  try {
    const startup = await readStartup(process, stderr);
    expect(startup.status).toBe('ok');
    return { process, url: startup.url };
  } catch (error) {
    if (process.exitCode === null) process.kill('SIGKILL');
    await exited(process);
    throw error;
  }
};

const stopRelay = async (relay?: { process: ChildProcess }) => {
  if (!relay || relay.process.exitCode !== null) return;
  relay.process.kill('SIGTERM');
  const exitCode = await Promise.race([
    exited(relay.process),
    wait(2_000).then(() => undefined),
  ]);
  if (exitCode === undefined) {
    relay.process.kill('SIGKILL');
    await exited(relay.process);
    throw new Error('relay did not exit after SIGTERM');
  }
  expect(exitCode).toBe(0);
};

const buildIdentity = async () => {
  const enc = await generateEcdhKeyPair();
  const encPrivJwk = await globalThis.crypto.subtle.exportKey('jwk', enc.privateKey);
  const { privateKey: signPriv, publicKey: signPub } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const signPubJwk = signPub.export({ format: 'jwk' }) as JsonWebKey;
  const canonical = JSON.stringify({ crv: signPubJwk.crv, kty: signPubJwk.kty, x: signPubJwk.x, y: signPubJwk.y });
  const serverId = crypto.createHash('sha256').update(canonical).digest('base64url');
  return {
    serverId,
    hostEncPubJwk: await exportPublicKeyJwk(enc.publicKey),
    hostEncPrivateKey: await importEcdhPrivateKey(encPrivJwk),
    signRelayAuth: (role: string, connectionId?: string | null) => {
      const ts = Date.now();
      const sig = crypto.sign('SHA256', Buffer.from(`${ts}.${serverId}.${role}.${connectionId ?? ''}`), { key: signPriv, dsaEncoding: 'ieee-p1363' }).toString('base64url');
      return { ts, sig, pk: Buffer.from(canonical, 'utf8').toString('base64url') };
    },
  };
};

const addResponseAdapter = (res: http.ServerResponse) => Object.assign(res, {
  status(code: number) { res.statusCode = code; return res; },
  json(payload: unknown) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(payload)); return res; },
});

const readBody = async (req: http.IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
};

const startOrigin = async () => {
  const mediaDirectory = await mkdtemp(path.join(os.tmpdir(), 'relay-video-'));
  const videoPath = path.join(mediaDirectory, 'clip.mp4');
  await fsPromises.writeFile(videoPath, Buffer.from('0123456789'));
  const rawFiles = express();
  registerFsRoutes({ get: (route: string, handler: express.RequestHandler) => { if (route === '/api/fs/raw') rawFiles.get(route, handler); }, post() {}, put() {} }, {
    fsPromises, os, path, spawn, crypto: globalThis.crypto, normalizeDirectoryPath: (value: string) => value,
    resolveProjectDirectory: async () => ({ directory: mediaDirectory }), buildAugmentedPath: () => '',
    resolveGitBinaryForSpawn: () => 'git', yuriUserConfigRoot: mediaDirectory,
  });
  const bearerRequests: string[] = [];
  const observedOrigins: string[] = [];
  const sockets = new Set<net.Socket>();
  const clientAuthController = {
    authenticateBearerToken: async (token: string) => token === 'client-token'
      ? { ok: true, clientId: 'device-1', sessionToken: 'client:device-1' }
      : { ok: false },
  };
  const uiAuth = createUiAuth({ requireClientAuth: true, clientAuthController });
  const requestSecurity = createRequestSecurityRuntime({ readSettingsFromDiskMigrated: async () => ({}) });
  const wss = new WebSocketServer({ noServer: true });
  const proxy = express();
  const speech = express();
  speech.use(express.json());
  registerTtsRoutes(speech, { sayTTSCapability: null });
  const broadcast = createGlobalUiEventBroadcaster({ sseClients: new Set(), wsClients: new Set(), writeSseEvent() {} });
  let hostSubscriptions = 0;
  registerOpenCodeProxy(proxy, {
    fs: { promises: { realpath: async (value: string) => value } }, os: {}, path: {},
    getRuntime: () => ({ isOpenCodeReady: true, openCodePort: 4096 }),
    getOpenCodeAuthHeaders: () => ({}), ensureOpenCodeApiPrefix() {},
    buildOpenCodeUrl: () => `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/fixture-event`,
    subscribeGlobalUiEvent: (emit: (payload: unknown, options: unknown) => void) => {
      hostSubscriptions += 1;
      const remove = broadcast.subscribe(emit);
      let removed = false;
      return () => { if (!removed) { removed = true; hostSubscriptions -= 1; remove(); } };
    },
  });
  const server = http.createServer((req, rawRes) => {
    void (async () => {
      const res = addResponseAdapter(rawRes);
      const pathname = new URL(req.url ?? '/', 'http://origin').pathname;
      if (pathname === '/fixture-event') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"type":"session.execution.started","data":{"sessionID":"ses_relay"}}\n\n');
        await wait(70);
        broadcast({ type: 'session.updated', properties: { info: { id: 'ses_relay', title: 'Relay title', time: { created: 1, updated: 2 } } } }, { directory: '/repo' });
        broadcast({ type: 'yuri:session-metadata', properties: { sessionID: 'ses_relay', metadata: { yuri: { titleRefresh: { isGenerating: false } } } } }, { directory: '/repo' });
        await wait(70);
        res.end();
        return;
      }
      if (pathname === '/api/event') {
        await uiAuth.requireAuth(req, res, () => proxy(req, rawRes));
        return;
      }
      if (pathname === '/api/tts/speak' || pathname === '/api/voice/session' || pathname === '/api/voice/volcengine' || pathname === '/api/voice/settings') {
        await uiAuth.requireAuth(req, res, () => speech(req, rawRes));
        return;
      }
      if (pathname === '/auth/url-token' && req.method === 'POST') {
        await uiAuth.handleUrlAuthToken(req, res);
        return;
      }
      if (pathname === '/api/e2e/http' && req.method === 'POST') {
        await uiAuth.requireAuth(req, res, async () => {
          bearerRequests.push(String(req.headers.authorization ?? ''));
          res.json({ body: await readBody(req), hasRelayConnection: Boolean(req.headers['x-yuri-relay-connection']) });
        });
        return;
      }
      if (pathname === '/api/e2e/initialization' && req.method === 'GET') {
        await uiAuth.requireAuth(req, res, () => res.json(initializationSnapshot));
        return;
      }
      if (pathname === '/api/agent' && req.method === 'GET') {
        await uiAuth.requireAuth(req, res, () => {
          const directory = new URL(req.url ?? '/', 'http://origin').searchParams.get('location[directory]');
          if (directory !== '/remote/worktrees/project/feature' || !req.headers['x-yuri-relay-connection']) {
            res.status(404).json({ _tag: 'LocationNotFoundError', location: { directory }, message: `Location not found: ${directory}` });
            return;
          }
          res.json({ location: { directory }, data: [{ id: 'build', name: 'Remote Build', mode: 'primary' }] });
        });
        return;
      }
      if (pathname === '/api/fs/raw' && req.method === 'GET') {
        await uiAuth.requireAuth(req, res, () => {
          const filePath = new URL(req.url ?? '/', 'http://origin').searchParams.get('path');
          if (filePath === videoPath) { rawFiles(req, rawRes); return; }
          if (filePath !== '/remote/icons-zoom.png' || !req.headers['x-yuri-relay-connection']) {
            res.status(404).end(); return;
          }
          res.writeHead(200, { 'content-type': 'image/png' });
          res.end(previewPng);
        });
        return;
      }
      if (pathname === '/api/e2e/sse' && req.method === 'GET') {
        await uiAuth.requireAuth(req, res, async () => {
          bearerRequests.push(String(req.headers.authorization ?? ''));
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
          res.write('data: one\n\n'); await wait(70);
          res.write('data: two\n\n'); await wait(70);
          res.end('data: three\n\n');
        });
        return;
      }
      res.status(404).end();
    })().catch(() => {
      if (rawRes.headersSent) rawRes.destroy();
      else rawRes.writeHead(500).end();
    });
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const dictation = createDictationRuntime({ app: speech, server, express, uiAuthController: uiAuth,
    isRequestOriginAllowed: requestSecurity.isRequestOriginAllowed,
    rejectWebSocketUpgrade: requestSecurity.rejectWebSocketUpgrade,
  });
  server.on('upgrade', (req, socket, head) => {
    void (async () => {
      const pathname = new URL(req.url ?? '/', 'http://origin').pathname;
      if (pathname === '/api/dictation/ws') return;
      if (pathname !== '/api/terminal/ws' || !await requestSecurity.isRequestOriginAllowed(req)) {
        requestSecurity.rejectWebSocketUpgrade(socket, 403, 'Forbidden');
        return;
      }
      const auth = await uiAuth.resolveAuthContext(req, null);
      if (!auth) {
        requestSecurity.rejectWebSocketUpgrade(socket, 401, 'Unauthorized');
        return;
      }
      observedOrigins.push(String(req.headers.origin ?? ''));
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on('message', (data, binary) => ws.send(data, { binary }));
      });
    })().catch(() => {
      requestSecurity.rejectWebSocketUpgrade(socket, 500, 'Upgrade failed');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port, videoPath, bearerRequests, observedOrigins, getHostSubscriptions: () => hostSubscriptions,
    stop: async () => {
      dictation.stop();
      for (const client of wss.clients) client.terminate();
      for (const socket of sockets) socket.destroy();
      await Promise.race([new Promise<void>((resolve) => wss.close(() => resolve())), wait(1_000)]);
      await Promise.race([new Promise<void>((resolve) => server.close(() => resolve())), wait(1_000)]);
      uiAuth.dispose();
      await rm(mediaDirectory, { recursive: true, force: true });
    },
  };
};

const waitSocketOpen = (socket: ReturnType<ReturnType<typeof createRelayTunnelClient>['openWebSocket']>) => new Promise<void>((resolve, reject) => {
  socket.onopen = () => resolve();
  socket.onerror = () => reject(new Error('tunneled websocket error'));
  socket.onclose = (event) => reject(new Error(`tunneled websocket closed: ${event.code}`));
});

async function verifyStreamingAsrOverRelay() {
  const upstream = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(upstream, 'listening');
  const receivedAudio: Buffer[] = [];
  let finals = 0;
  let closed = 0;
  const reply = (text: string, final = false) => {
    const payload = gzipSync(Buffer.from(JSON.stringify({ result: { text } })));
    const fields = Buffer.alloc(8);
    fields.writeInt32BE(final ? -1 : 1);
    fields.writeUInt32BE(payload.length, 4);
    return Buffer.concat([Buffer.from([0x11, final ? 0x93 : 0x91, 0x11, 0]), fields, payload]);
  };
  upstream.on('connection', (socket, request) => {
    expect(request.headers['x-api-key']).toBe('fixture-asr-key');
    socket.on('close', () => { closed += 1; });
    socket.on('message', (data) => {
      const frame = Buffer.from(data as Buffer);
      if (frame[1] >> 4 === 1) { socket.send(reply('')); return; }
      const final = Boolean(frame[1] & 2);
      if (final) finals += 1;
      else receivedAudio.push(gunzipSync(frame.subarray(8)));
      socket.send(reply(final ? '你好世界。' : '你好', final));
    });
  });
  const connect = VolcengineTranscriptionSession.prototype.connect;
  const redirect = vi.spyOn(VolcengineTranscriptionSession.prototype, 'connect').mockImplementation(function () {
    this.createSocket = (_url: string, options: object) => new WebSocket(`ws://127.0.0.1:${(upstream.address() as net.AddressInfo).port}`, options);
    return connect.call(this);
  });
  let socket: ReturnType<typeof openRuntimeWebSocket> | undefined;
  try {
    const saved = await runtimeFetch('/api/voice/volcengine', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'fixture-asr-key', sttProvider: 'volcengine', asrResourceId: 'volc.seedasr.sauc.duration' }),
    });
    expect(saved.status).toBe(200);
    await refreshRuntimeUrlAuthToken();
    socket = openRuntimeWebSocket(getRuntimeUrlResolver().websocket('/api/dictation/ws'));
    const messages: Array<{ type: string; dictationId?: string; text?: string }> = [];
    socket.onmessage = (event) => { messages.push(JSON.parse(String(event.data))); };
    await waitSocketOpen(socket);
    await eventually(() => messages.some((message) => message.type === 'ready'), 'ASR Relay handshake did not reach ready');
    const send = (message: object) => socket!.send(JSON.stringify(message));
    for (const id of ['finish', 'cancel']) {
      send({ type: 'start', dictationId: id, format: 'audio/pcm;rate=16000;bits=16' });
      await eventually(() => messages.some((message) => message.type === 'ack' && message.dictationId === id), 'ASR start was not acknowledged');
      const pcm = Buffer.alloc(6400); // One 200 ms PCM16 chunk.
      for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(4096, i);
      send({ type: 'chunk', dictationId: id, seq: 0, audio: pcm.toString('base64') });
      await eventually(() => messages.some((message) => message.type === 'partial' && message.dictationId === id && message.text === '你好'), 'No live ASR caption before finish over Relay');
      expect(receivedAudio.at(-1)).toEqual(pcm);
      expect(messages.some((message) => message.type === 'final' && message.dictationId === id)).toBe(false);
      const previouslyClosed = closed;
      send(id === 'finish' ? { type: 'finish', dictationId: id, finalSeq: 0 } : { type: 'cancel', dictationId: id });
      if (id === 'finish') {
        await eventually(() => messages.some((message) => message.type === 'final' && message.text === '你好世界。'), 'Final ASR transcript did not cross Relay');
      }
      await eventually(() => closed > previouslyClosed, 'ASR upstream socket was not cleaned up');
    }
    expect(finals).toBe(1);
    expect(messages.some((message) => message.type === 'final' && message.dictationId === 'cancel')).toBe(false);
  } finally {
    socket?.close();
    redirect.mockRestore();
    for (const connection of upstream.clients) connection.terminate();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
}

describe('private relay compiled-process boundary', () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => { try { await cleanup?.(); } finally { cleanup = undefined; vi.unstubAllEnvs(); } });

  it('carries authenticated HTTP, SSE, URL-token WebSocket, restart recovery, and cleanup across compiled Relay', { timeout: 60_000 }, async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'yuri-relay-e2e-'));
    vi.stubEnv('YURI_DATA_DIR', path.join(temp, 'host-data'));
    const binary = path.join(temp, 'yuri-relay');
    let relay: Awaited<ReturnType<typeof startCompiledRelay>> | undefined;
    let origin: Awaited<ReturnType<typeof startOrigin>> | undefined = undefined;
    let host: ReturnType<typeof startRelayHost> | undefined = undefined;
    let client: ReturnType<typeof createRelayTunnelClient> | undefined = undefined;
    cleanup = async () => {
      const results = await Promise.allSettled([Promise.resolve(client?.close()), Promise.resolve(host?.stop()), origin?.stop(), stopRelay(relay)]);
      await rm(temp, { recursive: true, force: true });
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    };
    const relayEntrypoint = fileURLToPath(new URL('../../../../relay-server/bin/yuri-relay.js', import.meta.url));
    const compile = spawn('bun', ['build', '--compile', relayEntrypoint, '--outfile', binary], { stdio: ['ignore', 'pipe', 'pipe'] });
    let compileStderr = '';
    compile.stderr?.on('data', (chunk: Buffer | string) => {
      compileStderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    const [compileExitCode] = await once(compile, 'exit');
    if (compileExitCode !== 0) throw new Error(`relay compilation failed with code ${compileExitCode}: ${compileStderr}`);
    const port = await freePort();
    relay = await startCompiledRelay(binary, port);
    origin = await startOrigin();
    const identity = await buildIdentity();
    host = startRelayHost({ relayUrl: relay.url, identity, getLocalPort: () => origin.port, onStatus: () => {}, logger: { warn: () => {}, info: () => {} } });
    let receivedBytes = 0;
    client = createRelayTunnelClient({
      relayUrl: relay.url, serverId: identity.serverId, hostEncPubJwk: identity.hostEncPubJwk,
      helloRetryMs: 50, helloTimeoutMs: 2_000, pingIntervalMs: 500, pingTimeoutMs: 250,
      reconnectBaseDelayMs: 50, reconnectMaxDelayMs: 250, batchWindowMs: 5,
      createWireSocket: (url) => {
        const socket = new globalThis.WebSocket(url);
        socket.binaryType = 'arraybuffer';
        const wire = {
          get readyState() { return socket.readyState; },
          send: (data: string | ArrayBuffer | Uint8Array) => socket.send(data as string | ArrayBuffer),
          close: (code?: number, reason?: string) => socket.close(code, reason),
          onopen: null as (() => void) | null,
          onmessage: null as ((event: { data: unknown }) => void) | null,
          onclose: null as ((event: { code: number; reason: string }) => void) | null,
          onerror: null as (() => void) | null,
        };
        socket.onopen = () => wire.onopen?.();
        socket.onmessage = (event) => {
          receivedBytes += typeof event.data === 'string' ? Buffer.byteLength(event.data) : event.data.byteLength;
          wire.onmessage?.({ data: event.data });
        };
        socket.onclose = (event) => wire.onclose?.({ code: event.code, reason: event.reason });
        socket.onerror = () => wire.onerror?.();
        return wire;
      },
    });

    await eventually(() => host!.getStatus().state === 'connected' && client!.getStatus().state === 'connected', 'host and TypeScript client did not connect');
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('stream-')); controller.enqueue(new TextEncoder().encode('body')); controller.close(); },
    });
    const httpResponse = await client.fetch('/api/e2e/http', { method: 'POST', headers: { authorization: 'Bearer client-token' }, body, duplex: 'half' } as RequestInit);
    expect(httpResponse.status).toBe(200);
    expect(await httpResponse.json()).toEqual({ body: 'stream-body', hasRelayConnection: true });

    const beforeSnapshot = receivedBytes;
    const compressed = await client.fetch('/api/e2e/initialization', { headers: { authorization: 'Bearer client-token' } });
    expect(compressed.status).toBe(200);
    expect(await compressed.json()).toEqual(initializationSnapshot);
    expect(receivedBytes - beforeSnapshot).toBeLessThan(Buffer.byteLength(JSON.stringify(initializationSnapshot)) / 4);

    const sseResponse = await client.fetch('/api/e2e/sse', { headers: { authorization: 'Bearer client-token' } });
    const reader = sseResponse.body!.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
    }
    expect(chunks.length).toBeGreaterThan(1);
    expect(new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))))).toBe('data: one\n\ndata: two\n\ndata: three\n\n');

    const denied = await client.fetch('/api/event');
    expect(denied.status).toBe(401);
    const hostEvents = await client.fetch('/api/event', { headers: { authorization: 'Bearer client-token' } });
    expect(hostEvents.status).toBe(200);
    const frames = (await hostEvents.text()).trim().split('\n\n').map((block) => JSON.parse(block.slice(6)));
    expect(frames.map((frame) => (frame.payload ?? frame).type)).toEqual(['session.execution.started', 'session.updated', 'yuri:session-metadata']);
    expect(frames[1]).toMatchObject({ directory: '/repo', payload: { properties: { info: { title: 'Relay title' } } } });
    await eventually(() => origin!.getHostSubscriptions() === 0, 'closed Relay SSE leaked Host subscriber');

    const tokenResponse = await client.fetch('/auth/url-token', { method: 'POST', headers: { authorization: 'Bearer client-token' } });
    const { token } = await tokenResponse.json() as { token: string };
    expect(token.startsWith('yuri_url_')).toBe(true);
    const socket = client.openWebSocket(`/api/terminal/ws?yuri_url_token=${encodeURIComponent(token)}`);
    await waitSocketOpen(socket);
    const messages: Array<string | ArrayBuffer> = [];
    const received = new Promise<void>((resolve) => {
      socket.onmessage = (event) => { messages.push(event.data); if (messages.length === 2) resolve(); };
    });
    socket.send('hello');
    socket.send(new Uint8Array([1, 2, 3]));
    await received;
    expect(messages[0]).toBe('hello');
    expect([...new Uint8Array(messages[1] as ArrayBuffer)]).toEqual([1, 2, 3]);
    socket.close();
    await eventually(() => origin.observedOrigins.length === 1, 'origin did not observe websocket upgrade');
    expect(origin.observedOrigins[0]).toBe(`http://127.0.0.1:${origin.port}`);
    expect(origin.bearerRequests).toEqual(['Bearer client-token', 'Bearer client-token']);

    const stoppedRelay = relay;
    relay = undefined;
    await stopRelay(stoppedRelay);
    relay = await startCompiledRelay(binary, port);
    await eventually(() => host!.getStatus().state === 'connected' && client!.getStatus().state === 'connected', 'host and client did not reconnect after Relay restart');
    const recovered = await client.fetch('/api/e2e/http', { method: 'POST', headers: { authorization: 'Bearer client-token' }, body: 'recovered' });
    expect(await recovered.json()).toEqual({ body: 'recovered', hasRelayConnection: true });
    const previousResolver = getRuntimeUrlResolver();
    try {
      configureRuntimeUrlResolver({ apiBaseUrl: 'http://127.0.0.1:1' });
      opencodeClient.reconnectToRuntimeBaseUrl();
      const sdk = opencodeClient.getSdkClient();
      configureRuntimeUrlResolver({ apiBaseUrl: 'https://relay-runtime.example' });
      setRuntimeBearerToken('client-token');
      adoptRelayTunnel({ relayUrl: relay.url, serverId: identity.serverId, hostEncPubJwk: identity.hostEncPubJwk }, client);
      await verifyStreamingAsrOverRelay();
      // Only the external synthesizer is mocked: runtime routing, auth, Host route,
      // encrypted tunnel and compiled Relay process all remain real.
      const realFetch = globalThis.fetch;
      let upstreamController: ReadableStreamDefaultController<Uint8Array> | undefined;
      let upstreamSignal: AbortSignal | undefined;
      const speechFetch = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
        if (String(input) === 'https://openspeech.bytedance.com/api/v1/sts/token') {
          expect(new Headers(init?.headers).get('X-Api-Key')).toBe('fixture-speech-key');
          const claims = Buffer.from(JSON.stringify({ aud: ['fixture-app'], exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url');
          return Promise.resolve(Response.json({ jwt_token: `header.${claims}.signature` }));
        }
        if (String(input) !== 'https://openspeech.bytedance.com/api/v3/tts/unidirectional') return realFetch(input, init);
        upstreamSignal = init?.signal ?? undefined;
        const signal = upstreamSignal;
        return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            upstreamController = controller;
            controller.enqueue(new TextEncoder().encode('{"code":0,"data":"AABAQA=="}\n'));
            signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
          },
        })));
      });
      try {
        const deniedSpeech = await client.fetch('/api/tts/speak', { method: 'POST' });
        expect(deniedSpeech.status).toBe(401);
        expect((await client.fetch('/api/voice/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"kind":"tts"}' })).status).toBe(401);
        expect((await client.fetch('/api/voice/volcengine')).status).toBe(401);
        expect((await client.fetch('/api/voice/volcengine', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
        const saved = await realFetch(`http://127.0.0.1:${origin.port}/api/voice/settings`, {
          method: 'PUT', headers: { authorization: 'Bearer client-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey: 'fixture-speech-key', voice: 'zh_female_vv_uranus_bigtts', showMessageTTSButtons: true, voiceProvider: 'volcengine', dictationEnabled: true, sttProvider: 'volcengine' }),
        });
        expect(saved.status).toBe(200);
        const mobileSettings = await (await runtimeFetch('/api/voice/settings')).json();
        expect(mobileSettings).toMatchObject({ showMessageTTSButtons: true, voiceProvider: 'volcengine', dictationEnabled: true, sttProvider: 'volcengine' });
        expect(mobileSettings.configured).toBe(true);
        expect(JSON.stringify(mobileSettings)).not.toContain('fixture-speech-key');
        for (const kind of ['asr', 'tts'] as const) {
          const ticket = await requestSpeechSession(kind, new AbortController().signal);
          expect(ticket).toMatchObject({ transport: 'volcengine-direct', appId: 'fixture-app' });
          expect(JSON.stringify(ticket)).not.toContain('fixture-speech-key');
        }
        for (const outcome of ['done', 'error', 'cancel'] as const) {
          upstreamSignal = undefined;
          upstreamController = undefined;
          const abort = new AbortController();
          try {
            const speechResponse = await runtimeFetch('/api/tts/speak', {
              method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, signal: abort.signal,
              body: JSON.stringify({ text: 'Relay speech test' }),
            });
            expect(speechResponse.status).toBe(200);
            expect(speechResponse.headers.get('content-type')).toContain('application/x-ndjson');
            const audioReader = speechResponse.body!.getReader();
            const first = await audioReader.read();
            expect(new TextDecoder().decode(first.value)).toBe('{"type":"audio","data":"AABAQA=="}\n');
            // Upstream has not sent success or EOF, yet PCM is already at the client.
            expect(upstreamSignal?.aborted).toBe(false);
            if (outcome === 'cancel') {
              abort.abort();
              await eventually(() => upstreamSignal?.aborted === true, 'TTS cancellation did not cross Relay to upstream');
              await expect(audioReader.read()).rejects.toThrow();
            } else {
              upstreamController!.enqueue(new TextEncoder().encode(outcome === 'done' ? '{"code":20000000}\n' : '{"code":45000001}\n'));
              upstreamController!.close();
              let tail = '';
              while (true) {
                const part = await audioReader.read();
                if (part.done) break;
                tail += new TextDecoder().decode(part.value);
              }
              expect(JSON.parse(tail)).toMatchObject({ type: outcome });
            }
            audioReader.releaseLock();
          } finally {
            abort.abort();
          }
        }
      } finally {
        speechFetch.mockRestore();
      }
      const agents = await sdk.agent.list({ location: { directory: '/remote/worktrees/project/feature' } });
      expect(agents.data[0].name).toBe('Remote Build');
      const received: Uint8Array[] = [];
      let ended = false;
      let released = false;
      Object.assign(globalThis, { [NATIVE_RELAY_ASSET_BRIDGE_KEY]: {
        openAsset: async ({ assetId }: { assetId: string }) => ({ assetId, url: `yuri-asset://v/${assetId}` }),
        writeChunk: async (_id: string, bytes: Uint8Array) => { received.push(bytes.slice()); },
        endAsset: async () => { ended = true; },
        abortAsset: async () => {},
        releaseAsset: async () => { released = true; },
      } });
      const deniedImage = await client.fetch('/api/fs/raw?path=%2Fremote%2Ficons-zoom.png');
      expect(deniedImage.status).toBe(401);
      for (const intent of ['inline', 'preview'] as const) {
        received.length = 0;
        ended = false;
        released = false;
        const image = await acquireRuntimeImage('/remote/icons-zoom.png', new AbortController().signal, intent);
        expect(image.url).toMatch(/^yuri-asset:\/\/v\//);
        await eventually(() => ended, 'relay image did not finish writing to native bridge');
        expect(Buffer.concat(received)).toEqual(previewPng);
        const savedImage = await readRelayImageDisplayBlob(image.url);
        expect(Buffer.from(await savedImage!.arrayBuffer())).toEqual(previewPng);
        image.release();
        await eventually(() => released, 'native image lease was not released');
      }
      for (const [range, expectedRange, bytes] of [['bytes=0-1', 'bytes 0-1/10', '01'], ['bytes=7-', 'bytes 7-9/10', '789']]) {
        const response = await runtimeFetch('/api/fs/raw', { query: { path: origin.videoPath }, headers: { Range: range } });
        expect(response.status).toBe(206);
        expect(response.headers.get('content-range')).toBe(expectedRange);
        expect(response.headers.get('accept-ranges')).toBe('bytes');
        expect(response.headers.get('content-type')).toBe('video/mp4');
        expect(await response.text()).toBe(bytes);
      }
      const downloadProgress: Array<number | null> = [];
      const savedVideo = await materializeImageBlob({ kind: 'video', sourceUrl: `file://${origin.videoPath}` }, undefined, percent => downloadProgress.push(percent));
      expect(await savedVideo.blob.text()).toBe('0123456789');
      expect(downloadProgress[0]).toBe(0);
      expect(downloadProgress).toContain(99);
      expect(downloadProgress.at(-1)).toBe(100);
      expect(downloadProgress).not.toContain(null);
    } finally {
      resetRelayImageStreamForTests();
      Reflect.deleteProperty(globalThis, NATIVE_RELAY_ASSET_BRIDGE_KEY);
      deactivateRelayTunnel();
      setRuntimeBearerToken(null);
      setRuntimeUrlResolver(previousResolver);
    }
  });
});
