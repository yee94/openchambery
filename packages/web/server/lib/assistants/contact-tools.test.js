import { describe, expect, it, vi } from 'vitest';
import { AssignError, ASSIGN_CODES, PROJECT_REQUIRED_MESSAGE } from './assign.js';
import {
  ASSIGN_SESSION_TOOL_NAME,
  createContactTools,
  parseContactToolCalls,
  stripContactToolFences,
} from './contact-tools.js';

describe('contact tool protocol', () => {
  it('parses an assign_session fence and strips it from chat text', () => {
    const text = 'On it.\n\n```openchamber-tool\n{"name":"assign_session","arguments":{"prompt":"Fix login","projectPath":"/repo"}}\n```';
    const parsed = parseContactToolCalls(text, [ASSIGN_SESSION_TOOL_NAME]);
    expect(parsed.chatText).toBe('On it.');
    expect(parsed.toolCall).toEqual({
      name: ASSIGN_SESSION_TOOL_NAME,
      arguments: { prompt: 'Fix login', projectPath: '/repo' },
    });
    expect(stripContactToolFences(text)).toBe('On it.');
  });

  it('ignores bash/edit tool fences', () => {
    const text = '```openchamber-tool\n{"name":"bash","arguments":{"command":"ls"}}\n```';
    expect(parseContactToolCalls(text, ['bash', ASSIGN_SESSION_TOOL_NAME]).toolCall).toBeNull();
  });
});

describe('createContactTools', () => {
  it('exposes only assign_session and returns a session card on success', async () => {
    const onCard = vi.fn();
    const tools = createContactTools({
      assignWork: async () => ({
        sessionID: 'ses_1',
        directory: '/repo',
        title: 'Login',
        status: 'busy',
      }),
      onCard,
    });
    expect(tools.map((tool) => tool.name)).toEqual([ASSIGN_SESSION_TOOL_NAME]);
    expect(tools.some((tool) => ['bash', 'edit', 'read', 'write'].includes(tool.name))).toBe(false);
    const result = await tools[0].execute('call_1', { prompt: 'Fix login' });
    expect(result.details.card).toMatchObject({
      type: 'card',
      cardType: 'session',
      sessionID: 'ses_1',
      title: 'Login',
    });
    expect(result.terminate).toBe(true);
    expect(onCard).toHaveBeenCalledWith(result.details.card);
  });

  it('returns a clear project_required result instead of throwing', async () => {
    const tools = createContactTools({
      assignWork: async () => {
        throw new AssignError(ASSIGN_CODES.PROJECT_REQUIRED, PROJECT_REQUIRED_MESSAGE);
      },
    });
    const result = await tools[0].execute('call_1', { prompt: 'Fix login' });
    expect(result.details.error).toBe('project_required');
    expect(result.content[0].text).toContain('Add a project in Settings');
    expect(result.content[0].text).toContain('assistant-workspaces');
  });
});
