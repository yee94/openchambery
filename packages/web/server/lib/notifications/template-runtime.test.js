import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNotificationTemplateRuntime } from './template-runtime.js';

const originalFetch = globalThis.fetch;

const createRuntime = (settings = {}) => createNotificationTemplateRuntime({
  readSettingsFromDisk: async () => settings,
  persistSettings: vi.fn(async () => {}),
  buildOpenCodeUrl: (path) => path,
  getOpenCodeAuthHeaders: () => ({}),
  resolveGitBinaryForSpawn: () => 'git',
});

describe('notification template runtime zen models', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns no selectable zen models after provider retirement', async () => {
    const runtime = createRuntime();
    const models = await runtime.fetchFreeZenModels();

    expect(models).toEqual([]);
  });

  it('preserves stored zen model value for compatibility without validation', async () => {
    const runtime = createRuntime({ zenModel: 'trinity-large-preview-free' });

    await expect(runtime.resolveZenModel()).resolves.toBe('trinity-large-preview-free');
  });
});

describe('notification template message extraction', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('excludes reasoning parts from payload message text', () => {
    const runtime = createRuntime();

    expect(runtime.extractLastMessageText({
      properties: {
        info: {
          parts: [
            { type: 'reasoning', text: 'private chain of thought' },
            { type: 'text', text: 'final answer' },
          ],
        },
      },
    })).toBe('final answer');
  });

  it('ignores untyped parts even when they contain text', () => {
    const runtime = createRuntime();

    expect(runtime.extractLastMessageText({
      properties: {
        info: {
          parts: [
            { text: 'untyped text' },
            { content: 'untyped content' },
            { type: 'text', text: 'typed final answer' },
          ],
        },
      },
    })).toBe('typed final answer');
  });

  it('excludes reasoning parts when fetching assistant messages', async () => {
    const runtime = createRuntime();
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify([
      {
        info: { id: 'msg-1', role: 'assistant', finish: 'stop' },
        parts: [
          { type: 'reasoning', text: 'private chain of thought' },
          { type: 'text', text: 'final answer' },
        ],
      },
    ])));

    await expect(runtime.fetchLastAssistantMessageText('session-1', 'msg-1')).resolves.toBe('final answer');
  });
});

describe('notification session titles', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('reads the OpenCode 2 session title from the data envelope', async () => {
    const runtime = createNotificationTemplateRuntime({
      readSettingsFromDisk: async () => ({}),
      buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
      getOpenCodeAuthHeaders: () => ({ authorization: 'Basic test' }),
      resolveGitBinaryForSpawn: () => 'git',
    });
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      data: { id: 'ses_1', title: '发布说明' },
    })));

    const variables = await runtime.buildTemplateVariables({
      type: 'message.updated',
      location: { directory: '/repo' },
      properties: { info: { sessionID: 'ses_1', role: 'assistant', finish: 'stop' } },
    }, 'ses_1');

    expect(variables.session_name).toBe('发布说明');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://opencode.test/session/ses_1?directory=%2Frepo',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Basic test' }),
      }),
    );
  });

  it('keeps a title learned from session.renamed when the session fetch fails', async () => {
    const runtime = createRuntime();
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 401 }));
    runtime.maybeCacheSessionInfoFromEvent({
      type: 'session.renamed',
      data: { sessionID: 'ses_1', title: '修通知标题' },
    });

    const variables = await runtime.buildTemplateVariables({
      type: 'session.execution.succeeded',
      data: { sessionID: 'ses_1' },
    }, 'ses_1');

    expect(variables.session_name).toBe('修通知标题');
  });

  it('reads the latest assistant text from an OpenCode 2 message page', async () => {
    const runtime = createRuntime();
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      data: [
        {
          id: 'msg_new',
          sessionID: 'ses_1',
          type: 'assistant',
          agent: 'build',
          model: { id: 'gpt-5', providerID: 'openai' },
          content: [
            { type: 'reasoning', text: 'private' },
            { type: 'text', text: '发布说明已写好' },
          ],
          time: { created: 2 },
        },
        {
          id: 'msg_old',
          sessionID: 'ses_1',
          type: 'assistant',
          content: [{ type: 'text', text: 'older' }],
          finish: 'stop',
          time: { created: 1 },
        },
      ],
    })));

    await expect(runtime.fetchLastAssistantMessageText('ses_1')).resolves.toBe('发布说明已写好');
  });

  it('fills agent and model names from the OpenCode 2 session record', async () => {
    const runtime = createRuntime();
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      data: { id: 'ses_1', title: '发布说明', agent: 'build', model: { id: 'gpt-5', providerID: 'openai' } },
    })));

    const variables = await runtime.buildTemplateVariables({
      type: 'session.execution.succeeded',
      data: { sessionID: 'ses_1' },
    }, 'ses_1');

    expect(variables).toMatchObject({
      session_name: '发布说明',
      agent_name: 'Build',
      model_name: 'Gpt 5',
    });
  });
});
