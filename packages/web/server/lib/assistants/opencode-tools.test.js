import { describe, expect, it, vi } from 'vitest';
import { makeOpenCodeV2Client } from '../opencode/v2-client.js';
import { createOpenCodeContactToolGroups, createOpenCodeContactTools } from './opencode-tools.js';
import { runContactTurn } from './harness.js';
import { createYuriContactTools } from './yuri-tools.js';

const nativeCall = (name, args) => ({ completion: { choices: [{ message: { tool_calls: [{ id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] } });

const setup = (api, options = {}) => {
  const resolveClient = vi.fn(() => api);
  const tools = createOpenCodeContactTools({ resolveClient, directory: '/workspace', ...options });
  return { tools, resolveClient, call: (name, params = {}, signal) => tools.find((tool) => tool.name === name).execute('probe', params, signal) };
};

describe('direct OpenCode contact tools', () => {
  it('describes three deferred groups using existing tool objects without resolving a client or reading skills', () => {
    const { tools, resolveClient } = setup({});
    const groups = createOpenCodeContactToolGroups(tools);
    expect(groups.map(({ id, tools: members }) => ({ id, names: members.map((tool) => tool.name) }))).toEqual([
      { id: 'opencode.web', names: ['list_websearch_providers', 'websearch'] },
      { id: 'opencode.activity', names: ['list_active_sessions'] },
      { id: 'opencode.catalog', names: ['list_opencode_capabilities', 'read_opencode_skill'] },
    ]);
    for (const group of groups) {
      for (const tool of group.tools) expect(tool).toBe(tools.find((original) => original.name === tool.name));
    }
    expect(groups.flatMap((group) => group.tools)).toHaveLength(tools.length);
    expect(resolveClient).not.toHaveBeenCalled();
    expect(createOpenCodeContactToolGroups([])).toEqual([]);
    expect(createOpenCodeContactToolGroups(tools.filter((tool) => tool.name === 'websearch')).map((group) => group.id)).toEqual(['opencode.web']);
  });

  it('executes a search through the official authenticated SDK with location and signal', async () => {
    const fetchImpl = vi.fn(async (input, init) => {
      const request = new Request(input, init);
      expect(request.headers.get('authorization')).toBe('test-auth');
      expect(new URL(request.url).origin).toBe('https://upstream.example.test');
      expect(new URL(request.url).searchParams.get('location[directory]')).toBe('/workspace');
      expect(await request.json()).toEqual({ query: 'site:github.com iOS client', providerID: 'exa' });
      expect(request.signal).toBeInstanceOf(AbortSignal);
      return Response.json({ location: { directory: '/workspace' }, data: { providerID: 'exa', results: [{ url: 'https://example.test/source', title: 'Source', content: 'Verified snippet', time: {} }] } });
    });
    const api = makeOpenCodeV2Client({ baseUrl: 'https://upstream.example.test', authHeaders: { authorization: 'test-auth' }, fetchImpl });
    const { call } = setup(api);
    const output = await call('websearch', { query: 'site:github.com iOS client', providerID: 'exa' });
    expect(output.isError).not.toBe(true);
    expect(output.details).toMatchObject({ providerID: 'exa', results: [{ title: 'Source', content: 'Verified snippet' }], partial: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('uses the current client on every call and does not replay a failed search', async () => {
    const first = { websearch: { query: vi.fn().mockRejectedValue({ status: 503, message: 'private upstream body', headers: { authorization: 'private' } }) } };
    const second = { websearch: { query: vi.fn().mockResolvedValue({ data: { providerID: 'exa', results: [] } }) } };
    let current = first;
    const tools = createOpenCodeContactTools({ resolveClient: () => current });
    const search = tools.find((tool) => tool.name === 'websearch');
    const failed = await search.execute('one', { query: 'research' });
    expect(failed).toMatchObject({ isError: true, details: { error: 'opencode_failed', status: 503 }, terminate: false });
    expect(JSON.stringify(failed)).not.toContain('private');
    expect(first.websearch.query).toHaveBeenCalledTimes(1);
    current = second;
    expect((await search.execute('two', { query: 'research', providerID: 'exa' })).details.results).toEqual([]);
    expect(second.websearch.query).toHaveBeenCalledTimes(1);
  });

  it.each([
    [401, 'UnauthorizedError', 'authentication_required', /authentication|sign.in/i],
    [403, 'ForbiddenError', 'permission_denied', /permission|access/i],
    [503, 'ServiceUnavailableError', 'opencode_failed', /retry/i],
  ])('preserves SDK failure %s without exposing its private body', async (status, tag, category, guidance) => {
    const fetchImpl = vi.fn(async () => Response.json({ _tag: tag, message: 'PRIVATE_SENTINEL', headers: { authorization: 'PRIVATE_SENTINEL' } }, { status }));
    const api = makeOpenCodeV2Client({ baseUrl: 'https://upstream.example.test', fetchImpl });
    const { call } = setup(api);
    const output = await call('websearch', { query: 'research' });
    expect(output).toMatchObject({ isError: true, details: { error: category, status } });
    const visible = JSON.parse(output.content[0].text);
    expect(visible).toMatchObject({ error: category, status, message: expect.stringMatching(guidance) });
    if (status === 503) expect(visible.message).toMatch(/list_websearch_providers before.*retry/);
    expect(JSON.stringify(output)).not.toContain('PRIVATE_SENTINEL');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 401 }, { cause: { status: 401 } },
  ])('classifies status-only authentication errors as well as SDK tags (%j)', async (error) => {
    const { call } = setup({ websearch: { query: async () => { throw error; } } });
    expect(await call('websearch', { query: 'research' })).toMatchObject({ isError: true, details: { error: 'authentication_required', status: 401 } });
  });

  it.each(['authentication', 'timeout'])('delivers %s failure and safe guidance to the model through the real Agent', async (scenario) => {
    const fetchImpl = vi.fn(async () => scenario === 'authentication'
      ? Response.json({ _tag: 'UnauthorizedError', message: 'PRIVATE_SENTINEL' }, { status: 401 })
      : new Promise(() => {}));
    const api = makeOpenCodeV2Client({ baseUrl: 'https://upstream.example.test', fetchImpl });
    const { tools } = setup(api, { timeoutMs: 20 });
    let round = 0;
    await runContactTurn({ assistant: { providerID: 'p', modelID: 'm' }, history: [], userText: 'Search once; if it times out, do not retry.', tools,
      createChatCompletion: async ({ body }) => {
        round++;
        if (round === 1) return nativeCall('load_tools', { domain: 'opencode.web' });
        if (round === 2) return nativeCall('websearch', { query: 'research' });
        const message = body.messages.find((item) => item.role === 'tool' && item.tool_call_id === 'call_websearch');
        const envelope = JSON.parse(message.content);
        expect(envelope.isError).toBe(true);
        const visible = JSON.parse(envelope.content);
        expect(visible.error).toBe(scenario === 'authentication' ? 'authentication_required' : 'timeout');
        expect(visible.message).toMatch(scenario === 'authentication' ? /authentication|sign.in/i : /timed out/i);
        expect(visible.message).toMatch(scenario === 'authentication' ? /do not.*provider|do not.*switch/i : /user.*retry|retry.*user/i);
        expect(message.content).not.toContain('PRIVATE_SENTINEL');
        return { text: 'Failure acknowledged.' };
      },
    });
    expect(round).toBe(3);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('bounds source excerpts and explicitly marks truncated results', async () => {
    const { call } = setup({ websearch: { query: async () => ({ data: { providerID: 'exa', results: Array.from({ length: 12 }, (_, id) => ({ url: `https://example.test/${id}`, content: 'x'.repeat(4000) })) } }) } });
    const output = await call('websearch', { query: 'research', limit: 2 });
    expect(output.details).toMatchObject({ total: 12, partial: true });
    expect(output.details.results).toHaveLength(2);
    expect(output.details.results[0].content).toHaveLength(2000);
  });

  it.each([null, { data: null }, { data: { providerID: 'exa', results: [{ url: 'file:///private/source' }] } }])('does not turn malformed search data into empty success', async (response) => {
    const { call } = setup({ websearch: { query: async () => response } });
    expect(await call('websearch', { query: 'research' })).toMatchObject({ isError: true, details: { error: 'opencode_failed' } });
  });

  it('discovers providers without treating their catalog metadata as search results', async () => {
    const { call } = setup({ websearch: { providers: async () => ({ data: [{ id: 'exa', name: 'Exa', secret: 'private' }] }) } });
    expect((await call('list_websearch_providers')).details).toEqual({ providers: [{ id: 'exa', name: 'Exa' }] });
  });

  it('uses authoritative live membership, not historical statuses, and paginates without identity sorting', async () => {
    const active = vi.fn(async () => ({ ses_z: { type: 'running' }, ses_a: { type: 'running' } }));
    const { call } = setup({ session: { active } });
    const one = await call('list_active_sessions', { limit: 1 });
    expect(one.details).toMatchObject({ items: [{ sessionID: 'ses_z', status: 'running' }], total: 2, nextOffset: 1, partial: true });
    expect((await call('list_active_sessions', { limit: 1, offset: 1 })).details.items[0].sessionID).toBe('ses_a');
    expect((await call('list_active_sessions', { sessionID: 'ses_missing' })).details.status).toBe('not_active');
    expect((await call('list_active_sessions', { sessionID: 'ses_z' })).details.status).toBe('running');
    active.mockResolvedValueOnce({});
    expect((await call('list_active_sessions')).details).toMatchObject({ items: [], total: 0, partial: false });
    active.mockRejectedValueOnce(new Error('network'));
    expect(await call('list_active_sessions')).toMatchObject({ isError: true });
    active.mockResolvedValueOnce({ error: 'invalid' });
    expect(await call('list_active_sessions')).toMatchObject({ isError: true });
  });

  it('projects capability metadata without leaking agent prompts, request headers or MCP error bodies', async () => {
    const { call } = setup({
      agent: { list: async () => ({ data: [{ id: 'build', name: 'Build', description: 'Coding', system: 'private', request: { headers: { private: 'private' } } }, { id: 'hidden', hidden: true }] }) },
      mcp: { list: async () => ({ data: [{ name: 'docs', status: { status: 'needs_auth', error: 'private body' } }] }) },
    });
    expect((await call('list_opencode_capabilities', { resource: 'agents' })).details.items).toEqual([{ id: 'build', name: 'Build', description: 'Coding' }]);
    const output = await call('list_opencode_capabilities', { resource: 'mcp' });
    expect(output.details.items).toEqual([{ id: 'docs', name: 'docs', description: '', status: 'needs_auth' }]);
    expect(output.details.execution).toContain('assign_session');
    expect(JSON.stringify(output)).not.toContain('private');
  });

  it('reads built-in skills from API content, with bounded continuation, not their virtual file paths', async () => {
    const { call } = setup({ skill: { list: async () => ({ data: [{ id: 'opencode', name: 'OpenCode', path: '/builtin/opencode.md', content: 'abcdef' }] }) } });
    expect((await call('read_opencode_skill', { id: 'opencode', maxChars: 3 })).details).toEqual({ id: 'opencode', name: 'OpenCode', content: 'abc', nextOffset: 3, partial: true });
    expect((await call('read_opencode_skill', { id: 'opencode', maxChars: 3, offset: 3 })).details).toMatchObject({ content: 'def', nextOffset: null, partial: false });
    expect(await call('read_opencode_skill', { id: 'missing' })).toMatchObject({ isError: true, details: { error: 'validation_error' } });
  });

  it('validates arguments even when callers bypass the model schema', async () => {
    const query = vi.fn();
    const active = vi.fn(async () => ({}));
    const { call } = setup({ websearch: { query }, session: { active } });
    for (const params of [{ query: '' }, { query: 'x', limit: 11 }, { query: 'x', providerID: '' }]) {
      expect(await call('websearch', params)).toMatchObject({ isError: true, details: { error: 'validation_error' } });
    }
    expect(query).not.toHaveBeenCalled();
    expect(await call('list_opencode_capabilities', { resource: 'credentials' })).toMatchObject({ isError: true });
    expect(await call('list_active_sessions', { offset: -1 })).toMatchObject({ isError: true });
    expect(await call('list_active_sessions', { sessionID: 'a guessed title' })).toMatchObject({ isError: true, details: { error: 'validation_error' } });
  });

  it('propagates cancellation and bounds an uncooperative SDK request without retrying', async () => {
    const query = vi.fn(() => new Promise(() => {}));
    const { call } = setup({ websearch: { query } }, { timeoutMs: 15 });
    const timeout = await call('websearch', { query: 'research' });
    expect(timeout).toMatchObject({ isError: true, details: { error: 'timeout' } });
    expect(query.mock.calls[0][1].signal.aborted).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    const parent = new AbortController();
    const pending = call('websearch', { query: 'research' }, parent.signal);
    parent.abort(new Error('user cancelled'));
    await expect(pending).rejects.toThrow('user cancelled');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('executes native websearch calls through the real contact Agent and returns source evidence to the model', async () => {
    const query = vi.fn(async () => ({ data: { providerID: 'exa', results: [{ url: 'https://example.test/repo', title: 'Found repository', content: 'Actual source content' }] } }));
    const { tools } = setup({ websearch: { query } });
    let round = 0;
    const createChatCompletion = vi.fn(async ({ body }) => {
      round++;
      if (round === 1) {
        expect(body.tools.map((tool) => tool.function.name)).toEqual(['load_tools', 'notify_user']);
        expect(query).not.toHaveBeenCalled();
        return { completion: { choices: [{ message: { tool_calls: [{ id: 'load-1', type: 'function', function: { name: 'load_tools', arguments: JSON.stringify({ domain: 'opencode.web' }) } }] } }] } };
      }
      expect(body.tools.map((tool) => tool.function.name)).toContain('websearch');
      expect(body.tools.map((tool) => tool.function.name)).not.toContain('read_opencode_skill');
      if (round === 2) return { completion: { choices: [{ message: { content: '', tool_calls: [{ id: 'search-1', type: 'function', function: { name: 'websearch', arguments: JSON.stringify({ query: 'site:github.com iOS', providerID: 'exa' }) } }] } }] } };
      const evidence = body.messages.find((message) => message.role === 'tool' && message.tool_call_id === 'search-1');
      expect(evidence.content).toContain('Actual source content');
      expect(evidence.content).toContain('https://example.test/repo');
      return { text: '找到了来源。' };
    });
    const output = await runContactTurn({ assistant: { providerID: 'p', modelID: 'm' }, history: [], userText: '帮我联网找一下', tools, createChatCompletion });
    expect(output.bubbles).toEqual(['找到了来源。']);
    expect(query).toHaveBeenCalledTimes(1);
    expect(createChatCompletion).toHaveBeenCalledTimes(3);
  });

  it('does not offer the new execution tools to a read-only background review', async () => {
    const { tools, resolveClient } = setup({});
    await runContactTurn({ assistant: { providerID: 'p', modelID: 'm' }, history: [], userText: '后台复盘', tools, readOnly: true,
      createChatCompletion: async ({ body }) => {
        expect(body.tools).toEqual([]);
        return { text: '结果已记录。' };
      },
    });
    expect(resolveClient).not.toHaveBeenCalled();
  });

  it('uses one loader for Yuri and OpenCode, keeps unrelated groups hidden and resets both on the next contact turn', async () => {
    const query = vi.fn(async () => ({ data: { providerID: 'exa', results: [] } }));
    const list = vi.fn();
    const { tools: openCodeTools } = setup({ websearch: { query }, skill: { list } });
    const registerProject = vi.fn(async () => ({ project: { id: 'p', path: '/workspace' }, created: true }));
    const tools = [...createYuriContactTools({ registerProject }), ...openCodeTools];
    let round = 0;
    const input = { assistant: { providerID: 'p', modelID: 'm' }, history: [], userText: 'Search, then register the requested project.', tools };
    await runContactTurn({ ...input, createChatCompletion: async ({ body }) => {
      round++;
      const names = body.tools.map((item) => item.function.name);
      expect(names.filter((name) => name.startsWith('load_'))).toEqual(['load_tools']);
      expect(names).not.toContain('read_opencode_skill');
      expect(names).not.toContain('list_active_sessions');
      if (round === 1) {
        expect(names).toEqual(['load_tools', 'notify_user']);
        expect(body.tools[0].function.parameters.properties.domain.enum).toEqual(['yuri.projects', 'opencode.web', 'opencode.activity', 'opencode.catalog']);
        return nativeCall('load_tools', { domain: 'opencode.web' });
      }
      if (round === 2) {
        expect(names).not.toContain('register_project');
        return nativeCall('websearch', { query: 'research' });
      }
      if (round === 3) return nativeCall('load_tools', { domain: 'yuri.projects' });
      if (round === 4) {
        expect(names).toContain('websearch');
        expect(names).toContain('register_project');
        return nativeCall('register_project', { path: '/workspace' });
      }
      return { text: 'Done.' };
    } });
    expect(query).toHaveBeenCalledTimes(1);
    expect(registerProject).toHaveBeenCalledTimes(1);
    expect(list).not.toHaveBeenCalled();
    await runContactTurn({ ...input, createChatCompletion: async ({ body }) => {
      expect(body.tools.map((item) => item.function.name)).toEqual(['load_tools', 'notify_user']);
      return { text: 'New turn.' };
    } });
  });

  it.each([false, true])('rejects an unloaded OpenCode call before SDK execution (batched with loader=%s)', async (batched) => {
    const query = vi.fn(async () => ({ data: { providerID: 'exa', results: [] } }));
    const { tools } = setup({ websearch: { query } });
    let round = 0;
    await runContactTurn({ assistant: { providerID: 'p', modelID: 'm' }, history: [], userText: 'Search online.', tools,
      createChatCompletion: async () => {
        round++;
        if (round === 1) {
          const response = nativeCall('websearch', { query: 'research' });
          if (batched) response.completion.choices[0].message.tool_calls.unshift(nativeCall('load_tools', { domain: 'opencode.web' }).completion.choices[0].message.tool_calls[0]);
          return response;
        }
        if (round === 2) {
          expect(query).not.toHaveBeenCalled();
          return nativeCall('load_tools', { domain: 'opencode.web' });
        }
        if (round === 3) return nativeCall('websearch', { query: 'research' });
        return { text: 'Searched.' };
      },
    });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
