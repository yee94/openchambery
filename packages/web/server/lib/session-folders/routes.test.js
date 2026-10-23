import { describe, expect, it, vi } from 'vitest';
import path from 'path';

import { registerSessionFoldersRoutes } from './routes.js';

const createRouteRegistry = () => {
  const routes = new Map();

  return {
    app: {
      get(routePath, handler) {
        routes.set(`GET ${routePath}`, handler);
      },
      post(routePath, handler) {
        routes.set(`POST ${routePath}`, handler);
      },
    },
    getRoute(method, routePath) {
      return routes.get(`${method} ${routePath}`);
    },
  };
};

const createMockResponse = () => {
  let statusCode = 200;
  let body = null;

  return {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
  };
};

describe('session folders routes', () => {
  it('persists per-scope orders, serializes concurrent clients, and imports legacy ranks only once', async () => {
    const files = new Map();
    const fsPromises = {
      mkdir: vi.fn(async () => {}),
      readFile: vi.fn(async (file) => {
        if (!files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return files.get(file);
      }),
      writeFile: vi.fn(async (file, content) => { files.set(file, content); }),
      rename: vi.fn(async (source, destination) => { files.set(destination, files.get(source)); files.delete(source); }),
      unlink: vi.fn(async (file) => { files.delete(file); }),
    };
    const broadcast = vi.fn();
    const registry = createRouteRegistry();
    const deps = { fsPromises, path, openchamberDataDir: '/test/data', broadcastOpenChamberEvent: broadcast };
    registerSessionFoldersRoutes(registry.app, deps);
    const post = registry.getRoute('POST', '/api/session-folders/order');
    const write = async (body) => {
      const res = createMockResponse();
      await post({ body }, res);
      return res;
    };
    const [pins, project] = await Promise.all([
      write({ scopeKey: '__pinned__', order: ['b', 'a'], activity: {} }),
      write({ scopeKey: '/repo', order: ['c', 'd'], activity: { c: 1, d: 2 } }),
    ]);
    expect(pins.statusCode).toBe(200);
    expect(project.body.sessionOrderByScope).toEqual({ __pinned__: ['b', 'a'], '/repo': ['c', 'd'] });
    const staleImport = await write({ scopeKey: '__pinned__', order: ['a', 'b'], activity: {}, onlyIfAbsent: true });
    expect(staleImport.body.sessionOrderByScope.__pinned__).toEqual(['b', 'a']);
    expect(staleImport.body.revision).toBe(2);
    expect(broadcast).toHaveBeenCalledTimes(2);

    fsPromises.rename.mockRejectedValueOnce(new Error('disk full'));
    expect((await write({ scopeKey: '__pinned__', order: ['a', 'b'], activity: {} })).statusCode).toBe(500);
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(files.size).toBe(1);
    const restarted = createRouteRegistry();
    registerSessionFoldersRoutes(restarted.app, deps);
    const res = createMockResponse();
    await restarted.getRoute('GET', '/api/session-folders/order')({}, res);
    expect(res.body).toEqual(staleImport.body);
    expect((await write({ scopeKey: '', order: ['a'], activity: {} })).statusCode).toBe(400);
    files.set('/test/data/session-order.json', 'corrupt');
    const broken = createMockResponse();
    await restarted.getRoute('GET', '/api/session-folders/order')({}, broken);
    expect(broken.statusCode).toBe(500);
  });

  it('uses unique temp files for concurrent saves', async () => {
    const { app, getRoute } = createRouteRegistry();
    const tempPaths = [];
    const fsPromises = {
      mkdir: vi.fn(async () => {}),
      writeFile: vi.fn(async (tempPath) => {
        tempPaths.push(tempPath);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }),
      rename: vi.fn(async () => {}),
    };

    registerSessionFoldersRoutes(app, {
      fsPromises,
      path,
      openchamberDataDir: '/tmp/openchamber-test',
    });

    const handler = getRoute('POST', '/api/session-folders');

    await Promise.all([
      handler({ body: { version: 1, updatedAt: 1 } }, createMockResponse()),
      handler({ body: { version: 1, updatedAt: 2 } }, createMockResponse()),
    ]);

    expect(tempPaths).toHaveLength(2);
    expect(new Set(tempPaths).size).toBe(2);
    expect(tempPaths.every((tempPath) => tempPath.includes('sessions-directories.json.tmp-'))).toBe(true);
  });

  it('removes the temp file when rename fails', async () => {
    const { app, getRoute } = createRouteRegistry();
    const fsPromises = {
      mkdir: vi.fn(async () => {}),
      writeFile: vi.fn(async () => {}),
      rename: vi.fn(async () => {
        throw new Error('rename failed');
      }),
      unlink: vi.fn(async () => {}),
    };

    registerSessionFoldersRoutes(app, {
      fsPromises,
      path,
      openchamberDataDir: '/tmp/openchamber-test',
    });

    const handler = getRoute('POST', '/api/session-folders');
    const response = createMockResponse();

    await handler({ body: { version: 1, updatedAt: 1 } }, response);

    expect(response.statusCode).toBe(500);
    expect(fsPromises.unlink).toHaveBeenCalledWith(expect.stringContaining('sessions-directories.json.tmp-'));
  });
});
