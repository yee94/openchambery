import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConnectedCatalog, parseModelRef, projectConnectedModels } from './catalog.js'

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

  it('marks vision models from capabilities.input containing image', () => {
    const catalog = projectConnectedModels({
      providers: [{ id: 'openai', name: 'OpenAI' }],
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
      ],
    })
    expect(catalog.models.find((model) => model.modelID === 'gpt-4o')?.acceptsImages).toBe(true)
    expect(catalog.models.find((model) => model.modelID === 'deepseek-v4-flash')?.acceptsImages).toBe(false)
    expect(catalog.connected).toEqual(['openai'])
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
})
