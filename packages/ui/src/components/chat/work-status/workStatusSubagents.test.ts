import { expect, it } from 'vitest';
import type { Part } from '@/lib/opencode/v2-types';
import {
  mergeWorkStatusSubagents,
  projectTranscriptSubagents,
  transcriptSubagentsEqual,
} from './workStatusSubagents';

const toolPart = (overrides: Record<string, unknown> & { id: string }): Part => ({
  sessionID: 'parent',
  messageID: 'msg',
  type: 'tool',
  tool: 'task',
  callID: overrides.id,
  state: { status: 'completed', input: { subagent_type: 'explore' } },
  ...overrides,
} as Part);

it('projects a completed task tool as done and a running one as working', () => {
  const faces = projectTranscriptSubagents({
    messageOrder: ['msg'],
    partsByMessageID: {
      msg: [
        toolPart({ id: 'done-task' }),
        toolPart({
          id: 'live-task',
          state: { status: 'running', input: { agent: 'review' } },
        }),
        { id: 'text', sessionID: 'parent', messageID: 'msg', type: 'text', text: 'hello' },
      ],
    },
  });
  expect(faces).toEqual([
    { id: 'done-task', sessionID: undefined, label: 'Explore', description: '', running: false },
    { id: 'live-task', sessionID: undefined, label: 'Review', description: '', running: true },
  ]);
  expect(transcriptSubagentsEqual(faces, [...faces])).toBe(true);
  expect(transcriptSubagentsEqual(faces, faces.slice(0, 1))).toBe(false);
});

it('keeps one face when a child session is the task target, and promotes a finished tool that is still busy', () => {
  const tasks = projectTranscriptSubagents({
    messageOrder: ['msg'],
    partsByMessageID: {
      msg: [
        toolPart({
          id: 'task-1',
          metadata: { sessionID: 'child-1' },
          state: { status: 'completed', input: { subagent_type: 'explore' } },
        }),
        {
          id: 'sub-2',
          sessionID: 'parent',
          messageID: 'msg',
          type: 'subtask',
          agent: 'plan',
          taskSessionID: 'child-2',
        } as Part,
      ],
    },
  });
  const merged = mergeWorkStatusSubagents(tasks, [
    { id: 'child-1', title: 'Explore session', busy: true },
    { id: 'child-2', title: 'Plan session', busy: false },
    { id: 'child-3', title: 'Only child', busy: false },
  ]);
  expect(merged).toEqual([
    { key: 'child-1', sessionID: 'child-1', seed: 'child-1', label: 'Explore session', phase: 'working' },
    { key: 'child-2', sessionID: 'child-2', seed: 'child-2', label: 'Plan session', phase: 'done' },
    { key: 'child-3', sessionID: 'child-3', seed: 'child-3', label: 'Only child', phase: 'done' },
  ]);
});

it('treats a linked session as working when its status is busy and the catalog row is missing', () => {
  const merged = mergeWorkStatusSubagents(
    [{ id: 'task-1', sessionID: 'child-1', label: 'Explore', description: '', running: false }],
    [],
    new Set(['child-1']),
  );
  expect(merged).toEqual([
    { key: 'child-1', sessionID: 'child-1', seed: 'child-1', label: 'Explore', phase: 'working' },
  ]);
});

it('orders working faces ahead of completed ones', () => {
  const merged = mergeWorkStatusSubagents(
    [
      { id: 'done', label: 'Done agent', description: '', running: false },
      { id: 'live', label: 'Live agent', description: '', running: true },
    ],
    [],
  );
  expect(merged.map((face) => face.key)).toEqual(['live', 'done']);
});

it('shows the task description instead of the agent name when OpenCode published one', () => {
  const faces = projectTranscriptSubagents({
    messageOrder: ['msg'],
    partsByMessageID: {
      msg: [
        toolPart({
          id: 'task-1',
          state: {
            status: 'running',
            input: { agent: 'general', description: '查同步层调用链' },
          },
        }),
        {
          id: 'sub-1',
          sessionID: 'parent',
          messageID: 'msg',
          type: 'subtask',
          agent: 'general',
          description: '核对标题来源',
          taskSessionID: 'child-2',
        } as Part,
      ],
    },
  });
  expect(faces.map((face) => face.description)).toEqual(['查同步层调用链', '核对标题来源']);
  expect(mergeWorkStatusSubagents(faces, []).map((face) => face.label)).toEqual([
    '查同步层调用链',
    '核对标题来源',
  ]);
});

it('keeps one row per session id and prefers the live title after a rename', () => {
  const merged = mergeWorkStatusSubagents(
    [
      { id: 'task-old', sessionID: 'child-1', label: 'General', description: '旧标题', running: false },
      { id: 'task-continued', sessionID: 'child-1', label: 'General', description: '续聊描述', running: true },
    ],
    [{ id: 'child-1', title: '改过的标题', busy: false }],
  );
  expect(merged).toEqual([
    { key: 'child-1', sessionID: 'child-1', seed: 'child-1', label: '改过的标题', phase: 'working' },
  ]);
});

it('keeps the create-time description when a continuation has no live title yet', () => {
  const merged = mergeWorkStatusSubagents(
    [
      { id: 'task-old', sessionID: 'child-1', label: 'General', description: '创建时标题', running: false },
      { id: 'task-continued', sessionID: 'child-1', label: 'General', description: '续聊描述', running: false },
    ],
    [],
  );
  expect(merged).toEqual([
    { key: 'child-1', sessionID: 'child-1', seed: 'child-1', label: '创建时标题', phase: 'done' },
  ]);
});

it('uses live state metadata over a stale part-level session id', () => {
  const faces = projectTranscriptSubagents({
    messageOrder: ['msg'],
    partsByMessageID: {
      msg: [
        toolPart({
          id: 'task-1',
          metadata: { sessionID: 'old-child' },
          state: {
            status: 'completed',
            input: { subagent_type: 'general', description: '查标题' },
            metadata: { sessionID: 'child-1' },
          },
        }),
      ],
    },
  });
  expect(faces[0]?.sessionID).toBe('child-1');
});

it('links a task whose session id is only in the tool output so the child is not listed twice', () => {
  const faces = projectTranscriptSubagents({
    messageOrder: ['msg'],
    partsByMessageID: {
      msg: [
        toolPart({
          id: 'task-1',
          state: {
            status: 'completed',
            input: { subagent_type: 'general', description: '查标题' },
            output: '<task_metadata>{"sessionID":"child-1"}</task_metadata>',
          },
        }),
      ],
    },
  });
  expect(faces[0]?.sessionID).toBe('child-1');
  expect(mergeWorkStatusSubagents(faces, [
    { id: 'child-1', title: '查标题', busy: false },
  ])).toEqual([
    { key: 'child-1', sessionID: 'child-1', seed: 'child-1', label: '查标题', phase: 'done' },
  ]);
});
