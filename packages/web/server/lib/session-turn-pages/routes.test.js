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
  };
};

const response = () => ({
  statusCode: 200,
  body: undefined,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
});

const ROUTE = '/api/openchamber/sessions/:sessionID/messages';

describe('registerSessionTurnPageRoutes', () => {
  it('registers GET /api/openchamber/sessions/:sessionID/messages', () => {
    const { app, route } = registry();
    registerSessionTurnPageRoutes(app, {
      sessionTurnPageService: { loadPage: vi.fn() },
    });
    expect(route('GET', ROUTE)).toEqual(expect.any(Function));
  });

  it('rejects turns outside 1..10', async () => {
    const loadPage = vi.fn();
    const { app, route } = registry();
    registerSessionTurnPageRoutes(app, { sessionTurnPageService: { loadPage } });
    const handler = route('GET', ROUTE);

    for (const turns of ['0', '11', '-1', 'abc', '']) {
      const res = response();
      await handler({
        params: { sessionID: 'ses_1' },
        query: { turns },
        headers: {},
      }, res);
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
      expect(loadPage).not.toHaveBeenCalled();
      loadPage.mockClear();
    }
  });

  it('rejects scanLimit outside 10..200', async () => {
    const loadPage = vi.fn();
    const { app, route } = registry();
    registerSessionTurnPageRoutes(app, { sessionTurnPageService: { loadPage } });
    const handler = route('GET', ROUTE);

    for (const scanLimit of ['9', '201', '0', 'nope']) {
      const res = response();
      await handler({
        params: { sessionID: 'ses_1' },
        query: { turns: '3', scanLimit },
        headers: {},
      }, res);
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
      expect(loadPage).not.toHaveBeenCalled();
      loadPage.mockClear();
    }
  });

  it('passes turns, scanLimit, before, and directory to the service and returns success JSON', async () => {
    const loadPage = vi.fn(async () => ({
      ok: true,
      records: [
        { info: { id: 'msg_u1', role: 'user' }, parts: [{ type: 'text', text: 'hi' }] },
        { info: { id: 'msg_a1', role: 'assistant' }, parts: [{ type: 'text', text: 'ok' }] },
      ],
      turnCount: 1,
      cursor: 'msg_u1',
      complete: false,
    }));
    const { app, route } = registry();
    registerSessionTurnPageRoutes(app, { sessionTurnPageService: { loadPage } });
    const res = response();

    await route('GET', ROUTE)({
      params: { sessionID: 'ses_42' },
      query: {
        turns: '3',
        scanLimit: '50',
        before: 'msg_cursor',
        directory: '/repo/project',
      },
      headers: {},
    }, res);

    expect(loadPage).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: 'ses_42',
      turns: 3,
      scanLimit: 50,
      before: 'msg_cursor',
      directory: '/repo/project',
    }));
    expect(res.statusCode).toBe(200);
    expect(res.body.turnCount).toBe(1);
    expect(res.body.cursor).toBe('msg_u1');
    expect(res.body.complete).toBe(false);
    expect(Array.isArray(res.body.records)).toBe(true);
    expect(res.body.records).toHaveLength(2);
  });

  it('maps upstream service errors to an upstream HTTP status', async () => {
    const loadPage = vi.fn(async () => ({
      ok: false,
      error: 'upstream',
    }));
    const { app, route } = registry();
    registerSessionTurnPageRoutes(app, { sessionTurnPageService: { loadPage } });
    const res = response();

    await route('GET', ROUTE)({
      params: { sessionID: 'ses_1' },
      query: { turns: '3' },
      headers: {},
    }, res);

    expect(res.statusCode).toBeGreaterThanOrEqual(502);
    expect(res.statusCode).toBeLessThan(600);
    expect(res.body).toMatchObject({ error: expect.stringMatching(/upstream/i) });
  });

  it('maps too-large / scan-limit service errors to a client or payload status', async () => {
    for (const error of ['too_large', 'scan_limit', 'max_scan_pages', 'max_scan_messages']) {
      const loadPage = vi.fn(async () => ({ ok: false, error }));
      const { app, route } = registry();
      registerSessionTurnPageRoutes(app, { sessionTurnPageService: { loadPage } });
      const res = response();

      await route('GET', ROUTE)({
        params: { sessionID: 'ses_1' },
        query: { turns: '3' },
        headers: {},
      }, res);

      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
      expect(res.body?.error ?? res.body?.code).toEqual(expect.stringMatching(/large|scan|limit|page|message/i));
    }
  });

  it('maps invalid_cursor service errors to HTTP 400', async () => {
    const loadPage = vi.fn(async () => ({ ok: false, error: 'invalid_cursor' }));
    const { app, route } = registry();
    registerSessionTurnPageRoutes(app, { sessionTurnPageService: { loadPage } });
    const res = response();

    await route('GET', ROUTE)({
      params: { sessionID: 'ses_1' },
      query: { turns: '3', before: 'oc1.bad' },
      headers: {},
    }, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({
      error: expect.stringMatching(/cursor|invalid/i),
    });
  });

  it('forwards an observable AbortSignal into loadPage', async () => {
    const controller = new AbortController();
    const loadPage = vi.fn(async ({ signal }) => {
      expect(signal).toBeTruthy();
      expect(signal.aborted).toBe(false);
      return {
        ok: true,
        records: [],
        turnCount: 0,
        cursor: null,
        complete: true,
      };
    });
    const { app, route } = registry();
    registerSessionTurnPageRoutes(app, { sessionTurnPageService: { loadPage } });
    const res = response();

    await route('GET', ROUTE)({
      params: { sessionID: 'ses_1' },
      query: { turns: '2' },
      headers: {},
      signal: controller.signal,
      aborted: false,
    }, res);

    expect(loadPage).toHaveBeenCalledTimes(1);
    const call = loadPage.mock.calls[0][0];
    expect(call.signal).toBeDefined();
    // Either the request signal is passed through, or the route builds a linked AbortSignal.
    if (call.signal === controller.signal) {
      expect(call.signal.aborted).toBe(false);
    } else {
      expect(typeof call.signal.aborted).toBe('boolean');
    }
    expect(res.statusCode).toBe(200);
  });

  const okPage = () => ({
    ok: true,
    records: [],
    turnCount: 0,
    cursor: null,
    complete: true,
  });

  /** Resolve the scanLimit the route handed the service for one request. */
  const resolvedScanLimit = async (query) => {
    const loadPage = vi.fn(async () => okPage());
    const { app, route } = registry();
    registerSessionTurnPageRoutes(app, { sessionTurnPageService: { loadPage } });
    const res = response();

    await route('GET', ROUTE)({
      params: { sessionID: 'ses_1' },
      query,
      headers: {},
    }, res);

    expect(res.statusCode).toBe(200);
    return loadPage.mock.calls[0][0].scanLimit;
  };

  it('defaults turns=3 and applies the host-owned scan width', async () => {
    const loadPage = vi.fn(async () => okPage());
    const { app, route } = registry();
    registerSessionTurnPageRoutes(app, { sessionTurnPageService: { loadPage } });
    const res = response();

    await route('GET', ROUTE)({
      params: { sessionID: 'ses_1' },
      query: {},
      headers: {},
    }, res);

    expect(res.statusCode).toBe(200);
    expect(loadPage).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: 'ses_1',
      turns: 3,
      scanLimit: 100,
    }));
  });

  it('applies the same width to prepend, which always carries before', async () => {
    expect(await resolvedScanLimit({ turns: '4', before: 'msg_cursor' })).toBe(100);
  });

  it('lets an explicit client scanLimit override the host default', async () => {
    expect(await resolvedScanLimit({ turns: '3', scanLimit: '80' })).toBe(80);
  });

  const toolRecord = () => ({
    info: { id: 'msg_a1', role: 'assistant' },
    parts: [{
      id: 'prt_1',
      type: 'tool',
      tool: 'bash',
      state: { status: 'completed', title: 'ran bash', output: 'x'.repeat(4000) },
    }],
  });

  /** Send one request and return the JSON body the route produced. */
  const pageBody = async (query) => {
    const loadPage = vi.fn(async () => ({
      ok: true,
      records: [toolRecord()],
      turnCount: 1,
      cursor: null,
      complete: true,
    }));
    const { app, route } = registry();
    registerSessionTurnPageRoutes(app, { sessionTurnPageService: { loadPage } });
    const res = response();

    await route('GET', ROUTE)({
      params: { sessionID: 'ses_1' },
      query,
      headers: {},
    }, res);

    expect(res.statusCode).toBe(200);
    return res.body;
  };

  it('projects tool parts on a first packet and labels the response', async () => {
    const body = await pageBody({ turns: '3' });

    expect(body.partsProjection).toBe('slim-v1');
    const part = body.records[0].parts[0];
    expect(part.slim).toBe(true);
    expect(part.state.status).toBe('completed');
    expect(part.state.output).toBeUndefined();
  });

  it('leaves prepend pages whole and unlabelled', async () => {
    const body = await pageBody({ turns: '4', before: 'msg_cursor' });

    expect(body.partsProjection).toBeNull();
    const part = body.records[0].parts[0];
    expect(part.slim).toBeUndefined();
    expect(part.state.output).toHaveLength(4000);
  });

  it('projects file parts on the first packet only and keeps prepend/explicit-cursor full', async () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
      Buffer.from([0x00, 0x00, 0x00, 0x0D]),
      Buffer.from('IHDR'),
      Buffer.from([0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x03, 0x08, 0x02, 0x00, 0x00, 0x00]),
      Buffer.alloc(4),
    ]);
    const url = `data:image/png;base64,${png.toString('base64')}`;
    const fileRecord = () => ({
      info: { id: 'msg_u1', role: 'user' },
      parts: [{
        id: 'prt_file',
        type: 'file',
        mime: 'image/png',
        filename: 'shot.png',
        url,
      }],
    });
    const loadPage = vi.fn(async () => ({
      ok: true,
      records: [fileRecord()],
      turnCount: 1,
      cursor: 'oc1.next',
      complete: false,
    }));
    const page = async (query) => {
      const { app, route } = registry();
      registerSessionTurnPageRoutes(app, { sessionTurnPageService: { loadPage } });
      const res = response();
      await route('GET', ROUTE)({ params: { sessionID: 'ses_1' }, query, headers: {} }, res);
      expect(res.statusCode).toBe(200);
      return res.body;
    };

    const first = await page({ turns: '3' });
    expect(first.partsProjection).toBe('slim-v1');
    expect(first.turnCount).toBe(1);
    expect(first.records[0].parts[0]).toMatchObject({
      type: 'file',
      mime: 'image/png',
      filename: 'shot.png',
      width: 2,
      height: 3,
      slim: true,
    });
    expect(first.records[0].parts[0].url).toBeUndefined();
    expect(JSON.stringify(first.records[0].parts[0])).not.toContain('base64');

    const prepend = await page({ turns: '3', before: 'oc1.next' });
    expect(prepend.partsProjection).toBeNull();
    expect(prepend.records[0].parts[0].url).toBe(url);
    expect(prepend.records[0].parts[0].slim).toBeUndefined();
  });

  it('does not abort on normal GET request close after a successful response', async () => {
    let capturedSignal;
    const loadPage = vi.fn(async ({ signal }) => {
      capturedSignal = signal;
      return {
        ok: true,
        records: [{ info: { id: 'msg_u1', role: 'user' }, parts: [] }],
        turnCount: 1,
        cursor: null,
        complete: true,
      };
    });
    const { app, route } = registry();
    registerSessionTurnPageRoutes(app, { sessionTurnPageService: { loadPage } });

    const listeners = new Map();
    const req = {
      params: { sessionID: 'ses_1' },
      query: { turns: '1' },
      headers: {},
      aborted: false,
      destroyed: false,
      once(event, handler) {
        listeners.set(event, handler);
      },
    };
    const res = {
      ...response(),
      writableEnded: false,
      once(event, handler) {
        listeners.set(`res:${event}`, handler);
      },
    };

    await route('GET', ROUTE)(req, res);

    expect(res.statusCode).toBe(200);
    // Simulate normal completion: response ends, then request close fires.
    res.writableEnded = true;
    listeners.get('close')?.();
    listeners.get('res:close')?.();

    expect(capturedSignal?.aborted).toBe(false);
  });

  it('aborts when the client disconnects before the response ends', async () => {
    let capturedSignal;
    let resolveLoad;
    const loadPage = vi.fn(async ({ signal }) => {
      capturedSignal = signal;
      await new Promise((resolve) => {
        resolveLoad = resolve;
      });
      if (signal?.aborted) {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }
      return {
        ok: true,
        records: [],
        turnCount: 0,
        cursor: null,
        complete: true,
      };
    });
    const { app, route } = registry();
    registerSessionTurnPageRoutes(app, { sessionTurnPageService: { loadPage } });

    const listeners = new Map();
    const req = {
      params: { sessionID: 'ses_1' },
      query: { turns: '1' },
      headers: {},
      aborted: false,
      destroyed: false,
      once(event, handler) {
        listeners.set(event, handler);
      },
    };
    const res = {
      ...response(),
      writableEnded: false,
      once(event, handler) {
        listeners.set(`res:${event}`, handler);
      },
    };

    const pending = route('GET', ROUTE)(req, res);
    // Client disconnect while response still open.
    listeners.get('res:close')?.();
    expect(capturedSignal?.aborted).toBe(true);
    resolveLoad?.();
    await pending;
  });
});
