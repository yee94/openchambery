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

  it('accepts v2 list-shaped capabilities.input containing image', () => {
    expect(modelAcceptsImages({
      capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
    })).toBe(true)
    expect(modelAcceptsImages({
      capabilities: { tools: true, input: ['text'], output: ['text'] },
    })).toBe(false)
  })
})

describe('projectConnectedModels', () => {
  it('projects models from provider.list + model.list using ModelInfo.id as modelID', () => {
    const catalog = projectConnectedModels({
      providers: [
        { id: 'openai', name: 'OpenAI' },
        { id: 'anthropic', name: 'Anthropic' },
      ],
      models: [
        {
          id: 'gpt-5.2',
          modelID: 'internal-gpt-pack',
          providerID: 'openai',
          name: 'GPT-5.2',
          capabilities: { tools: true, input: ['text'], output: ['text'] },
        },
        {
          id: 'claude-sonnet-4',
          modelID: 'internal-claude',
          providerID: 'anthropic',
          name: 'Claude',
          capabilities: { tools: true, input: ['text'], output: ['text'] },
        },
      ],
    })
    expect(catalog.models).toEqual([
      { providerID: 'openai', modelID: 'gpt-5.2', name: 'GPT-5.2', acceptsImages: false },
      { providerID: 'anthropic', modelID: 'claude-sonnet-4', name: 'Claude', acceptsImages: false },
    ])
    expect(catalog.connected).toEqual(['openai', 'anthropic'])
  })

  it('marks vision from SDK capabilities, v2 list input, and legacy modalities', () => {
    const catalog = projectConnectedModels({
      providers: [
        { id: 'openai', name: 'OpenAI' },
        { id: 'xai', name: 'xAI' },
      ],
      models: [
        {
          id: 'gpt-4o',
          modelID: 'pack-4o',
          providerID: 'openai',
          name: 'GPT-4o',
          capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
        },
        {
          id: 'deepseek-v4-flash',
          modelID: 'pack-ds',
          providerID: 'openai',
          name: 'deepseek-v4-flash',
          capabilities: { tools: true, input: ['text'], output: ['text'] },
        },
        {
          id: 'grok-4.6',
          modelID: 'pack-grok',
          providerID: 'xai',
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
        },
      ],
    })
    expect(catalog.models.find((model) => model.modelID === 'gpt-4o')?.acceptsImages).toBe(true)
    expect(catalog.models.find((model) => model.modelID === 'grok-4.6')?.acceptsImages).toBe(true)
    expect(catalog.models.find((model) => model.modelID === 'deepseek-v4-flash')?.acceptsImages).toBe(false)
    expect(catalog.connected).toEqual(['openai', 'xai'])
  })

  it('ignores models whose provider is not in provider.list when providers are present', () => {
    const catalog = projectConnectedModels({
      providers: [{ id: 'openai', name: 'OpenAI' }],
      models: [
        { id: 'gpt-5.2', providerID: 'openai', name: 'GPT-5.2', capabilities: { input: ['text'], output: ['text'], tools: false } },
        { id: 'other', providerID: 'missing', name: 'Other', capabilities: { input: ['text'], output: ['text'], tools: false } },
      ],
    })
    expect(catalog.models.map((m) => m.modelID)).toEqual(['gpt-5.2'])
  })
})

describe('loadConnectedCatalog', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('requires provider.list and model.list data arrays', async () => {
    await expect(loadConnectedCatalog({
      provider: { list: async () => ({ location: {}, data: [{ id: 'openai', name: 'OpenAI' }] }) },
      model: { list: async () => ({ location: {}, data: null }) },
    })).rejects.toThrow(/provider catalog/)
  })

  it('composes real client-shaped catalog responses', async () => {
    const catalog = await loadConnectedCatalog({
      provider: {
        list: async () => ({
          location: { directory: '/tmp' },
          data: [{ id: 'openai', name: 'OpenAI' }],
        }),
      },
      model: {
        list: async () => ({
          location: { directory: '/tmp' },
          data: [{
            id: 'gpt-4o',
            modelID: 'internal',
            providerID: 'openai',
            name: 'GPT-4o',
            capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
          }],
        }),
      },
    })
    expect(catalog.models).toEqual([
      { providerID: 'openai', modelID: 'gpt-4o', name: 'GPT-4o', acceptsImages: true },
    ])
  })

  it('surfaces thrown client errors as upstream_error', async () => {
    await expect(loadConnectedCatalog({
      provider: { list: async () => { throw new Error('boom') } },
      model: { list: async () => ({ data: [] }) },
    })).rejects.toMatchObject({ code: 'upstream_error', message: 'boom' })
  })

  it('passes AbortSignal to provider.list and model.list', async () => {
    const signals = []
    const catalog = await loadConnectedCatalog({
      provider: {
        list: async (_params, options) => {
          signals.push(options?.signal)
          return {
            location: {},
            data: [{ id: 'xai', name: 'xAI' }],
          }
        },
      },
      model: {
        list: async (_params, options) => {
          signals.push(options?.signal)
          return {
            location: {},
            data: [{
              id: 'grok-4.6',
              modelID: 'internal',
              providerID: 'xai',
              name: 'Grok 4.6',
              capabilities: {
                input: { text: true, image: true },
                attachment: true,
              },
            }],
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
      model: { list: async () => ({ data: [] }) },
    }, { timeoutMs: 30 })).rejects.toMatchObject({
      code: 'upstream_error',
      message: expect.stringMatching(/timed out|aborted/i),
    })
    expect(CONNECTED_CATALOG_TIMEOUT_MS).toBeGreaterThan(0)
  })
})
