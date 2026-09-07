/**
 * Relay integration evidence for Host reasoning projection (`includeReasoning=false`).
 *
 * Stack (real components, not helper-only stubs):
 * - Layer 1: `@openchambery/relay-server` private relay (real auth gates)
 * - Host: `startRelayHost` + tunnel-host loopback dispatcher
 * - Client: TS `createRelayTunnelClient` (E2EE decrypt on receive)
 * - Origin: Express + `createUiAuth` (bearer) + `registerOpenCodeProxy`
 *   (the real Host SSE/list filtering routes)
 * - Upstream: controllable fake OpenCode (SSE + session.messages)
 *
 * Asserts disabled clients never decrypt reasoning body markers; enabled clients
 * still receive them; Host strips `includeReasoning` before OpenCode; text /
 * tokens.reasoning / session status survive. Synthetic markers only — no real
 * user content or credentials in assertions.
 */

// @ts-nocheck — match relay-server.e2e.test.ts: runtime Vitest/bun-test shim, not tsc project.
import { afterEach, describe, expect, it } from 'bun:test';
import crypto from 'node:crypto';
import express from 'express';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { startPrivateRelayServer } from '../../../../relay-server/src/index.js';
import { createRelayTunnelClient } from '../../../../ui/src/lib/relay/tunnel-client.ts';
import { exportPublicKeyJwk, generateEcdhKeyPair, importEcdhPrivateKey } from './e2ee.js';
import { startRelayHost } from './host-client.js';
import { registerOpenCodeProxy } from '../opencode/proxy.js';
import { createUiAuth } from '../ui-auth/ui-auth.js';

const timeoutMs = 30_000;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const eventually = async (
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeout = timeoutMs,
) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await wait(25);
  }
  throw new Error(message);
};

/** Synthetic neutral markers — never real message text or secrets. */
const TEXT_MARKER = 'syn-text-visible-marker-bbbb';
const REASONING_MARKER = 'syn-reason-hidden-marker-aaaa';
const REASONING_DELTA_PAD = 'x'.repeat(768);
const REASONING_DELTA_COUNT = 128;
const SESSION_STATUS_TYPE = 'session.status';
const TOKEN_REASONING = 42;

const buildIdentity = async () => {
  const enc = await generateEcdhKeyPair();
  const encPrivJwk = await globalThis.crypto.subtle.exportKey('jwk', enc.privateKey);
  const { privateKey: signPriv, publicKey: signPub } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  const signPubJwk = signPub.export({ format: 'jwk' }) as JsonWebKey;
  const canonical = JSON.stringify({
    crv: signPubJwk.crv,
    kty: signPubJwk.kty,
    x: signPubJwk.x,
    y: signPubJwk.y,
  });
  const serverId = crypto.createHash('sha256').update(canonical).digest('base64url');
  return {
    serverId,
    hostEncPubJwk: await exportPublicKeyJwk(enc.publicKey),
    hostEncPrivateKey: await importEcdhPrivateKey(encPrivJwk),
    signRelayAuth: (role: string, connectionId?: string | null) => {
      const ts = Date.now();
      const sig = crypto
        .sign('SHA256', Buffer.from(`${ts}.${serverId}.${role}.${connectionId ?? ''}`), {
          key: signPriv,
          dsaEncoding: 'ieee-p1363',
        })
        .toString('base64url');
      return {
        ts,
        sig,
        pk: Buffer.from(canonical, 'utf8').toString('base64url'),
      };
    },
  };
};

const readResponseText = async (response: Response): Promise<string> => {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length > 0) chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
};

const countOccurrences = (haystack: string, needle: string): number => {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while (true) {
    const found = haystack.indexOf(needle, idx);
    if (found === -1) break;
    count += 1;
    idx = found + needle.length;
  }
  return count;
};

const closeServer = (server?: http.Server | null) =>
  new Promise((resolve, reject) => {
    if (!server) {
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
  });

type UpstreamObservation = {
  urls: string[];
  methods: string[];
};

/**
 * Controllable fake OpenCode: fixed reasoning + text parts/deltas and session status.
 * Records full request URLs so the test can prove includeReasoning never arrives.
 */
const startFakeOpenCode = async (): Promise<{
  port: number;
  observation: UpstreamObservation;
  stop: () => Promise<void>;
}> => {
  const observation: UpstreamObservation = { urls: [], methods: [] };
  const app = express();

  app.use((req, _res, next) => {
    observation.urls.push(req.originalUrl || req.url || '');
    observation.methods.push(req.method || 'GET');
    next();
  });

  app.get('/global/event', (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    // Seed part types so field=text deltas classify correctly on Host filter.
    res.write(
      `id: seed-r\ndata: ${JSON.stringify({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'prt_reason',
            messageID: 'msg_1',
            type: 'reasoning',
            text: REASONING_MARKER,
          },
        },
      })}\n\n`,
    );
    res.write(
      `id: seed-t\ndata: ${JSON.stringify({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'prt_text',
            messageID: 'msg_1',
            type: 'text',
            text: TEXT_MARKER,
          },
        },
      })}\n\n`,
    );

    // High-volume reasoning deltas (field=text on known reasoning part).
    for (let i = 0; i < REASONING_DELTA_COUNT; i += 1) {
      res.write(
        `id: rd-${i}\ndata: ${JSON.stringify({
          type: 'message.part.delta',
          properties: {
            messageID: 'msg_1',
            partID: 'prt_reason',
            field: 'text',
            delta: `${REASONING_MARKER}-${i}-${REASONING_DELTA_PAD}`,
          },
        })}\n\n`,
      );
    }

    // Ordinary text delta must survive filtering.
    res.write(
      `id: td-1\ndata: ${JSON.stringify({
        type: 'message.part.delta',
        properties: {
          messageID: 'msg_1',
          partID: 'prt_text',
          field: 'text',
          delta: `${TEXT_MARKER}-delta`,
        },
      })}\n\n`,
    );

    // Versioned current-style reasoning stream event — must drop when disabled.
    res.write(
      `id: snr-1\ndata: ${JSON.stringify({
        type: 'session.next.reasoning.delta',
        properties: { sessionID: 'ses_1', delta: `${REASONING_MARKER}-snr` },
      })}\n\n`,
    );

    // Session status + message snapshot with tokens.reasoning must keep.
    res.write(
      `id: st-1\ndata: ${JSON.stringify({
        type: SESSION_STATUS_TYPE,
        properties: { sessionID: 'ses_1', status: 'busy' },
      })}\n\n`,
    );
    res.write(
      `id: mu-1\ndata: ${JSON.stringify({
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_1',
            role: 'assistant',
            tokens: { input: 1, output: 2, reasoning: TOKEN_REASONING },
          },
          parts: [
            { id: 'prt_reason', type: 'reasoning', text: REASONING_MARKER },
            { id: 'prt_text', type: 'text', text: TEXT_MARKER },
          ],
        },
      })}\n\n`,
    );

    res.end();
  });

  app.get('/session/:sessionID/message', (req, res) => {
    res.json([
      {
        info: {
          id: 'msg_1',
          role: 'assistant',
          tokens: { input: 3, output: 4, reasoning: TOKEN_REASONING },
        },
        parts: [
          { id: 'prt_reason', type: 'reasoning', text: REASONING_MARKER },
          { id: 'prt_text', type: 'text', text: TEXT_MARKER },
          { id: 'prt_tool', type: 'tool', tool: 'bash' },
        ],
      },
    ]);
  });

  const server = await new Promise<http.Server>((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });
  const port = (server.address() as { port: number }).port;

  return {
    port,
    observation,
    stop: () => closeServer(server),
  };
};

/**
 * OpenChamber origin: real UI auth + real OpenCode proxy (Host filtering boundary).
 * Tunnel-host dials this loopback port.
 */
const startOpenChamberOrigin = async (openCodePort: number) => {
  const clientAuthController = {
    authenticateBearerToken: async (token: string) =>
      token === 'client-token'
        ? { ok: true, clientId: 'device-relay-reason', sessionToken: 'client:device-relay-reason' }
        : { ok: false },
  };
  const uiAuth = createUiAuth({
    requireClientAuth: true,
    clientAuthController: clientAuthController as never,
  });

  const app = express();
  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'openchamber-origin' });
  });

  // Real auth gate before Host proxy routes (parity with remote clients).
  app.use((req, res, next) => {
    if (req.path === '/health') {
      next();
      return;
    }
    void uiAuth.requireAuth(req, res, next);
  });

  registerOpenCodeProxy(app, {
    fs: { promises: { realpath: async (value: string) => value } },
    os: {},
    path: {},
    OPEN_CODE_READY_GRACE_MS: 0,
    SSE_UPSTREAM_CONNECT_TIMEOUT_MS: 5_000,
    SSE_UPSTREAM_STALL_TIMEOUT_MS: 10_000,
    getRuntime: () => ({
      openCodePort,
      isOpenCodeReady: true,
      openCodeNotReadySince: 0,
      isRestartingOpenCode: false,
      openCodeBaseUrl: `http://127.0.0.1:${openCodePort}`,
    }),
    getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer opencode-upstream-token' }),
    buildOpenCodeUrl: (requestPath: string) => {
      const normalized = requestPath.startsWith('/') ? requestPath : `/${requestPath}`;
      return `http://127.0.0.1:${openCodePort}${normalized}`;
    },
    ensureOpenCodeApiPrefix: () => {},
  });

  const server = await new Promise<http.Server>((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });
  const port = (server.address() as { port: number }).port;

  return {
    port,
    stop: async () => {
      await closeServer(server);
      uiAuth.dispose();
    },
  };
};

describe('relay reasoning projection e2e (Host filter over private relay)', () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it(
    'filters reasoning on SSE + session.messages through real relay tunnel while enabled path keeps them',
    { timeout: 90_000 },
    async () => {
      const temp = await mkdtemp(path.join(os.tmpdir(), 'openchamber-relay-reason-'));
      const previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
      process.env.OPENCHAMBER_DATA_DIR = temp;

      let relay: Awaited<ReturnType<typeof startPrivateRelayServer>> | undefined;
      let upstream: Awaited<ReturnType<typeof startFakeOpenCode>> | undefined;
      let origin: Awaited<ReturnType<typeof startOpenChamberOrigin>> | undefined;
      let host: ReturnType<typeof startRelayHost> | undefined;
      let client: ReturnType<typeof createRelayTunnelClient> | undefined;

      cleanup = async () => {
        const results = await Promise.allSettled([
          Promise.resolve(client?.close()),
          Promise.resolve(host?.stop()),
          origin?.stop(),
          upstream?.stop(),
          relay?.stop(),
        ]);
        if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
        else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
        await rm(temp, { recursive: true, force: true });
        const failed = results.find((result) => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      };

      upstream = await startFakeOpenCode();
      origin = await startOpenChamberOrigin(upstream.port);
      relay = await startPrivateRelayServer({ host: '127.0.0.1', port: 0 });
      const relayUrl = relay.wsUrl;
      if (!relayUrl) throw new Error('relay did not expose wsUrl');

      const identity = await buildIdentity();
      host = startRelayHost({
        relayUrl,
        identity,
        getLocalPort: () => origin!.port,
        onStatus: () => {},
        logger: { warn: () => {}, info: () => {} },
      });

      client = createRelayTunnelClient({
        relayUrl,
        serverId: identity.serverId,
        hostEncPubJwk: identity.hostEncPubJwk,
        helloRetryMs: 50,
        helloTimeoutMs: 2_000,
        pingIntervalMs: 500,
        pingTimeoutMs: 250,
        reconnectBaseDelayMs: 50,
        reconnectMaxDelayMs: 250,
        batchWindowMs: 5,
      });

      await eventually(
        () => host!.getStatus().state === 'connected' && client!.getStatus().state === 'connected',
        'host and tunnel client did not connect over private relay',
      );

      const authHeaders = { authorization: 'Bearer client-token' };

      // --- SSE: includeReasoning=false (must go through Host proxy filter) ---
      const disabledSse = await client.fetch('/api/global/event?includeReasoning=false', {
        headers: authHeaders,
      });
      expect(disabledSse.status).toBe(200);
      const disabledSseText = await readResponseText(disabledSse);
      const disabledSseBytes = Buffer.byteLength(disabledSseText, 'utf8');

      // --- SSE: default enabled (byte path keeps reasoning) ---
      const enabledSse = await client.fetch('/api/global/event', {
        headers: authHeaders,
      });
      expect(enabledSse.status).toBe(200);
      const enabledSseText = await readResponseText(enabledSse);
      const enabledSseBytes = Buffer.byteLength(enabledSseText, 'utf8');

      // Disabled: zero reasoning body leakage after tunnel decrypt.
      expect(disabledSseText).not.toContain(REASONING_MARKER);
      expect(disabledSseText).not.toContain('session.next.reasoning');
      expect(disabledSseText).not.toContain('"type":"reasoning"');
      expect(countOccurrences(disabledSseText, REASONING_MARKER)).toBe(0);

      // Disabled: text + session status + tokens.reasoning survive.
      expect(disabledSseText).toContain(TEXT_MARKER);
      expect(disabledSseText).toContain(SESSION_STATUS_TYPE);
      expect(disabledSseText).toContain(`"reasoning":${TOKEN_REASONING}`);
      expect(disabledSseText).toContain('"type":"text"');
      expect(disabledSseText).toContain(`${TEXT_MARKER}-delta`);

      // Enabled: reasoning still present (proves upstream + passthrough path).
      expect(enabledSseText).toContain(REASONING_MARKER);
      expect(enabledSseText).toContain('session.next.reasoning.delta');
      expect(enabledSseText).toContain('"type":"reasoning"');
      expect(countOccurrences(enabledSseText, REASONING_MARKER)).toBeGreaterThanOrEqual(
        REASONING_DELTA_COUNT,
      );
      expect(enabledSseText).toContain(TEXT_MARKER);
      expect(enabledSseText).toContain(SESSION_STATUS_TYPE);

      // Byte comparison: disabled drops the KB-scale reasoning flood.
      expect(enabledSseBytes).toBeGreaterThan(disabledSseBytes);
      expect(enabledSseBytes - disabledSseBytes).toBeGreaterThan(
        REASONING_DELTA_COUNT * 400,
      );

      // Text event parity: both paths keep the ordinary text delta once.
      const disabledTextDeltas = countOccurrences(disabledSseText, `${TEXT_MARKER}-delta`);
      const enabledTextDeltas = countOccurrences(enabledSseText, `${TEXT_MARKER}-delta`);
      expect(disabledTextDeltas).toBe(1);
      expect(enabledTextDeltas).toBe(1);

      // Observable run metrics for coordinator acceptance (synthetic markers only).
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          reasoningDeltaCount: REASONING_DELTA_COUNT,
          reasoningMarkerHitsDisabled: countOccurrences(disabledSseText, REASONING_MARKER),
          reasoningMarkerHitsEnabled: countOccurrences(enabledSseText, REASONING_MARKER),
          disabledSseBytes,
          enabledSseBytes,
          savedBytes: enabledSseBytes - disabledSseBytes,
          disabledTextDeltas,
          enabledTextDeltas,
          upstreamUrlCount: upstream.observation.urls.length,
        }),
      );

      // --- HTTP session.messages list (optional second surface) ---
      const disabledList = await client.fetch(
        '/api/session/ses_1/message?limit=30&includeReasoning=false&directory=%2Frepo',
        { headers: authHeaders },
      );
      expect(disabledList.status).toBe(200);
      const disabledListJson = (await disabledList.json()) as Array<{
        info: { tokens: { reasoning: number } };
        parts: Array<{ type: string; text?: string }>;
      }>;
      expect(disabledListJson[0].info.tokens.reasoning).toBe(TOKEN_REASONING);
      expect(disabledListJson[0].parts.every((p) => p.type !== 'reasoning')).toBe(true);
      expect(JSON.stringify(disabledListJson)).not.toContain(REASONING_MARKER);
      expect(disabledListJson[0].parts.some((p) => p.type === 'text' && p.text === TEXT_MARKER)).toBe(
        true,
      );

      const enabledList = await client.fetch('/api/session/ses_1/message?directory=%2Frepo', {
        headers: authHeaders,
      });
      expect(enabledList.status).toBe(200);
      const enabledListJson = (await enabledList.json()) as Array<{
        parts: Array<{ type: string; text?: string }>;
      }>;
      expect(enabledListJson[0].parts.some((p) => p.type === 'reasoning')).toBe(true);
      expect(JSON.stringify(enabledListJson)).toContain(REASONING_MARKER);

      // Host must strip includeReasoning before OpenCode upstream (all observed URLs).
      expect(upstream.observation.urls.length).toBeGreaterThan(0);
      for (const url of upstream.observation.urls) {
        expect(url).not.toContain('includeReasoning');
      }
      // Sanity: upstream still saw the event + message routes.
      expect(upstream.observation.urls.some((u) => u.includes('/global/event'))).toBe(true);
      expect(upstream.observation.urls.some((u) => u.includes('/session/ses_1/message'))).toBe(
        true,
      );

      // Unauthenticated tunnel request still hits real auth gate (not open).
      const denied = await client.fetch('/api/global/event?includeReasoning=false', {
        headers: { authorization: 'Bearer wrong-token' },
      });
      expect(denied.status).toBe(401);
    },
  );
});
