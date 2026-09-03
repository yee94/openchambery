import { describe, expect, it, vi } from 'vitest'
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
})
