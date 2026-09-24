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
    { id: 'done-task', sessionID: undefined, label: 'Explore', running: false },
    { id: 'live-task', sessionID: undefined, label: 'Review', running: true },
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
    { key: 'task-1', sessionID: 'child-1', seed: 'task-1', label: 'Explore', phase: 'working' },
    { key: 'sub-2', sessionID: 'child-2', seed: 'sub-2', label: 'Plan', phase: 'done' },
    { key: 'child-3', sessionID: 'child-3', seed: 'child-3', label: 'Only child', phase: 'done' },
  ]);
});

it('treats a linked session as working when its status is busy and the catalog row is missing', () => {
  const merged = mergeWorkStatusSubagents(
    [{ id: 'task-1', sessionID: 'child-1', label: 'Explore', running: false }],
    [],
    new Set(['child-1']),
  );
  expect(merged).toEqual([
    { key: 'task-1', sessionID: 'child-1', seed: 'task-1', label: 'Explore', phase: 'working' },
  ]);
});

it('orders working faces ahead of completed ones', () => {
  const merged = mergeWorkStatusSubagents(
    [
      { id: 'done', label: 'Done agent', running: false },
      { id: 'live', label: 'Live agent', running: true },
    ],
    [],
  );
  expect(merged.map((face) => face.key)).toEqual(['live', 'done']);
});
