import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { describe, expect, it, vi } from 'vitest';

const external = vi.hoisted(() => ({ complete: null, client: null }));
vi.mock('../llm/completions.js', () => ({ createChatCompletion: (input) => external.complete(input) }));
vi.mock('../opencode/v2-client.js', () => ({ makeOpenCodeV2Client: () => external.client }));
vi.mock('@opencode/client', () => ({ OpenCode: { make: () => external.client } }));
import { registerAssistantRoutes } from './routes.js';
import { registerConversationRoutes } from '../conversations/routes.js';
import { registerOpenCodeRoutes } from '../opencode/routes.js';
import { createSettingsRuntime } from '../opencode/settings-runtime.js';
import { createSettingsNormalizationRuntime } from '../opencode/settings-normalization-runtime.js';
import { createProjectDirectoryRuntime } from '../opencode/project-directory-runtime.js';
import { createProjectRegistry } from '../projects/registry.js';

const call = (name, args) => ({ completion: { choices: [{ message: { content: '', tool_calls: [{ id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] } });

describe('HTTP → real contact Agent → project registry → worker admission', () => {
  it('registers a cloned directory, sends hello and persists a real session card without manual Settings', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yuri-project-http-'));
    const workspace = path.join(directory, 'cloned-app');
    await fs.mkdir(workspace);
    const canonical = await fs.realpath(workspace);
    const normalization = createSettingsNormalizationRuntime({ os, path, processLike: process });
    const settings = createSettingsRuntime({ fsPromises: fs, path, crypto, SETTINGS_FILE_PATH: path.join(directory, 'settings.json'), ...normalization,
      sanitizeSettingsUpdate: (patch) => patch, mergePersistedSettings: (current, patch) => ({ ...current, ...patch }),
      formatSettingsResponse: (value) => value, resolveDirectoryCandidate: (value) => value,
    });
    const { validateDirectoryPath } = createProjectDirectoryRuntime({ fsPromises: fs, path, normalizeDirectoryPath: normalization.normalizeDirectoryPath });
    const registry = createProjectRegistry({ persistSettings: settings.persistSettings, validateDirectoryPath });
    const creates = vi.fn(async () => ({ id: 'ses_hello' }));
    const prompts = vi.fn(async () => ({ id: 'inbox_hello', type: 'user' }));
    external.client = {
      provider: { list: async () => ({ data: [{ id: 'p' }] }) },
      model: { list: async () => ({ data: [{ id: 'm', providerID: 'p' }] }) },
      skill: { list: async () => ({ data: [] }) },
      session: { create: creates, prompt: prompts, active: async () => ({}) },
    };
    const roots = [];
    const refresh = async () => {
      const current = await settings.readSettingsFromDiskStrict();
      roots.splice(0, roots.length, ...(current.projects || []).map((project) => project.path));
    };
    let round = 0;
    external.complete = async ({ body }) => {
      round++;
      if (round === 1) {
        expect(body.tools.some((tool) => tool.function.name === 'register_project')).toBe(false);
        expect(body.tools.some((tool) => tool.function.name === 'websearch')).toBe(false);
        return call('load_tools', { domain: 'opencode.web' });
      }
      if (round === 2) {
        expect(body.tools.some((tool) => tool.function.name === 'websearch')).toBe(true);
        return call('load_tools', { domain: 'yuri.projects' });
      }
      if (round === 3) {
        expect(body.tools.some((tool) => tool.function.name === 'register_project')).toBe(true);
        return call('register_project', { path: workspace, label: 'Cloned App' });
      }
      if (round === 4) {
        expect(body.messages.find((message) => message.name === 'register_project')?.content).toContain(canonical);
        return call('assign_session', { projectPath: canonical, prompt: 'hello' });
      }
      return { text: '已在这个项目里创建会话并发送 hello。' };
    };
    const app = express(); app.use(express.json());
    const runtime = registerAssistantRoutes(app, {
      dbPath: path.join(directory, 'assistants.sqlite'), yuriDataDir: directory,
      getAllowedRoots: () => roots, refreshAllowedRoots: refresh,
      listProjects: async () => (await settings.readSettingsFromDiskStrict()).projects || [],
      registerProject: async (input) => { const result = await registry.register(input); await refresh(); return result; },
      buildOpenCodeUrl: (pathname) => `http://upstream.invalid${pathname}`, getOpenCodeAuthHeaders: () => ({}),
    });
    registerOpenCodeRoutes(app, { ...settings, validateDirectoryPath, formatSettingsResponse: (value) => value });
    registerConversationRoutes(app, { buildOpenCodeUrl: (pathname) => `http://upstream.invalid${pathname}`, getOpenCodeAuthHeaders: () => ({}) });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = async (route, body) => {
      const response = await fetch(`${base}${route}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      expect(response.ok).toBe(true);
      return response.json();
    };
    try {
      const assistant = await request('/api/yuri/assistants', { name: 'Test Bot', providerID: 'p', modelID: 'm' });
      const admitted = await request(`/api/yuri/assistants/${assistant.id}/messages`, { messageID: 'create-project-chat', text: `Add ${workspace} and open a session saying hello` });
      expect(admitted.admitted).toBe(true);
      expect((await runtime.service.whenContactTurnSettled(admitted.messageID)).status).toBe('complete');
      expect(creates).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ location: { directory: canonical } }));
      expect(prompts).toHaveBeenCalledWith(expect.objectContaining({ sessionID: 'ses_hello', text: 'hello' }));
      expect(prompts.mock.calls[0][0]).not.toHaveProperty('skills');
      expect(prompts.mock.calls[0][0]).not.toHaveProperty('tools');
      expect(JSON.stringify(creates.mock.calls[0][0])).not.toContain('load_tools');
      expect(JSON.stringify(creates.mock.calls[0][0])).not.toContain('opencode.web');
      const page = await request(`/api/yuri/assistants/${assistant.id}/contact/messages`);
      expect(page.messages.flatMap((message) => message.parts)).toContainEqual(expect.objectContaining({ type: 'card', cardType: 'session', sessionID: 'ses_hello', directory: canonical }));
      const persisted = await settings.readSettingsFromDiskStrict();
      expect(persisted.projects).toHaveLength(1);
      expect(persisted.projects[0]).toMatchObject({ path: canonical, label: 'Cloned App' });
      // The pre-existing UI API uses the same registration owner and identity.
      const ui = await request('/api/opencode/directory', { path: workspace });
      expect(ui.settings.projects).toHaveLength(1);
      expect(ui.path).toBe(canonical);
      expect(ui.settings.activeProjectId).toBe(persisted.projects[0].id);
      // Ordinary Session admission after a contact load still receives only its own prompt.
      const modelRounds = round;
      const session = await request('/api/yuri/conversations', {
        input: { type: 'prompt' }, directory: canonical, messageID: 'ordinary-session',
        model: { providerID: 'p', modelID: 'm' }, parts: [{ type: 'text', text: 'ordinary hello' }],
      });
      expect(session.ok).toBe(true);
      expect(prompts.mock.calls.at(-1)[0]).toEqual({ sessionID: 'ses_hello', id: 'ordinary-session', text: 'ordinary hello', delivery: 'steer' });
      expect(round).toBe(modelRounds);
    } finally {
      runtime.close(); server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      external.complete = null; external.client = null;
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
