import { describe, expect, test } from 'bun:test';
import {
  buildAssistantPath,
  buildSchedulePath,
  buildSessionPath,
  buildSettingsPath,
  parseAppPath,
} from './pathContract';

describe('top-level schedule primary', () => {
  test('root schedule path is not under session', () => {
    expect(buildSchedulePath()).toBe('/schedule');
    expect(buildSchedulePath({ scheduleView: 'tasks' })).toBe('/schedule');
    expect(buildSchedulePath({ scheduleView: 'history' })).toBe('/schedule/history');
    expect(parseAppPath('/schedule').kind).toBe('schedule');
    expect(parseAppPath('/schedule/history')).toEqual({
      kind: 'schedule',
      scheduleView: 'history',
      scheduleProjectId: null,
      scheduleTaskId: null,
      focusSessionId: null,
    });
  });

  test('task editor and agent focus', () => {
    expect(
      buildSchedulePath({
        scheduleProjectId: 'proj/a',
        scheduleTaskId: 'task-1',
      }),
    ).toBe('/schedule/tasks/proj%2Fa/task-1');
    expect(
      buildSchedulePath({ focusSessionId: 'ses_child' }),
    ).toBe('/schedule/agent/ses_child');
    const parsed = parseAppPath('/schedule/agent/ses_child');
    expect(parsed.kind).toBe('schedule');
    if (parsed.kind === 'schedule') {
      expect(parsed.focusSessionId).toBe('ses_child');
    }
  });

  test('legacy nested /session/$id/schedule promotes to schedule kind', () => {
    const parsed = parseAppPath('/session/s1/schedule/history');
    expect(parsed.kind).toBe('schedule');
    if (parsed.kind === 'schedule') {
      expect(parsed.scheduleView).toBe('history');
    }
  });

  test('buildSessionPath never nests schedule under session', () => {
    expect(buildSessionPath({ sessionId: 's1', tab: 'schedule' })).toBe('/schedule');
  });
});

describe('top-level assistant primary', () => {
  test('assistant is not under session', () => {
    expect(buildAssistantPath()).toBe('/assistant');
    expect(buildAssistantPath({ assistantId: 'asst_1' })).toBe('/assistant/asst_1');
    expect(parseAppPath('/assistant/asst_1')).toEqual({
      kind: 'assistant',
      assistantId: 'asst_1',
      focusSessionId: null,
    });
    expect(buildSessionPath({ sessionId: 's1', tab: 'assistant' })).toBe('/assistant');
  });

  test('assistant agent focus', () => {
    expect(
      buildAssistantPath({ assistantId: 'asst_1', focusSessionId: 'ses_sub' }),
    ).toBe('/assistant/asst_1/agent/ses_sub');
  });
});

describe('session tools', () => {
  test('diff scope', () => {
    expect(
      buildSessionPath({ sessionId: 's1', tab: 'diff', file: 'a.ts', scope: 'staged' }),
    ).toBe('/session/s1/diff?file=a.ts&scope=staged');
  });
});

describe('settings', () => {
  test('entity path', () => {
    expect(buildSettingsPath('providers', 'openai')).toBe('/settings/providers/openai');
  });
});
