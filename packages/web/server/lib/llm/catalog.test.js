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
      { providerID: 'openai', modelID: 'gpt-5.2', name: 'GPT-5.2' },
    ])
    expect(catalog.connected).toEqual(['openai'])
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
})
