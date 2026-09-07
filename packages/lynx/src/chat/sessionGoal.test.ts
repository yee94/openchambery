import { describe, expect, test } from 'vitest';

import {
  clearLynxSessionGoal,
  fitLynxGoalObjective,
  formatLynxGoalDuration,
  formatLynxGoalTokens,
  lynxGoalElapsedMs,
  lynxGoalPauseResumeAction,
  lynxGoalTitleText,
  lynxGoalTokensLabel,
  parseLynxSessionGoal,
  SESSION_GOAL_OBJECTIVE_CHAR_LIMIT,
  setLynxSessionGoal,
  setLynxSessionGoalStatus,
  type LynxSessionGoalPayload,
} from './sessionGoal';

const sampleGoal = (overrides: Partial<LynxSessionGoalPayload> = {}): LynxSessionGoalPayload => ({
  id: 'g1',
  objective: 'Ship queue chips',
  objectiveFile: false,
  status: 'active',
  tokenBudget: 10000,
  tokensUsed: 1500,
  turnsUsed: 2,
  blockedStreak: 0,
  note: '',
  statusReason: '',
  lastAccountedMessageID: '',
  createdAt: 1_000,
  updatedAt: 2_000,
  ...overrides,
});

describe('parseLynxSessionGoal', () => {
  test('reads Cap metadata.openchamber.goal', () => {
    const goal = parseLynxSessionGoal({
      id: 'ses_1',
      metadata: {
        openchamber: {
          goal: {
            id: 'g1',
            objective: '  Do the thing  ',
            status: 'paused',
            tokensUsed: 12,
            createdAt: 10,
            updatedAt: 20,
          },
        },
      },
    });
    expect(goal).toMatchObject({
      id: 'g1',
      objective: 'Do the thing',
      status: 'paused',
      tokensUsed: 12,
    });
  });

  test('rejects incomplete goal', () => {
    expect(parseLynxSessionGoal({ metadata: { openchamber: { goal: { id: 'x' } } } })).toBeNull();
    expect(parseLynxSessionGoal(null)).toBeNull();
  });

  test('accepts objectiveFile without inline objective', () => {
    const goal = parseLynxSessionGoal({
      metadata: {
        openchamber: {
          goal: { id: 'g', objectiveFile: true, status: 'active' },
        },
      },
    });
    expect(goal?.objectiveFile).toBe(true);
  });
});

describe('goal presentation helpers', () => {
  test('format tokens and duration', () => {
    expect(formatLynxGoalTokens(0)).toBe('0');
    expect(formatLynxGoalTokens(1500)).toBe('1.5K');
    expect(formatLynxGoalDuration(5_000)).toBe('5s');
    expect(formatLynxGoalDuration(65_000)).toBe('1m5s');
    expect(formatLynxGoalDuration(3_600_000)).toBe('1h');
  });

  test('pause/resume mapping', () => {
    expect(lynxGoalPauseResumeAction('active')).toEqual({ kind: 'pause', next: 'paused' });
    expect(lynxGoalPauseResumeAction('paused')).toEqual({ kind: 'resume', next: 'active' });
    expect(lynxGoalPauseResumeAction('blocked')).toEqual({ kind: 'resume', next: 'active' });
    expect(lynxGoalPauseResumeAction('complete')).toBeNull();
  });

  test('elapsed / tokens / title', () => {
    const active = sampleGoal({ status: 'active', createdAt: 1000, note: 'audit' });
    expect(lynxGoalElapsedMs(active, 6000)).toBe(5000);
    const complete = sampleGoal({ status: 'complete', createdAt: 1000, updatedAt: 4000 });
    expect(lynxGoalElapsedMs(complete, 99999)).toBe(3000);
    expect(lynxGoalTokensLabel(active)).toBe('1.5K/10K');
    expect(lynxGoalTitleText(active, 'obj')).toBe('audit');
    expect(lynxGoalTitleText(sampleGoal({ note: '' }), 'obj')).toBe('obj');
  });
});

describe('setLynxSessionGoalStatus', () => {
  test('no-runtime never fake-succeeds', async () => {
    expect(await setLynxSessionGoalStatus(null, {
      sessionId: 'ses_1',
      nextStatus: 'paused',
    })).toEqual({ status: 'no-runtime' });
  });

  test('patches metadata goal status via GET+PATCH', async () => {
    const calls: Array<{ path: string; method?: string; body?: string }> = [];
    const runtimeFetch = async (path: string, init?: { method?: string; body?: string }) => {
      calls.push({ path, method: init?.method, body: init?.body });
      if (!init?.method || init.method === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'ses_1',
            metadata: {
              openchamber: {
                goal: {
                  id: 'g1',
                  objective: 'Ship',
                  status: 'active',
                  tokensUsed: 0,
                  createdAt: 1,
                  updatedAt: 1,
                },
              },
            },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    const result = await setLynxSessionGoalStatus(runtimeFetch, {
      sessionId: 'ses_1',
      directory: '/repo',
      nextStatus: 'paused',
    });
    expect(result).toEqual({ status: 'ok' });
    expect(calls[0]?.path).toContain('/session/ses_1');
    expect(calls[1]?.method).toBe('PATCH');
    const body = JSON.parse(calls[1]!.body!);
    expect(body.metadata.openchamber.goal.status).toBe('paused');
  });

  test('unavailable when session has no goal', async () => {
    const runtimeFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 'ses_1', metadata: {} }),
    });
    expect(await setLynxSessionGoalStatus(runtimeFetch, {
      sessionId: 'ses_1',
      nextStatus: 'active',
    })).toMatchObject({ status: 'unavailable' });
  });
});

describe('fitLynxGoalObjective', () => {
  test('passes through under limit', () => {
    expect(fitLynxGoalObjective('short')).toBe('short');
  });

  test('head+tail trims over limit without fake distill', () => {
    const raw = 'A'.repeat(SESSION_GOAL_OBJECTIVE_CHAR_LIMIT + 200);
    const fitted = fitLynxGoalObjective(raw);
    expect(fitted.length).toBeLessThanOrEqual(SESSION_GOAL_OBJECTIVE_CHAR_LIMIT);
    expect(fitted.startsWith('A')).toBe(true);
    expect(fitted.endsWith('A')).toBe(true);
    expect(fitted.includes('objective trimmed')).toBe(true);
  });
});

describe('setLynxSessionGoal', () => {
  test('no-runtime never fake-succeeds', async () => {
    expect(await setLynxSessionGoal(null, {
      sessionId: 'ses_1',
      objective: 'Ship it',
      tokenBudget: null,
    })).toEqual({ status: 'no-runtime' });
  });

  test('rejects empty objective', async () => {
    const runtimeFetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
    expect(await setLynxSessionGoal(runtimeFetch, {
      sessionId: 'ses_1',
      objective: '   ',
      tokenBudget: null,
    })).toMatchObject({ status: 'failed' });
  });

  test('creates goal via GET + optional objective PUT + PATCH', async () => {
    const calls: Array<{ path: string; method?: string; body?: string }> = [];
    const runtimeFetch = async (path: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
      calls.push({ path, method: init?.method, body: init?.body });
      if (path.includes('/api/goals/objective/')) {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      if (!init?.method || init.method === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'ses_1', metadata: {} }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    const result = await setLynxSessionGoal(runtimeFetch, {
      sessionId: 'ses_1',
      directory: '/repo',
      objective: 'Ship dialog',
      tokenBudget: 50_000,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.goal.objectiveFile).toBe(true);
    expect(result.goal.status).toBe('active');
    expect(result.goal.tokenBudget).toBe(50_000);
    expect(calls.some((c) => c.path.includes('/api/goals/objective/') && c.method === 'PUT')).toBe(true);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(true);
    const patch = calls.find((c) => c.method === 'PATCH');
    const body = JSON.parse(patch!.body!);
    expect(body.metadata.openchamber.goal.objectiveFile).toBe(true);
    expect(body.metadata.openchamber.goal.objective).toBe('');
  });

  test('falls back to inline objective when PUT fails', async () => {
    const runtimeFetch = async (path: string, init?: { method?: string; body?: string }) => {
      if (path.includes('/api/goals/objective/')) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      if (!init?.method || init.method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ id: 'ses_1', metadata: {} }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const result = await setLynxSessionGoal(runtimeFetch, {
      sessionId: 'ses_1',
      objective: 'Inline goal',
      tokenBudget: null,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.goal.objectiveFile).toBe(false);
    expect(result.goal.objective).toBe('Inline goal');
  });
});

describe('clearLynxSessionGoal', () => {
  test('no-runtime never fake-succeeds', async () => {
    expect(await clearLynxSessionGoal(null, { sessionId: 'ses_1' })).toEqual({ status: 'no-runtime' });
  });

  test('patches away goal and deletes objective file', async () => {
    const calls: Array<{ path: string; method?: string; body?: string }> = [];
    const runtimeFetch = async (path: string, init?: { method?: string; body?: string }) => {
      calls.push({ path, method: init?.method, body: init?.body });
      if (path.includes('/api/goals/objective/')) {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      if (!init?.method || init.method === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'ses_1',
            metadata: {
              openchamber: {
                goal: {
                  id: 'g1',
                  objective: 'Ship',
                  status: 'active',
                  tokensUsed: 0,
                  createdAt: 1,
                  updatedAt: 1,
                },
              },
            },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const result = await clearLynxSessionGoal(runtimeFetch, { sessionId: 'ses_1' });
    expect(result).toMatchObject({ status: 'ok', wasActive: true });
    const patch = calls.find((c) => c.method === 'PATCH');
    const body = JSON.parse(patch!.body!);
    expect(body.metadata.openchamber.goal).toBeUndefined();
    expect(calls.some((c) => c.path.includes('/api/goals/objective/') && c.method === 'DELETE')).toBe(true);
  });
});
