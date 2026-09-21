import { describe, expect, it } from 'vitest';
import {
  SESSION_GOAL_UNSUPPORTED_REASON,
  assertSessionGoalSupported,
  getSessionGoalCapability,
  isSessionGoalSupported,
  sessionGoalUnavailableMessage,
} from './capability.js';

describe('session-goal capability', () => {
  it('advertises unsupported with the fixed v2 reason (not recovery-complete)', () => {
    expect(getSessionGoalCapability()).toEqual({
      supported: false,
      reason: SESSION_GOAL_UNSUPPORTED_REASON,
    });
    expect(SESSION_GOAL_UNSUPPORTED_REASON).toBe('v2_goal_state_unavailable');
    expect(isSessionGoalSupported()).toBe(false);
  });

  it('formats a stable unavailable message for run history and APIs', () => {
    expect(sessionGoalUnavailableMessage()).toBe(
      'session goal is unavailable (v2_goal_state_unavailable)',
    );
  });

  it('assertSessionGoalSupported throws structured 501 refusal', () => {
    try {
      assertSessionGoalSupported({ operation: 'create' });
      expect.unreachable('should throw');
    } catch (error) {
      expect(error.statusCode).toBe(501);
      expect(error.code).toBe('v2_goal_state_unavailable');
      expect(error.message).toMatch(/cannot create/);
      expect(error.capability).toEqual({
        supported: false,
        reason: 'v2_goal_state_unavailable',
      });
    }
  });
});
