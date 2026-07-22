import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Readable } from 'node:stream';
import { createTunnelAuth } from './tunnel-auth.js';
import { registerAuthAndAccessRoutes, registerCommonRequestMiddleware, registerServerStatusRoutes, registerSettingsUtilityRoutes } from './core-routes.js';
import { registerSessionIndexRoutes } from '../session-index/routes.js';
import { registerMessageQueueRoutes } from '../message-queue/routes.js';

describe('core-routes', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries OpenCode startup through the onboarding recovery route', async () => {
    const app = express();
    const retryOpenCodeStartup = vi.fn(async () => {});

    registerSettingsUtilityRoutes(app, {
      readCustomThemesFromDisk: vi.fn(async () => []),
      refreshOpenCodeAfterConfigChange: vi.fn(async () => {}),
      retryOpenCodeStartup,
      clientReloadDelayMs: 100,
    });

    await request(app)
      .post('/api/opencode/retry')
      .expect(200, { success: true });

    expect(retryOpenCodeStartup).toHaveBeenCalledTimes(1);
  });

  it('reports an unavailable OpenCode retry as a service failure', async () => {
    const app = express();
    const error = new Error('OpenCode CLI could not be resolved');
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    registerSettingsUtilityRoutes(app, {
      readCustomThemesFromDisk: vi.fn(async () => []),
      refreshOpenCodeAfterConfigChange: vi.fn(async () => {}),
      retryOpenCodeStartup: vi.fn(async () => {
        throw error;
      }),
      clientReloadDelayMs: 100,
    });

    try {
      await request(app)
        .post('/api/opencode/retry')
        .expect(503, {
          error: 'OpenCode CLI could not be resolved',
          success: false,
        });
    } finally {
      errorLog.mockRestore();
    }
  });

  it('should call gracefulShutdown with exitProcess: true on /api/system/shutdown', async () => {
    const app = express();
    let shutdownOpts = null;
    const dependencies = {
      gracefulShutdown: vi.fn(async (opts) => {
        shutdownOpts = opts;
      }),
      getHealthSnapshot: () => ({ status: 'ok' }),
      openchamberVersion: '1.0.0',
      runtimeName: 'test',
      express,
    };

    registerServerStatusRoutes(app, dependencies);

    await request(app).post('/api/system/shutdown');

    expect(dependencies.gracefulShutdown).toHaveBeenCalled();
    expect(shutdownOpts).toEqual({ exitProcess: true });
  });

  it('should require UI auth before /api/system/shutdown when auth is configured', async () => {
    const app = express();
    const dependencies = {
      gracefulShutdown: vi.fn(async () => {}),
      getHealthSnapshot: () => ({ status: 'ok' }),
      openchamberVersion: '1.0.0',
      runtimeName: 'test',
      express,
      tunnelAuthController: {
        classifyRequestScope: () => 'local',
        requireTunnelSession: vi.fn(),
      },
      uiAuthController: {
        requireAuth: vi.fn((_req, res) => res.status(401).json({ error: 'Unauthorized' })),
      },
    };

    registerServerStatusRoutes(app, dependencies);

    await request(app)
      .post('/api/system/shutdown')
      .expect(401, { error: 'Unauthorized' });

    expect(dependencies.uiAuthController.requireAuth).toHaveBeenCalledTimes(1);
    expect(dependencies.gracefulShutdown).not.toHaveBeenCalled();
  });

  it('should allow authenticated /api/system/shutdown requests', async () => {
    const app = express();
    const dependencies = {
      gracefulShutdown: vi.fn(async () => {}),
      getHealthSnapshot: () => ({ status: 'ok' }),
      openchamberVersion: '1.0.0',
      runtimeName: 'test',
      express,
      tunnelAuthController: {
        classifyRequestScope: () => 'local',
        requireTunnelSession: vi.fn(),
      },
      uiAuthController: {
        requireAuth: vi.fn((_req, _res, next) => next()),
      },
    };

    registerServerStatusRoutes(app, dependencies);

    await request(app)
      .post('/api/system/shutdown')
      .expect(200, { ok: true });

    expect(dependencies.uiAuthController.requireAuth).toHaveBeenCalledTimes(1);
    expect(dependencies.gracefulShutdown).toHaveBeenCalledWith({ exitProcess: true });
  });

  it('should require tunnel auth for tunneled /api/system/shutdown requests', async () => {
    const app = express();
    const dependencies = {
      gracefulShutdown: vi.fn(async () => {}),
      getHealthSnapshot: () => ({ status: 'ok' }),
      openchamberVersion: '1.0.0',
      runtimeName: 'test',
      express,
      tunnelAuthController: {
        classifyRequestScope: () => 'tunnel',
        requireTunnelSession: vi.fn((_req, res) => res.status(401).json({ error: 'Tunnel auth required' })),
      },
      uiAuthController: {
        requireAuth: vi.fn((_req, _res, next) => next()),
      },
    };

    registerServerStatusRoutes(app, dependencies);

    await request(app)
      .post('/api/system/shutdown')
      .expect(401, { error: 'Tunnel auth required' });

    expect(dependencies.tunnelAuthController.requireTunnelSession).toHaveBeenCalledTimes(1);
    expect(dependencies.uiAuthController.requireAuth).not.toHaveBeenCalled();
    expect(dependencies.gracefulShutdown).not.toHaveBeenCalled();
  });

  it('should parse JSON bodies for snippet config routes', async () => {
    const app = express();
    registerCommonRequestMiddleware(app, { express });
    app.post('/api/config/snippets/example', (req, res) => {
      res.json({ body: req.body });
    });

    const response = await request(app)
      .post('/api/config/snippets/example')
      .send({ content: 'Snippet body' })
      .expect(200);

    expect(response.body).toEqual({ body: { content: 'Snippet body' } });
  });

  // Global raw config saves send { content: "<jsonc string>" }. Without this
  // prefix in the JSON middleware allowlist, PUT arrives with an empty body and
  // the handler rejects with "Configuration content must be a string".
  it('should parse JSON bodies for global config routes', async () => {
    const app = express();
    registerCommonRequestMiddleware(app, { express });
    app.put('/api/config/global/oh-my-opencode-slim', (req, res) => {
      res.json({ body: req.body });
    });

    const response = await request(app)
      .put('/api/config/global/oh-my-opencode-slim')
      .send({ content: '{\n  "preset": "openai"\n}' })
      .expect(200);

    expect(response.body).toEqual({
      body: { content: '{\n  "preset": "openai"\n}' },
    });
  });

  it('should parse JSON bodies for Electron session-index writes', async () => {
    const app = express();
    const replaceDirectory = vi.fn();
    registerCommonRequestMiddleware(app, { express });
    registerSessionIndexRoutes(app, {
      sessionIndexService: {
        replaceDirectory,
        snapshot: () => ({ directories: [] }),
        upsert: () => true,
        remove: () => false,
      },
    });

    await request(app)
      .put('/api/openchamber/session-index/directory')
      .send({
        directory: '/repo',
        sessions: [{ id: 'ses_1', title: 'Cached', time: { created: 1, updated: 2 } }],
        cursor: null,
        hasMore: false,
      })
      .expect(204);

    expect(replaceDirectory).toHaveBeenCalledWith({
      directory: '/repo',
      sessions: [{ id: 'ses_1', title: 'Cached', time: { created: 1, updated: 2 } }],
      cursor: null,
      hasMore: false,
    });
  });

  it('should parse JSON bodies for bounded message queue routes', async () => {
    const app = express();
    registerCommonRequestMiddleware(app, { express });
    app.post('/api/openchamber/message-queue/items', (req, res) => {
      res.json({ body: req.body });
    });

    const payload = { requestID: 'request_1', item: { content: 'queued message' } };
    await request(app)
      .post('/api/openchamber/message-queue/items')
      .send(payload)
      .expect(200, { body: payload });
  });

  it('should parse JSON bodies for Assistant routes with the attachment payload parser', async () => {
    const app = express();
    registerCommonRequestMiddleware(app, { express });
    app.post('/api/openchamber/assistants/topics/topic_1/messages', (req, res) => {
      res.json({ body: req.body });
    });

    const payload = { operationID: 'operation_1', parts: [{ type: 'file', mime: 'image/heic', url: 'data:image/heic;base64,aGVsbG8=' }] };
    await request(app)
      .post('/api/openchamber/assistants/topics/topic_1/messages')
      .send(payload)
      .expect(200, { body: payload });
  });

  it('should parse JSON bodies for message queue scope and worktree order updates', async () => {
    const app = express();
    const reorder = vi.fn(() => ({ updated: 'scope' }));
    const setWorktreeOrder = vi.fn(() => ({ updated: 'worktree' }));
    registerCommonRequestMiddleware(app, { express });
    registerMessageQueueRoutes(app, {
      messageQueueService: {
        reorder,
        setWorktreeOrder,
      },
    });

    const scopePayload = { queueItemIDs: ['item_2', 'item_1'], expectedRevision: 4 };
    await request(app)
      .put('/api/openchamber/message-queue/scopes/scope_1/order')
      .send(scopePayload)
      .expect(200, { updated: 'scope' });
    expect(reorder).toHaveBeenCalledWith({ ...scopePayload, scopeID: 'scope_1' });

    const worktreePayload = { projectDirectory: '/repo', worktreePaths: ['/repo/a', '/repo/b'] };
    await request(app)
      .put('/api/openchamber/message-queue/worktrees/order')
      .send(worktreePayload)
      .expect(200, { updated: 'worktree' });
    expect(setWorktreeOrder).toHaveBeenCalledWith(worktreePayload);
  });

  it('should pass message queue upload bytes directly to the upload handler', async () => {
    const app = express();
    const received = [];
    const getAttachmentUpload = vi.fn();
    const markAttachmentReady = vi.fn(() => ({ ready: true }));
    const attachmentStore = {
      writeUpload: vi.fn(async ({ stream, expectedSize, onStored }) => {
        for await (const chunk of stream) received.push(Buffer.from(chunk));
        const object = { storageKey: 'object_1', size: expectedSize }; onStored(object); return object;
      }),
    };
    registerCommonRequestMiddleware(app, { express });
    const getRuntimeKey = vi.fn(() => 'a'.repeat(64));
    registerMessageQueueRoutes(app, {
      messageQueueService: { getAttachmentUpload, markAttachmentReady, getRuntimeKey },
      messageQueueRuntime: { service: { getAttachmentUpload, markAttachmentReady, getRuntimeKey }, attachmentStore },
    });

    const payload = Buffer.from(JSON.stringify({ content: 'a'.repeat(1024 * 1024) }));
    const uploadRequest = request(app)
      .put('/api/openchamber/message-queue/attachments/uploads/upload_1')
      .set('Content-Type', 'application/json')
      .set('Content-Length', String(payload.length))
      .set('x-message-queue-upload-token', 'upload-token');
    uploadRequest.write(payload);
    await uploadRequest.expect(200, { ready: true });

    expect(Buffer.concat(received)).toEqual(payload);
    expect(attachmentStore.writeUpload).toHaveBeenCalledWith(expect.objectContaining({
      uploadID: 'upload_1',
      expectedSize: payload.length,
      stream: expect.anything(),
    }));
    expect(markAttachmentReady).toHaveBeenCalledWith({
      uploadID: 'upload_1',
      uploadToken: 'upload-token',
      objectHash: 'object_1',
      storageKey: 'object_1',
      sizeBytes: payload.length,
    }, { runtimeKey: 'a'.repeat(64) });
  });

  it('should accept relay-safe X-Message-Queue-Content-Length when Content-Length is absent', async () => {
    const app = express();
    const received = [];
    const getAttachmentUpload = vi.fn();
    const markAttachmentReady = vi.fn(() => ({ ready: true }));
    const attachmentStore = {
      writeUpload: vi.fn(async ({ stream, expectedSize, onStored }) => {
        for await (const chunk of stream) received.push(Buffer.from(chunk));
        const object = { storageKey: 'object_2', size: expectedSize }; onStored(object); return object;
      }),
    };
    registerCommonRequestMiddleware(app, { express });
    const getRuntimeKey = vi.fn(() => 'a'.repeat(64));
    registerMessageQueueRoutes(app, {
      messageQueueService: { getAttachmentUpload, markAttachmentReady, getRuntimeKey },
      messageQueueRuntime: { service: { getAttachmentUpload, markAttachmentReady, getRuntimeKey }, attachmentStore },
    });

    const payload = Buffer.from('relay-bytes');
    const uploadRequest = request(app)
      .put('/api/openchamber/message-queue/attachments/uploads/upload_2')
      .set('Content-Type', 'application/octet-stream')
      .set('x-message-queue-content-length', String(payload.length))
      .set('x-message-queue-upload-token', 'upload-token');
    uploadRequest.write(payload);
    await uploadRequest.expect(200, { ready: true });

    expect(Buffer.concat(received)).toEqual(payload);
    expect(attachmentStore.writeUpload).toHaveBeenCalledWith(expect.objectContaining({
      uploadID: 'upload_2',
      expectedSize: payload.length,
    }));
  });

  it('should stream validated message queue attachment content', async () => {
    const app = express();
    const getItemAttachment = vi.fn(() => ({ attachment: { attachmentID: 'attachment_1' }, item: { runtimeKey: 'a'.repeat(64), directory: '/repo' } }));
    const openAttachment = vi.fn(async () => ({ stream: Readable.from([Buffer.from('attachment bytes')]), size: 16, mime: 'text/plain', filename: 'notes.txt' }));
    const getRuntimeKey = vi.fn(() => 'a'.repeat(64));
    registerMessageQueueRoutes(app, { messageQueueService: { getItemAttachment, getRuntimeKey }, messageQueueRuntime: { service: { getItemAttachment, getRuntimeKey }, attachmentStore: { openAttachment } } });
    await request(app).get('/api/openchamber/message-queue/items/item_1/attachments/attachment_1/content').expect('Content-Type', /text\/plain/).expect('Content-Disposition', 'attachment; filename="notes.txt"').expect(200, 'attachment bytes');
    expect(getItemAttachment).toHaveBeenCalledWith('item_1', 'attachment_1', { runtimeKey: 'a'.repeat(64) });
    expect(openAttachment).toHaveBeenCalledWith({ attachmentID: 'attachment_1' }, { runtimeKey: 'a'.repeat(64), directory: '/repo' });
  });

  it('should enforce the 1 MiB JSON limit for similar and other message queue PUT paths', async () => {
    const app = express();
    const reached = vi.fn((_req, res) => res.sendStatus(204));
    registerCommonRequestMiddleware(app, { express });
    app.put('/api/openchamber/message-queue/attachments/uploads/:uploadID/metadata', reached);
    app.put('/api/openchamber/message-queue/items', reached);
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.type }));

    const oversizedJson = JSON.stringify({ content: 'a'.repeat(1024 * 1024) });
    await request(app)
      .put('/api/openchamber/message-queue/attachments/uploads/upload_1/metadata')
      .set('Content-Type', 'application/json')
      .send(oversizedJson)
      .expect(413);
    await request(app)
      .put('/api/openchamber/message-queue/items')
      .set('Content-Type', 'application/json')
      .send(oversizedJson)
      .expect(413);

    expect(reached).not.toHaveBeenCalled();
  });

  it('should allow a queue HTTP envelope in the explicit 70–72 MiB parser margin', async () => {
    const app = express(); const reached = vi.fn((_req, res) => res.sendStatus(204));
    registerCommonRequestMiddleware(app, { express });
    app.post('/api/openchamber/message-queue/items', reached);
    app.post('/api/openchamber/assistants/a/message', reached);
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.type }));
    const body = { content: 'a'.repeat(71 * 1024 * 1024) };
    await request(app).post('/api/openchamber/message-queue/items').send(body).expect(204);
    await request(app).post('/api/openchamber/assistants/a/message').send(body).expect(204);
    expect(reached).toHaveBeenCalledTimes(2);
  });

  it('should reject message queue JSON beyond the 72 MiB HTTP envelope', async () => {
    const app = express(); const reached = vi.fn((_req, res) => res.sendStatus(204));
    registerCommonRequestMiddleware(app, { express });
    app.post('/api/openchamber/message-queue/items', reached);
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.type }));
    const body = { content: 'a'.repeat((72 * 1024 * 1024) + 1) };
    await request(app).post('/api/openchamber/message-queue/items').send(body).expect(413, { error: 'entity.too.large' });
    expect(reached).not.toHaveBeenCalled();
  });

  it('should parse JSON bodies for conversation creation', async () => {
    const app = express();
    registerCommonRequestMiddleware(app, { express });
    app.post('/api/openchamber/conversations', (req, res) => {
      res.json({ body: req.body });
    });

    const payload = {
      input: { type: 'prompt' },
      directory: '/repo',
      messageID: 'msg_1',
    };
    const response = await request(app)
      .post('/api/openchamber/conversations')
      .send(payload)
      .expect(200);

    expect(response.body).toEqual({ body: payload });
  });

  it('should parse conversation attachments larger than 256 KB', async () => {
    const app = express();
    registerCommonRequestMiddleware(app, { express });
    app.post('/api/openchamber/conversations', (req, res) => {
      res.json({ attachmentUrl: req.body.parts?.[0]?.url });
    });

    const url = `data:text/plain;base64,${'a'.repeat(300 * 1024)}`;
    const response = await request(app)
      .post('/api/openchamber/conversations')
      .send({ parts: [{ type: 'file', url }] })
      .expect(200);

    expect(response.body).toEqual({ attachmentUrl: url });
  });

  it('should require API auth before probing loopback preview URLs', async () => {
    const app = express();
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    registerAuthAndAccessRoutes(app, {
      express,
      tunnelAuthController: {
        classifyRequestScope: () => 'local',
        requireTunnelSession: vi.fn(),
        getTunnelSessionFromRequest: vi.fn(),
        clearTunnelSessionCookie: vi.fn(),
        exchangeBootstrapToken: vi.fn(),
      },
      uiAuthController: {
        requireAuth: (_req, res) => res.status(401).json({ error: 'Unauthorized' }),
        handleSessionStatus: vi.fn(),
        handleSessionCreate: vi.fn(),
        handlePasskeyStatus: vi.fn(),
        handlePasskeyAuthenticationOptions: vi.fn(),
        handlePasskeyAuthenticationVerify: vi.fn(),
        handlePasskeyRegistrationOptions: vi.fn(),
        handlePasskeyRegistrationVerify: vi.fn(),
        handlePasskeyList: vi.fn(),
        handlePasskeyRevoke: vi.fn(),
        handleResetAuth: vi.fn(),
      },
      readSettingsFromDiskMigrated: vi.fn(async () => ({})),
      normalizeTunnelSessionTtlMs: vi.fn(),
    });

    try {
      await request(app)
        .post('/api/system/probe-url')
        .send({ url: 'http://127.0.0.1:5173/' })
        .expect(401);

      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should probe loopback preview URLs and return ok: true for status codes 200-599', async () => {
    const app = express();
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    registerAuthAndAccessRoutes(app, {
      express,
      tunnelAuthController: {
        classifyRequestScope: () => 'local',
        requireTunnelSession: vi.fn(),
        getTunnelSessionFromRequest: vi.fn(),
        clearTunnelSessionCookie: vi.fn(),
        exchangeBootstrapToken: vi.fn(),
      },
      uiAuthController: {
        requireAuth: (_req, _res, next) => next(),
        handleSessionStatus: vi.fn(),
        handleSessionCreate: vi.fn(),
        handlePasskeyStatus: vi.fn(),
        handlePasskeyAuthenticationOptions: vi.fn(),
        handlePasskeyAuthenticationVerify: vi.fn(),
        handlePasskeyRegistrationOptions: vi.fn(),
        handlePasskeyRegistrationVerify: vi.fn(),
        handlePasskeyList: vi.fn(),
        handlePasskeyRevoke: vi.fn(),
        handleResetAuth: vi.fn(),
      },
      readSettingsFromDiskMigrated: vi.fn(async () => ({})),
      normalizeTunnelSessionTtlMs: vi.fn(),
    });

    try {
      const testCases = [
        { status: 200, expectedOk: true },
        { status: 302, expectedOk: true },
        { status: 404, expectedOk: true },
        { status: 500, expectedOk: true },
        { status: 600, expectedOk: false },
      ];

      for (const { status, expectedOk } of testCases) {
        fetchMock.mockResolvedValueOnce({
          status,
          ok: status >= 200 && status < 300,
        });

        const response = await request(app)
          .post('/api/system/probe-url')
          .send({ url: 'http://127.0.0.1:5173/' })
          .expect(200);

        expect(response.body).toEqual({ ok: expectedOk, status });
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  const createPairingRouteApp = (overrides = {}) => {
    const app = express();
    const dependencies = {
      express,
      tunnelAuthController: {
        classifyRequestScope: () => 'local',
        requireTunnelSession: vi.fn(),
        getTunnelSessionFromRequest: vi.fn(),
        clearTunnelSessionCookie: vi.fn(),
        exchangeBootstrapToken: vi.fn(),
      },
      uiAuthController: {
        resolveAuthContext: vi.fn(async () => ({ type: 'session', token: 'session-token' })),
        requireAuth: vi.fn((_req, _res, next) => next()),
        requireSessionAuth: vi.fn((_req, _res, next) => next()),
        handleSessionStatus: vi.fn(),
        handleSessionCreate: vi.fn(),
        handleUrlAuthToken: vi.fn(),
        handlePasskeyStatus: vi.fn(),
        handlePasskeyAuthenticationOptions: vi.fn(),
        handlePasskeyAuthenticationVerify: vi.fn(),
        handlePasskeyRegistrationOptions: vi.fn(),
        handlePasskeyRegistrationVerify: vi.fn(),
        handlePasskeyList: vi.fn(),
        handlePasskeyRevoke: vi.fn(),
        handleResetAuth: vi.fn(),
      },
      remoteClientAuthRuntime: {
        listClients: vi.fn(async () => []),
        createClient: vi.fn(),
        revokeClient: vi.fn(),
        purgeRevokedClients: vi.fn(),
      },
      clientPairingRuntime: {
        createPairingSession: vi.fn(async () => ({ pairing: { id: 'pair_1', secret: 'secret', expiresAt: '2099-01-01T00:00:00.000Z', fingerprint: 'ABCD-1234' } })),
        cancelPairingSession: vi.fn(async () => ({ cancelled: true })),
        redeemPairingSession: vi.fn(async () => ({
          pairing: { fingerprint: 'ABCD-1234' },
          client: { id: 'client-1', label: 'Phone', authMethod: 'pairing' },
          token: 'oc_client_token',
        })),
      },
      readSettingsFromDiskMigrated: vi.fn(async () => ({})),
      normalizeTunnelSessionTtlMs: vi.fn(),
      ...overrides,
    };
    registerAuthAndAccessRoutes(app, dependencies);
    return { app, dependencies };
  };

  it('creates pairing sessions behind owner auth and returns no-store payload data', async () => {
    const { app, dependencies } = createPairingRouteApp();

    const response = await request(app)
      .post('/api/client-auth/pairing/sessions')
      .set('Host', 'runtime.example')
      .send({ label: 'Pair phone', allowedClientKinds: ['mobile'] })
      .expect(201);

    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.pairing).toMatchObject({ id: 'pair_1', secret: 'secret' });
    expect(response.body.server.candidates).toEqual([{ type: 'lan', url: 'http://runtime.example', priority: 10 }]);
    expect(dependencies.clientPairingRuntime.createPairingSession).toHaveBeenCalledWith({
      label: 'Pair phone',
      allowedClientKinds: ['mobile'],
      createdByClientId: null,
      usesRelay: false,
    });
  });

  it('advertises the caller-supplied serverUrl as the direct candidate over the request origin', async () => {
    const { app } = createPairingRouteApp();

    const response = await request(app)
      .post('/api/client-auth/pairing/sessions')
      .set('Host', 'runtime.example')
      .send({ label: 'Pair phone', serverUrl: 'http://192.168.1.20:2606' })
      .expect(201);

    expect(response.body.server.candidates).toEqual([
      { type: 'lan', url: 'http://192.168.1.20:2606', priority: 10 },
    ]);
  });

  it('folds in a relay candidate when the host relay is enabled', async () => {
    const relayCandidate = {
      type: 'relay',
      relayUrl: 'wss://relay.example/ws',
      serverId: 'srv_1',
      hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'aaa', y: 'bbb' },
      priority: 30,
    };
    const { app } = createPairingRouteApp({ getRelayPairingCandidate: vi.fn(async () => relayCandidate) });

    const response = await request(app)
      .post('/api/client-auth/pairing/sessions')
      .set('Host', 'runtime.example')
      .send({ label: 'Pair phone' })
      .expect(201);

    expect(response.body.server.candidates).toEqual([
      { type: 'lan', url: 'http://runtime.example', priority: 10 },
      relayCandidate,
    ]);
  });

  it('still returns the direct candidate when the relay candidate lookup throws', async () => {
    const { app } = createPairingRouteApp({
      getRelayPairingCandidate: vi.fn(async () => { throw new Error('relay status read failed'); }),
    });

    const response = await request(app)
      .post('/api/client-auth/pairing/sessions')
      .set('Host', 'runtime.example')
      .send({ label: 'Pair phone' })
      .expect(201);

    expect(response.body.server.candidates).toEqual([{ type: 'lan', url: 'http://runtime.example', priority: 10 }]);
  });

  it('requires owner auth before creating or cancelling pairing sessions', async () => {
    const { app, dependencies } = createPairingRouteApp({
      uiAuthController: {
        resolveAuthContext: vi.fn(async () => null),
        requireAuth: vi.fn((_req, res) => res.status(401).json({ error: 'Unauthorized' })),
        requireSessionAuth: vi.fn((_req, res) => res.status(401).json({ error: 'Unauthorized' })),
      },
    });

    await request(app).post('/api/client-auth/pairing/sessions').send({}).expect(401);
    await request(app).delete('/api/client-auth/pairing/sessions/pair_1').expect(401);
    expect(dependencies.clientPairingRuntime.createPairingSession).not.toHaveBeenCalled();
    expect(dependencies.clientPairingRuntime.cancelPairingSession).not.toHaveBeenCalled();
  });

  it('redeems pairing sessions with no-store response and generic errors', async () => {
    const { app, dependencies } = createPairingRouteApp();

    const response = await request(app)
      .post('/api/client-auth/pairing/redeem')
      .set('Host', 'runtime.example')
      .send({ pairingId: 'pair_1', secret: 'secret', clientKind: 'mobile', deviceName: 'Phone' })
      .expect(200);

    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({
      ok: true,
      server: { label: 'OpenChamber', url: 'http://runtime.example', fingerprint: 'ABCD-1234' },
      client: { id: 'client-1', authMethod: 'pairing' },
      clientToken: 'oc_client_token',
    });
    expect(dependencies.clientPairingRuntime.redeemPairingSession).toHaveBeenCalledWith(expect.objectContaining({
      pairingId: 'pair_1',
      secret: 'secret',
      clientKind: 'mobile',
      deviceName: 'Phone',
    }));

    dependencies.clientPairingRuntime.redeemPairingSession.mockRejectedValueOnce(new Error('Invalid or expired pairing session'));
    await request(app)
      .post('/api/client-auth/pairing/redeem')
      .send({ pairingId: 'pair_2', secret: 'wrong' })
      .expect(400, { error: 'Invalid or expired pairing session' });
  });

  it('rate limits pairing redeem attempts by socket address and pairingId, then resets after the window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { app, dependencies } = createPairingRouteApp();
    app.set('trust proxy', true);
    dependencies.clientPairingRuntime.redeemPairingSession.mockRejectedValue(new Error('Invalid or expired pairing session'));

    // The X-Forwarded-For headers below are deliberate spoof attempts: the rate
    // limiter buckets by socket address (not forwarded headers), so rotating the
    // header must NOT reset the counter or evade the lockout.
    for (let index = 0; index < 10; index += 1) {
      await request(app)
        .post('/api/client-auth/pairing/redeem')
        .set('X-Forwarded-For', `203.0.113.${index}`)
        .send({ pairingId: 'pair_rate', secret: `wrong-${index}` })
        .expect(400, { error: 'Invalid or expired pairing session' });
    }

    const locked = await request(app)
      .post('/api/client-auth/pairing/redeem')
      .set('X-Forwarded-For', '203.0.113.10')
      .send({ pairingId: 'pair_rate', secret: 'wrong-locked' })
      .expect(429, { error: 'Invalid or expired pairing session' });
    expect(locked.headers['retry-after']).toBe('300');
    expect(dependencies.clientPairingRuntime.redeemPairingSession).toHaveBeenCalledTimes(10);

    vi.setSystemTime(new Date('2026-01-01T00:05:01Z'));
    await request(app)
      .post('/api/client-auth/pairing/redeem')
      .set('X-Forwarded-For', '203.0.113.10')
      .send({ pairingId: 'pair_rate', secret: 'wrong-after-reset' })
      .expect(400, { error: 'Invalid or expired pairing session' });
    expect(dependencies.clientPairingRuntime.redeemPairingSession).toHaveBeenCalledTimes(11);
  });

  it('should let preview proxy credentials reach preview proxy validation', async () => {
    const app = express();
    const requireAuth = vi.fn((_req, res) => res.status(401).type('text/plain').send('Authentication required'));

    registerAuthAndAccessRoutes(app, {
      express,
      tunnelAuthController: {
        classifyRequestScope: () => 'local',
        requireTunnelSession: vi.fn(),
        getTunnelSessionFromRequest: vi.fn(),
        clearTunnelSessionCookie: vi.fn(),
        exchangeBootstrapToken: vi.fn(),
      },
      uiAuthController: {
        requireAuth,
        handleSessionStatus: vi.fn(),
        handleSessionCreate: vi.fn(),
        handlePasskeyStatus: vi.fn(),
        handlePasskeyAuthenticationOptions: vi.fn(),
        handlePasskeyAuthenticationVerify: vi.fn(),
        handlePasskeyRegistrationOptions: vi.fn(),
        handlePasskeyRegistrationVerify: vi.fn(),
        handlePasskeyList: vi.fn(),
        handlePasskeyRevoke: vi.fn(),
        handleResetAuth: vi.fn(),
      },
      readSettingsFromDiskMigrated: vi.fn(async () => ({})),
      normalizeTunnelSessionTtlMs: vi.fn(),
    });

    app.use('/api/preview/proxy', (_req, res) => res.json({ reached: true }));

    await request(app)
      .get('/api/preview/proxy/abc123/?oc_preview_token=preview-secret')
      .expect(200, { reached: true });

    await request(app)
      .get('/api/preview/proxy/abc123/')
      .set('Cookie', 'oc_preview_token=preview-secret')
      .expect(200, { reached: true });

    await request(app)
      .get('/api/preview/proxy/abc123/')
      .expect(401, 'Authentication required');

    expect(requireAuth).toHaveBeenCalledTimes(1);
  });

  it('requires the managed bridge capability independently from UI auth', async () => {
    const app = express();
    const requireAuth = vi.fn((_req, _res, next) => next());
    registerAuthAndAccessRoutes(app, {
      express,
      tunnelAuthController: { classifyRequestScope: () => 'local', requireTunnelSession: vi.fn(), getTunnelSessionFromRequest: vi.fn(), clearTunnelSessionCookie: vi.fn(), exchangeBootstrapToken: vi.fn() },
      uiAuthController: { requireAuth, handleSessionStatus: vi.fn(), handleSessionCreate: vi.fn(), handlePasskeyStatus: vi.fn(), handlePasskeyAuthenticationOptions: vi.fn(), handlePasskeyAuthenticationVerify: vi.fn(), handlePasskeyRegistrationOptions: vi.fn(), handlePasskeyRegistrationVerify: vi.fn(), handlePasskeyList: vi.fn(), handlePasskeyRevoke: vi.fn(), handleResetAuth: vi.fn() },
      readSettingsFromDiskMigrated: vi.fn(async () => ({})), normalizeTunnelSessionTtlMs: vi.fn(),
      authorizeManagedOpenCodeBridgeRequest: (req) => req.originalUrl === '/api/internal/managed-opencode/scheduled-task' && req.method === 'POST' && req.get('x-test-capability') === 'valid',
    });
    app.post('/api/internal/managed-opencode/scheduled-task', (_req, res) => res.json({ reached: true }));
    app.post('/api/other', (_req, res) => res.json({ reached: true }));

    await request(app)
      .post('/api/internal/managed-opencode/scheduled-task')
      .set('x-test-capability', 'valid')
      .expect(200, { reached: true });
    await request(app)
      .post('/api/internal/managed-opencode/scheduled-task')
      .expect(403, { error: 'Forbidden' });
    await request(app)
      .post('/api/internal/managed-opencode/scheduled-task/')
      .expect(403, { error: 'Forbidden' });
    await request(app)
      .post('/API/INTERNAL/MANAGED-OPENCODE/SCHEDULED-TASK')
      .expect(403, { error: 'Forbidden' });
    await request(app).post('/api/other').expect(200, { reached: true });
    expect(requireAuth).toHaveBeenCalledTimes(1);
  });
});

describe('client auth routes', () => {
  const createDependencies = (options = {}) => {
    const clients = [];
    const requireAuth = vi.fn((_req, _res, next) => next());
    const requireSessionAuth = vi.fn((_req, _res, next) => next());
    const resolveAuthContext = vi.fn(options.resolveAuthContext || (async () => ({ type: 'session' })));
    return {
      express,
      tunnelAuthController: {
        classifyRequestScope: () => 'local',
        getTunnelSessionFromRequest: () => null,
        clearTunnelSessionCookie: () => {},
        requireTunnelSession: (_req, _res, next) => next(),
      },
      uiAuthController: {
        handleSessionStatus: (_req, res) => res.json({ authenticated: true }),
        handleSessionCreate: (_req, res) => res.json({ authenticated: true }),
        handlePasskeyStatus: (_req, res) => res.json({ enabled: false }),
        handlePasskeyAuthenticationOptions: (_req, res) => res.json({}),
        handlePasskeyAuthenticationVerify: (_req, res) => res.json({ authenticated: true }),
        requireAuth,
        requireSessionAuth,
        resolveAuthContext,
        handlePasskeyRegistrationOptions: (_req, res) => res.json({}),
        handlePasskeyRegistrationVerify: (_req, res) => res.json({}),
        handlePasskeyList: (_req, res) => res.json({ passkeys: [] }),
        handlePasskeyRevoke: (_req, res) => res.json({ revoked: true }),
        handleResetAuth: (_req, res) => res.json({ cleared: true }),
      },
      remoteClientAuthRuntime: {
        listClients: async () => clients,
        createClient: async ({ label, clientKind }) => {
          const client = {
            id: `client-${clients.length + 1}`,
            label: label || 'Remote client',
            createdAt: 'now',
            lastUsedAt: null,
            revokedAt: null,
            clientKind: clientKind || null,
          };
          clients.push(client);
          return { client, token: 'oc_client_secret' };
        },
        revokeClient: async (id) => {
          const client = clients.find((entry) => entry.id === id);
          if (!client) return { revoked: false };
          client.revokedAt = 'revoked';
          return { revoked: true, client };
        },
        purgeRevokedClients: async () => {
          const before = clients.length;
          for (let index = clients.length - 1; index >= 0; index -= 1) {
            if (clients[index].revokedAt) clients.splice(index, 1);
          }
          return { purged: before - clients.length };
        },
      },
      readSettingsFromDiskMigrated: async () => ({}),
      normalizeTunnelSessionTtlMs: () => 1000,
      testHooks: { clients, requireAuth, requireSessionAuth, resolveAuthContext },
    };
  };

  it('creates, lists, and revokes remote client tokens', async () => {
    const app = express();
    const dependencies = createDependencies();
    registerAuthAndAccessRoutes(app, dependencies);

    const created = await request(app)
      .post('/api/client-auth/clients')
      .send({ label: 'Laptop' });
    expect(created.status).toBe(201);
    expect(created.body.token).toBe('oc_client_secret');
    expect(created.headers['cache-control']).toBe('no-store');

    const listed = await request(app).get('/api/client-auth/clients');
    expect(listed.status).toBe(200);
    expect(listed.body.clients).toHaveLength(1);
    expect(listed.body.clients[0]).not.toHaveProperty('token');

    const revoked = await request(app).delete('/api/client-auth/clients/client-1');
    expect(revoked.status).toBe(200);
    expect(revoked.body.revoked).toBe(true);

    const purged = await request(app).delete('/api/client-auth/clients');
    expect(purged.status).toBe(200);
    expect(purged.body.purged).toBe(1);

    const listedAfterPurge = await request(app).get('/api/client-auth/clients');
    expect(listedAfterPurge.body.clients).toHaveLength(0);
  });

  it('reports current connection candidates with server identity for paired devices', async () => {
    const app = express();
    const relayCandidate = {
      type: 'relay',
      relayUrl: 'wss://relay.example/ws',
      serverId: 'server-abc',
      hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
      priority: 30,
    };
    const dependencies = {
      ...createDependencies({ resolveAuthContext: async () => ({ type: 'client', clientId: 'client-1' }) }),
      getDirectCandidateUrls: () => ['http://192.168.1.20:3000', 'http://10.0.0.5:3000', 'not-a-url'],
      getRelayPairingCandidate: async () => relayCandidate,
      getServerId: async () => 'server-abc',
      getServerLabel: () => 'my-host',
    };
    registerAuthAndAccessRoutes(app, dependencies);

    const response = await request(app).get('/api/client-auth/connection/candidates');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.serverId).toBe('server-abc');
    expect(response.body.label).toBe('my-host');
    expect(response.body.candidates).toEqual([
      { type: 'lan', url: 'http://192.168.1.20:3000', priority: 10 },
      { type: 'lan', url: 'http://10.0.0.5:3000', priority: 10 },
      relayCandidate,
    ]);
  });

  it('omits serverId and relay candidate when unavailable and survives failures', async () => {
    const app = express();
    const dependencies = {
      ...createDependencies(),
      getDirectCandidateUrls: () => {
        throw new Error('scan failed');
      },
      getRelayPairingCandidate: async () => {
        throw new Error('relay status failed');
      },
      getServerId: async () => null,
    };
    registerAuthAndAccessRoutes(app, dependencies);

    const response = await request(app).get('/api/client-auth/connection/candidates');
    expect(response.status).toBe(200);
    expect(response.body).not.toHaveProperty('serverId');
    expect(response.body.candidates).toEqual([]);
  });

  it('scopes non-desktop client credentials to list and revoke only themselves', async () => {
    const app = express();
    let authContext = { type: 'session' };
    const dependencies = createDependencies({
      resolveAuthContext: async () => authContext,
    });
    registerAuthAndAccessRoutes(app, dependencies);

    const current = await request(app)
      .post('/api/client-auth/clients')
      .send({ label: 'OpenChamber Desktop', clientKind: 'desktop-local' });
    const other = await request(app)
      .post('/api/client-auth/clients')
      .send({ label: 'Other device' });

    // A regular (non-desktop-local) client token only sees and manages itself.
    authContext = { type: 'client', clientId: other.body.client.id, client: other.body.client };

    const listed = await request(app).get('/api/client-auth/clients');
    expect(listed.status).toBe(200);
    expect(listed.body.clients).toEqual([other.body.client]);

    const denied = await request(app).delete(`/api/client-auth/clients/${current.body.client.id}`);
    expect(denied.status).toBe(403);
    expect(denied.body.revoked).toBe(false);

    const deniedPurge = await request(app).delete('/api/client-auth/clients');
    expect(deniedPurge.status).toBe(403);

    const revoked = await request(app).delete(`/api/client-auth/clients/${other.body.client.id}`);
    expect(revoked.status).toBe(200);
    expect(revoked.body.revoked).toBe(true);
    expect(revoked.body.client.id).toBe(other.body.client.id);
  });

  it('lets the local desktop client list and revoke every device', async () => {
    const app = express();
    let authContext = { type: 'session' };
    const dependencies = createDependencies({
      resolveAuthContext: async () => authContext,
    });
    registerAuthAndAccessRoutes(app, dependencies);

    const desktop = await request(app)
      .post('/api/client-auth/clients')
      .send({ label: 'OpenChamber Desktop', clientKind: 'desktop-local' });
    const other = await request(app)
      .post('/api/client-auth/clients')
      .send({ label: 'Other device' });

    // The trusted desktop shell client manages all devices like a UI session.
    authContext = { type: 'client', clientId: desktop.body.client.id, client: desktop.body.client };

    const listed = await request(app).get('/api/client-auth/clients');
    expect(listed.status).toBe(200);
    const listedIds = listed.body.clients.map((client) => client.id).sort();
    expect(listedIds).toEqual([desktop.body.client.id, other.body.client.id].sort());

    const revoked = await request(app).delete(`/api/client-auth/clients/${other.body.client.id}`);
    expect(revoked.status).toBe(200);
    expect(revoked.body.revoked).toBe(true);
    expect(revoked.body.client.id).toBe(other.body.client.id);

    const purged = await request(app).delete('/api/client-auth/clients');
    expect(purged.status).toBe(200);
    expect(purged.body.purged).toBe(1);
  });

  it('allows only the local desktop client token to create remote client tokens', async () => {
    const app = express();
    let authContext = { type: 'session' };
    const dependencies = createDependencies({
      resolveAuthContext: async () => authContext,
    });
    registerAuthAndAccessRoutes(app, dependencies);

    const desktop = await request(app)
      .post('/api/client-auth/clients')
      .send({ label: 'OpenChamber Desktop', clientKind: 'desktop-local' });
    const remote = await request(app)
      .post('/api/client-auth/clients')
      .send({ label: 'Phone' });

    authContext = { type: 'client', clientId: remote.body.client.id, client: remote.body.client };
    const denied = await request(app)
      .post('/api/client-auth/clients')
      .send({ label: 'Another phone' });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('Client tokens cannot create remote clients');

    authContext = { type: 'client', clientId: desktop.body.client.id, client: desktop.body.client };
    const created = await request(app)
      .post('/api/client-auth/clients')
      .send({ label: 'Mobile' });
    expect(created.status).toBe(201);
    expect(created.body.client.label).toBe('Mobile');
  });

  it('requires UI-session auth for passkey registration management routes', async () => {
    const app = express();
    const dependencies = createDependencies();
    registerAuthAndAccessRoutes(app, dependencies);

    await request(app).post('/auth/passkey/register/options').expect(200);
    await request(app).post('/auth/passkey/register/verify').expect(200);

    expect(dependencies.testHooks.requireSessionAuth).toHaveBeenCalledTimes(2);
    expect(dependencies.testHooks.requireAuth).not.toHaveBeenCalled();
  });

  it('treats private LAN hosts as local even when a tunnel is active', async () => {
    const app = express();
    const dependencies = createDependencies();
    const tunnelAuthController = createTunnelAuth();
    tunnelAuthController.setActiveTunnel({ tunnelId: 'tunnel-1', publicUrl: 'https://tunnel.example.com' });
    dependencies.tunnelAuthController = tunnelAuthController;
    dependencies.uiAuthController.handlePasskeyStatus = vi.fn((_req, res) => {
      res.json({ enabled: true, hasPasskeys: true, passkeyCount: 1, rpID: 'example.com' });
    });

    registerAuthAndAccessRoutes(app, dependencies);

    await request(app)
      .get('/auth/passkey/status')
      .set('Host', '192.168.1.5:57123')
      .expect(200, { enabled: true, hasPasskeys: true, passkeyCount: 1, rpID: 'example.com' });

    expect(dependencies.uiAuthController.handlePasskeyStatus).toHaveBeenCalledTimes(1);
  });

  it('does not trust a private Host header from a public socket peer', () => {
    const tunnelAuthController = createTunnelAuth();
    tunnelAuthController.setActiveTunnel({ tunnelId: 'tunnel-1', publicUrl: 'https://tunnel.example.com' });

    expect(tunnelAuthController.classifyRequestScope({
      headers: { host: '192.168.1.5:57123' },
      socket: { remoteAddress: '203.0.113.10' },
    })).toBe('unknown-public');
  });
});
