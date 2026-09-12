import { describe, expect, it, vi } from 'vitest'
import { detectSessionlessGenerate, generateOpenCodeText, _test } from './generate.js'

const completedAssistant = (text) => ({
  info: {
    role: 'assistant',
    time: { completed: Date.now() },
  },
  parts: [{ type: 'text', text }],
})


const throwawayGenerate = (client, extra = {}) => generateOpenCodeText({
  providerID: 'p',
  modelID: 'm',
  messages: [{ role: 'user', content: 'work' }],
  buildOpenCodeUrl: () => 'http://localhost:1',
  getOpenCodeAuthHeaders: () => ({}),
  detect: async () => ({ available: false, mode: 'throwaway-session' }),
  clientFactory: () => client,
  ensureTempDirectory: async () => '/tmp/timeout-fixture',
  ...extra,
})

const throwawayClient = ({ status, messages, id = 'ses_tmp', remove = vi.fn(async () => ({ data: true })) }) => ({
  tool: { ids: async () => ({ data: [] }) },
  session: {
    create: async () => ({ data: { id } }),
    update: async () => ({ data: { id } }),
    promptAsync: async () => ({ response: { status: 204 } }),
    status,
    messages,
    delete: remove,
  },
})

describe('generate cancellation', () => {
  it('cancels throwaway polling and still deletes only its temporary session', async () => {
    const controller = new AbortController()
    const remove = vi.fn(async () => ({ data: true }))
    const client = {
      tool: { ids: async () => ({ data: [] }) },
      session: {
        create: async () => ({ data: { id: 'ses_abort_fixture' } }),
        update: async () => ({ data: { id: 'ses_abort_fixture' } }),
        promptAsync: async () => ({ response: { status: 204 } }),
        status: async (_args, { signal }) => { controller.abort(); signal.throwIfAborted() },
        delete: remove,
      },
    }
    await expect(generateOpenCodeText({
      providerID: 'p', modelID: 'm', messages: [{ role: 'user', content: 'work' }],
      buildOpenCodeUrl: () => 'http://localhost:1', getOpenCodeAuthHeaders: () => ({}),
      detect: async () => ({ available: false, mode: 'throwaway-session' }),
      clientFactory: () => client, ensureTempDirectory: async () => '/tmp/abort-fixture',
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(remove).toHaveBeenCalledExactlyOnceWith({ sessionID: 'ses_abort_fixture', directory: '/tmp/abort-fixture' })
  })
  it('aborts an in-flight model request when the contact continuation is cancelled', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn(async (_url, { signal }) => {
      controller.abort()
      signal.throwIfAborted()
    })
    await expect(generateOpenCodeText({
      providerID: 'p', modelID: 'm', messages: [{ role: 'user', content: 'work' }],
      buildOpenCodeUrl: () => 'http://localhost:1', getOpenCodeAuthHeaders: () => ({}),
      detect: async () => ({ available: true, mode: 'http', url: 'http://localhost:1/generate' }),
      fetchImpl, signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
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
  it.each(['high', undefined])('passes variant %s to the upstream prompt and returns only text parts', async (variant) => {
    const client = throwawayClient({
      status: async () => ({ data: {} }),
      messages: async () => ({ data: [{
        ...completedAssistant('public reply'),
        parts: [{ type: 'reasoning', text: 'private reasoning' }, { type: 'text', text: 'public reply' }],
      }] }),
    });
    client.session.promptAsync = vi.fn(async () => ({ response: { status: 204 } }));
    const result = await throwawayGenerate(client, { variant });
    expect(client.session.promptAsync.mock.calls[0][0].variant).toBe(variant);
    expect(result.text).toBe('public reply');
  });

  it('passes variant to sessionless generation', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ text: 'reply' })));
    await throwawayGenerate({}, {
      variant: 'high', fetchImpl,
      detect: async () => ({ available: true, mode: 'http', url: 'http://localhost:1/generate' }),
    });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).variant).toBe('high');
  });

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
      ensureTempDirectory: async ({ agentMarkdown }) => {
        expect(agentMarkdown).toContain('openchamber-tool JSON fences')
        expect(agentMarkdown).toMatch(/"\*"\s*:\s*deny/)
        expect(agentMarkdown).toContain('permission:')
        expect(agentMarkdown).not.toContain('effect: deny')
        expect(agentMarkdown).toContain('Report execution and failures from supplied tool results only.')
        expect(agentMarkdown).toContain('Native permissions are denied')
        return '/tmp/openchamber-llm'
      },
      detect: async () => ({ available: false, mode: 'throwaway-session' }),
    })

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      title: expect.stringContaining('[openchamber-llm]'),
      agent: 'openchamber-llm',
      permission: [{ permission: '*', pattern: '*', action: 'deny' }],
      metadata: { openchamber: { llm: { purpose: 'chat-completions' } } },
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

  it('forwards contact file parts on promptAsync so the model can see images', async () => {
    const image = { type: 'file', mime: 'image/png', url: 'data:image/png;base64,aa', filename: 'shot.png' }
    const file = { type: 'file', mime: 'text/plain', url: 'data:text/plain;base64,eA==', filename: 'notes.txt' }
    const flattened = _test.flattenMessages([
      { role: 'user', content: 'look', parts: [image, file] },
    ])
    expect(flattened.prompt).toContain('User: look')
    expect(flattened.prompt).toContain('[image: shot.png (image/png)]')
    expect(flattened.prompt).toContain('[file: notes.txt (text/plain)]')
    expect(flattened.files).toEqual([image, file])

    const promptAsync = vi.fn(async () => ({ response: { status: 204 } }))
    const createOpencodeClient = vi.fn(() => ({
      session: {
        create: async () => ({ data: { id: 'ses_tmp' } }),
        update: async () => ({ data: { id: 'ses_tmp' } }),
        prompt: vi.fn(),
        promptAsync,
        status: async () => ({ data: { ses_tmp: { type: 'idle' } } }),
        messages: async () => ({ data: [completedAssistant('saw it')] }),
        delete: async () => ({ data: true }),
      },
      tool: { ids: async () => ({ data: [] }) },
    }))
    await generateOpenCodeText({
      buildOpenCodeUrl: () => 'http://127.0.0.1:4096',
      getOpenCodeAuthHeaders: () => ({}),
      providerID: 'opencode',
      modelID: 'gpt-5-nano',
      messages: [{ role: 'user', content: 'look', parts: [image, file] }],
      clientFactory: createOpencodeClient,
      ensureTempDirectory: async () => '/tmp/openchamber-llm',
      detect: async () => ({ available: false, mode: 'throwaway-session' }),
      forwardImageParts: true,
    })
    expect(promptAsync.mock.calls[0][0].parts).toEqual([
      expect.objectContaining({ type: 'text', synthetic: false }),
      image,
      file,
    ])
  })

  it('skips image bytes for non-vision generate and keeps text files plus the image description', async () => {
    const image = { type: 'file', mime: 'image/png', url: 'data:image/png;base64,aa', filename: 'shot.png' }
    const file = { type: 'file', mime: 'text/plain', url: 'data:text/plain;base64,eA==', filename: 'notes.txt' }
    expect(_test.filesForPrompt([image, file], false)).toEqual([file])
    const promptAsync = vi.fn(async () => ({ response: { status: 204 } }))
    const createOpencodeClient = vi.fn(() => ({
      session: {
        create: async () => ({ data: { id: 'ses_tmp' } }),
        update: async () => ({ data: { id: 'ses_tmp' } }),
        prompt: vi.fn(),
        promptAsync,
        status: async () => ({ data: { ses_tmp: { type: 'idle' } } }),
        messages: async () => ({ data: [completedAssistant('cannot see images')] }),
        delete: async () => ({ data: true }),
      },
      tool: { ids: async () => ({ data: [] }) },
    }))
    await generateOpenCodeText({
      buildOpenCodeUrl: () => 'http://127.0.0.1:4096',
      getOpenCodeAuthHeaders: () => ({}),
      providerID: 'opencode',
      modelID: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'look', parts: [image, file] }],
      clientFactory: createOpencodeClient,
      ensureTempDirectory: async () => '/tmp/openchamber-llm',
      detect: async () => ({ available: false, mode: 'throwaway-session' }),
    })
    expect(promptAsync.mock.calls[0][0].parts).toEqual([
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining('[image: shot.png (image/png)]'),
      }),
      file,
    ])
    expect(promptAsync.mock.calls[0][0].parts.some((part) => part.type === 'file' && part.mime.startsWith('image/'))).toBe(false)
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

  it('forwards filtered throwaway session text deltas via onTextDelta and still returns full text', async () => {
    const subscribers = new Set()
    const globalEventHub = {
      subscribeEvent(fn) {
        subscribers.add(fn)
        return () => { subscribers.delete(fn) }
      },
      emit(event) {
        for (const fn of Array.from(subscribers)) fn(event)
      },
    }
    const deltas = []
    const onTextDelta = vi.fn((text) => { deltas.push(text) })

    const promptAsync = vi.fn(async () => {
      // Same-session text deltas
      globalEventHub.emit({
        payload: {
          type: 'message.part.delta',
          properties: {
            sessionID: 'ses_tmp',
            messageID: 'msg_asst',
            partID: 'prt_1',
            field: 'text',
            delta: 'Hel',
          },
        },
      })
      globalEventHub.emit({
        payload: {
          type: 'message.part.delta',
          properties: {
            sessionID: 'ses_tmp',
            messageID: 'msg_asst',
            partID: 'prt_1',
            field: 'text',
            delta: 'lo',
          },
        },
      })
      // Other session — must be ignored
      globalEventHub.emit({
        payload: {
          type: 'message.part.delta',
          properties: {
            sessionID: 'ses_other',
            messageID: 'msg_other',
            partID: 'prt_x',
            field: 'text',
            delta: 'NOPE',
          },
        },
      })
      // Same session, different messageID after lock — ignored
      globalEventHub.emit({
        payload: {
          type: 'message.part.delta',
          properties: {
            sessionID: 'ses_tmp',
            messageID: 'msg_other_asst',
            partID: 'prt_2',
            field: 'text',
            delta: 'SKIP',
          },
        },
      })
      // Non-text field — ignored
      globalEventHub.emit({
        payload: {
          type: 'message.part.delta',
          properties: {
            sessionID: 'ses_tmp',
            messageID: 'msg_asst',
            partID: 'prt_1',
            field: 'reasoning',
            delta: 'think',
          },
        },
      })
      return { response: { status: 204 } }
    })

    const result = await generateOpenCodeText({
      buildOpenCodeUrl: () => 'http://127.0.0.1:4096',
      getOpenCodeAuthHeaders: () => ({}),
      providerID: 'opencode',
      modelID: 'gpt-5-nano',
      messages: [{ role: 'user', content: 'hi' }],
      clientFactory: () => ({
        session: {
          create: async () => ({ data: { id: 'ses_tmp' } }),
          update: async () => ({ data: { id: 'ses_tmp' } }),
          prompt: vi.fn(),
          promptAsync,
          status: async () => ({ data: { ses_tmp: { type: 'idle' } } }),
          messages: async () => ({ data: [completedAssistant('Hello')] }),
          delete: async () => ({ data: true }),
        },
        tool: { ids: async () => ({ data: [] }) },
      }),
      ensureTempDirectory: async () => '/tmp/openchamber-llm',
      detect: async () => ({ available: false, mode: 'throwaway-session' }),
      onTextDelta,
      globalEventHub,
    })

    expect(result).toEqual({ text: 'Hello', source: 'throwaway-session' })
    expect(deltas).toEqual(['Hel', 'lo'])
    expect(onTextDelta).toHaveBeenCalledTimes(2)
    // Listener removed after complete — further emits must not reach onTextDelta
    expect(subscribers.size).toBe(0)
    globalEventHub.emit({
      payload: {
        type: 'message.part.delta',
        properties: {
          sessionID: 'ses_tmp',
          messageID: 'msg_asst',
          partID: 'prt_1',
          field: 'text',
          delta: 'late',
        },
      },
    })
    expect(onTextDelta).toHaveBeenCalledTimes(2)
  })

  it('removes the hub listener when generate fails after subscribe', async () => {
    const subscribers = new Set()
    const globalEventHub = {
      subscribeEvent(fn) {
        subscribers.add(fn)
        return () => { subscribers.delete(fn) }
      },
    }
    const onTextDelta = vi.fn()

    await expect(generateOpenCodeText({
      buildOpenCodeUrl: () => 'http://127.0.0.1:4096',
      getOpenCodeAuthHeaders: () => ({}),
      providerID: 'opencode',
      modelID: 'gpt-5-nano',
      messages: [{ role: 'user', content: 'hi' }],
      clientFactory: () => ({
        session: {
          create: async () => ({ data: { id: 'ses_tmp' } }),
          update: async () => ({ data: { id: 'ses_tmp' } }),
          prompt: vi.fn(),
          promptAsync: async () => ({ response: { status: 204 } }),
          status: async () => ({ data: { ses_tmp: { type: 'idle' } } }),
          messages: async () => ({
            data: [{
              info: { role: 'assistant', error: { message: 'boom' }, time: { completed: Date.now() } },
              parts: [],
            }],
          }),
          delete: async () => ({ data: true }),
        },
        tool: { ids: async () => ({ data: [] }) },
      }),
      ensureTempDirectory: async () => '/tmp/openchamber-llm',
      detect: async () => ({ available: false, mode: 'throwaway-session' }),
      onTextDelta,
      globalEventHub,
    })).rejects.toMatchObject({ code: 'upstream_error', message: 'boom' })

    expect(subscribers.size).toBe(0)
  })

  it('throws when tool.ids returns an SDK error instead of denying nothing', async () => {
    const remove = vi.fn(async () => ({ data: true }))
    await expect(generateOpenCodeText({
      buildOpenCodeUrl: () => 'http://127.0.0.1:4096',
      getOpenCodeAuthHeaders: () => ({}),
      providerID: 'opencode',
      modelID: 'gpt-5-nano',
      messages: [{ role: 'user', content: 'hi' }],
      clientFactory: () => ({
        session: {
          create: vi.fn(async () => ({ data: { id: 'ses_tmp' } })),
          update: vi.fn(),
          prompt: vi.fn(),
          promptAsync: vi.fn(),
          status: vi.fn(),
          messages: vi.fn(),
          delete: remove,
        },
        tool: { ids: async () => ({ error: { status: 500, message: 'tool catalog unavailable' } }) },
      }),
      ensureTempDirectory: async () => '/tmp/openchamber-llm',
      detect: async () => ({ available: false, mode: 'throwaway-session' }),
    })).rejects.toMatchObject({
      code: 'upstream_error',
      message: expect.stringContaining('tool.ids failed'),
    })
    expect(remove).not.toHaveBeenCalled()
  })

  it('throws when session.messages returns a deterministic 400', async () => {
    const remove = vi.fn(async () => ({ data: true }))
    await expect(generateOpenCodeText({
      buildOpenCodeUrl: () => 'http://127.0.0.1:4096',
      getOpenCodeAuthHeaders: () => ({}),
      providerID: 'opencode',
      modelID: 'gpt-5-nano',
      messages: [{ role: 'user', content: 'hi' }],
      clientFactory: () => ({
        session: {
          create: async () => ({ data: { id: 'ses_tmp' } }),
          update: async () => ({ data: { id: 'ses_tmp' } }),
          prompt: vi.fn(),
          promptAsync: async () => ({ response: { status: 204 } }),
          status: async () => ({ data: { ses_tmp: { type: 'idle' } } }),
          messages: async () => ({ error: { status: 400, message: 'OutputFormatJsonSchema' } }),
          delete: remove,
        },
        tool: { ids: async () => ({ data: ['bash'] }) },
      }),
      ensureTempDirectory: async () => '/tmp/openchamber-llm',
      detect: async () => ({ available: false, mode: 'throwaway-session' }),
    })).rejects.toMatchObject({
      code: 'upstream_error',
      message: expect.stringMatching(/session\.messages failed.*400|OutputFormatJsonSchema/),
    })
    expect(remove).toHaveBeenCalled()
  })

  it('logs SDK delete errors without erasing a successful generate result', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = await generateOpenCodeText({
        buildOpenCodeUrl: () => 'http://127.0.0.1:4096',
        getOpenCodeAuthHeaders: () => ({}),
        providerID: 'opencode',
        modelID: 'gpt-5-nano',
        messages: [{ role: 'user', content: 'hi' }],
        clientFactory: () => ({
          session: {
            create: async () => ({ data: { id: 'ses_tmp' } }),
            update: async () => ({ data: { id: 'ses_tmp' } }),
            prompt: vi.fn(),
            promptAsync: async () => ({ response: { status: 204 } }),
            status: async () => ({ data: { ses_tmp: { type: 'idle' } } }),
            messages: async () => ({ data: [completedAssistant('ok')] }),
            delete: async () => ({ error: { status: 500, message: 'delete denied' } }),
          },
          tool: { ids: async () => ({ data: [] }) },
        }),
        ensureTempDirectory: async () => '/tmp/openchamber-llm',
        detect: async () => ({ available: false, mode: 'throwaway-session' }),
      })
      expect(result).toEqual({ text: 'ok', source: 'throwaway-session' })
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('[llm] failed to delete throwaway OpenCode session:'),
        expect.stringContaining('delete denied'),
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('does not invent deltas on the sessionless /generate JSON path', async () => {
    const onTextDelta = vi.fn()
    const subscribers = new Set()
    const globalEventHub = {
      subscribeEvent(fn) {
        subscribers.add(fn)
        return () => { subscribers.delete(fn) }
      },
    }
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ text: 'full reply' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const result = await generateOpenCodeText({
      buildOpenCodeUrl: () => 'http://127.0.0.1:4096',
      getOpenCodeAuthHeaders: () => ({}),
      providerID: 'opencode',
      modelID: 'gpt-5-nano',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl,
      detect: async () => ({ available: true, mode: 'http', url: 'http://127.0.0.1:4096/generate' }),
      onTextDelta,
      globalEventHub,
    })

    expect(result).toEqual({ text: 'full reply', source: 'generate' })
    expect(onTextDelta).not.toHaveBeenCalled()
    expect(subscribers.size).toBe(0)
  })
})

describe('generate stall timeout', () => {
  it('keeps waiting while the throwaway session stays busy past the stall deadline', async () => {
    let polls = 0
    const result = await throwawayGenerate(throwawayClient({
      status: async () => {
        polls += 1
        return { data: { ses_tmp: { type: polls < 12 ? 'busy' : 'idle' } } }
      },
      messages: async () => ({ data: [completedAssistant('late reply')] }),
    }), {
      timeoutMs: 50,
      settlePollMs: 10,
    })
    expect(polls).toBeGreaterThan(5)
    expect(result).toEqual({ text: 'late reply', source: 'throwaway-session' })
  })

  it('times out when throwaway settle makes no progress', async () => {
    await expect(throwawayGenerate(throwawayClient({
      status: async () => ({ data: {} }),
      messages: async () => ({ data: [] }),
    }), {
      timeoutMs: 40,
      settlePollMs: 10,
    })).rejects.toThrow(/timed out after 40ms without progress/)
  })
})

describe('subscribeThrowawayTextDeltas', () => {
  it('returns null without a callback or hub', () => {
    expect(_test.subscribeThrowawayTextDeltas({
      sessionID: 'ses_1',
      onTextDelta: null,
      globalEventHub: { subscribeEvent: () => () => {} },
    })).toBeNull()
    expect(_test.subscribeThrowawayTextDeltas({
      sessionID: 'ses_1',
      onTextDelta: () => {},
      globalEventHub: null,
    })).toBeNull()
  })
})
