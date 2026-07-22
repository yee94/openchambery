import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

vi.mock('@opencode-ai/sdk/v2', () => ({ createOpencodeClient: vi.fn() }));

const { createOpencodeClient } = await import('@opencode-ai/sdk/v2');
const { registerConfigEntityRoutes } = await import('./config-entity-routes.js');

const createDependencies = (getCommandSources, configDirectory, getAgentSources = vi.fn()) => ({
  resolveProjectDirectory: async () => ({ directory: '/repo' }),
  resolveOptionalProjectDirectory: async () => ({ directory: '/repo' }),
  refreshOpenCodeAfterConfigChange: vi.fn(async () => ({})),
  clientReloadDelayMs: 0,
  getAgentSources,
  getAgentConfig: vi.fn(),
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(),
  getCommandSources,
  createCommand: vi.fn(),
  updateCommand: vi.fn(),
  deleteCommand: vi.fn(),
  listMcpConfigs: vi.fn(),
  getMcpConfig: vi.fn(),
  createMcpConfig: vi.fn(),
  updateMcpConfig: vi.fn(),
  deleteMcpConfig: vi.fn(),
  listSnippets: vi.fn(),
  getSnippet: vi.fn(),
  createSnippet: vi.fn(),
  updateSnippet: vi.fn(),
  deleteSnippet: vi.fn(),
  expandSnippets: vi.fn(),
  configDirectory,
  buildOpenCodeUrl: () => 'http://opencode-upstream:4096/',
  getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic example' }),
  getOpenCodePort: () => 4096,
});

describe('config entity command metadata route', () => {
  it('returns metadata for many commands through one request', async () => {
    const app = express();
    app.use(express.json());
    const getCommandSources = vi.fn((name) => ({
      md: { exists: name === 'project-command', scope: name === 'project-command' ? 'project' : null },
      json: { exists: name === 'user-command', scope: name === 'user-command' ? 'user' : null },
    }));
    registerConfigEntityRoutes(app, createDependencies(getCommandSources));

    const response = await request(app)
      .post('/api/config/commands/metadata?directory=%2Frepo')
      .send({ names: ['project-command', 'user-command', 'built-in', 'project-command'] })
      .expect(200);

    expect(getCommandSources).toHaveBeenCalledTimes(3);
    expect(response.body).toEqual({
      commands: {
        'project-command': { scope: 'project', isBuiltIn: false },
        'user-command': { scope: 'user', isBuiltIn: false },
        'built-in': { scope: null, isBuiltIn: true },
      },
    });
  });

  it('returns a compact SDK command catalog without templates', async () => {
    const app = express();
    app.use(express.json());
    const markdownPath = '/repo/.opencode/commands/markdown.md';
    const getCommandSources = vi.fn((name) => ({
      md: { exists: name === 'markdown', scope: name === 'markdown' ? 'project' : null, path: name === 'markdown' ? markdownPath : null },
      json: { exists: name === 'json', scope: name === 'json' ? 'project' : null },
    }));
    createOpencodeClient.mockReturnValue({
      command: {
        list: vi.fn(async () => ({ data: [
          { name: 'markdown', description: ` ${'😀'.repeat(161)}\nvalue `, template: 'secret markdown template', source: 'command' },
          { name: 'json', description: ' JSON\n command ', template: 'secret JSON template', source: 'command' },
          { name: 'skill-command', description: 'hidden', template: 'secret skill template', source: 'skill' },
        ] })),
      },
    });
    registerConfigEntityRoutes(app, createDependencies(getCommandSources));

    const response = await request(app)
      .post('/api/config/commands/metadata?directory=%2Frepo')
      .send({ catalog: true })
      .expect(200);

    expect(createOpencodeClient).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: 'http://opencode-upstream:4096',
      directory: '/repo',
      headers: { Authorization: 'Basic example' },
    }));
    expect(response.body.commands).toEqual([
      expect.objectContaining({ name: 'markdown', reference: markdownPath, description: `${'😀'.repeat(160)}…`, scope: 'project', isBuiltIn: false }),
      expect.objectContaining({ name: 'json', reference: 'json', description: 'JSON command', scope: 'project', isBuiltIn: false }),
    ]);
    expect(response.body.commands[0]).not.toHaveProperty('template');
  });

  it('bounds command tag references and excludes unsafe command names', async () => {
    const app = express();
    app.use(express.json());
    const getCommandSources = vi.fn((name) => ({
      md: {
        exists: ['safe-path', 'unsafe-path', 'long-path'].includes(name),
        scope: 'project',
        path: name === 'safe-path'
          ? '/repo/.opencode/commands/safe-path.md'
          : (name === 'unsafe-path' ? '/repo/commands/bad].md' : 'x'.repeat(8_193)),
      },
      json: { exists: false, scope: null },
    }));
    createOpencodeClient.mockReturnValue({
      command: {
        list: vi.fn(async () => ({ data: [
          { name: 'safe-path', source: 'command' },
          { name: 'unsafe-path', source: 'command' },
          { name: 'long-path', source: 'command' },
          { name: 'bad]name', source: 'command' },
          { name: 'bad\rname', source: 'command' },
          { name: 'bad\nname', source: 'command' },
          { name: '   ', source: 'command' },
        ] })),
      },
    });
    registerConfigEntityRoutes(app, createDependencies(getCommandSources));

    const response = await request(app)
      .post('/api/config/commands/metadata?directory=%2Frepo')
      .send({ catalog: true })
      .expect(200);

    expect(response.body.commands.map(({ name, reference }) => ({ name, reference }))).toEqual([
      { name: 'safe-path', reference: '/repo/.opencode/commands/safe-path.md' },
      { name: 'unsafe-path', reference: 'unsafe-path' },
      { name: 'long-path', reference: 'long-path' },
    ]);
  });
});

describe('provider catalog route', () => {
  it('uses the resolved directory, OpenCode auth, SDK providers call, and explicit catalog route', async () => {
    const app = express();
    const resolveProjectDirectory = vi.fn(async () => ({ directory: '/project/from-header' }));
    const providers = vi.fn(async () => ({ data: { providers: [], default: {} } }));
    createOpencodeClient.mockReturnValue({ config: { providers } });
    registerConfigEntityRoutes(app, {
      ...createDependencies(vi.fn()),
      resolveProjectDirectory,
    });
    app.use('/api', (_req, res) => res.status(599).json({ proxy: true }));

    const response = await request(app)
      .get('/api/config/catalog/providers?directory=%2Frepo')
      .set('x-opencode-directory', '/project/from-header')
      .expect(200);

    expect(resolveProjectDirectory).toHaveBeenCalledWith(expect.objectContaining({ query: { directory: '/repo' } }));
    expect(createOpencodeClient).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: 'http://opencode-upstream:4096',
      directory: '/project/from-header',
      headers: { Authorization: 'Basic example' },
      fetch: expect.any(Function),
    }));
    expect(providers).toHaveBeenCalledWith({ directory: '/project/from-header' });
    expect(response.body).toEqual({ schemaVersion: 1, providers: [], default: {}, partial: false });
  });

  it('returns 502 for SDK failure and malformed catalog responses', async () => {
    const app = express();
    createOpencodeClient.mockReturnValue({ config: { providers: vi.fn(async () => ({ data: { providers: {} } })) } });
    registerConfigEntityRoutes(app, createDependencies(vi.fn()));
    await request(app).get('/api/config/catalog/providers').expect(502);

    const failingApp = express();
    createOpencodeClient.mockReturnValue({ config: { providers: vi.fn(async () => { throw new Error('upstream unavailable'); }) } });
    registerConfigEntityRoutes(failingApp, createDependencies(vi.fn()));
    await request(failingApp).get('/api/config/catalog/providers').expect(502);
  });

  it('returns 502 for SDK error envelopes that include data', async () => {
    const app = express();
    createOpencodeClient.mockReturnValue({
      config: { providers: vi.fn(async () => ({ error: { message: 'upstream sentinel' }, data: { providers: [], default: {} } })) },
    });
    registerConfigEntityRoutes(app, createDependencies(vi.fn()));

    const response = await request(app).get('/api/config/catalog/providers').expect(502);
    expect(JSON.stringify(response.body)).not.toContain('sentinel');
  });
});

describe('agent and command mutation logging', () => {
  it('keeps request bodies and error stacks out of agent and command logs', async () => {
    const app = express();
    app.use(express.json());
    const bodySentinel = 'body-secret-sentinel';
    const stackSentinel = 'stack-secret-sentinel';
    const updateFailure = () => {
      const error = new Error('Update failed');
      error.stack = stackSentinel;
      throw error;
    };
    const dependencies = {
      ...createDependencies(vi.fn()),
      resolveProjectDirectory: async () => ({ directory: '/directory-secret-sentinel' }),
      createAgent: vi.fn(),
      updateAgent: vi.fn(updateFailure),
      createCommand: vi.fn(),
      updateCommand: vi.fn(updateFailure),
    };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    registerConfigEntityRoutes(app, dependencies);

    const agentCreate = await request(app).post('/api/config/agents/safe-agent').send({ prompt: bodySentinel }).expect(200);
    const commandCreate = await request(app).post('/api/config/commands/safe-command').send({ template: bodySentinel }).expect(200);
    const agentUpdate = await request(app).patch('/api/config/agents/safe-agent').send({ prompt: bodySentinel }).expect(500);
    const commandUpdate = await request(app).patch('/api/config/commands/safe-command').send({ template: bodySentinel }).expect(500);
    const output = JSON.stringify([agentCreate.body, commandCreate.body, agentUpdate.body, commandUpdate.body]);
    const logs = `${log.mock.calls.flat().join(' ')} ${error.mock.calls.flat().join(' ')}`;

    expect(output).not.toContain('sentinel');
    expect(logs).not.toContain(bodySentinel);
    expect(logs).not.toContain(stackSentinel);
    log.mockRestore();
    error.mockRestore();
  });
});

describe('config entity agent metadata route', () => {
  it('normalizes, deduplicates, bounds, and returns agent metadata in one batch', async () => {
    const app = express();
    app.use(express.json());
    const getAgentSources = vi.fn((name) => ({
      md: { exists: name === 'project-agent', scope: name === 'project-agent' ? 'project' : null, path: name === 'project-agent' ? '/repo/.opencode/agents/group/project-agent.md' : null },
      json: { exists: name === 'user-agent', scope: name === 'user-agent' ? 'user' : null },
    }));
    registerConfigEntityRoutes(app, createDependencies(vi.fn(), undefined, getAgentSources));

    const response = await request(app)
      .post('/api/config/agents/metadata?directory=%2Frepo')
      .send({ names: [' project-agent ', 'user-agent', 'project-agent', '', 42] })
      .expect(200);

    expect(getAgentSources).toHaveBeenCalledTimes(2);
    expect(response.body).toEqual({
      agents: {
        'project-agent': {
          scope: 'project',
          isBuiltIn: false,
          sources: {
            md: { exists: true, scope: 'project', path: '/repo/.opencode/agents/group/project-agent.md' },
            json: { exists: false, scope: null },
          },
        },
        'user-agent': {
          scope: 'user',
          isBuiltIn: false,
          sources: {
            md: { exists: false, scope: null, path: null },
            json: { exists: true, scope: 'user' },
          },
        },
      },
    });
  });

  it('bounds agent metadata batches at 500 names', async () => {
    const app = express();
    app.use(express.json());
    const getAgentSources = vi.fn(() => ({
      md: { exists: false, scope: null, path: null },
      json: { exists: false, scope: null },
    }));
    registerConfigEntityRoutes(app, createDependencies(vi.fn(), undefined, getAgentSources));

    await request(app)
      .post('/api/config/agents/metadata?directory=%2Frepo')
      .send({ names: Array.from({ length: 501 }, (_, index) => `agent-${index}`) })
      .expect(200);

    expect(getAgentSources).toHaveBeenCalledTimes(500);
  });
});

describe('global raw configuration routes', () => {
  it('reads and validates the configured OpenCode and oh-my-opencode files', async () => {
    const app = express();
    app.use(express.json());
    const configDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-global-config-'));
    await fs.writeFile(path.join(configDirectory, 'opencode.jsonc'), `{
  "$schema": "https://opencode.ai/config.json",
  "model": "imate/deepseek-v4-pro",
  "plugin": ["oh-my-opencode-slim"],
  // Existing comments must round-trip unchanged.
}`, 'utf8');
    await fs.writeFile(path.join(configDirectory, 'oh-my-opencode-slim.json'), JSON.stringify({
      scoringEngineVersion: 'v2',
      disabled_agents: ['observer'],
      agents: { fixer: { model: ['openai/gpt-5.6-terra'] } },
    }, null, 2), 'utf8');

    registerConfigEntityRoutes(app, createDependencies(vi.fn(), configDirectory));

    const openCode = await request(app).get('/api/config/global/opencode').expect(200);
    expect(openCode.body).toMatchObject({
      target: 'opencode',
      fileName: 'opencode.jsonc',
      content: expect.stringContaining('// Existing comments must round-trip unchanged.'),
    });

    const slim = await request(app).get('/api/config/global/oh-my-opencode-slim').expect(200);
    expect(slim.body.content).toContain('"disabled_agents"');

    const invalid = await request(app)
      .put('/api/config/global/opencode')
      .send({ content: '{ "model": }' })
      .expect(400);
    expect(invalid.body.error).toContain('Invalid JSONC');

    const saved = await request(app)
      .put('/api/config/global/opencode')
      .send({ content: '{\n  "model": "imate/deepseek-v4-pro",\n  // preserved JSONC syntax\n}' })
      .expect(200);
    expect(saved.body.content).toContain('// preserved JSONC syntax');
    expect(await fs.readFile(path.join(configDirectory, 'opencode.jsonc'), 'utf8')).toBe(saved.body.content);

    await fs.rm(configDirectory, { recursive: true, force: true });
  });

  it('discovers only existing configuration targets and prefers JSON files', async () => {
    const app = express();
    app.use(express.json());
    const configDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-global-config-'));
    await fs.writeFile(path.join(configDirectory, 'opencode.json'), '{ "model": "json-model" }', 'utf8');
    await fs.writeFile(path.join(configDirectory, 'opencode.jsonc'), '{ "model": "jsonc-model" }', 'utf8');
    await fs.writeFile(path.join(configDirectory, 'oh-my-openagent.jsonc'), '{\n  // JSONC configuration\n}', 'utf8');

    registerConfigEntityRoutes(app, createDependencies(vi.fn(), configDirectory));

    const available = await request(app).get('/api/config/global').expect(200);
    expect(available.body).toEqual({
      targets: [
        { target: 'opencode', fileName: 'opencode.json' },
        { target: 'oh-my-openagent', fileName: 'oh-my-openagent.jsonc' },
      ],
    });

    const openCode = await request(app).get('/api/config/global/opencode').expect(200);
    expect(openCode.body).toMatchObject({ fileName: 'opencode.json', content: '{ "model": "json-model" }' });

    await request(app)
      .put('/api/config/global/opencode')
      .send({ content: '{ "model": "updated-json-model" }' })
      .expect(200);
    expect(await fs.readFile(path.join(configDirectory, 'opencode.json'), 'utf8')).toContain('updated-json-model');
    expect(await fs.readFile(path.join(configDirectory, 'opencode.jsonc'), 'utf8')).toContain('jsonc-model');

    await fs.rm(configDirectory, { recursive: true, force: true });
  });
});
