import { describe, expect, it, vi } from 'vitest'
import { generateOpenCodeText, _test } from './generate.js'

const denyAllAgent = {
  location: { directory: '/tmp/openchamber-llm' },
  data: {
    id: 'openchamber-llm',
    name: 'openchamber-llm',
    mode: 'primary',
    hidden: true,
    permissions: [
      { action: '*', resource: '*', effect: 'deny' },
    ],
  },
}

const completedAssistant = (text, extras = {}) => ({
  id: 'msg_asst',
  type: 'assistant',
  time: { created: 1, completed: Date.now() },
  agent: 'openchamber-llm',
  model: { id: 'gpt-5-nano', providerID: 'opencode' },
  content: [{ type: 'text', text }],
  finish: 'stop',
  ...extras,
})

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: {
    get: (name) => (String(name).toLowerCase() === 'content-type' ? 'application/json' : null),
  },
  json: async () => body,
  text: async () => JSON.stringify(body ?? null),
  arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body ?? null)).buffer,
})

describe('generate cancellation', () => {
  it('cancels attachment wait and still removes only its temporary session', async () => {
    const controller = new AbortController()
    const remove = vi.fn(async () => undefined)
    const interrupt = vi.fn(async () => undefined)
    const image = { type: 'file', mime: 'image/png', url: 'data:image/png;base64,aa', filename: 'shot.png' }

    await expect(generateOpenCodeText({
      buildOpenCodeUrl: () => 'http://127.0.0.1:4096',
      getOpenCodeAuthHeaders: () => ({}),
      providerID: 'opencode',
      modelID: 'gpt-4o',
      messages: [{ role: 'user', content: 'look', parts: [image] }],
      clientFactory: () => ({
        agent: { get: async () => denyAllAgent },
        session: {
          create: async () => ({ id: 'ses_abort_fixture' }),
          prompt: async () => ({ id: 'inbox' }),
          wait: async (_args, { signal }) => {
            controller.abort()
            signal.throwIfAborted()
          },
          interrupt,
          remove,
          instructions: { entry: { put: async () => {} } },
        },
        message: { list: vi.fn() },
      }),
      ensureTempDirectory: async () => '/tmp/abort-fixture',
      forwardImageParts: true,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(remove).toHaveBeenCalledExactlyOnceWith({ sessionID: 'ses_abort_fixture' })
    expect(interrupt).toHaveBeenCalledWith({ sessionID: 'ses_abort_fixture', continue: false })
  })

  it('aborts an in-flight session.generate and still removes the throwaway session', async () => {
    const controller = new AbortController()
    const generate = vi.fn(async (_args, { signal }) => {
      controller.abort()
      signal.throwIfAborted()
    })
    const { client, remove, interrupt } = textSessionClient({ generate })
    await expect(generateOpenCodeText({
      buildOpenCodeUrl: () => 'http://127.0.0.1:4096',
      getOpenCodeAuthHeaders: () => ({}),
      providerID: 'opencode',
      modelID: 'gpt-5-nano',
      messages: [{ role: 'user', content: 'work' }],
      clientFactory: () => client,
      ensureTempDirectory: async () => '/tmp/openchamber-text',
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(generate).toHaveBeenCalledTimes(1)
    expect(interrupt).toHaveBeenCalledWith({ sessionID: 'ses_text', continue: false })
    expect(remove).toHaveBeenCalledExactlyOnceWith({ sessionID: 'ses_text' })
  })
})

const denyAllTextAgent = {
  location: { directory: '/tmp/openchamber-text' },
  data: {
    id: 'openchamber-text',
    name: 'openchamber-text',
    mode: 'primary',
    hidden: true,
    permissions: [{ action: '*', resource: '*', effect: 'deny' }],
  },
}

function textSessionClient({ generate = vi.fn(async () => ({ text: 'reply' })), agentGet } = {}) {
  const create = vi.fn(async () => ({ id: 'ses_text' }))
  const remove = vi.fn(async () => undefined)
  const interrupt = vi.fn(async () => undefined)
  const prompt = vi.fn()
  const get = agentGet || vi.fn(async () => denyAllTextAgent)
  return {
    client: {
      agent: { get },
      session: { create, generate, remove, interrupt, prompt },
    },
    agentGet: get,
    create,
    generate,
    remove,
    interrupt,
    prompt,
  }
}

describe('generateOpenCodeText — text path', () => {
  it('runs session.generate in a verified deny-all throwaway session and removes it', async () => {
    const { client, agentGet, create, generate, remove, prompt } = textSessionClient()
    const ensureTempDirectory = vi.fn(async ({ agentName, agentMarkdown }) => {
      expect(agentName).toBe(_test.TEXT_AGENT_NAME)
      expect(agentMarkdown).toBe(_test.TEXT_AGENT_MARKDOWN)
      return '/tmp/openchamber-text'
    })

    const result = await generateOpenCodeText({
      buildOpenCodeUrl: () => 'http://127.0.0.1:4096',
      getOpenCodeAuthHeaders: () => ({}),
      providerID: 'opencode-go',
      modelID: 'deepseek-v4-flash',
      messages: [
        { role: 'system', content: 'Be brief' },
        { role: 'user', content: 'hi' },
      ],
      clientFactory: () => client,
      ensureTempDirectory,
    })

    expect(result).toEqual({ text: 'reply', source: 'session.generate' })
    expect(agentGet).toHaveBeenCalledWith(expect.objectContaining({
      agentID: 'openchamber-text',
      location: { directory: '/tmp/openchamber-text' },
    }), expect.anything())
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'openchamber-text',
      model: { id: 'deepseek-v4-flash', providerID: 'opencode-go' },
      location: { directory: '/tmp/openchamber-text' },
    }), expect.anything())
    expect(agentGet.mock.invocationCallOrder[0]).toBeLessThan(create.mock.invocationCallOrder[0])
    const generateArgs = generate.mock.calls[0][0]
    expect(generateArgs.sessionID).toBe('ses_text')
    expect(generateArgs.prompt.startsWith('Be brief')).toBe(true)
    expect(generateArgs.prompt).toContain('User: hi')
    expect(prompt).not.toHaveBeenCalled()
    expect(remove).toHaveBeenCalledExactlyOnceWith({ sessionID: 'ses_text' })
  })

  it.each(['high', undefined])('passes variant %s on the session model', async (variant) => {
    const { client, create } = textSessionClient()
    const result = await generateOpenCodeText({
      buildOpenCodeUrl: () => 'http://127.0.0.1:4096',
      getOpenCodeAuthHeaders: () => ({}),
      providerID: 'opencode',
      modelID: 'gpt-5-nano',
      messages: [{ role: 'user', content: 'hi' }],
      variant,
      clientFactory: () => client,
      ensureTempDirectory: async () => '/tmp/openchamber-text',
    })
    expect(result.text).toBe('reply')
    const model = create.mock.calls[0][0].model
    if (variant) {
      expect(model).toEqual({ id: 'gpt-5-nano', providerID: 'opencode', variant })
    } else {
      expect(model).toEqual({ id: 'gpt-5-nano', providerID: 'opencode' })
    }
  })

  it('blocks before creating a session when the text agent is not deny-all', async () => {
    const { client, create, generate } = textSessionClient({
      agentGet: vi.fn(async () => ({
        data: { id: 'openchamber-text', permissions: [{ action: 'bash', resource: '*', effect: 'allow' }] },
      })),
    })
    await expect(generateOpenCodeText({
      buildOpenCodeUrl: () => 'http://127.0.0.1:4096',
      getOpenCodeAuthHeaders: () => ({}),
      providerID: 'opencode',
      modelID: 'gpt-5-nano',
      messages: [{ role: 'user', content: 'hi' }],
      clientFactory: () => client,
      ensureTempDirectory: async () => '/tmp/openchamber-text',
    })).rejects.toMatchObject({ code: 'llm_attachment_generation_unavailable' })
    expect(create).not.toHaveBeenCalled()
    expect(generate).not.toHaveBeenCalled()
  })

  it('waits for a lazily loaded agent instead of failing on the first read', async () => {
    let reads = 0
    const agentGet = vi.fn(async () => {
      reads += 1
      if (reads < 3) throw new Error('Agent not found: openchamber-text')
      return denyAllTextAgent
    })
    const client = { agent: { get: agentGet } }
    const agent = await _test.assertLlmAgentDenyAll({
      client,
      location: { directory: '/tmp/openchamber-text' },
      agentID: 'openchamber-text',
      waitMs: 1_000,
      pollMs: 1,
    })
    expect(agent.id).toBe('openchamber-text')
    expect(agentGet).toHaveBeenCalledTimes(3)
  })

  it('fails when the agent never appears within the wait window', async () => {
    const agentGet = vi.fn(async () => { throw new Error('Agent not found') })
    await expect(_test.assertLlmAgentDenyAll({
      client: { agent: { get: agentGet } },
      agentID: 'openchamber-text',
      waitMs: 0,
      pollMs: 1,
    })).rejects.toMatchObject({ code: 'llm_attachment_generation_unavailable' })
    expect(agentGet).toHaveBeenCalledTimes(1)
  })

  it('surfaces session.generate errors and still removes the session', async () => {
    const { client, remove } = textSessionClient({
      generate: vi.fn(async () => { throw new Error('Request is missing x-opencode-session') }),
    })
    await expect(generateOpenCodeText({
      buildOpenCodeUrl: () => 'http://127.0.0.1:4096',
      getOpenCodeAuthHeaders: () => ({}),
      providerID: 'opencode-go',
      modelID: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hi' }],
      clientFactory: () => client,
      ensureTempDirectory: async () => '/tmp/openchamber-text',
    })).rejects.toMatchObject({ code: 'upstream_error', message: 'Request is missing x-opencode-session' })
    expect(remove).toHaveBeenCalledWith({ sessionID: 'ses_text' })
  })

  it('rejects an empty session.generate reply instead of returning blank success', async () => {
    const { client } = textSessionClient({ generate: vi.fn(async () => ({ text: '   ' })) })
    await expect(generateOpenCodeText({
      buildOpenCodeUrl: () => 'http://127.0.0.1:4096',
      getOpenCodeAuthHeaders: () => ({}),
      providerID: 'opencode',
      modelID: 'gpt-5-nano',
      messages: [{ role: 'user', content: 'hi' }],
      clientFactory: () => client,
      ensureTempDirectory: async () => '/tmp/openchamber-text',
    })).rejects.toMatchObject({ message: 'OpenCode session.generate returned no text' })
  })

  it('does not invent deltas on the session.generate path', async () => {
    const onTextDelta = vi.fn()
    const subscribers = new Set()
    const globalEventHub = {
      subscribeEvent(fn) {
        subscribers.add(fn)
        return () => { subscribers.delete(fn) }
      },
    }
    const { client } = textSessionClient({ generate: vi.fn(async () => ({ text: 'full reply' })) })
    const result = await generateOpenCodeText({
      buildOpenCodeUrl: () => 'http://127.0.0.1:4096',
      getOpenCodeAuthHeaders: () => ({}),
      providerID: 'opencode',
      modelID: 'gpt-5-nano',
      messages: [{ role: 'user', content: 'hi' }],
      clientFactory: () => client,
      ensureTempDirectory: async () => '/tmp/openchamber-text',
      onTextDelta,
      globalEventHub,
    })
    expect(result).toEqual({ text: 'full reply', source: 'session.generate' })
    expect(onTextDelta).not.toHaveBeenCalled()
    expect(subscribers.size).toBe(0)
  })

  it('keeps image descriptions for non-vision generate and stays on text path', async () => {
    const image = { type: 'file', mime: 'image/png', url: 'data:image/png;base64,aa', filename: 'shot.png' }
    const file = { type: 'file', mime: 'text/plain', url: 'data:text/plain;base64,eA==', filename: 'notes.txt' }
    expect(_test.filesForPrompt([image, file], false)).toEqual([file])
    expect(_test.imageFilesForSession([image, file], false)).toEqual([])

    const { client, generate, prompt } = textSessionClient({ generate: vi.fn(async () => ({ text: 'cannot see images' })) })
    await generateOpenCodeText({
      buildOpenCodeUrl: () => 'http://127.0.0.1:4096',
      getOpenCodeAuthHeaders: () => ({}),
      providerID: 'opencode',
      modelID: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'look', parts: [image, file] }],
      clientFactory: () => client,
      ensureTempDirectory: async () => '/tmp/openchamber-text',
      forwardImageParts: false,
    })
    expect(prompt).not.toHaveBeenCalled()
    expect(generate.mock.calls[0][0].prompt).toContain('[image: shot.png (image/png)]')
    expect(generate.mock.calls[0][0].prompt).toContain('[file: notes.txt (text/plain)]')
  })
})

describe('generateOpenCodeText — attachment session path', () => {
  it('verifies deny-all before prompt, prompts with files, waits, lists, and removes', async () => {
    const agentGet = vi.fn(async () => denyAllAgent)
    const create = vi.fn(async () => ({ id: 'ses_tmp' }))
    const put = vi.fn(async () => undefined)
    const prompt = vi.fn(async () => ({ id: 'inbox_1', type: 'user' }))
    const wait = vi.fn(async () => undefined)
    const list = vi.fn(async () => ({ data: [completedAssistant('saw it')], cursor: {} }))
    const remove = vi.fn(async () => undefined)
    const interrupt = vi.fn(async () => undefined)
    const text = vi.fn()
    const persistSessionMetadata = vi.fn(async () => ({}))
    const onSystemSessionPersisted = vi.fn()
    const image = { type: 'file', mime: 'image/png', url: 'data:image/png;base64,aa', filename: 'shot.png' }

    const result = await generateOpenCodeText({
      buildOpenCodeUrl: () => 'http://127.0.0.1:4096',
      getOpenCodeAuthHeaders: () => ({}),
      providerID: 'opencode',
      modelID: 'gpt-4o',
      messages: [
        { role: 'system', content: 'Be careful' },
        { role: 'user', content: 'look', parts: [image] },
      ],
      variant: 'high',
      persistSessionMetadata,
      onSystemSessionPersisted,
      clientFactory: () => ({
        generate: { text },
        agent: { get: agentGet },
        session: {
          create,
          prompt,
          wait,
          interrupt,
          remove,
          instructions: { entry: { put } },
        },
        message: { list },
      }),
      ensureTempDirectory: async ({ agentMarkdown }) => {
        expect(agentMarkdown).toContain('openchamber-tool JSON fences')
        expect(agentMarkdown).toMatch(/action:\s*"\*"/)
        expect(agentMarkdown).toMatch(/effect:\s*deny/)
        return '/tmp/openchamber-llm'
      },
      forwardImageParts: true,
    })

    expect(result).toEqual({ text: 'saw it', source: 'attachment-session' })
    expect(agentGet).toHaveBeenCalledWith(expect.objectContaining({
      agentID: 'openchamber-llm',
      location: { directory: '/tmp/openchamber-llm' },
    }), expect.anything())
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'openchamber-llm',
      model: { id: 'gpt-4o', providerID: 'opencode', variant: 'high' },
      location: { directory: '/tmp/openchamber-llm' },
      metadata: { openchamber: { llm: { purpose: 'chat-completions' } } },
    }), expect.anything())
    expect(put).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: 'ses_tmp',
      key: 'system',
      value: 'Be careful',
    }), expect.anything())
    // agent.get must complete before prompt
    expect(agentGet.mock.invocationCallOrder[0]).toBeLessThan(prompt.mock.invocationCallOrder[0])
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: 'ses_tmp',
      text: expect.stringContaining('User: look'),
      files: [{ uri: image.url, name: 'shot.png' }],
      delivery: 'steer',
    }), expect.anything())
    expect(wait).toHaveBeenCalledWith({ sessionID: 'ses_tmp' }, expect.anything())
    expect(list).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: 'ses_tmp',
      order: 'desc',
    }), expect.anything())
    expect(remove).toHaveBeenCalledWith({ sessionID: 'ses_tmp' })
    expect(persistSessionMetadata).toHaveBeenCalledWith('ses_tmp', {
      openchamber: { llm: { purpose: 'chat-completions' } },
    })
    expect(onSystemSessionPersisted).toHaveBeenCalledWith({
      sessionID: 'ses_tmp',
      directory: '/tmp/openchamber-llm',
      metadata: { openchamber: { llm: { purpose: 'chat-completions' } } },
    })
    expect(text).not.toHaveBeenCalled()
  })

  it('fails with llm_attachment_generation_unavailable before prompt when deny-all is missing', async () => {
    const prompt = vi.fn()
    const remove = vi.fn()
    const image = { type: 'file', mime: 'image/png', url: 'data:image/png;base64,aa', filename: 'shot.png' }

    await expect(generateOpenCodeText({
      buildOpenCodeUrl: () => 'http://127.0.0.1:4096',
      getOpenCodeAuthHeaders: () => ({}),
      providerID: 'opencode',
      modelID: 'gpt-4o',
      messages: [{ role: 'user', content: 'look', parts: [image] }],
      clientFactory: () => ({
        agent: {
          get: async () => ({
            data: {
              id: 'openchamber-llm',
              permissions: [
                { action: 'read', resource: 'file', effect: 'allow' },
              ],
            },
          }),
        },
        session: {
          create: async () => ({ id: 'ses_tmp' }),
          prompt,
          remove,
        },
      }),
      ensureTempDirectory: async () => '/tmp/openchamber-llm',
      forwardImageParts: true,
    })).rejects.toMatchObject({
      code: 'llm_attachment_generation_unavailable',
    })
    expect(prompt).not.toHaveBeenCalled()
  })

  it('removes the session when wait fails and still cleans hub listeners', async () => {
    const subscribers = new Set()
    const globalEventHub = {
      subscribeEvent(fn) {
        subscribers.add(fn)
        return () => { subscribers.delete(fn) }
      },
    }
    const remove = vi.fn(async () => undefined)
    const image = { type: 'file', mime: 'image/png', url: 'data:image/png;base64,aa', filename: 'shot.png' }

    await expect(generateOpenCodeText({
      buildOpenCodeUrl: () => 'http://127.0.0.1:4096',
      getOpenCodeAuthHeaders: () => ({}),
      providerID: 'opencode',
      modelID: 'gpt-4o',
      messages: [{ role: 'user', content: 'look', parts: [image] }],
      clientFactory: () => ({
        agent: { get: async () => denyAllAgent },
        session: {
          create: async () => ({ id: 'ses_tmp' }),
          prompt: async () => ({ id: 'inbox' }),
          wait: async () => {
            throw new Error('wait boom')
          },
          remove,
          interrupt: vi.fn(),
          instructions: { entry: { put: async () => {} } },
        },
        message: { list: vi.fn() },
      }),
      ensureTempDirectory: async () => '/tmp/openchamber-llm',
      forwardImageParts: true,
      onTextDelta: vi.fn(),
      globalEventHub,
    })).rejects.toMatchObject({
      code: 'upstream_error',
      message: 'wait boom',
    })
    expect(remove).toHaveBeenCalledWith({ sessionID: 'ses_tmp' })
    expect(subscribers.size).toBe(0)
  })

  it('surfaces assistant error from message.list and cleans up', async () => {
    const remove = vi.fn(async () => undefined)
    const image = { type: 'file', mime: 'image/png', url: 'data:image/png;base64,aa', filename: 'shot.png' }

    await expect(generateOpenCodeText({
      buildOpenCodeUrl: () => 'http://127.0.0.1:4096',
      getOpenCodeAuthHeaders: () => ({}),
      providerID: 'opencode',
      modelID: 'gpt-4o',
      messages: [{ role: 'user', content: 'look', parts: [image] }],
      clientFactory: () => ({
        agent: { get: async () => denyAllAgent },
        session: {
          create: async () => ({ id: 'ses_tmp' }),
          prompt: async () => ({ id: 'inbox' }),
          wait: async () => undefined,
          remove,
          interrupt: vi.fn(),
          instructions: { entry: { put: async () => {} } },
        },
        message: {
          list: async () => ({
            data: [completedAssistant('', {
              finish: 'error',
              error: { message: 'model refused the request' },
              content: [],
            })],
            cursor: {},
          }),
        },
      }),
      ensureTempDirectory: async () => '/tmp/openchamber-llm',
      forwardImageParts: true,
    })).rejects.toMatchObject({
      code: 'upstream_error',
      message: 'model refused the request',
    })
    expect(remove).toHaveBeenCalled()
  })

  it('forwards filtered session.text.delta tokens via onTextDelta and still returns full text', async () => {
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
    const image = { type: 'file', mime: 'image/png', url: 'data:image/png;base64,aa', filename: 'shot.png' }

    const prompt = vi.fn(async () => {
      globalEventHub.emit({
        payload: {
          type: 'session.text.delta',
          data: {
            sessionID: 'ses_tmp',
            assistantMessageID: 'msg_asst',
            ordinal: 0,
            delta: 'Hel',
          },
        },
      })
      globalEventHub.emit({
        payload: {
          type: 'session.text.delta',
          data: {
            sessionID: 'ses_tmp',
            assistantMessageID: 'msg_asst',
            ordinal: 1,
            delta: 'lo',
          },
        },
      })
      // Other session — ignored
      globalEventHub.emit({
        payload: {
          type: 'session.text.delta',
          data: {
            sessionID: 'ses_other',
            assistantMessageID: 'msg_other',
            ordinal: 0,
            delta: 'NOPE',
          },
        },
      })
      // Same session, different assistantMessageID after lock — ignored
      globalEventHub.emit({
        payload: {
          type: 'session.text.delta',
          data: {
            sessionID: 'ses_tmp',
            assistantMessageID: 'msg_other_asst',
            ordinal: 2,
            delta: 'SKIP',
          },
        },
      })
      // Stale ordinal — ignored
      globalEventHub.emit({
        payload: {
          type: 'session.text.delta',
          data: {
            sessionID: 'ses_tmp',
            assistantMessageID: 'msg_asst',
            ordinal: 1,
            delta: 'DUP',
          },
        },
      })
      return { id: 'inbox' }
    })

    const result = await generateOpenCodeText({
      buildOpenCodeUrl: () => 'http://127.0.0.1:4096',
      getOpenCodeAuthHeaders: () => ({}),
      providerID: 'opencode',
      modelID: 'gpt-4o',
      messages: [{ role: 'user', content: 'look', parts: [image] }],
      clientFactory: () => ({
        agent: { get: async () => denyAllAgent },
        session: {
          create: async () => ({ id: 'ses_tmp' }),
          prompt,
          wait: async () => undefined,
          remove: async () => undefined,
          interrupt: vi.fn(),
          instructions: { entry: { put: async () => {} } },
        },
        message: {
          list: async () => ({ data: [completedAssistant('Hello')], cursor: {} }),
        },
      }),
      ensureTempDirectory: async () => '/tmp/openchamber-llm',
      forwardImageParts: true,
      onTextDelta,
      globalEventHub,
    })

    expect(result).toEqual({ text: 'Hello', source: 'attachment-session' })
    expect(deltas).toEqual(['Hel', 'lo'])
    expect(subscribers.size).toBe(0)
    globalEventHub.emit({
      payload: {
        type: 'session.text.delta',
        data: {
          sessionID: 'ses_tmp',
          assistantMessageID: 'msg_asst',
          ordinal: 3,
          delta: 'late',
        },
      },
    })
    expect(onTextDelta).toHaveBeenCalledTimes(2)
  })

  it('logs remove errors without erasing a successful generate result', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const image = { type: 'file', mime: 'image/png', url: 'data:image/png;base64,aa', filename: 'shot.png' }
    try {
      const result = await generateOpenCodeText({
        buildOpenCodeUrl: () => 'http://127.0.0.1:4096',
        getOpenCodeAuthHeaders: () => ({}),
        providerID: 'opencode',
        modelID: 'gpt-4o',
        messages: [{ role: 'user', content: 'look', parts: [image] }],
        clientFactory: () => ({
          agent: { get: async () => denyAllAgent },
          session: {
            create: async () => ({ id: 'ses_tmp' }),
            prompt: async () => ({ id: 'inbox' }),
            wait: async () => undefined,
            remove: async () => {
              throw new Error('delete denied')
            },
            interrupt: vi.fn(),
            instructions: { entry: { put: async () => {} } },
          },
          message: {
            list: async () => ({ data: [completedAssistant('ok')], cursor: {} }),
          },
        }),
        ensureTempDirectory: async () => '/tmp/openchamber-llm',
        forwardImageParts: true,
      })
      expect(result).toEqual({ text: 'ok', source: 'attachment-session' })
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('[llm] failed to remove throwaway OpenCode session:'),
        expect.stringContaining('delete denied'),
      )
    } finally {
      warn.mockRestore()
    }
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

describe('data URL validation', () => {
  it('rejects oversized attachments', () => {
    const huge = Buffer.alloc(_test.MAX_ATTACHMENT_BYTES + 1, 1).toString('base64')
    expect(() => _test.parseDataUrl(`data:image/png;base64,${huge}`)).toThrow(/limit/)
  })

  it('accepts small valid data URLs', () => {
    const parsed = _test.parseDataUrl('data:image/png;base64,aa')
    expect(parsed?.mime).toBe('image/png')
    expect(parsed?.byteLength).toBeGreaterThan(0)
  })
})

describe('generateOpenCodeText — real OpenCode.make + fake HTTP', () => {
  it('session.generate text completion through the real client', async () => {
    const { OpenCode } = await import('@opencode/client')
    const calls = []
    const emptyOk = { ok: true, status: 204, headers: { get: () => null }, text: async () => '', json: async () => null, arrayBuffer: async () => new ArrayBuffer(0) }
    const fetchImpl = vi.fn(async (url, init) => {
      const path = String(url)
      const method = init?.method || 'GET'
      calls.push(`${method} ${path.replace(/^https?:\/\/[^/]+/, '').split('?')[0]}`)
      if (path.includes('/api/agent/openchamber-text')) {
        return jsonResponse(200, {
          location: { directory: '/tmp/openchamber-text', project: { id: 'p', directory: '/tmp', canonical: '/tmp' } },
          data: { ...denyAllTextAgent.data, request: {} },
        })
      }
      if (path.endsWith('/api/session') && method === 'POST') {
        return jsonResponse(200, {
          data: {
            id: 'ses_text',
            projectID: 'p',
            cost: 0,
            tokens: {},
            time: { created: 1, updated: 1 },
            location: { directory: '/tmp/openchamber-text' },
          },
        })
      }
      if (path.includes('/api/session/ses_text/generate') && method === 'POST') {
        const body = JSON.parse(init.body)
        expect(body.prompt).toContain('User: hi')
        return jsonResponse(200, { data: { text: 'hello from generate' } })
      }
      if (path.includes('/api/session/ses_text') && method === 'DELETE') return emptyOk
      return jsonResponse(500, { _tag: 'UnknownError', message: `unexpected ${method} ${path}` })
    })

    const result = await generateOpenCodeText({
      buildOpenCodeUrl: () => 'http://127.0.0.1:4096',
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic test' }),
      providerID: 'opencode',
      modelID: 'gpt-5-nano',
      messages: [{ role: 'user', content: 'hi' }],
      clientFactory: () => OpenCode.make({
        baseUrl: 'http://127.0.0.1:4096',
        headers: { Authorization: 'Basic test' },
        fetch: fetchImpl,
      }),
      ensureTempDirectory: async () => '/tmp/openchamber-text',
    })

    expect(result).toEqual({ text: 'hello from generate', source: 'session.generate' })
    expect(calls.some((c) => c.startsWith('DELETE ') && c.includes('/api/session/ses_text'))).toBe(true)
  })

  it('attachment deny-all failure happens before prompt on the real client path shape', async () => {
    const { OpenCode } = await import('@opencode/client')
    let prompted = false
    const fetchImpl = vi.fn(async (url, init) => {
      const path = String(url)
      if (path.includes('/api/agent/openchamber-llm')) {
        return jsonResponse(200, {
          location: { directory: '/tmp/openchamber-llm', project: { id: 'p', directory: '/tmp', canonical: '/tmp' } },
          data: {
            id: 'openchamber-llm',
            name: 'openchamber-llm',
            mode: 'primary',
            hidden: true,
            permissions: [{ action: 'bash', resource: '*', effect: 'allow' }],
            request: {},
          },
        })
      }
      if (path.includes('/prompt')) {
        prompted = true
        return jsonResponse(200, { data: { id: 'inbox' } })
      }
      if (path.endsWith('/api/session') && init?.method === 'POST') {
        return jsonResponse(200, {
          data: {
            id: 'ses_tmp',
            projectID: 'p',
            cost: 0,
            tokens: {},
            time: { created: 1, updated: 1 },
            location: { directory: '/tmp/openchamber-llm' },
          },
        })
      }
      return jsonResponse(500, { _tag: 'UnknownError', message: `unexpected ${path}` })
    })

    const image = { type: 'file', mime: 'image/png', url: 'data:image/png;base64,aa', filename: 'shot.png' }
    await expect(generateOpenCodeText({
      buildOpenCodeUrl: () => 'http://127.0.0.1:4096',
      getOpenCodeAuthHeaders: () => ({}),
      providerID: 'opencode',
      modelID: 'gpt-4o',
      messages: [{ role: 'user', content: 'look', parts: [image] }],
      clientFactory: () => OpenCode.make({
        baseUrl: 'http://127.0.0.1:4096',
        fetch: fetchImpl,
      }),
      ensureTempDirectory: async () => '/tmp/openchamber-llm',
      forwardImageParts: true,
    })).rejects.toMatchObject({ code: 'llm_attachment_generation_unavailable' })
    expect(prompted).toBe(false)
  })

  it('attachment success path removes the session after message.list', async () => {
    const { OpenCode } = await import('@opencode/client')
    const calls = []
    const fetchImpl = vi.fn(async (url, init) => {
      const path = String(url)
      const method = init?.method || 'GET'
      calls.push(`${method} ${path.replace(/^https?:\/\/[^/]+/, '')}`)
      if (path.includes('/api/agent/openchamber-llm')) {
        return jsonResponse(200, {
          location: { directory: '/tmp/openchamber-llm', project: { id: 'p', directory: '/tmp', canonical: '/tmp' } },
          data: {
            id: 'openchamber-llm',
            name: 'openchamber-llm',
            mode: 'primary',
            hidden: true,
            permissions: [{ action: '*', resource: '*', effect: 'deny' }],
            request: {},
          },
        })
      }
      if (path.endsWith('/api/session') && method === 'POST') {
        return jsonResponse(200, {
          data: {
            id: 'ses_tmp',
            projectID: 'p',
            cost: 0,
            tokens: {},
            time: { created: 1, updated: 1 },
            location: { directory: '/tmp/openchamber-llm' },
          },
        })
      }
      if (path.includes('/instructions/entries/')) {
        return { ok: true, status: 204, headers: { get: () => null }, text: async () => '', json: async () => null, arrayBuffer: async () => new ArrayBuffer(0) }
      }
      if (path.includes('/prompt')) {
        return jsonResponse(200, { data: { id: 'inbox_1', type: 'user', text: 'look' } })
      }
      if (path.includes('/wait')) {
        return { ok: true, status: 204, headers: { get: () => null }, text: async () => '', json: async () => null, arrayBuffer: async () => new ArrayBuffer(0) }
      }
      if (path.includes('/message') && method === 'GET') {
        return jsonResponse(200, {
          data: [completedAssistant('vision ok')],
          cursor: {},
        })
      }
      if (path.includes('/api/session/ses_tmp') && method === 'DELETE') {
        return { ok: true, status: 204, headers: { get: () => null }, text: async () => '', json: async () => null, arrayBuffer: async () => new ArrayBuffer(0) }
      }
      return jsonResponse(500, { _tag: 'UnknownError', message: `unexpected ${method} ${path}` })
    })

    const image = { type: 'file', mime: 'image/png', url: 'data:image/png;base64,aa', filename: 'shot.png' }
    const result = await generateOpenCodeText({
      buildOpenCodeUrl: () => 'http://127.0.0.1:4096',
      getOpenCodeAuthHeaders: () => ({}),
      providerID: 'opencode',
      modelID: 'gpt-4o',
      messages: [{ role: 'user', content: 'look', parts: [image] }],
      clientFactory: () => OpenCode.make({
        baseUrl: 'http://127.0.0.1:4096',
        fetch: fetchImpl,
      }),
      ensureTempDirectory: async () => '/tmp/openchamber-llm',
      forwardImageParts: true,
    })

    expect(result).toEqual({ text: 'vision ok', source: 'attachment-session' })
    expect(calls.some((c) => c.startsWith('DELETE ') && c.includes('/api/session/ses_tmp'))).toBe(true)
    const agentIdx = calls.findIndex((c) => c.includes('/api/agent/openchamber-llm'))
    const promptIdx = calls.findIndex((c) => c.includes('/prompt'))
    expect(agentIdx).toBeGreaterThanOrEqual(0)
    expect(promptIdx).toBeGreaterThan(agentIdx)
  })
})
