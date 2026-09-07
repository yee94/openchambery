import { describe, expect, test } from 'vitest';

import {
  formatLynxGoalDuration,
  formatLynxGoalTokens,
  lynxGoalElapsedMs,
  lynxGoalPauseResumeAction,
  lynxGoalTitleText,
  lynxGoalTokensLabel,
  parseLynxSessionGoal,
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
