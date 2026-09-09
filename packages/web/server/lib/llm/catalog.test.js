import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CONNECTED_CATALOG_TIMEOUT_MS,
  loadConnectedCatalog,
  modelAcceptsImages,
  parseModelRef,
  projectConnectedModels,
} from './catalog.js'

describe('parseModelRef', () => {
  it('splits provider/model refs', () => {
    expect(parseModelRef('openai/gpt-5.2')).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.2',
    })
  })

  it('prefers explicit providerID/modelID', () => {
    expect(parseModelRef('ignored', 'anthropic', 'claude-sonnet-4')).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4',
    })
  })

  it('returns null for invalid refs', () => {
    expect(parseModelRef('')).toBeNull()
    expect(parseModelRef('openai')).toBeNull()
  })
})

describe('modelAcceptsImages', () => {
  it('prefers authoritative SDK capabilities.input.image (Grok-shaped)', () => {
    // Real OpenCode Model shape from types.gen Model.capabilities
    expect(modelAcceptsImages({
      id: 'grok-4.6',
      name: 'Grok 4.6',
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
    })).toBe(true)

    expect(modelAcceptsImages({
      id: 'deepseek-v4-flash',
      capabilities: {
        temperature: false,
        reasoning: false,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
    })).toBe(false)
  })

  it('does not let legacy attachment override explicit capabilities.input.image=false', () => {
    expect(modelAcceptsImages({
      attachment: true,
      modalities: { input: ['text', 'image'] },
      capabilities: {
        attachment: false,
        input: { text: true, image: false },
      },
    })).toBe(false)
  })

  it('falls back to legacy modalities/attachment when capabilities are absent', () => {
    expect(modelAcceptsImages({ modalities: { input: ['text', 'image'] } })).toBe(true)
    expect(modelAcceptsImages({ input: ['image'] })).toBe(true)
    expect(modelAcceptsImages({ attachment: true })).toBe(true)
    expect(modelAcceptsImages({ id: 'plain' })).toBe(false)
  })
})

describe('projectConnectedModels', () => {
  it('projects only connected providers', () => {
    const catalog = projectConnectedModels({
      connected: ['openai'],
      providers: [
        {
          id: 'openai',
          name: 'OpenAI',
          models: {
            'gpt-5.2': { id: 'gpt-5.2', name: 'GPT-5.2' },
          },
        },
        {
          id: 'anthropic',
          name: 'Anthropic',
          models: { 'claude-sonnet-4': { id: 'claude-sonnet-4', name: 'Claude' } },
        },
      ],
    })
    expect(catalog.models).toEqual([
      { providerID: 'openai', modelID: 'gpt-5.2', name: 'GPT-5.2', acceptsImages: false },
    ])
  })

  it('marks vision from SDK capabilities and legacy modalities', () => {
    const catalog = projectConnectedModels({
      connected: ['openai', 'xai'],
      providers: [
        {
          id: 'openai',
          name: 'OpenAI',
          models: {
            'gpt-4o': { id: 'gpt-4o', name: 'GPT-4o', modalities: { input: ['text', 'image'] } },
            'deepseek-v4-flash': { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash' },
          },
        },
        {
          id: 'xai',
          name: 'xAI',
          models: {
            'grok-4.6': {
              id: 'grok-4.6',
              name: 'Grok 4.6',
              // Authoritative SDK shape — no modalities.input array
              capabilities: {
                temperature: true,
                reasoning: true,
                attachment: true,
                toolcall: true,
                input: { text: true, audio: false, image: true, video: false, pdf: false },
                output: { text: true, audio: false, image: false, video: false, pdf: false },
                interleaved: false,
              },
            },
          },
        },
      ],
    })
    expect(catalog.models.find((model) => model.modelID === 'gpt-4o')?.acceptsImages).toBe(true)
    expect(catalog.models.find((model) => model.modelID === 'grok-4.6')?.acceptsImages).toBe(true)
    expect(catalog.models.find((model) => model.modelID === 'deepseek-v4-flash')?.acceptsImages).toBe(false)
    expect(catalog.connected).toEqual(['openai', 'xai'])
  })
})

describe('loadConnectedCatalog', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('requires both /provider and /config/providers', async () => {
    await expect(loadConnectedCatalog({
      provider: { list: async () => ({ data: { connected: ['openai'] } }) },
      config: { providers: async () => ({ error: { status: 500 } }) },
    })).rejects.toThrow(/provider catalog/)
  })

  it('passes AbortSignal to provider.list and config.providers', async () => {
    const signals = []
    const catalog = await loadConnectedCatalog({
      provider: {
        list: async (_params, options) => {
          signals.push(options?.signal)
          return { data: { connected: ['xai'] } }
        },
      },
      config: {
        providers: async (_params, options) => {
          signals.push(options?.signal)
          return {
            data: {
              providers: [{
                id: 'xai',
                name: 'xAI',
                models: {
                  'grok-4.6': {
                    id: 'grok-4.6',
                    name: 'Grok 4.6',
                    capabilities: {
                      input: { text: true, image: true },
                      attachment: true,
                    },
                  },
                },
              }],
            },
          }
        },
      },
    })
    expect(signals).toHaveLength(2)
    expect(signals[0]).toBeInstanceOf(AbortSignal)
    expect(signals[1]).toBe(signals[0])
    expect(catalog.models).toEqual([
      expect.objectContaining({
        providerID: 'xai',
        modelID: 'grok-4.6',
        acceptsImages: true,
      }),
    ])
  })

  it('fails closed when the catalog load exceeds the deadline', async () => {
    await expect(loadConnectedCatalog({
      provider: {
        list: async (_params, options) => new Promise((resolve, reject) => {
          const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          if (options?.signal?.aborted) onAbort()
          else options?.signal?.addEventListener('abort', onAbort, { once: true })
        }),
      },
      config: { providers: async () => ({ data: { providers: [] } }) },
    }, { timeoutMs: 30 })).rejects.toMatchObject({
      code: 'upstream_error',
      message: expect.stringMatching(/timed out|aborted/i),
    })
    expect(CONNECTED_CATALOG_TIMEOUT_MS).toBeGreaterThan(0)
  })
})
