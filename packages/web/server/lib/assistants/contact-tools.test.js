import { describe, expect, it, vi } from 'vitest';
import { AssignError, ASSIGN_CODES, PROJECT_REQUIRED_MESSAGE } from './assign.js';
import {
  ASSIGN_SESSION_TOOL_NAME,
  CREATE_ASSISTANT_TOOL_NAME,
  SCHEDULE_TASK_TOOL_NAME,
  createContactTools,
  formatContactToolsPrompt,
  parseContactToolCalls,
  resolveContactProviderModel,
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

  it('parses create_assistant and schedule_task fences from natural-language replies', () => {
    const create = parseContactToolCalls(
      '好。\n\n```openchamber-tool\n{"name":"create_assistant","arguments":{"name":"FlowQA","model":"opencode-go/deepseek-v4-flash"}}\n```',
      [CREATE_ASSISTANT_TOOL_NAME, SCHEDULE_TASK_TOOL_NAME, ASSIGN_SESSION_TOOL_NAME],
    );
    expect(create.chatText).toBe('好。');
    expect(create.toolCall).toEqual({
      name: CREATE_ASSISTANT_TOOL_NAME,
      arguments: { name: 'FlowQA', model: 'opencode-go/deepseek-v4-flash' },
    });
    const schedule = parseContactToolCalls(
      '```openchamber-tool\n{"name":"schedule_task","arguments":{"name":"Daily ping","prompt":"ping","time":"18:00","timezone":"Asia/Shanghai"}}\n```',
      [CREATE_ASSISTANT_TOOL_NAME, SCHEDULE_TASK_TOOL_NAME],
    );
    expect(schedule.toolCall).toEqual({
      name: SCHEDULE_TASK_TOOL_NAME,
      arguments: { name: 'Daily ping', prompt: 'ping', time: '18:00', timezone: 'Asia/Shanghai' },
    });
  });

  it('ignores bash/edit tool fences', () => {
    const text = '```openchamber-tool\n{"name":"bash","arguments":{"command":"ls"}}\n```';
    expect(parseContactToolCalls(text, ['bash', ASSIGN_SESSION_TOOL_NAME]).toolCall).toBeNull();
  });

  it('tells DeepSeek to call tools from natural language, not slash commands', () => {
    const prompt = formatContactToolsPrompt(createContactTools());
    expect(prompt).toContain('create_assistant');
    expect(prompt).toContain('schedule_task');
    expect(prompt).toContain('assign_session');
    expect(prompt).toContain('建助理');
    expect(prompt).toContain('排定时任务');
    expect(prompt).not.toContain('/card');
    expect(prompt).not.toContain('/dm');
  });

  it('resolves provider/model from a combined OpenCode id', () => {
    expect(resolveContactProviderModel({ model: 'opencode-go/deepseek-v4-flash' })).toEqual({
      providerID: 'opencode-go',
      modelID: 'deepseek-v4-flash',
    });
    expect(resolveContactProviderModel({}, { providerID: 'p', modelID: 'm' })).toEqual({
      providerID: 'p',
      modelID: 'm',
    });
  });
});

describe('createContactTools', () => {
  it('exposes create_assistant, schedule_task, and assign_session and returns success cards', async () => {
    const onCard = vi.fn();
    const tools = createContactTools({
      createAssistant: async (input) => ({
        id: 'asst_flow',
        name: input.name,
        providerID: input.providerID,
        modelID: input.modelID,
        mode: 'continuous',
      }),
      scheduleTask: async (input) => ({
        taskID: 'task_1',
        projectID: 'proj_1',
        name: input.name,
        kind: 'daily',
        time: input.time,
        timezone: input.timezone,
        prompt: input.prompt,
      }),
      assignWork: async () => ({
        sessionID: 'ses_1',
        directory: '/repo',
        title: 'Login',
        status: 'busy',
      }),
      currentAssistant: { providerID: 'p', modelID: 'm' },
      onCard,
    });
    expect(tools.map((tool) => tool.name)).toEqual([
      CREATE_ASSISTANT_TOOL_NAME,
      SCHEDULE_TASK_TOOL_NAME,
      ASSIGN_SESSION_TOOL_NAME,
    ]);
    expect(tools.some((tool) => ['bash', 'edit', 'read', 'write'].includes(tool.name))).toBe(false);

    const created = await tools[0].execute('call_1', { name: 'FlowQA', model: 'opencode-go/deepseek-v4-flash' });
    expect(created.details.card).toMatchObject({
      type: 'card',
      cardType: 'assistant',
      assistantID: 'asst_flow',
      name: 'FlowQA',
      providerID: 'opencode-go',
      modelID: 'deepseek-v4-flash',
    });
    expect(created.terminate).toBe(false);

    const scheduled = await tools[1].execute('call_2', {
      name: 'Daily ping',
      prompt: 'ping',
      time: '18:00',
      timezone: 'Asia/Shanghai',
    });
    expect(scheduled.details.card).toMatchObject({
      type: 'card',
      cardType: 'schedule',
      taskID: 'task_1',
      name: 'Daily ping',
      time: '18:00',
    });

    const assigned = await tools[2].execute('call_3', { prompt: 'Fix login' });
    expect(assigned.details.card).toMatchObject({
      type: 'card',
      cardType: 'session',
      sessionID: 'ses_1',
      title: 'Login',
    });
    expect(onCard).toHaveBeenCalledTimes(3);
  });

  it('returns a clear project_required result instead of throwing', async () => {
    const tools = createContactTools({
      assignWork: async () => {
        throw new AssignError(ASSIGN_CODES.PROJECT_REQUIRED, PROJECT_REQUIRED_MESSAGE);
      },
    });
    const result = await tools.find((tool) => tool.name === ASSIGN_SESSION_TOOL_NAME).execute('call_1', { prompt: 'Fix login' });
    expect(result.details.error).toBe('project_required');
    expect(result.content[0].text).toContain('Add a project in Settings');
    expect(result.content[0].text).toContain('assistant-workspaces');
  });
});
