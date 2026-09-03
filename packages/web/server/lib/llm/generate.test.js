import { describe, expect, it, vi } from 'vitest'
import { detectSessionlessGenerate, generateOpenCodeText } from './generate.js'

describe('detectSessionlessGenerate', () => {
  it('returns unavailable when the probe 404s', async () => {
    const fetchImpl = vi.fn(async () => new Response('missing', { status: 404 }))
    await expect(detectSessionlessGenerate({
      fetchImpl,
      baseUrl: 'http://127.0.0.1:4096',
      headers: {},
    })).resolves.toEqual({ available: false, mode: 'throwaway-session' })
  })

  it('returns available when the probe is not 404', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    await expect(detectSessionlessGenerate({
      fetchImpl,
      baseUrl: 'http://127.0.0.1:4096',
      headers: {},
    })).resolves.toMatchObject({ available: true, mode: 'http' })
  })
})

describe('generateOpenCodeText', () => {
  it('creates an archived throwaway session and denies every tool', async () => {
    const create = vi.fn(async () => ({ data: { id: 'ses_tmp' } }))
    const update = vi.fn(async () => ({ data: { id: 'ses_tmp' } }))
    const ids = vi.fn(async () => ({ data: ['bash', 'edit'] }))
    const prompt = vi.fn(async () => ({
      data: { parts: [{ type: 'text', text: 'reply' }] },
    }))
    const remove = vi.fn(async () => ({ data: true }))
    const createOpencodeClient = vi.fn(() => ({
      session: { create, update, prompt, delete: remove },
      tool: { ids },
    }))

    const result = await generateOpenCodeText({
      buildOpenCodeUrl: () => 'http://127.0.0.1:4096',
      getOpenCodeAuthHeaders: () => ({}),
      providerID: 'openai',
      modelID: 'gpt-5.2',
      messages: [{ role: 'user', content: 'hi' }],
      clientFactory: createOpencodeClient,
      ensureTempDirectory: async () => '/tmp/openchamber-llm',
      detect: async () => ({ available: false, mode: 'throwaway-session' }),
    })

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      title: expect.stringContaining('[openchamber-llm]'),
    }), expect.anything())
    expect(update).toHaveBeenCalled()
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({
      tools: { bash: false, edit: false },
      agent: 'openchamber-llm',
    }), expect.anything())
    expect(remove).toHaveBeenCalled()
    expect(result).toEqual({ text: 'reply', source: 'throwaway-session' })
  })
})
