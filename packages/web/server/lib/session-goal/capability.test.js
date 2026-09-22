import { describe, expect, it } from 'vitest';
import {
  SESSION_GOAL_UNSUPPORTED_REASON,
  assertSessionGoalSupported,
  getSessionGoalCapability,
  isSessionGoalSupported,
  sessionGoalUnavailableMessage,
} from './capability.js';

describe('session-goal capability', () => {
  it('advertises supported Host goal state (session-metadata store)', () => {
    expect(getSessionGoalCapability()).toEqual({
      supported: true,
    });
    expect(SESSION_GOAL_UNSUPPORTED_REASON).toBe('v2_goal_state_unavailable');
    expect(isSessionGoalSupported()).toBe(true);
  });

  it('formats a stable unavailable message for run history and APIs', () => {
    expect(sessionGoalUnavailableMessage({
      supported: false,
      reason: SESSION_GOAL_UNSUPPORTED_REASON,
    })).toBe(
      'session goal is unavailable (v2_goal_state_unavailable)',
    );
  });

  it('assertSessionGoalSupported returns when supported', () => {
    expect(assertSessionGoalSupported({ operation: 'create' })).toEqual({
      supported: true,
    });
  });
});
