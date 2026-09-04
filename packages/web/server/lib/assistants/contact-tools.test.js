import { describe, expect, it, vi } from 'vitest';
import { AssignError, ASSIGN_CODES, PROJECT_REQUIRED_MESSAGE } from './assign.js';
import {
  ASSIGN_SESSION_TOOL_NAME,
  CREATE_ASSISTANT_TOOL_NAME,
  MESSAGE_ASSISTANT_TOOL_NAME,
  NEW_CONVERSATION_CONFIRM_BUBBLE,
  NEW_CONVERSATION_TOOL_NAME,
  SCHEDULE_TASK_TOOL_NAME,
  confirmBubbleAfterContactReset,
  createContactTools,
  detectRequestedContactTools,
  formatContactToolsPrompt,
  parseContactToolCalls,
  resolveContactProviderModel,
  resolvePeerAssistant,
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
    const peer = parseContactToolCalls(
      '```openchamber-tool\n{"name":"message_assistant","arguments":{"to":"PeerQA","text":"hello-from-assistant 写好了"}}\n```',
      [MESSAGE_ASSISTANT_TOOL_NAME],
    );
    expect(peer.toolCall).toEqual({
      name: MESSAGE_ASSISTANT_TOOL_NAME,
      arguments: { to: 'PeerQA', text: 'hello-from-assistant 写好了' },
    });
    expect(schedule.toolCall).toEqual({
      name: SCHEDULE_TASK_TOOL_NAME,
      arguments: { name: 'Daily ping', prompt: 'ping', time: '18:00', timezone: 'Asia/Shanghai' },
    });
  });

  it('parses a bare {name, arguments} object anywhere in the assistant text', () => {
    const parsed = parseContactToolCalls(
      '好的，我来直接创建这个助理，不开编码会话。\n{"name":"create_assistant","arguments":{"name":"FlowNL","model":"opencode-go/deepseek-v4-flash"}}',
      [CREATE_ASSISTANT_TOOL_NAME, ASSIGN_SESSION_TOOL_NAME],
    );
    expect(parsed.toolCall).toEqual({
      name: CREATE_ASSISTANT_TOOL_NAME,
      arguments: { name: 'FlowNL', model: 'opencode-go/deepseek-v4-flash' },
    });
    expect(parsed.chatText).toContain('好的，我来直接创建这个助理');
    expect(parsed.chatText).not.toContain('create_assistant');
  });

  it('detects 建助理 without treating 不要开编码 session as assign_session', () => {
    const tools = [NEW_CONVERSATION_TOOL_NAME, CREATE_ASSISTANT_TOOL_NAME, SCHEDULE_TASK_TOOL_NAME, MESSAGE_ASSISTANT_TOOL_NAME, ASSIGN_SESSION_TOOL_NAME];
    expect(detectRequestedContactTools('帮我新建一个助理，名叫 FlowNL，不要开编码 session', tools)).toEqual([
      CREATE_ASSISTANT_TOOL_NAME,
    ]);
    expect(detectRequestedContactTools('每天 18:00 排一个 ping 定时任务', tools)).toEqual([SCHEDULE_TASK_TOOL_NAME]);
    expect(detectRequestedContactTools('建会话写一个文件', tools)).toEqual([ASSIGN_SESSION_TOOL_NAME]);
    expect(detectRequestedContactTools('给 PeerQA 说一声 hello-from-assistant 写好了', tools)).toEqual([
      MESSAGE_ASSISTANT_TOOL_NAME,
    ]);
    expect(detectRequestedContactTools('开新对话', tools)).toEqual([NEW_CONVERSATION_TOOL_NAME]);
    expect(detectRequestedContactTools('new conversation please', tools)).toEqual([NEW_CONVERSATION_TOOL_NAME]);
    expect(detectRequestedContactTools('clear chat', tools)).toEqual([NEW_CONVERSATION_TOOL_NAME]);
    expect(detectRequestedContactTools('开新对话', tools)).not.toContain(ASSIGN_SESSION_TOOL_NAME);
    expect(detectRequestedContactTools('不要开编码 session', tools)).toEqual([]);
  });

  it('ignores bash/edit tool fences', () => {
    const text = '```openchamber-tool\n{"name":"bash","arguments":{"command":"ls"}}\n```';
    expect(parseContactToolCalls(text, ['bash', ASSIGN_SESSION_TOOL_NAME]).toolCall).toBeNull();
  });

  it('tells DeepSeek to call tools from natural language, not slash commands', () => {
    const prompt = formatContactToolsPrompt(createContactTools());
    expect(prompt).toContain('new_conversation');
    expect(prompt).toContain('create_assistant');
    expect(prompt).toContain('schedule_task');
    expect(prompt).toContain('message_assistant');
    expect(prompt).toContain('assign_session');
    expect(prompt).toContain('开新对话');
    expect(prompt).toContain('建助理');
    expect(prompt).toContain('排定时任务');
    expect(prompt).toContain('说一声');
    expect(prompt).toContain('session/new');
    expect(prompt).not.toContain('/card');
    expect(prompt).not.toContain('/dm');
    expect(prompt).toContain('A reply without the tool call does nothing');
    expect(prompt).toContain('已创建');
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
    const resetContact = vi.fn(async () => ({ reset: true }));
    const tools = createContactTools({
      resetContact,
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
      deliverPeerMessage: async (input) => ({
        admitted: true,
        role: 'peer',
        toAssistantID: input.toAssistantID,
      }),
      listAssistants: async () => [{ id: 'asst_peer', name: 'PeerQA' }],
      currentAssistant: { id: 'asst_host', providerID: 'p', modelID: 'm' },
      onCard,
    });
    expect(tools.map((tool) => tool.name)).toEqual([
      NEW_CONVERSATION_TOOL_NAME,
      CREATE_ASSISTANT_TOOL_NAME,
      SCHEDULE_TASK_TOOL_NAME,
      MESSAGE_ASSISTANT_TOOL_NAME,
      ASSIGN_SESSION_TOOL_NAME,
    ]);
    expect(tools.some((tool) => ['bash', 'edit', 'read', 'write'].includes(tool.name))).toBe(false);

    const reset = await tools.find((tool) => tool.name === NEW_CONVERSATION_TOOL_NAME).execute('call_0', {});
    expect(resetContact).toHaveBeenCalledTimes(1);
    expect(reset.details.card).toBeUndefined();
    expect(reset.details.reset).toBe(true);
    expect(reset.terminate).toBe(true);
    expect(reset.content[0].text).toBe(NEW_CONVERSATION_CONFIRM_BUBBLE);

    const created = await tools.find((tool) => tool.name === CREATE_ASSISTANT_TOOL_NAME).execute('call_1', { name: 'FlowQA', model: 'opencode-go/deepseek-v4-flash' });
    expect(created.details.card).toMatchObject({
      type: 'card',
      cardType: 'assistant',
      assistantID: 'asst_flow',
      name: 'FlowQA',
      providerID: 'opencode-go',
      modelID: 'deepseek-v4-flash',
    });
    expect(created.terminate).toBe(false);

    const scheduled = await tools.find((tool) => tool.name === SCHEDULE_TASK_TOOL_NAME).execute('call_2', {
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

    const messaged = await tools.find((tool) => tool.name === MESSAGE_ASSISTANT_TOOL_NAME).execute('call_3', {
      to: 'PeerQA',
      text: 'hello-from-assistant 写好了',
    });
    expect(messaged.details.card).toBeUndefined();
    expect(messaged.content[0].text).toContain('Sent to PeerQA');
    expect(messaged.details.toAssistantID).toBe('asst_peer');

    const assigned = await tools.find((tool) => tool.name === ASSIGN_SESSION_TOOL_NAME).execute('call_4', { prompt: 'Fix login' });
    expect(assigned.details.card).toMatchObject({
      type: 'card',
      cardType: 'session',
      sessionID: 'ses_1',
      title: 'Login',
    });
    expect(onCard).toHaveBeenCalledTimes(3);
  });

  it('resolves a peer by name and rejects a missing recipient', () => {
    const listed = [{ id: 'asst_peer', name: 'PeerQA' }, { id: 'asst_host', name: 'DeepSeekQA' }];
    expect(resolvePeerAssistant({ to: 'PeerQA' }, listed, { id: 'asst_host' })).toEqual(listed[0]);
    expect(() => resolvePeerAssistant({ to: 'Missing' }, listed, { id: 'asst_host' })).toThrow(/No assistant named/);
    expect(() => resolvePeerAssistant({ to: 'DeepSeekQA' }, listed, { id: 'asst_host' })).toThrow(/same assistant/);
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

describe('confirmBubbleAfterContactReset', () => {
  it('keeps the canonical confirm and drops leftover attachment bubbles', () => {
    expect(confirmBubbleAfterContactReset([
      NEW_CONVERSATION_CONFIRM_BUBBLE,
      'I still see your dot.png and note.txt.',
      'Those attachments are still in context.',
    ])).toEqual([NEW_CONVERSATION_CONFIRM_BUBBLE]);
  });

  it('falls back to the first confirm bubble when the canonical string is absent', () => {
    expect(confirmBubbleAfterContactReset([
      '好，已开新对话。',
      'dot.png is still here',
    ])).toEqual(['好，已开新对话。']);
  });
});
