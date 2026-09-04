import { describe, expect, it, vi } from 'vitest'
import {
  CREATE_ASSISTANT_TOOL_NAME,
  MESSAGE_ASSISTANT_TOOL_NAME,
  MISSED_FENCE_RETRY_USER_TEXT,
  MISSED_TOOL_FAILURE_BUBBLE,
  createContactTools,
} from './contact-tools.js'
import { createContactStreamFn, runContactTurn } from './harness.js'

describe('createContactStreamFn', () => {
  it('forwards completion text as pi-ai text events', async () => {
    const createChatCompletion = vi.fn(async () => ({
      completion: { choices: [{ message: { content: 'Hi' } }] },
    }))
    const streamFn = createContactStreamFn(createChatCompletion)
    const events = []
    const stream = streamFn(
      { name: 'openai/gpt-5.2', id: 'gpt-5.2', provider: 'openchamber', api: 'openai-completions' },
      { messages: [{ role: 'user', content: 'hello', timestamp: 1 }] },
    )
    for await (const event of stream) events.push(event)
    expect(createChatCompletion).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        model: expect.any(String),
        messages: expect.any(Array),
      }),
    }))
    expect(createChatCompletion.mock.calls[0][0].body.stream).toBeUndefined()
    expect(events.some((event) => event.type === 'text_delta' && event.delta === 'Hi')).toBe(true)
    expect(events.at(-1).type).toBe('done')
    expect(typeof stream.result).toBe('function')
    await expect(stream.result()).resolves.toMatchObject({ stopReason: 'stop' })
  })

  it('forwards contact file parts on the last user completion message', async () => {
    const createChatCompletion = vi.fn(async () => ({
      completion: { choices: [{ message: { content: 'saw the image' } }] },
    }))
    const image = { type: 'file', mime: 'image/png', url: 'data:image/png;base64,aa', filename: 'shot.png' }
    const file = { type: 'file', mime: 'text/plain', url: 'data:text/plain;base64,eA==', filename: 'notes.txt' }
    const streamFn = createContactStreamFn(createChatCompletion, { pendingFileParts: [image, file] })
    const stream = streamFn(
      { name: 'openai/gpt-5.2', id: 'gpt-5.2', provider: 'openchamber', api: 'openai-completions' },
      { messages: [{ role: 'user', content: 'look', timestamp: 1 }] },
    )
    for await (const event of stream) void event
    expect(createChatCompletion.mock.calls[0][0].body.messages.at(-1)).toEqual({
      role: 'user',
      content: 'look',
      parts: [image, file],
    })
  })

  it('keeps thinking off and never installs bash/edit/read/write when sending attachments', async () => {
    const prompt = vi.fn(async function prompt() {
      this.state.messages = [{
        role: 'assistant',
        content: [{ type: 'text', text: 'Got it.' }],
      }]
    })
    function AgentImpl(options) {
      expect(options.initialState.thinkingLevel).toBe('off')
      expect(options.initialState.tools).toEqual([])
      this.state = { ...options.initialState, messages: [] }
      this.prompt = prompt
    }
    const result = await runContactTurn({
      assistant: { providerID: 'openai', modelID: 'gpt-5.2', defaultPrompt: '' },
      history: [],
      userText: '[attachment]',
      userParts: [{ type: 'file', mime: 'image/png', url: 'data:image/png;base64,aa', filename: 'shot.png' }],
      createChatCompletion: vi.fn(),
      AgentImpl,
    })
    expect(result.thinkingLevel).toBe('off')
    expect(result.tools).toEqual([])
    expect(prompt).toHaveBeenCalledWith('[attachment]')
  })

  it('replays an assign_session fence as a toolUse burst, not token SSE', async () => {
    const createChatCompletion = vi.fn(async () => ({
      completion: {
        choices: [{
          message: {
            content: 'On it.\n\n```openchamber-tool\n{"name":"assign_session","arguments":{"prompt":"Fix login"}}\n```',
          },
        }],
      },
    }))
    const streamFn = createContactStreamFn(createChatCompletion)
    const events = []
    const stream = streamFn(
      { name: 'openai/gpt-5.2', id: 'gpt-5.2', provider: 'openchamber', api: 'openai-completions' },
      {
        messages: [{ role: 'user', content: 'assign login', timestamp: 1 }],
        tools: [{ name: 'assign_session' }],
      },
    )
    for await (const event of stream) events.push(event)
    expect(events.some((event) => event.type === 'toolcall_end' && event.toolCall?.name === 'assign_session')).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'toolUse' })
    expect(createChatCompletion.mock.calls[0][0].body.stream).toBeUndefined()
  })

  it('replays a bare {name, arguments} object as a toolUse burst', async () => {
    const createChatCompletion = vi.fn(async () => ({
      completion: {
        choices: [{
          message: {
            content: '好的 {"name":"create_assistant","arguments":{"name":"FlowNL"}}',
          },
        }],
      },
    }))
    const streamFn = createContactStreamFn(createChatCompletion)
    const events = []
    const stream = streamFn(
      { name: 'opencode-go/deepseek-v4-flash', id: 'deepseek-v4-flash', provider: 'openchamber', api: 'openai-completions' },
      {
        messages: [{ role: 'user', content: '新建助理 FlowNL', timestamp: 1 }],
        tools: [{ name: 'create_assistant' }],
      },
    )
    for await (const event of stream) events.push(event)
    expect(events.some((event) => event.type === 'toolcall_end' && event.toolCall?.name === 'create_assistant')).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'toolUse' })
  })
})

describe('runContactTurn', () => {
  it('runs pi-agent-core with thinking off and no tools by default', async () => {
    const prompt = vi.fn(async function prompt() {
      this.state.messages = [{
        role: 'assistant',
        content: [{ type: 'text', text: 'Hey.\n\nI can open that session.' }],
      }]
    })
    function AgentImpl(options) {
      expect(options.initialState.thinkingLevel).toBe('off')
      expect(options.initialState.tools).toEqual([])
      this.state = { ...options.initialState, messages: [] }
      this.prompt = prompt
    }

    const result = await runContactTurn({
      assistant: { providerID: 'openai', modelID: 'gpt-5.2', defaultPrompt: '' },
      history: [],
      userText: 'open login',
      createChatCompletion: vi.fn(),
      AgentImpl,
    })
    expect(result.bubbles).toEqual(['Hey.', 'I can open that session.'])
    expect(prompt).toHaveBeenCalled()
  })

  it('attaches OpenChamber tools only and collects session cards from tool results', async () => {
    const assignTool = {
      name: 'assign_session',
      label: 'Assign session',
      description: 'Open a worker session',
      parameters: {},
      execute: vi.fn(),
    }
    function AgentImpl(options) {
      expect(options.initialState.thinkingLevel).toBe('off')
      expect(options.initialState.tools.map((tool) => tool.name)).toEqual(['assign_session'])
      expect(options.initialState.tools.some((tool) => ['bash', 'edit', 'read', 'write'].includes(tool.name))).toBe(false)
      expect(options.initialState.systemPrompt).toContain('assign_session')
      expect(options.initialState.systemPrompt).toContain('create_assistant')
      expect(options.initialState.systemPrompt).toContain('message_assistant')
      expect(options.initialState.systemPrompt).toContain('new_conversation')
      expect(options.initialState.systemPrompt).toContain('建助理')
      expect(options.initialState.systemPrompt).toContain('开新对话')
      expect(options.initialState.systemPrompt).toContain('说一声')
      expect(options.initialState.systemPrompt).toContain('A reply without the tool call does nothing')
      expect(options.initialState.systemPrompt).toContain('已创建')
      this.state = { ...options.initialState, messages: [] }
      this.prompt = async () => {
        this.state.messages = [
          { role: 'assistant', content: [{ type: 'text', text: 'Opening that.' }] },
          {
            role: 'toolResult',
            toolName: 'assign_session',
            content: [{ type: 'text', text: 'opened' }],
            details: {
              card: {
                type: 'card',
                cardType: 'session',
                sessionID: 'ses_1',
                directory: '/repo',
                title: 'Login',
                status: 'busy',
              },
            },
          },
        ]
      }
    }

    const result = await runContactTurn({
      assistant: { providerID: 'openai', modelID: 'gpt-5.2', defaultPrompt: '' },
      history: [],
      userText: 'assign login',
      createChatCompletion: vi.fn(),
      tools: [assignTool, { name: 'bash', execute: vi.fn() }],
      AgentImpl,
    })
    expect(result.bubbles).toEqual(['Opening that.'])
    expect(result.cards).toEqual([expect.objectContaining({ sessionID: 'ses_1', cardType: 'session' })])
    expect(result.thinkingLevel).toBe('off')
  })

  it('retries a missed fence once and then executes create_assistant', async () => {
    const createAssistant = vi.fn(async (input) => ({
      id: 'asst_flow',
      name: input.name,
      providerID: input.providerID,
      modelID: input.modelID,
      mode: 'continuous',
    }))
    const tools = createContactTools({
      createAssistant,
      currentAssistant: { providerID: 'opencode-go', modelID: 'deepseek-v4-flash' },
    })
    const prompts = []
    function AgentImpl(options) {
      expect(options.initialState.thinkingLevel).toBe('off')
      expect(options.initialState.tools.some((tool) => ['bash', 'edit', 'read', 'write'].includes(tool.name))).toBe(false)
      this.state = { ...options.initialState, messages: [] }
      this.prompt = async (text) => {
        prompts.push(text)
        this.state.messages.push({ role: 'user', content: text, timestamp: Date.now() })
        if (text === MISSED_FENCE_RETRY_USER_TEXT) {
          const tool = this.state.tools.find((item) => item.name === CREATE_ASSISTANT_TOOL_NAME)
          const result = await tool.execute('call_retry', { name: 'FlowNL', model: 'opencode-go/deepseek-v4-flash' })
          this.state.messages.push(
            { role: 'assistant', content: [{ type: 'text', text: '' }] },
            {
              role: 'toolResult',
              toolName: CREATE_ASSISTANT_TOOL_NAME,
              content: result.content,
              details: result.details,
            },
          )
          return
        }
        this.state.messages.push({
          role: 'assistant',
          content: [{ type: 'text', text: '好的，我来直接创建这个助理，不开编码会话。' }],
        })
      }
    }

    const result = await runContactTurn({
      assistant: { providerID: 'opencode-go', modelID: 'deepseek-v4-flash', defaultPrompt: '' },
      history: [],
      userText: '帮我新建一个助理，名叫 FlowNL，不要开编码 session',
      createChatCompletion: vi.fn(),
      tools,
      AgentImpl,
    })
    expect(prompts).toEqual([
      '帮我新建一个助理，名叫 FlowNL，不要开编码 session',
      MISSED_FENCE_RETRY_USER_TEXT,
    ])
    expect(createAssistant).toHaveBeenCalledWith({
      name: 'FlowNL',
      providerID: 'opencode-go',
      modelID: 'deepseek-v4-flash',
      mode: 'continuous',
    })
    expect(result.cards).toEqual([expect.objectContaining({
      cardType: 'assistant',
      name: 'FlowNL',
      assistantID: 'asst_flow',
    })])
    expect(result.bubbles.join('')).not.toContain('好的，我来直接创建')
    expect(result.bubbles.join('')).toContain('Created assistant FlowNL')
    expect(result.thinkingLevel).toBe('off')
  })

  it('does not fake a card when the missed-fence retry still has no tool', async () => {
    const createAssistant = vi.fn()
    const tools = createContactTools({
      createAssistant,
      currentAssistant: { providerID: 'opencode-go', modelID: 'deepseek-v4-flash' },
    })
    const prompts = []
    function AgentImpl(options) {
      this.state = { ...options.initialState, messages: [] }
      this.prompt = async (text) => {
        prompts.push(text)
        this.state.messages.push(
          { role: 'user', content: text, timestamp: Date.now() },
          { role: 'assistant', content: [{ type: 'text', text: '好的，已创建。' }] },
        )
      }
    }

    const result = await runContactTurn({
      assistant: { providerID: 'opencode-go', modelID: 'deepseek-v4-flash', defaultPrompt: '' },
      history: [],
      userText: '帮我新建一个助理，名叫 FlowNL',
      createChatCompletion: vi.fn(),
      tools,
      AgentImpl,
    })
    expect(prompts).toEqual([
      '帮我新建一个助理，名叫 FlowNL',
      MISSED_FENCE_RETRY_USER_TEXT,
    ])
    expect(createAssistant).not.toHaveBeenCalled()
    expect(result.cards).toEqual([])
    expect(result.bubbles).toEqual([MISSED_TOOL_FAILURE_BUBBLE])
    expect(result.bubbles.join('')).not.toContain('已创建')
  })

  it('retries a missed fence once and then executes message_assistant', async () => {
    const deliverPeerMessage = vi.fn(async (input) => ({
      admitted: true,
      role: 'peer',
      toAssistantID: input.toAssistantID,
    }))
    const tools = createContactTools({
      deliverPeerMessage,
      listAssistants: async () => [{ id: 'asst_peer', name: 'PeerQA' }],
      currentAssistant: { id: 'asst_host', name: 'DeepSeekQA', providerID: 'opencode-go', modelID: 'deepseek-v4-flash' },
    })
    const prompts = []
    function AgentImpl(options) {
      this.state = { ...options.initialState, messages: [] }
      this.prompt = async (text) => {
        prompts.push(text)
        this.state.messages.push({ role: 'user', content: text, timestamp: Date.now() })
        if (text === MISSED_FENCE_RETRY_USER_TEXT) {
          const tool = this.state.tools.find((item) => item.name === MESSAGE_ASSISTANT_TOOL_NAME)
          const result = await tool.execute('call_retry', { to: 'PeerQA', text: 'hello-from-assistant 写好了' })
          this.state.messages.push(
            { role: 'assistant', content: [{ type: 'text', text: '' }] },
            {
              role: 'toolResult',
              toolName: MESSAGE_ASSISTANT_TOOL_NAME,
              content: result.content,
              details: result.details,
            },
          )
          return
        }
        this.state.messages.push({
          role: 'assistant',
          content: [{ type: 'text', text: '好的，我去说一声。' }],
        })
      }
    }

    const result = await runContactTurn({
      assistant: { providerID: 'opencode-go', modelID: 'deepseek-v4-flash', defaultPrompt: '' },
      history: [],
      userText: '给 PeerQA 说一声 hello-from-assistant 写好了',
      createChatCompletion: vi.fn(),
      tools,
      AgentImpl,
    })
    expect(prompts).toEqual([
      '给 PeerQA 说一声 hello-from-assistant 写好了',
      MISSED_FENCE_RETRY_USER_TEXT,
    ])
    expect(deliverPeerMessage).toHaveBeenCalledWith({
      toAssistantID: 'asst_peer',
      text: 'hello-from-assistant 写好了',
    })
    expect(result.cards).toEqual([])
    expect(result.bubbles.join('')).toContain('Sent to PeerQA')
    expect(result.bubbles.join('')).not.toContain('好的，我去说一声')
  })
})
