import { describe, expect, test } from 'bun:test';
import type { PendingUserMessagePresentation } from '@/sync/session-ui-store';
import { reconcileAdmittedAssistantBinding, rebindPendingAssistantMessage } from './assistantPendingMessages';

const pending = (id: string, sessionID: string): PendingUserMessagePresentation => ({
  info: { id, sessionID, role: 'user' } as PendingUserMessagePresentation['info'],
  parts: [],
});

describe('Assistant admitted-message convergence', () => {
  test('rebinds one pending identity to a stateless result session', () => {
    const first = pending('msg_first', 'ses_old');
    const target = pending('msg_target', 'ses_old');
    const rebound = rebindPendingAssistantMessage([first, target], 'msg_target', 'ses_new');

    expect(rebound[0]).toBe(first);
    expect(rebound[1]?.info.sessionID).toBe('ses_new');
    expect(rebound[1]?.info.id).toBe('msg_target');
  });

  test('returns admission success immediately and bounds failed materialization retries', async () => {
    let refreshes = 0;
    const sleeps: number[] = [];
    const result = reconcileAdmittedAssistantBinding({
      binding: { sessionID: 'ses_new', directory: '/project', sessionGeneration: 2 },
      refresh: async () => { refreshes++; throw new Error('materialization failed'); },
      isCurrent: () => true,
      refreshDelaysMs: [0, 1, 1],
      sleep: async (delayMs) => { sleeps.push(delayMs); },
    });

    expect(result).toBe(undefined);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(refreshes).toBe(3);
    expect(sleeps).toEqual([1, 1]);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(refreshes).toBe(3);
  });

  test('stops background materialization retries after the runtime lifecycle retires', async () => {
    let current = true;
    let refreshes = 0;
    reconcileAdmittedAssistantBinding({
      binding: { sessionID: 'ses_new', directory: '/project', sessionGeneration: 2 },
      refresh: async () => { refreshes++; throw new Error('materialization failed'); },
      isCurrent: () => current,
      refreshDelaysMs: [0, 1, 1],
      sleep: async () => { current = false; },
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(refreshes).toBe(1);
  });
});
