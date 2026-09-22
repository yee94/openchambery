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
  const register = (deps) => {
    const { app, getRoute } = createRouteRegistry();
    registerSessionGoalRoutes(app, deps);
    return getRoute;
  };

  it('exposes capability as supported', async () => {
    const getRoute = register();
    const response = createResponse();
    await getRoute('GET', '/api/goals/capability')({}, response);
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      supported: true,
    });
  });

  it('returns 503 on create when persist is not injected (no side effects)', async () => {
    writeObjective.mockClear();
    const getRoute = register();
    const response = createResponse();
    await getRoute('POST', '/api/goals/:sessionId')({
      params: { sessionId: 'ses_1' },
      body: { objective: 'ship it' },
    }, response);

    expect(response.statusCode).toBe(503);
    expect(response.body.operation).toBe('create');
    expect(writeObjective).not.toHaveBeenCalled();
  });

  it('returns 503 on resume when persist is not injected', async () => {
    const getRoute = register();
    const response = createResponse();
    await getRoute('POST', '/api/goals/:sessionId/resume')({
      params: { sessionId: 'ses_1' },
    }, response);

    expect(response.statusCode).toBe(503);
    expect(response.body.operation).toBe('resume');
  });

  it('writes objective when capability is supported', async () => {
    writeObjective.mockClear();
    const getRoute = register();
    const response = createResponse();
    await getRoute('PUT', '/api/goals/objective/:sessionId')({
      params: { sessionId: 'ses_1' },
      body: { content: 'objective text' },
    }, response);

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(writeObjective).toHaveBeenCalledWith('ses_1', 'objective text');
  });

  it('creates an active goal via persist when injected', async () => {
    writeObjective.mockClear();
    const persistSessionGoal = vi.fn(async (_id, _dir, goal) => ({
      openchamber: { goal },
    }));
    const onGoalPersisted = vi.fn();
    const getRoute = register({ persistSessionGoal, onGoalPersisted });
    const response = createResponse();
    await getRoute('POST', '/api/goals/:sessionId')({
      params: { sessionId: 'ses_1' },
      body: { objective: 'ship it', directory: '/repo', tokenBudget: 5000 },
    }, response);

    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.goal).toMatchObject({
      status: 'active',
      objectiveFile: true,
      objective: '',
      tokenBudget: 5000,
      tokensUsed: 0,
      turnsUsed: 0,
      blockedStreak: 0,
    });
    expect(writeObjective).toHaveBeenCalledWith('ses_1', 'ship it');
    expect(persistSessionGoal).toHaveBeenCalledTimes(1);
    expect(persistSessionGoal.mock.calls[0][0]).toBe('ses_1');
    expect(persistSessionGoal.mock.calls[0][1]).toBe('/repo');
    expect(onGoalPersisted).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: 'ses_1',
      directory: '/repo',
    }));
  });

  it('resumes an existing goal to active with statusReason resumed', async () => {
    const existing = {
      id: 'goal-1',
      status: 'paused',
      objective: 'keep going',
      objectiveFile: false,
      tokenBudget: null,
      tokensUsed: 10,
      turnsUsed: 1,
      blockedStreak: 0,
      note: '',
      statusReason: '',
      lastAccountedMessageID: 'msg_1',
      createdAt: 1,
      updatedAt: 2,
    };
    const readSessionMetadata = vi.fn(async () => ({
      openchamber: { goal: existing },
    }));
    const persistSessionGoal = vi.fn(async (_id, _dir, goal) => ({
      openchamber: { goal },
    }));
    const getRoute = register({ persistSessionGoal, readSessionMetadata });
    const response = createResponse();
    await getRoute('POST', '/api/goals/:sessionId/resume')({
      params: { sessionId: 'ses_1' },
      body: { directory: '/repo' },
    }, response);

    expect(response.statusCode).toBe(200);
    expect(response.body.goal).toMatchObject({
      id: 'goal-1',
      status: 'active',
      statusReason: 'resumed',
      objective: 'keep going',
    });
    expect(persistSessionGoal).toHaveBeenCalledTimes(1);
  });

  it('returns 404 on resume when no goal exists', async () => {
    const readSessionMetadata = vi.fn(async () => ({}));
    const persistSessionGoal = vi.fn();
    const getRoute = register({ persistSessionGoal, readSessionMetadata });
    const response = createResponse();
    await getRoute('POST', '/api/goals/:sessionId/resume')({
      params: { sessionId: 'ses_1' },
    }, response);

    expect(response.statusCode).toBe(404);
    expect(persistSessionGoal).not.toHaveBeenCalled();
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
