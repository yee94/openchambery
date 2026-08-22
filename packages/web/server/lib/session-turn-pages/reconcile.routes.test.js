import { describe, expect, it, vi } from 'vitest';

import { registerSessionTurnPageRoutes } from './routes.js';

const registry = () => {
  const routes = new Map();
  return {
    app: {
      get: (path, handler) => routes.set(`GET ${path}`, handler),
      put: (path, handler) => routes.set(`PUT ${path}`, handler),
      post: (path, handler) => routes.set(`POST ${path}`, handler),
      delete: (path, handler) => routes.set(`DELETE ${path}`, handler),
    },
    route: (method, path) => routes.get(`${method} ${path}`),
    paths: () => [...routes.keys()],
  };
};

const response = () => ({
  statusCode: 200,
  body: undefined,
  headersSent: false,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    this.headersSent = true;
    return this;
  },
});

const RECONCILE_ROUTE = '/api/openchamber/sessions/:sessionID/messages/reconcile';
const TURN_ROUTE = '/api/openchamber/sessions/:sessionID/messages';

const successPage = (overrides = {}) => ({
  ok: true,
  records: [
    { info: { id: 'msg_u2', role: 'user' }, parts: [{ type: 'text', text: 'hi' }] },
    { info: { id: 'msg_a2', role: 'assistant' }, parts: [{ type: 'text', text: 'ok' }] },
  ],
  anchorFound: true,
  capturedHeadMessageID: 'msg_a2',
  latestHeadMessageID: 'msg_a2',
  continuation: null,
  complete: true,
  resetRequired: false,
  scannedRecords: 2,
  responseBytes: 120,
  ...overrides,
});

describe('registerSessionTurnPageRoutes — reconcile', () => {
  it('registers GET reconcile route alongside the turn-page route', () => {
    const { app, route, paths } = registry();
    registerSessionTurnPageRoutes(app, {
      sessionTurnPageService: { loadPage: vi.fn() },
      sessionReconcileService: { reconcile: vi.fn() },
    });
    expect(route('GET', RECONCILE_ROUTE)).toEqual(expect.any(Function));
    expect(route('GET', TURN_ROUTE)).toEqual(expect.any(Function));
    // Specific reconcile path must be registered (Express match order: more specific first).
    expect(paths()).toContain(`GET ${RECONCILE_ROUTE}`);
  });

  it('rejects missing sessionID', async () => {
    const reconcile = vi.fn();
    const { app, route } = registry();
    registerSessionTurnPageRoutes(app, {
      sessionTurnPageService: { loadPage: vi.fn() },
      sessionReconcileService: { reconcile },
    });
    const res = response();
    await route('GET', RECONCILE_ROUTE)({
      params: { sessionID: '' },
      query: { anchor: 'msg_u1' },
      headers: {},
    }, res);
    expect(res.statusCode).toBe(400);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('rejects first request without anchor or continuation', async () => {
    const reconcile = vi.fn();
    const { app, route } = registry();
    registerSessionTurnPageRoutes(app, {
      sessionTurnPageService: { loadPage: vi.fn() },
      sessionReconcileService: { reconcile },
    });
    const res = response();
    await route('GET', RECONCILE_ROUTE)({
      params: { sessionID: 'ses_1' },
      query: {},
      headers: {},
    }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({
      error: expect.stringMatching(/anchor|continuation|required/i),
    });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('rejects simultaneous anchor and continuation', async () => {
    const reconcile = vi.fn();
    const { app, route } = registry();
    registerSessionTurnPageRoutes(app, {
      sessionTurnPageService: { loadPage: vi.fn() },
      sessionReconcileService: { reconcile },
    });
    const res = response();
    await route('GET', RECONCILE_ROUTE)({
      params: { sessionID: 'ses_1' },
      query: { anchor: 'msg_u1', continuation: 'ocr2.abc.def' },
      headers: {},
    }, res);
    expect(res.statusCode).toBe(400);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('rejects empty or oversize anchor', async () => {
    const reconcile = vi.fn();
    const { app, route } = registry();
    registerSessionTurnPageRoutes(app, {
      sessionTurnPageService: { loadPage: vi.fn() },
      sessionReconcileService: { reconcile },
    });

    for (const anchor of ['', 'x'.repeat(513)]) {
      const res = response();
      await route('GET', RECONCILE_ROUTE)({
        params: { sessionID: 'ses_1' },
        query: { anchor },
        headers: {},
      }, res);
      expect(res.statusCode).toBe(400);
      expect(reconcile).not.toHaveBeenCalled();
      reconcile.mockClear();
    }
  });

  it('passes anchor/directory/continuation to the service and returns success JSON', async () => {
    const reconcile = vi.fn(async () => successPage());
    const { app, route } = registry();
    registerSessionTurnPageRoutes(app, {
      sessionTurnPageService: { loadPage: vi.fn() },
      sessionReconcileService: { reconcile },
    });
    const res = response();

    await route('GET', RECONCILE_ROUTE)({
      params: { sessionID: 'ses_42' },
      query: {
        anchor: 'msg_u2',
        directory: '/repo/project',
      },
      headers: {},
    }, res);

    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: 'ses_42',
      anchor: 'msg_u2',
      directory: '/repo/project',
    }));
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      anchorFound: true,
      capturedHeadMessageID: 'msg_a2',
      latestHeadMessageID: 'msg_a2',
      continuation: null,
      complete: true,
      resetRequired: false,
      scannedRecords: 2,
      responseBytes: 120,
    });
    expect(Array.isArray(res.body.records)).toBe(true);
    expect(res.body.records).toHaveLength(2);
  });

  it('keeps full file parts on reconcile — no slim-v1 projection', async () => {
    const url = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
    const reconcile = vi.fn(async () => successPage({
      records: [{
        info: { id: 'msg_u2', role: 'user' },
        parts: [{ id: 'prt_file', type: 'file', mime: 'image/png', filename: 'shot.png', url }],
      }],
    }));
    const { app, route } = registry();
    registerSessionTurnPageRoutes(app, {
      sessionTurnPageService: { loadPage: vi.fn() },
      sessionReconcileService: { reconcile },
    });
    const res = response();

    await route('GET', RECONCILE_ROUTE)({
      params: { sessionID: 'ses_42' },
      query: { anchor: 'msg_u2' },
      headers: {},
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.partsProjection).toBeUndefined();
    expect(res.body.records[0].parts[0]).toEqual({
      id: 'prt_file',
      type: 'file',
      mime: 'image/png',
      filename: 'shot.png',
      url,
    });
  });

  it('summarizes message diff snapshots while preserving full reconcile parts', async () => {
    const patch = 'diff-body-'.repeat(20_000);
    const reconcile = vi.fn(async () => successPage({
      records: [{
        info: {
          id: 'msg_u2',
          role: 'user',
          summary: {
            diffs: [{
              file: 'src/large.ts',
              status: 'modified',
              additions: 5,
              deletions: 1,
              patch,
            }],
          },
        },
        parts: [{ id: 'prt_1', type: 'text', text: 'full recovery text' }],
      }],
    }));
    const { app, route } = registry();
    registerSessionTurnPageRoutes(app, {
      sessionTurnPageService: { loadPage: vi.fn() },
      sessionReconcileService: { reconcile },
    });
    const res = response();

    await route('GET', RECONCILE_ROUTE)({
      params: { sessionID: 'ses_42' },
      query: { anchor: 'msg_u2' },
      headers: {},
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.records[0].info.summary).toEqual({
      diffCount: 1,
      hasDiffs: true,
    });
    expect(res.body.records[0].info.summary.diffs).toBeUndefined();
    expect(res.body.records[0].parts[0]).toEqual({
      id: 'prt_1',
      type: 'text',
      text: 'full recovery text',
    });
    expect(JSON.stringify(res.body)).not.toContain(patch);
    expect(JSON.stringify(res.body)).not.toContain('src/large.ts');
  });

  it('returns HTTP 200 for resetRequired (anchor lost / budget rebuild)', async () => {
    const reconcile = vi.fn(async () => successPage({
      records: [],
      anchorFound: false,
      resetRequired: true,
      complete: true,
      capturedHeadMessageID: 'msg_a9',
      latestHeadMessageID: 'msg_a9',
    }));
    const { app, route } = registry();
    registerSessionTurnPageRoutes(app, {
      sessionTurnPageService: { loadPage: vi.fn() },
      sessionReconcileService: { reconcile },
    });
    const res = response();

    await route('GET', RECONCILE_ROUTE)({
      params: { sessionID: 'ses_1' },
      query: { anchor: 'msg_gone' },
      headers: {},
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.resetRequired).toBe(true);
    expect(res.body.complete).toBe(true);
  });

  it('maps invalid_continuation to HTTP 400', async () => {
    const reconcile = vi.fn(async () => ({ ok: false, error: 'invalid_continuation' }));
    const { app, route } = registry();
    registerSessionTurnPageRoutes(app, {
      sessionTurnPageService: { loadPage: vi.fn() },
      sessionReconcileService: { reconcile },
    });
    const res = response();

    await route('GET', RECONCILE_ROUTE)({
      params: { sessionID: 'ses_1' },
      query: { continuation: 'ocr2.bad.mac' },
      headers: {},
    }, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({
      error: expect.stringMatching(/continuation|invalid/i),
    });
  });

  it('maps upstream to HTTP 502', async () => {
    const reconcile = vi.fn(async () => ({ ok: false, error: 'upstream' }));
    const { app, route } = registry();
    registerSessionTurnPageRoutes(app, {
      sessionTurnPageService: { loadPage: vi.fn() },
      sessionReconcileService: { reconcile },
    });
    const res = response();

    await route('GET', RECONCILE_ROUTE)({
      params: { sessionID: 'ses_1' },
      query: { anchor: 'msg_u1' },
      headers: {},
    }, res);

    expect(res.statusCode).toBe(502);
    expect(res.body).toMatchObject({ error: expect.stringMatching(/upstream/i) });
  });

  it('maps unavailable to HTTP 503', async () => {
    const reconcile = vi.fn(async () => ({ ok: false, error: 'unavailable' }));
    const { app, route } = registry();
    registerSessionTurnPageRoutes(app, {
      sessionTurnPageService: { loadPage: vi.fn() },
      sessionReconcileService: { reconcile },
    });
    const res = response();

    await route('GET', RECONCILE_ROUTE)({
      params: { sessionID: 'ses_1' },
      query: { anchor: 'msg_u1' },
      headers: {},
    }, res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ error: expect.stringMatching(/unavailable|upstream/i) });
  });

  it('logs full stack on unexpected 500 without auth or message content', async () => {
    const reconcile = vi.fn(async () => {
      throw new Error('boom-internal');
    });
    const warn = vi.fn();
    const error = vi.fn();
    const logger = { warn, error, info: vi.fn() };
    const { app, route } = registry();
    registerSessionTurnPageRoutes(app, {
      sessionTurnPageService: { loadPage: vi.fn() },
      sessionReconcileService: { reconcile },
      logger,
    });
    const res = response();

    await route('GET', RECONCILE_ROUTE)({
      params: { sessionID: 'ses_1' },
      query: { anchor: 'msg_secret_body' },
      headers: {
        authorization: 'Bearer super-secret-token',
      },
    }, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({
      error: expect.stringMatching(/internal|server/i),
    });
    // Client body must not leak internals.
    expect(JSON.stringify(res.body)).not.toMatch(/boom-internal|super-secret|Bearer/);

    const logPayload = JSON.stringify([warn.mock.calls, error.mock.calls]);
    expect(logPayload).toMatch(/boom-internal|Error/);
    expect(logPayload).toMatch(/stack|at /i);
    // Must omit auth headers and message content from logs.
    expect(logPayload).not.toMatch(/super-secret-token|Bearer super-secret/);
    expect(logPayload).not.toMatch(/msg_secret_body/);
  });

  it('forwards AbortSignal into reconcile', async () => {
    const controller = new AbortController();
    const reconcile = vi.fn(async ({ signal }) => {
      expect(signal).toBeTruthy();
      return successPage({ records: [] });
    });
    const { app, route } = registry();
    registerSessionTurnPageRoutes(app, {
      sessionTurnPageService: { loadPage: vi.fn() },
      sessionReconcileService: { reconcile },
    });
    const res = response();

    await route('GET', RECONCILE_ROUTE)({
      params: { sessionID: 'ses_1' },
      query: { anchor: 'msg_u1' },
      headers: {},
      signal: controller.signal,
      aborted: false,
    }, res);

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.calls[0][0].signal).toBeDefined();
    expect(res.statusCode).toBe(200);
  });

  it('maps aborted to HTTP 499', async () => {
    const reconcile = vi.fn(async () => ({ ok: false, error: 'aborted' }));
    const { app, route } = registry();
    registerSessionTurnPageRoutes(app, {
      sessionTurnPageService: { loadPage: vi.fn() },
      sessionReconcileService: { reconcile },
    });
    const res = response();

    await route('GET', RECONCILE_ROUTE)({
      params: { sessionID: 'ses_1' },
      query: { anchor: 'msg_u1' },
      headers: {},
    }, res);

    expect(res.statusCode).toBe(499);
  });
});
