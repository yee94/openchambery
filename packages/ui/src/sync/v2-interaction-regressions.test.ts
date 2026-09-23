import { expect, test } from 'vitest';
import { answersToFormAnswer } from './v2-runtime';
import { normalizeSessionProjectionMessage } from './session-projection-api';
import { computeAssistantTps } from '../components/chat/message/assistantTps';
import { parseSessionFormInfo } from './session-form-api';

test('shell projection preserves the command, output and terminal status in the existing shell card', () => {
  const row = normalizeSessionProjectionMessage('session', {
    id: 'msg_shell', type: 'shell', shellID: 'shell_1', command: 'pwd',
    status: 'exited', exit: 0, time: { created: 1000, completed: 2000 },
    output: { output: '/workspace\n', cursor: 11, size: 11, truncated: false },
  });
  expect(row?.info.role).toBe('user');
  expect(row?.parts[0]).toMatchObject({
    type: 'text', shellAction: { command: 'pwd', output: '/workspace\n', status: 'completed' },
  });
});

test('form answers preserve schema keys, option values and single-item multiselect arrays', () => {
  expect(answersToFormAnswer([['Production'], ['Web']], [
    { key: 'environment', type: 'string', options: [{ label: 'Production', value: 'prod' }] },
    { key: 'targets', type: 'multiselect', options: [{ label: 'Web', value: 'web' }] },
  ])).toEqual({ environment: 'prod', targets: ['web'] });
});

test('TPS uses upstream stream timing and excludes prefill latency', () => {
  const row = normalizeSessionProjectionMessage('session', {
    id: 'msg_a', type: 'assistant', agent: 'build', model: { providerID: 'test', id: 'model' },
    time: { created: 1000, streamed: 9000, completed: 10000 },
    tokens: { input: 10, output: 100, reasoning: 0 }, content: [],
  });
  expect(row?.info.time.streamed).toBe(9000);
  expect(computeAssistantTps({
    createdAt: row?.info.time.created, streamedAt: row?.info.time.streamed,
    completedAt: row?.info.time.completed, outputTokens: row?.info.tokens?.output,
  })).toBe(100);
});

test('native TPS ignores tool wall-time heuristics and rejects invalid native intervals', () => {
  expect(computeAssistantTps({ streamedAt: 1000, completedAt: 2000, outputTokens: 80, reasoningTokens: 20,
    parts: [{ id: 'tool', sessionID: 'session', messageID: 'message', type: 'tool', tool: 'bash', callID: 'tool',
      state: { status: 'completed', input: {}, time: { start: 1000, end: 2000 } } }],
  })).toBe(100);
  expect(computeAssistantTps({ createdAt: 1, streamedAt: 2000, completedAt: 2000, outputTokens: 100 })).toBeNull();
});

test('custom string answers stay enabled after form parsing', () => {
  expect(parseSessionFormInfo({ id: 'frm_custom', sessionID: 'session', title: 'Choice', fields: [
    { key: 'choice', type: 'string', custom: true, options: [{ value: 'web', label: 'Web' }] },
  ] }).fields[0]).toMatchObject({ custom: true });
});

test('form conversion preserves empty multi-selection and validates scalar types', () => {
  expect(answersToFormAnswer([[], ['2'], ['false']], [
    { key: 'targets', type: 'multiselect' }, { key: 'count', type: 'integer' }, { key: 'enabled', type: 'boolean' },
  ])).toEqual({ targets: [], count: 2, enabled: false });
  expect(() => answersToFormAnswer([['']], [{ key: 'count', type: 'integer' }])).toThrow();
  expect(() => answersToFormAnswer([['1.5']], [{ key: 'count', type: 'integer' }])).toThrow();
});
