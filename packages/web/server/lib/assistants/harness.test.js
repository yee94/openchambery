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
  })
})

describe('runContactTurn', () => {
  it('runs pi-agent-core with thinking off and no tools', async () => {
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
})
