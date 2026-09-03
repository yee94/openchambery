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

  it('rejects stream:true instead of faking SSE after a full generate', async () => {
    const generateText = vi.fn()
    await expect(createChatCompletion({
      generateText,
      loadCatalog: async () => ({
        models: [{ providerID: 'openai', modelID: 'gpt-5.2' }],
        connected: ['openai'],
      }),
      body: {
        model: 'openai/gpt-5.2',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      },
    })).rejects.toMatchObject({ code: 'validation_error', statusCode: 400 })
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

  it('forwards optional file parts on user messages', async () => {
    const generateText = vi.fn(async () => ({ text: 'saw it', source: 'throwaway-session' }))
    const image = { type: 'file', mime: 'image/png', url: 'data:image/png;base64,aa', filename: 'shot.png' }
    await createChatCompletion({
      generateText,
      loadCatalog: async () => ({
        models: [{ providerID: 'openai', modelID: 'gpt-5.2' }],
        connected: ['openai'],
      }),
      body: {
        model: 'openai/gpt-5.2',
        messages: [{ role: 'user', content: 'look', parts: [image] }],
      },
    })
    expect(generateText.mock.calls[0][0].messages).toEqual([
      { role: 'user', content: 'look', parts: [image] },
    ])
  })

  it('LlmError carries a stable code', () => {
    expect(new LlmError('no_provider', 400, 'missing')).toMatchObject({
      code: 'no_provider',
      statusCode: 400,
    })
  })

  it('wraps generate failures as 502 with the OpenCode error message', async () => {
    const generateText = vi.fn(async () => {
      const error = new Error('model refused the request')
      error.code = 'upstream_error'
      throw error
    })
    await expect(createChatCompletion({
      generateText,
      loadCatalog: async () => ({
        models: [{ providerID: 'opencode', modelID: 'gpt-5-nano' }],
        connected: ['opencode'],
      }),
      body: { model: 'opencode/gpt-5-nano', messages: [{ role: 'user', content: 'hi' }] },
    })).rejects.toMatchObject({
      code: 'upstream_error',
      statusCode: 502,
      message: 'model refused the request',
    })
  })
})
