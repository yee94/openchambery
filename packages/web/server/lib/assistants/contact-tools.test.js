import { describe, expect, it, vi } from 'vitest';
import { AssignError, ASSIGN_CODES, PROJECT_REQUIRED_MESSAGE } from './assign.js';
import {
  ASSIGN_DUPLICATE_TURN_MESSAGE,
  ASSIGN_SESSION_TOOL_NAME,
  CLEAR_CHAT_HISTORY_CONFIRM_BUBBLE,
  CLEAR_CHAT_HISTORY_TOOL_NAME,
  CREATE_ASSISTANT_TOOL_NAME,
  GET_ASSISTANT_SETTINGS_TOOL_NAME,
  LIST_PROJECTS_TOOL_NAME,
  LIST_SESSIONS_TOOL_NAME,
  MESSAGE_ASSISTANT_TOOL_NAME,
  NEW_CONVERSATION_CONFIRM_BUBBLE,
  NEW_CONVERSATION_TOOL_NAME,
  SCHEDULE_TASK_TOOL_NAME,
  UPDATE_DEFAULT_PROMPT_CONFIRM_BUBBLE,
  UPDATE_DEFAULT_PROMPT_TOOL_NAME,
  UPDATE_DEFAULT_PROMPT_UNCHANGED_BUBBLE,
  confirmBubbleAfterContactReset,
  contactTurnHasSuccessfulReset,
  createContactTools,
  detectRequestedContactTools,
  filterRegisteredProjects,
  formatConnectedModelsPrompt,
  formatContactToolsPrompt,
  formatRegisteredProjectsPrompt,
  matchesProjectQuery,
  normalizeAssignRequestKey,
  parseContactToolCalls,
  resolveContactProviderModel,
  resolvePeerAssistant,
  stripContactToolFences,
  userTextRequestsClearChatHistory,
} from './contact-tools.js';
import { attachmentScopeKey } from './assign.js';

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
    const tools = [
      NEW_CONVERSATION_TOOL_NAME,
      CLEAR_CHAT_HISTORY_TOOL_NAME,
      LIST_PROJECTS_TOOL_NAME,
      LIST_SESSIONS_TOOL_NAME,
      GET_ASSISTANT_SETTINGS_TOOL_NAME,
      UPDATE_DEFAULT_PROMPT_TOOL_NAME,
      CREATE_ASSISTANT_TOOL_NAME,
      SCHEDULE_TASK_TOOL_NAME,
      MESSAGE_ASSISTANT_TOOL_NAME,
      ASSIGN_SESSION_TOOL_NAME,
    ];
    expect(detectRequestedContactTools('帮我新建一个助理，名叫 FlowNL，不要开编码 session', tools)).toEqual([
      CREATE_ASSISTANT_TOOL_NAME,
    ]);
    expect(detectRequestedContactTools('每天 18:00 排一个 ping 定时任务', tools)).toEqual([SCHEDULE_TASK_TOOL_NAME]);
    expect(detectRequestedContactTools('建会话写一个文件', tools)).toEqual([ASSIGN_SESSION_TOOL_NAME]);
    expect(detectRequestedContactTools('对，你直接派给那个项目组，再建个会话去修这个问题', tools)).toEqual([ASSIGN_SESSION_TOOL_NAME]);
    expect(detectRequestedContactTools('写一个文件', tools)).toEqual([]);
    expect(detectRequestedContactTools('pwd', tools)).toEqual([]);
    expect(detectRequestedContactTools('给 PeerQA 说一声 hello-from-assistant 写好了', tools)).toEqual([
      MESSAGE_ASSISTANT_TOOL_NAME,
    ]);
    expect(detectRequestedContactTools('开新对话', tools)).toEqual([NEW_CONVERSATION_TOOL_NAME]);
    expect(detectRequestedContactTools('new conversation please', tools)).toEqual([NEW_CONVERSATION_TOOL_NAME]);
    expect(detectRequestedContactTools('clear chat', tools)).toEqual([NEW_CONVERSATION_TOOL_NAME]);
    expect(detectRequestedContactTools('清除记忆', tools)).toEqual([NEW_CONVERSATION_TOOL_NAME]);
    expect(detectRequestedContactTools('清空聊天记录', tools)).toEqual([CLEAR_CHAT_HISTORY_TOOL_NAME]);
    expect(detectRequestedContactTools('清除聊天记录', tools)).toEqual([CLEAR_CHAT_HISTORY_TOOL_NAME]);
    expect(detectRequestedContactTools('clear chat history', tools)).toEqual([CLEAR_CHAT_HISTORY_TOOL_NAME]);
    expect(detectRequestedContactTools('delete chat history', tools)).toEqual([CLEAR_CHAT_HISTORY_TOOL_NAME]);
    expect(detectRequestedContactTools('不要清除聊天记录', tools)).toEqual([]);
    expect(detectRequestedContactTools('do not clear chat history', tools)).toEqual([]);
    expect(detectRequestedContactTools('找项目 openchamber yee', tools)).toEqual([LIST_PROJECTS_TOOL_NAME]);
    expect(detectRequestedContactTools('看看现有对话', tools)).toEqual([LIST_SESSIONS_TOOL_NAME]);
    expect(detectRequestedContactTools('list sessions in that project', tools)).toEqual([LIST_SESSIONS_TOOL_NAME]);
    expect(detectRequestedContactTools('看看我的默认提示词', tools)).toEqual([GET_ASSISTANT_SETTINGS_TOOL_NAME]);
    expect(detectRequestedContactTools('看看 OpenCode 配置助手的默认提示词', tools)).toEqual([GET_ASSISTANT_SETTINGS_TOOL_NAME]);
    expect(detectRequestedContactTools('把默认提示词改成简洁中文', tools)).toEqual([UPDATE_DEFAULT_PROMPT_TOOL_NAME]);
    expect(detectRequestedContactTools('改 OpenCode 配置助手的默认提示词', tools)).toEqual([UPDATE_DEFAULT_PROMPT_TOOL_NAME]);
    expect(detectRequestedContactTools('update default prompt to be terse', tools)).toEqual([UPDATE_DEFAULT_PROMPT_TOOL_NAME]);
    expect(detectRequestedContactTools('开新对话', tools)).not.toContain(ASSIGN_SESSION_TOOL_NAME);
    expect(detectRequestedContactTools('开新对话', tools)).not.toContain(CLEAR_CHAT_HISTORY_TOOL_NAME);
    expect(detectRequestedContactTools('不要开编码 session', tools)).toEqual([]);
    expect(userTextRequestsClearChatHistory('清除聊天记录')).toBe(true);
    expect(userTextRequestsClearChatHistory('清空聊天记录')).toBe(true);
    expect(userTextRequestsClearChatHistory('清除记忆')).toBe(false);
    expect(userTextRequestsClearChatHistory('不要清除聊天记录')).toBe(false);
    expect(userTextRequestsClearChatHistory('开新对话')).toBe(false);
  });

  it('parses bash fences when the pi coding tools are allowed', () => {
    const text = '```openchamber-tool\n{"name":"bash","arguments":{"command":"pwd"}}\n```';
    expect(parseContactToolCalls(text, ['bash', ASSIGN_SESSION_TOOL_NAME]).toolCall).toEqual({
      name: 'bash',
      arguments: { command: 'pwd' },
    });
    expect(parseContactToolCalls(
      '```openchamber-tool\n{"name":"glob","arguments":{"pattern":"*"}}\n```',
      ['glob', 'bash'],
    ).toolCall).toBeNull();
  });

  it('tells DeepSeek to call tools from natural language, not slash commands', () => {
    const prompt = formatContactToolsPrompt(createContactTools());
    expect(prompt).toContain('new_conversation');
    expect(prompt).toContain('clear_chat_history');
    expect(prompt).toContain('list_projects');
    expect(prompt).toContain('list_sessions');
    expect(prompt).toContain('get_assistant_settings');
    expect(prompt).toContain('update_default_prompt');
    expect(prompt).toContain('create_assistant');
    expect(prompt).toContain('schedule_task');
    expect(prompt).toContain('message_assistant');
    expect(prompt).toContain('assign_session');
    expect(prompt).toContain('开新对话');
    expect(prompt).toContain('清除记忆');
    expect(prompt).toContain('清空聊天记录');
    expect(prompt).toContain('找项目');
    expect(prompt).toContain('现有对话');
    expect(prompt).toContain('默认提示词');
    expect(prompt).toContain('助手设定');
    expect(prompt).toContain('建助理');
    expect(prompt).toContain('排定时任务');
    expect(prompt).toContain('说一声');
    expect(prompt).toContain('session/new');
    expect(prompt).toContain('LLM memory only');
    expect(prompt).toContain('Persists');
    expect(prompt).toContain('later turns');
    expect(prompt).not.toContain('/card');
    expect(prompt).not.toContain('/dm');
    expect(prompt).toContain('A reply without the tool call does nothing');
    expect(prompt).toContain('已创建');
    expect(prompt).toContain('Never claim you cannot see projects');
    expect(prompt).toContain('One successful assign ends this turn');
    expect(prompt).toContain('application-owned OpenChamber contact tools');
    expect(prompt).toContain('arguments schema:');
    expect(prompt).toContain('"prompt"');
    expect(prompt).toContain('"projectPath"');
    expect(prompt).toContain('"providerID"');
    expect(prompt).toContain('"modelID"');
    expect(prompt).toContain('"model"');
    expect(prompt).toContain('connected catalog');
    expect(prompt).toContain('"to"');
    expect(prompt).toContain('"text"');
  });

  it('exposes connected models for assign worker selection without inventing ids', () => {
    const prompt = formatConnectedModelsPrompt([
      { providerID: 'xai', modelID: 'grok-4.6', name: 'Grok 4.6', acceptsImages: true },
      { providerID: 'opencode-go', modelID: 'deepseek-v4-flash', acceptsImages: false },
    ]);
    expect(prompt).toContain('xai');
    expect(prompt).toContain('grok-4.6');
    expect(prompt).toContain('acceptsImages=true');
    expect(prompt).toContain('does NOT change this contact');
    expect(formatConnectedModelsPrompt([])).toContain('none discoverable');
  });

  it('includes worker model and attachment scope in same-turn assign keys', () => {
    const scope = attachmentScopeKey([
      { type: 'file', mime: 'image/png', url: 'data:image/png;base64,aa', filename: 'a.png' },
    ]);
    const base = { prompt: 'Fix', projectPath: '/repo' };
    expect(normalizeAssignRequestKey(base)).not.toBe(normalizeAssignRequestKey({
      ...base,
      model: 'xai/grok-4.6',
    }));
    expect(normalizeAssignRequestKey({ ...base, attachmentScope: scope })).not.toBe(
      normalizeAssignRequestKey({ ...base, attachmentScope: [] }),
    );
  });

  it('fuzzy-matches project labels like openchamber yee / openchamer yee', () => {
    const project = { id: 'p1', path: '/Users/me/Code/sample-app', label: 'OpenChamber Yee' };
    expect(matchesProjectQuery(project, 'openchamber yee')).toBe(true);
    expect(matchesProjectQuery(project, 'openchamer yee')).toBe(true);
    expect(matchesProjectQuery(project, 'missing')).toBe(false);
    expect(filterRegisteredProjects([project, { id: 'p2', path: '/other' }], 'openchamber')).toEqual([
      { id: 'p1', path: '/Users/me/Code/sample-app', label: 'OpenChamber Yee' },
    ]);
    expect(formatRegisteredProjectsPrompt([project])).toContain('OpenChamber Yee');
    expect(formatRegisteredProjectsPrompt([project])).toContain('never say you cannot see registered projects');
    expect(formatRegisteredProjectsPrompt([])).toContain('none');
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
    const clearContactMemory = vi.fn(async () => ({ reset: true, memoryCleared: true }));
    const resetContact = vi.fn(async () => ({ reset: true, historyCleared: true }));
    const tools = createContactTools({
      clearContactMemory,
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
      CLEAR_CHAT_HISTORY_TOOL_NAME,
      LIST_PROJECTS_TOOL_NAME,
      LIST_SESSIONS_TOOL_NAME,
      GET_ASSISTANT_SETTINGS_TOOL_NAME,
      UPDATE_DEFAULT_PROMPT_TOOL_NAME,
      CREATE_ASSISTANT_TOOL_NAME,
      SCHEDULE_TASK_TOOL_NAME,
      MESSAGE_ASSISTANT_TOOL_NAME,
      ASSIGN_SESSION_TOOL_NAME,
    ]);
    expect(tools.some((tool) => ['bash', 'edit', 'read', 'write'].includes(tool.name))).toBe(false);

    const reset = await tools.find((tool) => tool.name === NEW_CONVERSATION_TOOL_NAME).execute('call_0', {});
    expect(clearContactMemory).toHaveBeenCalledTimes(1);
    expect(resetContact).not.toHaveBeenCalled();
    expect(reset.details.card).toBeUndefined();
    expect(reset.details).toMatchObject({ reset: true, memoryCleared: true });
    expect(reset.terminate).toBe(true);
    expect(reset.content[0].text).toBe(NEW_CONVERSATION_CONFIRM_BUBBLE);

    const wiped = await tools.find((tool) => tool.name === CLEAR_CHAT_HISTORY_TOOL_NAME).execute('call_wipe', {});
    expect(resetContact).toHaveBeenCalledTimes(1);
    expect(wiped.details).toMatchObject({ reset: true, historyCleared: true });
    expect(wiped.terminate).toBe(true);
    expect(wiped.content[0].text).toBe(CLEAR_CHAT_HISTORY_CONFIRM_BUBBLE);
    expect(wiped.content[0].text).not.toMatch(/not cleared|denied|new_conversation instead/i);
    expect(contactTurnHasSuccessfulReset([{
      role: 'toolResult',
      toolName: CLEAR_CHAT_HISTORY_TOOL_NAME,
      details: wiped.details,
    }])).toBe(true);

    // Storage failure still surfaces as a tool error (no silent denial protocol).
    resetContact.mockRejectedValueOnce(Object.assign(new Error('sqlite busy'), { code: 'upstream_error' }));
    const failed = await tools.find((tool) => tool.name === CLEAR_CHAT_HISTORY_TOOL_NAME).execute('call_wipe_fail', {});
    expect(failed.details.error).toBe('upstream_error');
    expect(failed.terminate).toBe(true);
    expect(contactTurnHasSuccessfulReset([{
      role: 'toolResult',
      toolName: CLEAR_CHAT_HISTORY_TOOL_NAME,
      details: failed.details,
    }])).toBe(false);

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
    expect(assigned.terminate).toBe(true);
    expect(onCard).toHaveBeenCalledTimes(3);
  });

  it('forwards server turn file parts on assign and keeps model selection in the tool args', async () => {
    const image = { type: 'file', mime: 'image/png', url: 'data:image/png;base64,aa', filename: 'shot.png' };
    const assignWork = vi.fn(async (params) => ({
      sessionID: 'ses_img',
      directory: '/repo',
      title: 'Shot',
      status: 'busy',
      model: { providerID: params.providerID, modelID: params.modelID },
    }));
    const tools = createContactTools({
      assignWork,
      turnFileParts: [image],
      turnAttachmentScope: attachmentScopeKey([image]),
    });
    const result = await tools.find((tool) => tool.name === ASSIGN_SESSION_TOOL_NAME).execute('call_img', {
      prompt: 'Fix card width',
      projectPath: '/repo',
      providerID: 'xai',
      modelID: 'grok-4.6',
    });
    expect(assignWork).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'Fix card width',
      providerID: 'xai',
      modelID: 'grok-4.6',
      fileParts: [image],
    }));
    expect(result.terminate).toBe(true);
  });

  it('same-turn assign gate caches identical success and rejects a different second assign', async () => {
    const assignWork = vi.fn(async () => ({
      sessionID: 'ses_once',
      directory: '/repo',
      title: 'Once',
      status: 'busy',
    }));
    const tools = createContactTools({ assignWork });
    const assign = tools.find((tool) => tool.name === ASSIGN_SESSION_TOOL_NAME);
    const args = { prompt: 'Fix login', projectPath: '/repo' };
    const first = await assign.execute('call_a', args);
    const secondSame = await assign.execute('call_b', { ...args });
    expect(assignWork).toHaveBeenCalledTimes(1);
    expect(secondSame.details.assigned.sessionID).toBe('ses_once');
    expect(secondSame.terminate).toBe(true);
    expect(normalizeAssignRequestKey(args)).toBe(normalizeAssignRequestKey({ ...args, title: '  ' }));
    const different = await assign.execute('call_c', { prompt: 'Other work', projectPath: '/repo' });
    expect(different.details.error).toBe('validation_error');
    expect(different.content[0].text).toContain(ASSIGN_DUPLICATE_TURN_MESSAGE);
    expect(different.terminate).toBe(true);
    expect(assignWork).toHaveBeenCalledTimes(1);
  });

  it('same-turn assign gate treats different worker models as distinct requests after success', async () => {
    const assignWork = vi.fn(async () => ({
      sessionID: 'ses_model',
      directory: '/repo',
      title: 'M',
      status: 'busy',
    }));
    const tools = createContactTools({ assignWork });
    const assign = tools.find((tool) => tool.name === ASSIGN_SESSION_TOOL_NAME);
    await assign.execute('call_1', { prompt: 'Fix', projectPath: '/repo', model: 'xai/grok-4.6' });
    const second = await assign.execute('call_2', { prompt: 'Fix', projectPath: '/repo', model: 'openai/gpt-4o' });
    expect(second.details.error).toBe('validation_error');
    expect(assignWork).toHaveBeenCalledTimes(1);
  });

  it('prompt_ambiguous keeps recoverable sessionID/messageID and blocks a different create this turn', async () => {
    let calls = 0;
    const assignWork = vi.fn(async (params) => {
      calls += 1;
      if (calls === 1) {
        throw new AssignError(
          ASSIGN_CODES.PROMPT_AMBIGUOUS,
          'admission unknown',
          { ambiguous: true, sessionID: 'ses_amb', messageID: 'msg_amb' },
        );
      }
      expect(params.sessionID).toBe('ses_amb');
      expect(params.messageID).toBe('msg_amb');
      return { sessionID: 'ses_amb', directory: '/repo', title: 'A', status: 'busy', messageID: 'msg_amb' };
    });
    const tools = createContactTools({ assignWork });
    const assign = tools.find((tool) => tool.name === ASSIGN_SESSION_TOOL_NAME);
    const args = { prompt: 'Fix', projectPath: '/repo' };
    const failed = await assign.execute('call_a', args);
    expect(failed.details).toMatchObject({
      error: 'prompt_ambiguous',
      ambiguous: true,
      sessionID: 'ses_amb',
      messageID: 'msg_amb',
    });
    expect(failed.terminate).toBe(true);
    const other = await assign.execute('call_b', { prompt: 'Other', projectPath: '/repo' });
    expect(other.details.error).toBe('validation_error');
    expect(assignWork).toHaveBeenCalledTimes(1);
    const recovered = await assign.execute('call_c', args);
    expect(assignWork).toHaveBeenCalledTimes(2);
    expect(recovered.details.assigned.sessionID).toBe('ses_amb');
    expect(recovered.terminate).toBe(true);
  });

  it('same-turn parallel identical assigns share one worker create', async () => {
    let release;
    const barrier = new Promise((resolve) => { release = resolve; });
    const assignWork = vi.fn(async () => {
      await barrier;
      return { sessionID: 'ses_parallel', directory: '/repo', title: 'P', status: 'busy' };
    });
    const tools = createContactTools({ assignWork });
    const assign = tools.find((tool) => tool.name === ASSIGN_SESSION_TOOL_NAME);
    const args = { prompt: 'Fix', projectPath: '/repo' };
    const pending = Promise.all([
      assign.execute('call_1', args),
      assign.execute('call_2', args),
    ]);
    release();
    const [a, b] = await pending;
    expect(assignWork).toHaveBeenCalledTimes(1);
    expect(a.details.assigned.sessionID).toBe('ses_parallel');
    expect(b.details.assigned.sessionID).toBe('ses_parallel');
    expect(a.terminate).toBe(true);
    expect(b.terminate).toBe(true);
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

  it('lists projects and sessions and surfaces list_sessions failure', async () => {
    const tools = createContactTools({
      listProjects: async () => [
        { id: 'proj_yee', path: '/repo/sample-app', label: 'OpenChamber Yee' },
        { id: 'proj_other', path: '/repo/other', label: 'Other' },
      ],
      listSessions: async () => ({
        sessions: [
          { sessionID: 'ses_1', title: 'Login fix', directory: '/repo/sample-app', updatedAt: 2 },
        ],
        truncated: false,
      }),
    });
    const listed = await tools.find((tool) => tool.name === LIST_PROJECTS_TOOL_NAME).execute('call_p', {
      query: 'openchamer yee',
    });
    expect(listed.details.projects).toEqual([
      { id: 'proj_yee', path: '/repo/sample-app', label: 'OpenChamber Yee' },
    ]);
    const sessions = await tools.find((tool) => tool.name === LIST_SESSIONS_TOOL_NAME).execute('call_s', {
      projectPath: '/repo/sample-app',
    });
    expect(sessions.details.sessions).toEqual([
      expect.objectContaining({ sessionID: 'ses_1', title: 'Login fix' }),
    ]);

    const failing = createContactTools({
      listSessions: async () => {
        throw new AssignError(ASSIGN_CODES.UPSTREAM, 'Session index is unavailable.');
      },
    });
    const failed = await failing.find((tool) => tool.name === LIST_SESSIONS_TOOL_NAME).execute('call_fail', {});
    expect(failed.details.error).toBe('upstream_error');
    expect(failed.content[0].text).toContain('Session index is unavailable');
    expect(failed.details.sessions).toBeUndefined();
  });

  it('reads assistant settings via live callback and formats empty defaultPrompt', async () => {
    const readAssistantSettings = vi.fn(async () => ({
      id: 'asst_host',
      name: 'DeepSeekQA',
      defaultPrompt: '',
      providerID: 'p',
      modelID: 'm',
      agent: null,
      variant: null,
      mode: 'continuous',
      workspacePath: null,
      enabled: true,
    }));
    const tools = createContactTools({ readAssistantSettings });
    const result = await tools.find((tool) => tool.name === GET_ASSISTANT_SETTINGS_TOOL_NAME).execute('call_get', {});
    expect(readAssistantSettings).toHaveBeenCalledTimes(1);
    expect(result.details.settings).toMatchObject({
      id: 'asst_host',
      name: 'DeepSeekQA',
      defaultPrompt: '',
      providerID: 'p',
      modelID: 'm',
      enabled: true,
    });
    expect(result.content[0].text).toContain('defaultPrompt: (empty)');
    expect(result.terminate).toBe(false);
  });

  it('updates default prompt, no-ops when unchanged, and reports callback failures', async () => {
    const updateAssistantSettings = vi.fn(async ({ defaultPrompt }) => {
      if (defaultPrompt === 'same') {
        return { updated: false, unchanged: true, defaultPrompt: 'same' };
      }
      return { updated: true, defaultPrompt };
    });
    const tools = createContactTools({ updateAssistantSettings });
    const update = tools.find((tool) => tool.name === UPDATE_DEFAULT_PROMPT_TOOL_NAME);

    const saved = await update.execute('call_set', { prompt: 'Be terse.' });
    expect(updateAssistantSettings).toHaveBeenCalledWith({ defaultPrompt: 'Be terse.' });
    expect(saved.details).toEqual({ updated: true, defaultPrompt: 'Be terse.' });
    expect(saved.content[0].text).toBe(UPDATE_DEFAULT_PROMPT_CONFIRM_BUBBLE);
    expect(saved.terminate).toBe(false);

    const cleared = await update.execute('call_clear', { prompt: '' });
    expect(updateAssistantSettings).toHaveBeenCalledWith({ defaultPrompt: '' });
    expect(cleared.details).toEqual({ updated: true, defaultPrompt: '' });
    expect(cleared.terminate).toBe(false);

    const unchanged = await update.execute('call_same', { prompt: 'same' });
    expect(unchanged.details).toEqual({ updated: false, unchanged: true, defaultPrompt: 'same' });
    expect(unchanged.content[0].text).toBe(UPDATE_DEFAULT_PROMPT_UNCHANGED_BUBBLE);
    expect(unchanged.terminate).toBe(false);

    const missing = await update.execute('call_missing', {});
    expect(missing.details.error).toBe('validation_error');
    expect(missing.terminate).toBe(true);

    updateAssistantSettings.mockRejectedValueOnce(Object.assign(new Error('revision_conflict'), { code: 'revision_conflict' }));
    const conflicted = await update.execute('call_conflict', { prompt: 'X' });
    expect(conflicted.details.error).toBe('revision_conflict');
    expect(conflicted.terminate).toBe(true);

    updateAssistantSettings.mockRejectedValueOnce(Object.assign(new Error('sqlite busy'), { code: 'upstream_error' }));
    const storageFailed = await update.execute('call_storage', { prompt: 'Y' });
    expect(storageFailed.details.error).toBe('upstream_error');
    expect(storageFailed.terminate).toBe(true);
  });

  it('reads and updates another assistant defaultPrompt by name without changing self', async () => {
    const peer = {
      id: 'asst_peer',
      name: 'OpenCode 配置助手',
      defaultPrompt: 'old peer',
      providerID: 'p',
      modelID: 'm',
      agent: null,
      variant: null,
      mode: 'continuous',
      workspacePath: null,
      enabled: true,
    };
    const host = {
      id: 'asst_host',
      name: 'Host',
      defaultPrompt: 'host prompt',
      providerID: 'p',
      modelID: 'm',
      agent: null,
      variant: null,
      mode: 'continuous',
      workspacePath: null,
      enabled: true,
    };
    const readAssistantSettings = vi.fn(async (input) => (
      input?.assistantID === 'asst_peer' ? peer : host
    ));
    const updateAssistantSettings = vi.fn(async (patch) => ({
      updated: true,
      defaultPrompt: patch.defaultPrompt,
    }));
    const listAssistants = vi.fn(async () => [host, peer]);
    const tools = createContactTools({
      readAssistantSettings,
      updateAssistantSettings,
      listAssistants,
      currentAssistant: host,
    });

    const got = await tools.find((tool) => tool.name === GET_ASSISTANT_SETTINGS_TOOL_NAME)
      .execute('call_peer_get', { to: 'OpenCode 配置助手' });
    expect(readAssistantSettings).toHaveBeenCalledWith({ assistantID: 'asst_peer' });
    expect(got.details.settings).toMatchObject({ id: 'asst_peer', name: 'OpenCode 配置助手', defaultPrompt: 'old peer' });

    const saved = await tools.find((tool) => tool.name === UPDATE_DEFAULT_PROMPT_TOOL_NAME)
      .execute('call_peer_set', { to: 'OpenCode 配置助手', prompt: 'new peer persona' });
    expect(updateAssistantSettings).toHaveBeenCalledWith({
      defaultPrompt: 'new peer persona',
      assistantID: 'asst_peer',
    });
    expect(saved.details).toMatchObject({
      updated: true,
      defaultPrompt: 'new peer persona',
      assistantID: 'asst_peer',
      name: 'OpenCode 配置助手',
    });

    const missing = await tools.find((tool) => tool.name === UPDATE_DEFAULT_PROMPT_TOOL_NAME)
      .execute('call_missing_peer', { to: '没有这个助手', prompt: 'x' });
    expect(missing.details.error).toBe('not_found');
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

  it('uses the canonical confirm when leftover text is the only extracted bubble', () => {
    expect(confirmBubbleAfterContactReset([
      'I still see your dot.png and note.txt from earlier.',
    ])).toEqual([NEW_CONVERSATION_CONFIRM_BUBBLE]);
  });

  it('prefers the clear-history confirm when that tool ran', () => {
    expect(confirmBubbleAfterContactReset([
      CLEAR_CHAT_HISTORY_CONFIRM_BUBBLE,
      'I still see older cards.',
    ], CLEAR_CHAT_HISTORY_CONFIRM_BUBBLE)).toEqual([CLEAR_CHAT_HISTORY_CONFIRM_BUBBLE]);
    expect(confirmBubbleAfterContactReset([
      'leftover only',
    ], CLEAR_CHAT_HISTORY_CONFIRM_BUBBLE)).toEqual([CLEAR_CHAT_HISTORY_CONFIRM_BUBBLE]);
  });
});
