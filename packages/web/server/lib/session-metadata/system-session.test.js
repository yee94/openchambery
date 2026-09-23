import { describe, expect, it } from 'vitest';
import {
  LLM_SESSION_PURPOSE,
  buildAssistantSessionMetadata,
  buildLlmSessionMetadata,
  buildScheduledTaskMetadata,
} from './system-session.js';

describe('system session metadata builders', () => {
  it('builds scheduled-task isolation from a non-empty taskID', () => {
    expect(buildScheduledTaskMetadata({
      projectID: 'project-1',
      taskID: 'task-1',
      runID: 'run-1',
      name: 'Morning Sync',
    })).toEqual({
      openchamber: {
        scheduledTask: {
          taskID: 'task-1',
          projectID: 'project-1',
          runID: 'run-1',
          name: 'Morning Sync',
        },
      },
    });
  });

  it('refuses scheduled-task metadata without taskID', () => {
    expect(() => buildScheduledTaskMetadata({ projectID: 'project-1' })).toThrow(/taskID/);
  });

  it('builds llm isolation with the chat-completions purpose', () => {
    expect(buildLlmSessionMetadata()).toEqual({
      openchamber: { llm: { purpose: LLM_SESSION_PURPOSE } },
    });
    expect(buildLlmSessionMetadata('  ')).toEqual({
      openchamber: { llm: { purpose: LLM_SESSION_PURPOSE } },
    });
  });

  it('builds assistant isolation from a non-empty assistantID', () => {
    expect(buildAssistantSessionMetadata({
      assistantID: 'assistant_1',
      name: 'Ops',
    })).toEqual({
      openchamber: {
        assistant: { assistantID: 'assistant_1', name: 'Ops' },
      },
    });
  });

  it('refuses assistant metadata without assistantID', () => {
    expect(() => buildAssistantSessionMetadata({ name: 'Ops' })).toThrow(/assistantID/);
  });
});
