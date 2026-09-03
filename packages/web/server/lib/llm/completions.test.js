import { describe, expect, it, vi } from 'vitest'
import { LlmError, createChatCompletion } from './completions.js'

describe('createChatCompletion', () => {
  it('rejects when the requested model is not connected', async () => {
    const generateText = vi.fn()
    await expect(createChatCompletion({
      generateText,
      loadCatalog: async () => ({
        models: [{ providerID: 'openai', modelID: 'gpt-5.2' }],
        connected: ['openai'],
      }),
      body: { model: 'anthropic/claude-sonnet-4', messages: [{ role: 'user', content: 'hi' }] },
    })).rejects.toMatchObject({ code: 'no_provider' })
    expect(generateText).not.toHaveBeenCalled()
  })

  it('returns a non-stream completion from generateText', async () => {
    const generateText = vi.fn(async () => ({ text: 'done', source: 'throwaway-session' }))
    const result = await createChatCompletion({
      generateText,
      loadCatalog: async () => ({
        models: [{ providerID: 'openai', modelID: 'gpt-5.2' }],
        connected: ['openai'],
      }),
      body: { model: 'openai/gpt-5.2', messages: [{ role: 'user', content: 'hi' }] },
    })
    expect(result.completion.choices[0].message.content).toBe('done')
    expect(result.providerID).toBe('openai')
    expect(result.modelID).toBe('gpt-5.2')
  })

  it('LlmError carries a stable code', () => {
    expect(new LlmError('no_provider', 400, 'missing')).toMatchObject({
      code: 'no_provider',
      statusCode: 400,
    })
  })
})
