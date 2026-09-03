import { describe, expect, it, vi } from 'vitest'
import { detectSessionlessGenerate, generateOpenCodeText } from './generate.js'

const completedAssistant = (text) => ({
  info: {
    role: 'assistant',
    time: { completed: Date.now() },
  },
  parts: [{ type: 'text', text }],
})

describe('detectSessionlessGenerate', () => {
  it('returns unavailable when the probe 404s', async () => {
    const fetchImpl = vi.fn(async () => new Response('missing', { status: 404 }))
    await expect(detectSessionlessGenerate({
      fetchImpl,
      baseUrl: 'http://127.0.0.1:4096',
      headers: {},
    })).resolves.toEqual({ available: false, mode: 'throwaway-session' })
  })

  it('returns available when the probe returns JSON', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    await expect(detectSessionlessGenerate({
      fetchImpl,
      baseUrl: 'http://127.0.0.1:4096',
      headers: {},
    })).resolves.toMatchObject({ available: true, mode: 'http' })
  })

  it('treats HTML 200 on /generate as unavailable', async () => {
    const fetchImpl = vi.fn(async (url) => {
      expect(String(url)).toMatch(/\/generate$/)
      return new Response('<!doctype html><html><body>OpenChamber</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    })
    await expect(detectSessionlessGenerate({
      fetchImpl,
      baseUrl: 'http://127.0.0.1:4096',
      headers: {},
    })).resolves.toEqual({ available: false, mode: 'throwaway-session' })
    expect(fetchImpl).toHaveBeenCalled()
  })
})

describe('generateOpenCodeText', () => {
  it('uses promptAsync with model+parts, waits for idle messages, and never calls v2 session.prompt', async () => {
    const create = vi.fn(async () => ({ data: { id: 'ses_tmp' } }))
    const update = vi.fn(async () => ({ data: { id: 'ses_tmp' } }))
    const ids = vi.fn(async () => ({ data: ['bash', 'edit'] }))
    const prompt = vi.fn(async () => {
      throw new Error('v2 session.prompt must not be used')
    })
    const promptAsync = vi.fn(async () => ({ response: { status: 204 } }))
    const status = vi.fn(async () => ({ data: { ses_tmp: { type: 'idle' } } }))
    const messages = vi.fn(async () => ({ data: [completedAssistant('reply')] }))
    const remove = vi.fn(async () => ({ data: true }))
    const createOpencodeClient = vi.fn(() => ({
      session: { create, update, prompt, promptAsync, status, messages, delete: remove },
      tool: { ids },
    }))

    const result = await generateOpenCodeText({
      buildOpenCodeUrl: () => 'http://127.0.0.1:4096',
      getOpenCodeAuthHeaders: () => ({}),
      providerID: 'opencode',
      modelID: 'gpt-5-nano',
      messages: [{ role: 'user', content: 'hi' }],
      clientFactory: createOpencodeClient,
      ensureTempDirectory: async () => '/tmp/openchamber-llm',
      detect: async () => ({ available: false, mode: 'throwaway-session' }),
    })

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      title: expect.stringContaining('[openchamber-llm]'),
    }), expect.anything())
    expect(update).toHaveBeenCalled()
    expect(promptAsync).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: 'ses_tmp',
      agent: 'openchamber-llm',
      model: { providerID: 'opencode', modelID: 'gpt-5-nano' },
      tools: { bash: false, edit: false },
      parts: [{ type: 'text', text: 'User: hi', synthetic: false }],
    }), expect.anything())
    expect(prompt).not.toHaveBeenCalled()
    expect(status).toHaveBeenCalled()
    expect(messages).toHaveBeenCalledWith(expect.objectContaining({ sessionID: 'ses_tmp' }), expect.anything())
    expect(remove).toHaveBeenCalled()
    expect(result).toEqual({ text: 'reply', source: 'throwaway-session' })
  })

  it('surfaces the OpenCode assistant error string after promptAsync 204', async () => {
    const promptAsync = vi.fn(async () => ({ response: { status: 204 } }))
    const prompt = vi.fn()
    const createOpencodeClient = vi.fn(() => ({
      session: {
        create: async () => ({ data: { id: 'ses_tmp' } }),
        update: async () => ({ data: { id: 'ses_tmp' } }),
        prompt,
        promptAsync,
        status: async () => ({ data: { ses_tmp: { type: 'idle' } } }),
        messages: async () => ({
          data: [{
            info: { role: 'assistant', error: { message: 'model refused the request' }, time: { completed: Date.now() } },
            parts: [],
          }],
        }),
        delete: async () => ({ data: true }),
      },
      tool: { ids: async () => ({ data: [] }) },
    }))

    await expect(generateOpenCodeText({
      buildOpenCodeUrl: () => 'http://127.0.0.1:4096',
      getOpenCodeAuthHeaders: () => ({}),
      providerID: 'opencode',
      modelID: 'gpt-5-nano',
      messages: [{ role: 'user', content: 'hi' }],
      clientFactory: createOpencodeClient,
      ensureTempDirectory: async () => '/tmp/openchamber-llm',
      detect: async () => ({ available: false, mode: 'throwaway-session' }),
    })).rejects.toMatchObject({
      code: 'upstream_error',
      message: 'model refused the request',
    })
    expect(prompt).not.toHaveBeenCalled()
  })

  it('falls through to promptAsync when the /generate probe returns HTML 200', async () => {
    const fetchImpl = vi.fn(async () => new Response('<!doctype html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    }))
    const promptAsync = vi.fn(async () => ({ response: { status: 204 } }))
    const prompt = vi.fn()
    const result = await generateOpenCodeText({
      buildOpenCodeUrl: () => 'http://127.0.0.1:4096',
      getOpenCodeAuthHeaders: () => ({}),
      providerID: 'opencode',
      modelID: 'glm-5.3-flash',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl,
      clientFactory: () => ({
        session: {
          create: async () => ({ data: { id: 'ses_tmp' } }),
          update: async () => ({ data: { id: 'ses_tmp' } }),
          prompt,
          promptAsync,
          status: async () => ({ data: { ses_tmp: { type: 'idle' } } }),
          messages: async () => ({ data: [completedAssistant('reply')] }),
          delete: async () => ({ data: true }),
        },
        tool: { ids: async () => ({ data: [] }) },
      }),
      ensureTempDirectory: async () => '/tmp/openchamber-llm',
    })
    expect(result).toEqual({ text: 'reply', source: 'throwaway-session' })
    expect(promptAsync).toHaveBeenCalled()
    expect(prompt).not.toHaveBeenCalled()
  })
})
