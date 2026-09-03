import { describe, expect, test } from 'vitest';
import { isAssistantWorking } from './assistantWorking';

describe('isAssistantWorking', () => {
  test('is on for a contact send or a busy assigned session, off when idle', () => {
    expect(isAssistantWorking({ sending: true })).toBe(true);
    expect(isAssistantWorking({ serverWorking: true })).toBe(true);
    expect(isAssistantWorking({
      assignedSessionIDs: ['ses_1'],
      statuses: { ses_1: { type: 'busy' } },
    })).toBe(true);
    expect(isAssistantWorking({
      assignedSessionIDs: ['ses_1'],
      statuses: { ses_1: { type: 'retry' } },
    })).toBe(true);
    expect(isAssistantWorking({
      assignedSessionIDs: ['ses_1'],
      statuses: { ses_1: { type: 'idle' } },
    })).toBe(false);
    expect(isAssistantWorking({
      assignedSessionIDs: ['ses_1'],
      statuses: { ses_1: { type: 'idle' } },
      serverWorking: false,
    })).toBe(false);
    expect(isAssistantWorking({})).toBe(false);
  });
});
