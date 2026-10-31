import { describe, expect, it, vi } from 'vitest';
import { createContactTools } from './contact-tools.js';
import { runContactTurn } from './harness.js';
import { createYuriContactToolGroups, createYuriContactTools } from './yuri-tools.js';
import { createProgressiveTools } from './progressive-tools.js';

const call = (name, args) => ({ completion: { choices: [{ message: { content: '', tool_calls: [{
  id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) },
}] } }] } });
const names = (body) => body.tools.map((tool) => tool.function.name);
const turn = (tools, createChatCompletion, extra = {}) => runContactTurn({
  assistant: { providerID: 'p', modelID: 'm' }, history: [], userText: 'Perform the requested operation.', tools, createChatCompletion, ...extra,
});

describe('assistant-only progressive business tools', () => {
  it('keeps only registration from the eleven-tool expansion, with safe projections', async () => {
    expect(createYuriContactTools()).toEqual([]);
    const registerProject = vi.fn(async () => ({ project: { id: 'p', path: '/workspace', label: 'App', secret: 'private' }, created: true, settings: { token: 'private' } }));
    const tools = createYuriContactTools({ registerProject });
    expect(tools.map((tool) => tool.name)).toEqual(['register_project']);
    const result = await tools[0].execute('register', { path: '/workspace' });
    expect(result.details).toEqual({ project: { id: 'p', path: '/workspace', label: 'App' }, created: true });
    expect(result.terminate).toBe(false);
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it.each([null, [], { path: '' }, { path: 123 }, { path: '/workspace', url: 'https://example.test' }, { path: '/workspace', label: null }])('rejects malformed registration before invoking the owner: %j', async (params) => {
    const registerProject = vi.fn();
    const result = await createYuriContactTools({ registerProject })[0].execute('bad', params);
    expect(result).toMatchObject({ isError: true, details: { error: 'validation_error' } });
    expect(registerProject).not.toHaveBeenCalled();
  });

  it('propagates cancellation and never exposes upstream errors', async () => {
    const registerProject = vi.fn(async () => { throw new Error('Bearer private'); });
    const tool = createYuriContactTools({ registerProject })[0];
    const failure = await tool.execute('failed', { path: '/workspace' });
    expect(failure.isError).toBe(true);
    expect(JSON.stringify(failure)).not.toContain('private');
    const controller = new AbortController(); controller.abort();
    await expect(tool.execute('cancelled', { path: '/workspace' }, controller.signal)).rejects.toThrow();
    expect(registerProject).toHaveBeenCalledTimes(1);
  });

  it('omits unavailable groups, rejects unknown/extra arguments and makes repeat loads idempotent', async () => {
    const source = createYuriContactTools({ registerProject: vi.fn() });
    const progressive = createProgressiveTools({ tools: source, groups: createYuriContactToolGroups(source) });
    const loader = progressive.getTools()[0];
    expect(loader.parameters.properties.domain.enum).toEqual(['yuri.projects']);
    for (const params of [{ domain: 'yuri.tasks' }, { domain: 'yuri.projects', url: '/' }, {}, null]) {
      expect((await loader.execute('bad', params)).isError).toBe(true);
      expect(progressive.getTools().map((tool) => tool.name)).toEqual(['load_tools']);
    }
    expect((await loader.execute('load', { domain: 'yuri.projects' })).addedToolNames).toEqual(['register_project']);
    expect((await loader.execute('again', { domain: 'yuri.projects' })).details.alreadyLoaded).toBe(true);
    expect(progressive.getTools().map((tool) => tool.name)).toEqual(['load_tools', 'register_project']);
    expect(source.map((tool) => tool.name)).toEqual(['register_project']);
    expect(createProgressiveTools({ tools: source, groups: createYuriContactToolGroups(source) }).getTools().map((tool) => tool.name)).toEqual(['load_tools']);
  });

  it('really mounts schemas and executors on the next model round, then resets on the next contact turn', async () => {
    const registerProject = vi.fn(async () => ({ project: { id: 'p', path: '/workspace' }, created: true }));
    const tools = [...createContactTools({}), ...createYuriContactTools({ registerProject })];
    let round = 0;
    const result = await turn(tools, async ({ body }) => {
      round++;
      if (round === 1) {
        expect(names(body)).toContain('assign_session');
        expect(names(body)).toContain('load_tools');
        for (const name of ['register_project', 'create_assistant', 'update_avatar', 'schedule_task', 'update_scheduled_task']) expect(names(body)).not.toContain(name);
        expect(JSON.stringify(body)).not.toContain('register_project');
        return call('load_tools', { domain: 'yuri.projects' });
      }
      expect(names(body)).toContain('register_project');
      expect(names(body)).not.toContain('schedule_task');
      const registration = body.tools.find((tool) => tool.function.name === 'register_project');
      expect(registration.function.parameters.required).toEqual(['path']);
      if (round === 2) return call('register_project', { path: '/workspace' });
      expect(body.messages.findLast((message) => message.name === 'register_project')?.content).toContain('/workspace');
      return { text: 'Registered.' };
    });
    expect(result.tools.map((tool) => tool.name)).toContain('register_project');
    expect(registerProject).toHaveBeenCalledTimes(1);
    await turn(tools, async ({ body }) => {
      expect(names(body)).not.toContain('register_project');
      return { text: 'New turn.' };
    });
  });

  it('rejects guessed hidden calls before execution and corrects to the visible loader', async () => {
    const registerProject = vi.fn(async () => ({ project: { id: 'p', path: '/workspace' }, created: true }));
    let round = 0;
    await turn(createYuriContactTools({ registerProject }), async ({ body }) => {
      round++;
      if (round === 1) return call('register_project', { path: '/workspace' });
      expect(registerProject).not.toHaveBeenCalled();
      if (round === 2) {
        expect(names(body)).not.toContain('register_project');
        expect(JSON.stringify(body.messages)).toContain('load_tools');
        return call('load_tools', { domain: 'yuri.projects' });
      }
      return { text: 'Loaded, no mutation requested.' };
    });
    expect(registerProject).not.toHaveBeenCalled();
  });

  it('cannot load and execute a hidden operation in the same response', async () => {
    const registerProject = vi.fn();
    let round = 0;
    await turn(createYuriContactTools({ registerProject }), async ({ body }) => {
      round++;
      expect(names(body)).not.toContain('register_project');
      if (round === 1) {
        const response = call('load_tools', { domain: 'yuri.projects' });
        response.completion.choices[0].message.tool_calls.push(call('register_project', { path: '/workspace' }).completion.choices[0].message.tool_calls[0]);
        return response;
      }
      return { text: 'No operation executed.' };
    });
    expect(registerProject).not.toHaveBeenCalled();
  });

  it.each(['assistants', 'tasks'])('loads existing %s operations without altering their owners', async (domain) => {
    const createAssistant = vi.fn(async () => ({ id: 'bot', name: 'Peer', providerID: 'p', modelID: 'm' }));
    const updateScheduledTask = vi.fn(async () => ({ task: { id: 'task', name: 'Task', enabled: false } }));
    const name = domain === 'assistants' ? 'create_assistant' : 'update_scheduled_task';
    const params = domain === 'assistants' ? { name: 'Peer', providerID: 'p', modelID: 'm' } : { projectID: 'p', taskID: 'task', enabled: false };
    let round = 0;
    await turn(createContactTools({ createAssistant, updateScheduledTask }), async ({ body }) => {
      round++;
      if (round === 1) {
        expect(names(body)).not.toContain(name);
        return call('load_tools', { domain: `yuri.${domain}` });
      }
      if (round === 2) return call(name, params);
      return { text: 'Done.' };
    });
    expect(domain === 'assistants' ? createAssistant : updateScheduledTask).toHaveBeenCalledTimes(1);
  });

  it('never offers the loader or mutations in a background read-only review, even with all tools supplied', async () => {
    const registerProject = vi.fn();
    const tools = [...createContactTools({}), ...createYuriContactTools({ registerProject })];
    await turn(tools, async ({ body }) => {
      expect(names(body)).toContain('list_scheduled_tasks');
      for (const name of ['load_tools', 'register_project', 'create_assistant', 'schedule_task', 'update_avatar']) expect(names(body)).not.toContain(name);
      return { text: 'Reviewed.' };
    }, { readOnly: true });
    expect(registerProject).not.toHaveBeenCalled();
  });
});
