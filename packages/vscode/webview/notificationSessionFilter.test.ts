import { describe, expect, test } from 'vitest';
import { shouldSkipVSCodeNotificationSession } from './notificationSessionFilter';

describe('shouldSkipVSCodeNotificationSession', () => {
  test('skips missing session and child sessions', () => {
    expect(shouldSkipVSCodeNotificationSession(undefined)).toBe(true);
    expect(shouldSkipVSCodeNotificationSession(null)).toBe(true);
    expect(shouldSkipVSCodeNotificationSession({ parentID: 'ses_parent' })).toBe(true);
  });

  test('allows ordinary root sessions', () => {
    expect(shouldSkipVSCodeNotificationSession({ parentID: null, metadata: {} })).toBe(false);
    expect(shouldSkipVSCodeNotificationSession({
      metadata: { yuri: { kind: 'review' } as never },
    })).toBe(false);
  });

  test('skips small-model, scheduled-task, and non-contact assistant sessions', () => {
    expect(shouldSkipVSCodeNotificationSession({
      metadata: { yuri: { smallModel: { purpose: 'session-title' } } },
    })).toBe(true);
    expect(shouldSkipVSCodeNotificationSession({
      metadata: { yuri: { scheduledTask: { taskID: 'task_1' } } },
    })).toBe(true);
    expect(shouldSkipVSCodeNotificationSession({
      metadata: { yuri: { assistant: { assistantID: 'assistant_1' } } },
    })).toBe(true);
  });

  test('keeps contact-assigned workers eligible', () => {
    expect(shouldSkipVSCodeNotificationSession({
      metadata: {
        yuri: {
          assistant: { assistantID: 'assistant_1' },
          assigned: { from: 'contact' },
        },
      },
    })).toBe(false);
  });

  test('skips LLM gateway throwaway sessions with non-empty llm.purpose', () => {
    expect(shouldSkipVSCodeNotificationSession({
      metadata: { yuri: { llm: { purpose: 'chat-completions' } } },
    })).toBe(true);
  });

  test('does not treat empty smallModel/llm purpose as system sessions', () => {
    expect(shouldSkipVSCodeNotificationSession({
      metadata: { yuri: { smallModel: { purpose: '' } } },
    })).toBe(false);
    expect(shouldSkipVSCodeNotificationSession({
      metadata: { yuri: { llm: { purpose: '' } } },
    })).toBe(false);
  });
});
