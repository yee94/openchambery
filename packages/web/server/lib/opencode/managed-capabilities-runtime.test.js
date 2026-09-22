import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import scheduledTaskPlugin from './managed-capabilities/scheduled-task.js';
import { MANAGED_SCHEDULED_TASK_TOKEN_HEADER, MANAGED_SCHEDULED_TASK_TOOL_PATH } from '../scheduled-tasks/managed-tool-contract.js';
import { createManagedCapabilitiesRuntime, mergeManagedOpenCodeConfig } from './managed-capabilities-runtime.js';

describe('managed OpenCode capabilities runtime', () => {
  it('merges config while retaining unknown fields and stable plugin tuples', () => {
    const content = mergeManagedOpenCodeConfig({ configContent: JSON.stringify({ unknown: true, plugin: [['existing', { mode: 'safe' }]] }), pluginUrl: 'file:///scheduled-task.js', instructionsUrl: 'file:///instructions.md' });
    expect(JSON.parse(content)).toEqual({ unknown: true, plugin: [['existing', { mode: 'safe' }], 'file:///scheduled-task.js'], instructions: ['file:///instructions.md'] });
    expect(() => mergeManagedOpenCodeConfig({ configContent: '{', pluginUrl: 'file:///plugin.js', instructionsUrl: 'file:///instructions.md' })).toThrow('Invalid OPENCODE_CONFIG_CONTENT JSON');
  });

  it('publishes resources and authorizes only the active loopback child', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-capabilities-'));
    let childPid = 44;
    const runtime = createManagedCapabilitiesRuntime({ dataDir, version: 'test', getManagedChildPid: () => childPid, isManagedChildAlive: (pid) => pid === 44 });
    try {
      runtime.setBridgeOrigin('http://127.0.0.1:3000');
      const childEnv = await runtime.prepareManagedChildEnv({ OPENCODE_CONFIG_CONTENT: '{"custom":true}' });
      runtime.recordManagedChildPid(44);
      const identity = runtime.getCapabilityIdentity();
      expect(childEnv.OPENCODE_CONFIG_CONTENT).toContain('scheduled-task.mjs');
      expect(JSON.parse(childEnv.OPENCODE_CONFIG_CONTENT).plugin).toContain(path.join(dataDir, 'managed-opencode-capabilities', 'v2-plugin-host-shim'));
      expect(JSON.parse(childEnv.OPENCODE_CONFIG_CONTENT).instructions[0]).toMatch(/^\//);
      expect(childEnv.OPENCHAMBER_SCHEDULED_TASK_BRIDGE_PATH).toBe(MANAGED_SCHEDULED_TASK_TOOL_PATH);
      expect(childEnv.OPENCHAMBER_SCHEDULED_TASK_TOKEN_HEADER).toBe(MANAGED_SCHEDULED_TASK_TOKEN_HEADER);
      await expect(fs.access(path.join(dataDir, 'managed-opencode-capabilities', identity.version, 'scheduled-task.mjs'))).resolves.toBeUndefined();
      const request = { method: 'POST', path: MANAGED_SCHEDULED_TASK_TOOL_PATH, socket: { remoteAddress: '127.0.0.1' }, headers: { [MANAGED_SCHEDULED_TASK_TOKEN_HEADER]: identity.token } };
      expect(runtime.authorizeManagedOpenCodeBridgeRequest(request)).toBe(true);
      expect(runtime.authorizeManagedOpenCodeBridgeRequest({ ...request, method: 'GET' })).toBe(false);
      expect(runtime.authorizeManagedOpenCodeBridgeRequest({ ...request, socket: { remoteAddress: '10.0.0.2' } })).toBe(false);
      childPid = 45;
      expect(runtime.authorizeManagedOpenCodeBridgeRequest(request)).toBe(false);
      expect(runtime.hasValidIdentity()).toBe(false);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it('uses a distinct material version and directory when capability source changes', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-capabilities-'));
    const resourceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-capability-source-'));
    try {
      await fs.copyFile(new URL('./managed-capabilities/scheduled-task.js', import.meta.url), path.join(resourceDir, 'scheduled-task.js'));
      await fs.writeFile(path.join(resourceDir, 'scheduled-task-instructions.md'), 'first');
      const first = createManagedCapabilitiesRuntime({ dataDir, version: 'test/app', resourceDir });
      first.setBridgeOrigin('http://127.0.0.1:3000');
      await first.prepareManagedChildEnv();
      const firstIdentity = first.getCapabilityIdentity();
      await fs.writeFile(path.join(resourceDir, 'scheduled-task-instructions.md'), 'second');
      const second = createManagedCapabilitiesRuntime({ dataDir, version: 'test/app', resourceDir });
      second.setBridgeOrigin('http://127.0.0.1:3000');
      await second.prepareManagedChildEnv();
      const secondIdentity = second.getCapabilityIdentity();
      expect(firstIdentity.version).not.toBe(secondIdentity.version);
      await expect(fs.access(path.join(dataDir, 'managed-opencode-capabilities', firstIdentity.version))).resolves.toBeUndefined();
      await expect(fs.access(path.join(dataDir, 'managed-opencode-capabilities', secondIdentity.version))).resolves.toBeUndefined();
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
      await fs.rm(resourceDir, { recursive: true, force: true });
    }
  });
});

describe('scheduled_task plugin', () => {
  const originalEnv = { ...process.env };
  afterEach(() => { process.env = { ...originalEnv }; vi.restoreAllMocks(); });

  it('uses the legacy args map, mutates config, and forwards the canonical envelope', async () => {
    process.env.OPENCHAMBER_SCHEDULED_TASK_BRIDGE_ORIGIN = 'http://127.0.0.1:3000';
    process.env.OPENCHAMBER_SCHEDULED_TASK_BRIDGE_PATH = MANAGED_SCHEDULED_TASK_TOOL_PATH;
    process.env.OPENCHAMBER_SCHEDULED_TASK_TOKEN_HEADER = MANAGED_SCHEDULED_TASK_TOKEN_HEADER;
    process.env.OPENCHAMBER_SCHEDULED_TASK_BRIDGE_TOKEN = crypto.randomBytes(32).toString('hex');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const plugin = await scheduledTaskPlugin();
    expect(plugin.tool.scheduled_task.args).toMatchObject({ request: { type: 'object', oneOf: expect.any(Array) } });
    expect(plugin.tool.scheduled_task.args.type).toBeUndefined();
    const [listSchema, createSchema, updateSchema, deleteSchema, runSchema] = plugin.tool.scheduled_task.args.request.oneOf;
    expect(listSchema.properties.operation.enum).toEqual(['list']);
    expect(createSchema.required).toEqual(['operation', 'name', 'schedule', 'execution']);
    expect(createSchema.not).toEqual({ required: ['taskId'] });
    expect(updateSchema.required).toEqual(['operation', 'taskId']);
    expect(deleteSchema.required).toEqual(['operation', 'taskId']);
    expect(runSchema.required).toEqual(['operation', 'taskId']);
    expect(plugin.tool.scheduled_task.args.request.properties.schedule.properties).toEqual(expect.objectContaining({ kind: expect.any(Object), time: expect.any(Object), times: expect.any(Object), weekdays: expect.any(Object), date: expect.any(Object), cron: expect.any(Object), timezone: expect.any(Object) }));
    expect(plugin.tool.scheduled_task.args.request.properties.schedule.properties.at).toBeUndefined();
    expect(plugin.tool.scheduled_task.args.request.properties.execution).toMatchObject({ additionalProperties: false, properties: expect.objectContaining({ prompt: expect.any(Object), providerID: expect.any(Object), modelID: expect.any(Object), agent: expect.any(Object), variant: expect.any(Object), goalEnabled: expect.any(Object), goalTokenBudget: expect.any(Object) }) });
    const defaultConfig = {};
    await plugin.config(defaultConfig);
    expect(defaultConfig.permission).toEqual({ scheduled_task: 'ask' });
    const scalarConfig = { permission: 'allow' };
    await plugin.config(scalarConfig);
    expect(scalarConfig.permission).toBe('allow');
    const wildcardConfig = { permission: { '*': 'deny' } };
    await plugin.config(wildcardConfig);
    expect(wildcardConfig.permission).toEqual({ '*': 'deny' });
    const exactConfig = { permission: { scheduled_task: 'allow' } };
    await plugin.config(exactConfig);
    expect(exactConfig.permission).toEqual({ scheduled_task: 'allow' });
    const ask = vi.fn(async () => {});
    const context = { ask, sessionID: 'ses_1', messageID: 'msg_1', directory: '/repo', worktree: '/repo', agent: 'build' };
    const output = await plugin.tool.scheduled_task.execute({ request: { operation: 'list' } }, context);
    expect(output).toBe('{"ok":true}');
    expect(ask).not.toHaveBeenCalled();
    await plugin.tool.scheduled_task.execute({ request: { operation: 'create', name: 'later', enabled: true, schedule: { kind: 'daily', time: '09:00' }, execution: { prompt: 'remind me' } } }, context);
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ permission: 'scheduled_task', patterns: ['create'], always: ['create'] }));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ operation: 'create', context: { sessionID: 'ses_1', messageID: 'msg_1', directory: '/repo', worktree: '/repo', agent: 'build' }, input: { name: 'later', enabled: true, schedule: { kind: 'daily', time: '09:00' }, execution: { prompt: 'remind me' } } });
    expect(fetchMock.mock.calls[1][1].headers[MANAGED_SCHEDULED_TASK_TOKEN_HEADER]).toBe(process.env.OPENCHAMBER_SCHEDULED_TASK_BRIDGE_TOKEN);
  });

  it('returns only the bridge safe error field', async () => {
    process.env.OPENCHAMBER_SCHEDULED_TASK_BRIDGE_ORIGIN = 'http://127.0.0.1:3000';
    process.env.OPENCHAMBER_SCHEDULED_TASK_BRIDGE_PATH = MANAGED_SCHEDULED_TASK_TOOL_PATH;
    process.env.OPENCHAMBER_SCHEDULED_TASK_TOKEN_HEADER = MANAGED_SCHEDULED_TASK_TOKEN_HEADER;
    process.env.OPENCHAMBER_SCHEDULED_TASK_BRIDGE_TOKEN = crypto.randomBytes(32).toString('hex');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'Task is invalid', internal: 'sensitive response content' }), { status: 400 }));
    const plugin = await scheduledTaskPlugin();
    await expect(plugin.tool.scheduled_task.execute({ request: { operation: 'list' } }, { ask: vi.fn() })).rejects.toThrow('400: Task is invalid');
  });
});
