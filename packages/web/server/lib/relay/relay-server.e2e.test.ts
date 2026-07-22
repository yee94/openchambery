import { afterEach, describe, expect, it } from 'bun:test';
import crypto from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { createRelayTunnelClient } from '../../../../ui/src/lib/relay/tunnel-client.ts';
import { startRelayHost } from './host-client.js';
import { exportPublicKeyJwk, generateEcdhKeyPair, importEcdhPrivateKey } from './e2ee.js';
import { createRequestSecurityRuntime } from '../security/request-security.js';
import { createUiAuth } from '../ui-auth/ui-auth.js';

const timeoutMs = 10_000;
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

const readStartup = async (process: ReturnType<typeof Bun.spawn>, stderr: { text: string }) => {
  const reader = process.stdout.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const startupTimeout = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`relay did not report startup within ${timeoutMs}ms; stderr: ${stderr.text}`)), timeoutMs);
    });
    while (true) {
      const next = await Promise.race([
        reader.read(),
        process.exited.then((code) => Promise.reject(new Error(`relay exited before startup with code ${code}; stderr: ${stderr.text}`))),
        startupTimeout,
      ]);
      if (next.done) throw new Error(`relay closed stdout before startup; stderr: ${stderr.text}`);
      text += decoder.decode(next.value, { stream: true });
      const newline = text.indexOf('\n');
      if (newline !== -1) return JSON.parse(text.slice(0, newline)) as { status: string; url: string };
    }
  } finally {
    if (timeout) clearTimeout(timeout);
    reader.releaseLock();
  }
};

const startCompiledRelay = async (binary: string, port: number) => {
  const process = Bun.spawn([binary, '--host', '127.0.0.1', '--port', String(port), '--json'], {
    stdout: 'pipe', stderr: 'pipe',
  });
  const stderr = { text: '' };
  void (async () => {
    const reader = process.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) return;
        stderr.text += decoder.decode(next.value, { stream: true });
      }
    } finally {
      reader.releaseLock();
    }
  })();
  try {
    const startup = await readStartup(process, stderr);
    expect(startup.status).toBe('ok');
    return { process, url: startup.url };
  } catch (error) {
    if (process.exitCode === null) process.kill('SIGKILL');
    await process.exited;
    throw error;
  }
};

const stopRelay = async (relay?: { process: ReturnType<typeof Bun.spawn> }) => {
  if (!relay || relay.process.exitCode !== null) return;
  relay.process.kill('SIGTERM');
  const exitCode = await Promise.race([
    relay.process.exited,
    wait(2_000).then(() => undefined),
  ]);
  if (exitCode === undefined) {
    relay.process.kill('SIGKILL');
    await relay.process.exited;
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
  const server = http.createServer((req, rawRes) => {
    void (async () => {
      const res = addResponseAdapter(rawRes);
      const pathname = new URL(req.url ?? '/', 'http://origin').pathname;
      if (pathname === '/auth/url-token' && req.method === 'POST') {
        await uiAuth.handleUrlAuthToken(req, res);
        return;
      }
      if (pathname === '/api/e2e/http' && req.method === 'POST') {
        await uiAuth.requireAuth(req, res, async () => {
          bearerRequests.push(String(req.headers.authorization ?? ''));
          res.json({ body: await readBody(req), hasRelayConnection: Boolean(req.headers['x-openchamber-relay-connection']) });
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
  server.on('upgrade', (req, socket, head) => {
    void (async () => {
      const pathname = new URL(req.url ?? '/', 'http://origin').pathname;
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
    port, bearerRequests, observedOrigins,
    stop: async () => {
      for (const client of wss.clients) client.terminate();
      for (const socket of sockets) socket.destroy();
      await Promise.race([new Promise<void>((resolve) => wss.close(() => resolve())), wait(1_000)]);
      await Promise.race([new Promise<void>((resolve) => server.close(() => resolve())), wait(1_000)]);
      uiAuth.dispose();
    },
  };
};

const waitSocketOpen = (socket: ReturnType<ReturnType<typeof createRelayTunnelClient>['openWebSocket']>) => new Promise<void>((resolve, reject) => {
  socket.onopen = () => resolve();
  socket.onerror = () => reject(new Error('tunneled websocket error'));
  socket.onclose = (event) => reject(new Error(`tunneled websocket closed: ${event.code}`));
});

describe('private relay compiled-process boundary', () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => { await cleanup?.(); cleanup = undefined; });

  it('carries authenticated HTTP, SSE, URL-token WebSocket, restart recovery, and cleanup across compiled Relay', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'openchamber-relay-e2e-'));
    const binary = path.join(temp, 'openchamber-relay');
    let relay: Awaited<ReturnType<typeof startCompiledRelay>> | undefined;
    let origin: Awaited<ReturnType<typeof startOrigin>> | undefined;
    let host: ReturnType<typeof startRelayHost> | undefined;
    let client: ReturnType<typeof createRelayTunnelClient> | undefined;
    cleanup = async () => {
      const results = await Promise.allSettled([Promise.resolve(client?.close()), Promise.resolve(host?.stop()), origin?.stop(), stopRelay(relay)]);
      await rm(temp, { recursive: true, force: true });
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    };
    const relayEntrypoint = fileURLToPath(new URL('../../../../relay-server/bin/openchamber-relay.js', import.meta.url));
    const compile = Bun.spawn(['bun', 'build', '--compile', relayEntrypoint, '--outfile', binary], { stdout: 'pipe', stderr: 'pipe' });
    const compileStderr = new Response(compile.stderr).text();
    const compileExitCode = await compile.exited;
    if (compileExitCode !== 0) throw new Error(`relay compilation failed with code ${compileExitCode}: ${await compileStderr}`);
    const port = await freePort();
    relay = await startCompiledRelay(binary, port);
    origin = await startOrigin();
    const identity = await buildIdentity();
    host = startRelayHost({ relayUrl: relay.url, identity, getLocalPort: () => origin.port, onStatus: () => {}, logger: { warn: () => {}, info: () => {} } });
    client = createRelayTunnelClient({
      relayUrl: relay.url, serverId: identity.serverId, hostEncPubJwk: identity.hostEncPubJwk,
      helloRetryMs: 50, helloTimeoutMs: 2_000, pingIntervalMs: 500, pingTimeoutMs: 250,
      reconnectBaseDelayMs: 50, reconnectMaxDelayMs: 250, batchWindowMs: 5,
    });

    await eventually(() => host!.getStatus().state === 'connected' && client!.getStatus().state === 'connected', 'host and TypeScript client did not connect');
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('stream-')); controller.enqueue(new TextEncoder().encode('body')); controller.close(); },
    });
    const httpResponse = await client.fetch('/api/e2e/http', { method: 'POST', headers: { authorization: 'Bearer client-token' }, body, duplex: 'half' } as RequestInit);
    expect(httpResponse.status).toBe(200);
    expect(await httpResponse.json()).toEqual({ body: 'stream-body', hasRelayConnection: true });

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

    const tokenResponse = await client.fetch('/auth/url-token', { method: 'POST', headers: { authorization: 'Bearer client-token' } });
    const { token } = await tokenResponse.json() as { token: string };
    expect(token).toStartWith('oc_url_');
    const socket = client.openWebSocket(`/api/terminal/ws?oc_url_token=${encodeURIComponent(token)}`);
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
  }, 30_000);
});
