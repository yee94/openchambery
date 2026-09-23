import { expect, test } from 'vitest';
import { answersToFormAnswer } from './v2-runtime';
import { normalizeSessionProjectionMessage } from './session-projection-api';
import { computeAssistantTps } from '../components/chat/message/assistantTps';
import { parseSessionFormInfo } from './session-form-api';

test('system catalog instructions stay outside the transcript while identical assistant text is preserved', () => {
  const text = 'The Code Mode tool catalog has changed. This catalog supersedes the previous Code Mode tool catalog.';
  expect(normalizeSessionProjectionMessage('session', {
    id: 'msg_catalog', type: 'system', time: { created: 1000 }, text,
  })).toBeNull();
  expect(normalizeSessionProjectionMessage('session', {
    id: 'msg_answer', type: 'assistant', time: { created: 2000 }, content: [{ type: 'text', text }],
  })?.parts[0]).toMatchObject({ type: 'text', text });
});

test('full system-only projection pages retain the upstream history cursor', async () => {
  const { normalizeSessionProjectionPage } = await import('./session-projection-api');
  const page = normalizeSessionProjectionPage({
    data: [{ id: 'msg_system', type: 'system', time: { created: 1000 }, text: 'internal instructions' }],
    cursor: { previous: null, next: 'older-history' },
  }, 'session', 'desc', 1);
  expect(page.records).toEqual([]);
  expect(page.cursor).toBe('older-history');
  expect(page.complete).toBe(false);
});

test('context refresh excludes instruction updates and preserves neighboring chat rows', async () => {
  const { normalizeSessionContextPage } = await import('./session-projection-api');
  const page = normalizeSessionContextPage({ data: [
    { id: 'msg_user', type: 'user', time: { created: 1000 }, text: 'hello' },
    { id: 'msg_system', type: 'system', time: { created: 2000 },
      text: 'model-facing catalog', description: 'Instructions updated: core/codemode' },
    { id: 'msg_answer', type: 'assistant', time: { created: 3000 }, content: [{ type: 'text', text: 'answer' }] },
  ] }, 'session');
  expect(page.records.map((row) => row.info.id)).toEqual(['msg_user', 'msg_answer']);
  expect(page.turnCount).toBe(1);
});

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
