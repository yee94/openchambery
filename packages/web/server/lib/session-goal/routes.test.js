import { describe, expect, it, vi } from 'vitest';

vi.mock('./objectives.js', () => ({
  writeObjective: vi.fn(async () => ({ content: 'ok' })),
  readObjective: vi.fn(async () => 'leftover'),
  deleteObjective: vi.fn(async () => undefined),
}));

const { writeObjective, readObjective, deleteObjective } = await import('./objectives.js');
const { registerSessionGoalRoutes } = await import('./routes.js');

const createRouteRegistry = () => {
  const routes = new Map();
  return {
    app: {
      get(path, handler) { routes.set(`GET ${path}`, handler); },
      post(path, handler) { routes.set(`POST ${path}`, handler); },
      put(path, handler) { routes.set(`PUT ${path}`, handler); },
      delete(path, handler) { routes.set(`DELETE ${path}`, handler); },
    },
    getRoute(method, path) {
      return routes.get(`${method} ${path}`);
    },
  };
};

const createResponse = () => {
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

describe('session-goal routes capability gating', () => {
  const register = () => {
    const { app, getRoute } = createRouteRegistry();
    registerSessionGoalRoutes(app);
    return getRoute;
  };

  it('exposes capability as unsupported with fixed reason', async () => {
    const getRoute = register();
    const response = createResponse();
    await getRoute('GET', '/api/goals/capability')({}, response);
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      supported: false,
      reason: 'v2_goal_state_unavailable',
    });
  });

  it('refuses manual goal create before any side effect', async () => {
    writeObjective.mockClear();
    const getRoute = register();
    const response = createResponse();
    await getRoute('POST', '/api/goals/:sessionId')({
      params: { sessionId: 'ses_1' },
      body: { objective: 'ship it' },
    }, response);

    expect(response.statusCode).toBe(501);
    expect(response.body.reason).toBe('v2_goal_state_unavailable');
    expect(response.body.operation).toBe('create');
    expect(writeObjective).not.toHaveBeenCalled();
  });

  it('refuses manual goal resume', async () => {
    const getRoute = register();
    const response = createResponse();
    await getRoute('POST', '/api/goals/:sessionId/resume')({
      params: { sessionId: 'ses_1' },
    }, response);

    expect(response.statusCode).toBe(501);
    expect(response.body.operation).toBe('resume');
    expect(response.body.capability.supported).toBe(false);
  });

  it('refuses objective write (create side-effect) while unsupported', async () => {
    writeObjective.mockClear();
    const getRoute = register();
    const response = createResponse();
    await getRoute('PUT', '/api/goals/objective/:sessionId')({
      params: { sessionId: 'ses_1' },
      body: { content: 'objective text' },
    }, response);

    expect(response.statusCode).toBe(501);
    expect(writeObjective).not.toHaveBeenCalled();
  });

  it('still allows objective read and delete for leftover files', async () => {
    readObjective.mockClear();
    deleteObjective.mockClear();
    const getRoute = register();

    const getResponse = createResponse();
    await getRoute('GET', '/api/goals/objective/:sessionId')({
      params: { sessionId: 'ses_1' },
    }, getResponse);
    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.body).toEqual({ content: 'leftover' });
    expect(readObjective).toHaveBeenCalledWith('ses_1');

    const deleteResponse = createResponse();
    await getRoute('DELETE', '/api/goals/objective/:sessionId')({
      params: { sessionId: 'ses_1' },
    }, deleteResponse);
    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.body.ok).toBe(true);
    expect(deleteObjective).toHaveBeenCalledWith('ses_1');
  });
});
