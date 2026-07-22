import { afterEach, describe, expect, mock, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

mock.module('vscode', () => ({
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({ get: () => undefined }),
  },
  window: { activeColorTheme: { kind: 1 } },
  ColorThemeKind: { Light: 1, HighContrastLight: 4 },
}));

const { handleConfigBridgeMessage } = await import('./bridge-config-runtime.ts');

const tempRoots = [];
const originalOpencodeConfig = process.env.OPENCODE_CONFIG;

const createCtx = (workingDirectory, restartImpl = async () => undefined) => {
  const restart = mock(restartImpl);
  return {
    restart,
    manager: {
      getWorkingDirectory: () => workingDirectory,
      restart,
    },
  };
};

const deps = {
  readSettings: () => ({}),
  persistSettings: async (changes) => changes,
  readMagicPromptOverrides: () => ({ version: 1, overrides: {} }),
  saveMagicPromptOverride: async () => ({ version: 1, overrides: {} }),
  resetMagicPromptOverride: async () => ({ version: 1, overrides: {} }),
  resetAllMagicPromptOverrides: async () => ({ version: 1, overrides: {} }),
  fetchOpenCodeSkillsFromApi: async () => null,
  fetchOpenCodeCommandsFromApi: async () => [],
  fetchProviderCatalogFromApi: async () => ({ schemaVersion: 1, providers: [], default: {}, partial: false }),
  clientReloadDelayMs: 800,
};

afterEach(() => {
  if (originalOpencodeConfig === undefined) {
    delete process.env.OPENCODE_CONFIG;
  } else {
    process.env.OPENCODE_CONFIG = originalOpencodeConfig;
  }

  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));

describe('VS Code config bridge plugin parity', () => {
  test('reads settings before projecting the bootstrap allowlist', async () => {
    const readSettings = mock(() => ({
      defaultModel: 'provider/model',
      summaryCustomAPIToken: 'SUMMARY_SENTINEL',
    }));
    const response = await handleConfigBridgeMessage({
      id: 'settings-bootstrap',
      type: 'api:config/settings:bootstrap',
    }, createCtx('/workspace'), { ...deps, readSettings });

    expect(readSettings).toHaveBeenCalledTimes(1);
    expect(response).toEqual({
      id: 'settings-bootstrap',
      type: 'api:config/settings:bootstrap',
      success: true,
      data: { schemaVersion: 1, defaultModel: 'provider/model' },
    });
  });

  test('forwards the provider catalog directory hint to the Extension Host fetcher', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-provider-catalog-'));
    tempRoots.push(root);
    const directory = path.join(root, 'workspace');
    const calls = [];
    const response = await handleConfigBridgeMessage({
      id: 'provider-catalog',
      type: 'api:config:providers:catalog',
      payload: { directory },
    }, createCtx(root), {
      ...deps,
      fetchProviderCatalogFromApi: async (_ctx, workingDirectory) => {
        calls.push(workingDirectory);
        return { schemaVersion: 1, providers: [], default: {}, partial: false };
      },
    });

    expect(calls).toEqual([directory]);
    expect(response?.data).toEqual({ schemaVersion: 1, providers: [], default: {}, partial: false });
  });

  test('requires a non-empty provider catalog directory', async () => {
    const fetchProviderCatalogFromApi = mock(async () => ({ schemaVersion: 1, providers: [], default: {}, partial: false }));
    const response = await handleConfigBridgeMessage({
      id: 'provider-catalog-missing-directory',
      type: 'api:config:providers:catalog',
      payload: {},
    }, createCtx('/manager-directory'), { ...deps, fetchProviderCatalogFromApi });

    expect(response).toMatchObject({ success: false, error: 'Directory is required' });
    expect(fetchProviderCatalogFromApi).not.toHaveBeenCalled();
  });

  test('uses an explicit directory for project skill creation and listing', async () => {
    const managerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-skills-manager-'));
    const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-skills-target-'));
    tempRoots.push(managerRoot, targetRoot);
    const ctx = createCtx(managerRoot);
    const skillsDeps = {
      ...deps,
      fetchOpenCodeSkillsFromApi: async (_ctx, workingDirectory) => [{
        name: 'directory-skill',
        path: workingDirectory,
        scope: workingDirectory === targetRoot ? 'project' : 'user',
        source: 'opencode',
      }],
    };

    const created = await handleConfigBridgeMessage({
      id: 'create-project-skill',
      type: 'api:config/skills',
      payload: {
        method: 'POST',
        name: 'target-skill',
        directory: targetRoot,
        body: { scope: 'project', source: 'opencode', description: 'Target project skill' },
      },
    }, ctx, deps);
    const listed = await handleConfigBridgeMessage({
      id: 'list-project-skills',
      type: 'api:config/skills',
      payload: { method: 'GET', directory: targetRoot },
    }, ctx, skillsDeps);

    expect(created?.success).toBe(true);
    expect(fs.existsSync(path.join(targetRoot, '.opencode', 'skills', 'target-skill', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(managerRoot, '.opencode', 'skills', 'target-skill', 'SKILL.md'))).toBe(false);
    expect(listed?.data?.skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'directory-skill', path: targetRoot, scope: 'project' }),
    ]));
  });

  test('returns deduplicated agent and command metadata batches', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-metadata-'));
    tempRoots.push(root);
    const ctx = createCtx(root);

    const agents = await handleConfigBridgeMessage({
      id: 'agent-metadata',
      type: 'api:config/agents',
      payload: { method: 'POST', directory: root, body: { names: [' built-in ', 'built-in', '', 1] } },
    }, ctx, deps);
    const commands = await handleConfigBridgeMessage({
      id: 'command-metadata',
      type: 'api:config/commands',
      payload: { method: 'POST', directory: root, body: { names: [' built-in ', 'built-in', '', 1] } },
    }, ctx, deps);

    expect(agents?.data).toMatchObject({ agents: { 'built-in': { scope: null, isBuiltIn: true } } });
    expect(Object.keys(agents?.data?.agents || {})).toEqual(['built-in']);
    expect(commands?.data).toMatchObject({ commands: { 'built-in': { scope: null, isBuiltIn: true } } });
    expect(Object.keys(commands?.data?.commands || {})).toEqual(['built-in']);
  });

  test('returns compact skill and command catalogs with matching references', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-catalog-'));
    tempRoots.push(root);
    const ctx = createCtx(root);
    const markdownPath = path.join(root, '.opencode', 'commands', 'markdown.md');
    fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
    fs.writeFileSync(markdownPath, '---\ndescription: markdown\n---\nTemplate', 'utf8');
    const longDescription = `  ${'😀'.repeat(161)}\nnext  `;
    const catalogDeps = {
      ...deps,
      fetchOpenCodeSkillsFromApi: async () => [{ name: 'skill', path: '/tmp/skill/SKILL.md', scope: 'user', source: 'opencode', description: longDescription, content: 'secret skill content' }],
      fetchOpenCodeCommandsFromApi: async () => [
        { name: 'markdown', description: longDescription, source: 'command' },
        { name: 'json', description: ' JSON\n command ', source: 'command' },
        { name: 'skill-command', description: 'hidden', source: 'skill' },
      ],
    };

    const skills = await handleConfigBridgeMessage({
      id: 'skills-summary', type: 'api:config/skills', payload: { method: 'GET', directory: root, body: { summary: true } },
    }, ctx, catalogDeps);
    const commands = await handleConfigBridgeMessage({
      id: 'commands-catalog', type: 'api:config/commands', payload: { method: 'POST', directory: root, body: { catalog: true } },
    }, ctx, catalogDeps);

    expect(skills?.data?.skills[0]).toEqual(expect.objectContaining({ description: `${'😀'.repeat(160)}…` }));
    expect(skills?.data?.skills[0]).not.toHaveProperty('content');
    expect(commands?.data?.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'markdown', reference: markdownPath, description: `${'😀'.repeat(160)}…` }),
      expect.objectContaining({ name: 'json', reference: 'json', description: 'JSON command' }),
    ]));
    expect(commands?.data?.commands).toHaveLength(2);
    expect(commands?.data?.commands[0]).not.toHaveProperty('template');
  });

  test('bounds command tag references and excludes unsafe command names', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-catalog-]-'));
    tempRoots.push(root);
    const ctx = createCtx(root);
    const markdownPath = path.join(root, '.opencode', 'commands', 'markdown.md');
    fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
    fs.writeFileSync(markdownPath, 'Template', 'utf8');
    const commands = await handleConfigBridgeMessage({
      id: 'commands-catalog', type: 'api:config/commands', payload: { method: 'POST', directory: root, body: { catalog: true } },
    }, ctx, {
      ...deps,
      fetchOpenCodeCommandsFromApi: async () => [
        { name: 'markdown', source: 'command' },
        { name: 'bad]name', source: 'command' },
        { name: 'bad\rname', source: 'command' },
        { name: 'bad\nname', source: 'command' },
        { name: '   ', source: 'command' },
      ],
    });

    expect(commands?.data?.commands).toEqual([
      expect.objectContaining({ name: 'markdown', reference: 'markdown' }),
    ]);
  });

  test('removes agent fields when update payload sends null', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-agent-null-'));
    tempRoots.push(root);
    const ctx = createCtx(root);
    const configDir = path.join(root, '.opencode');
    const configPath = path.join(configDir, 'opencode.json');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      agent: {
        build: {
          variant: 'fast',
          temperature: 0.3,
          top_p: 0.8,
          mode: 'subagent',
        },
      },
    }, null, 2), 'utf8');

    const updated = await handleConfigBridgeMessage({
      id: 'update-agent-null-fields',
      type: 'api:config/agents',
      payload: {
        method: 'PATCH',
        name: 'build',
        directory: root,
        body: { variant: null, temperature: null, top_p: null },
      },
    }, ctx, deps);

    expect(updated?.success).toBe(true);
    expect(readJson(configPath).agent.build).toEqual({ mode: 'subagent' });
  });

  test('creates, lists, updates, and deletes project plugin entries', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-plugins-'));
    tempRoots.push(root);
    const ctx = createCtx(root);

    const created = await handleConfigBridgeMessage({
      id: 'create',
      type: 'api:config/plugins',
      payload: {
        method: 'POST',
        target: 'entry',
        directory: root,
        body: { scope: 'project', spec: 'plugin-a', options: { enabled: true } },
      },
    }, ctx, deps);

    expect(created?.success).toBe(true);
    expect(ctx.restart).toHaveBeenCalledTimes(1);

    const listed = await handleConfigBridgeMessage({
      id: 'list',
      type: 'api:config/plugins',
      payload: { method: 'GET', target: 'list', directory: root },
    }, ctx, deps);
    const entries = listed?.data?.entries || [];
    const entry = entries.find((candidate) => candidate.spec === 'plugin-a');
    expect(entry?.scope).toBe('project');

    const updated = await handleConfigBridgeMessage({
      id: 'update',
      type: 'api:config/plugins',
      payload: {
        method: 'PATCH',
        target: 'entry',
        directory: root,
        pluginId: entry?.id,
        body: { spec: 'plugin-b' },
      },
    }, ctx, deps);
    expect(updated?.success).toBe(true);

    const config = JSON.parse(fs.readFileSync(path.join(root, '.opencode', 'opencode.json'), 'utf8'));
    expect(config.plugin).toEqual([['plugin-b', { enabled: true }]]);

    const relisted = await handleConfigBridgeMessage({
      id: 'relist',
      type: 'api:config/plugins',
      payload: { method: 'GET', target: 'list', directory: root },
    }, ctx, deps);
    const updatedEntry = (relisted?.data?.entries || []).find((candidate) => candidate.spec === 'plugin-b');

    const deleted = await handleConfigBridgeMessage({
      id: 'delete',
      type: 'api:config/plugins',
      payload: { method: 'DELETE', target: 'entry', directory: root, pluginId: updatedEntry?.id },
    }, ctx, deps);
    expect(deleted?.success).toBe(true);
  });

  test('creates and reads project plugin files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-plugin-files-'));
    tempRoots.push(root);
    const ctx = createCtx(root);

    const created = await handleConfigBridgeMessage({
      id: 'create-file',
      type: 'api:config/plugins',
      payload: {
        method: 'POST',
        target: 'file',
        directory: root,
        body: { scope: 'project', fileName: 'demo-plugin.ts', content: 'export default {}' },
      },
    }, ctx, deps);
    expect(created?.success).toBe(true);

    const listed = await handleConfigBridgeMessage({
      id: 'list',
      type: 'api:config/plugins',
      payload: { method: 'GET', target: 'list', directory: root },
    }, ctx, deps);
    const files = listed?.data?.files || [];
    const file = files.find((candidate) => candidate.fileName === 'demo-plugin.ts');
    expect(file?.scope).toBe('project');

    const read = await handleConfigBridgeMessage({
      id: 'read-file',
      type: 'api:config/plugins',
      payload: { method: 'GET', target: 'file', directory: root, pluginId: file?.id },
    }, ctx, deps);
    expect(read?.data).toEqual({ fileName: 'demo-plugin.ts', scope: 'project', content: 'export default {}' });
  });

  test('updates and deletes user plugin entries from OPENCODE_CONFIG source', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-custom-config-'));
    tempRoots.push(root);
    const configDir = path.join(root, 'custom-config');
    const configPath = path.join(configDir, 'opencode.json');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ plugin: ['custom-plugin'] }, null, 2), 'utf8');
    process.env.OPENCODE_CONFIG = configPath;
    const ctx = createCtx(root);

    const listed = await handleConfigBridgeMessage({
      id: 'list-custom',
      type: 'api:config/plugins',
      payload: { method: 'GET', target: 'list', directory: root },
    }, ctx, deps);
    const entry = (listed?.data?.entries || []).find((candidate) => candidate.spec === 'custom-plugin');
    expect(entry?.scope).toBe('user');

    const updated = await handleConfigBridgeMessage({
      id: 'update-custom',
      type: 'api:config/plugins',
      payload: {
        method: 'PATCH',
        target: 'entry',
        directory: root,
        pluginId: entry?.id,
        body: { spec: 'custom-plugin-next' },
      },
    }, ctx, deps);
    expect(updated?.success).toBe(true);
    expect(readJson(configPath).plugin).toEqual(['custom-plugin-next']);

    const relisted = await handleConfigBridgeMessage({
      id: 'relist-custom',
      type: 'api:config/plugins',
      payload: { method: 'GET', target: 'list', directory: root },
    }, ctx, deps);
    const updatedEntry = (relisted?.data?.entries || []).find((candidate) => candidate.spec === 'custom-plugin-next');

    const deleted = await handleConfigBridgeMessage({
      id: 'delete-custom',
      type: 'api:config/plugins',
      payload: { method: 'DELETE', target: 'entry', directory: root, pluginId: updatedEntry?.id },
    }, ctx, deps);
    expect(deleted?.success).toBe(true);
    expect(readJson(configPath).plugin).toBeUndefined();
  });

  test('writes user plugin files next to OPENCODE_CONFIG', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-custom-files-'));
    tempRoots.push(root);
    const configDir = path.join(root, 'custom-config');
    const configPath = path.join(configDir, 'opencode.json');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, '{}', 'utf8');
    process.env.OPENCODE_CONFIG = configPath;
    const ctx = createCtx(root);

    const created = await handleConfigBridgeMessage({
      id: 'create-custom-file',
      type: 'api:config/plugins',
      payload: {
        method: 'POST',
        target: 'file',
        directory: root,
        body: { scope: 'user', fileName: 'demo-plugin.ts', content: 'export default {}' },
      },
    }, ctx, deps);

    expect(created?.success).toBe(true);
    expect(fs.readFileSync(path.join(configDir, 'plugins', 'demo-plugin.ts'), 'utf8')).toBe('export default {}');
  });

  test('reports plugin mutation success when restart fails after writing config', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-plugin-restart-'));
    tempRoots.push(root);
    const ctx = createCtx(root, async () => {
      throw new Error('restart failed');
    });

    const created = await handleConfigBridgeMessage({
      id: 'create-restart-failure',
      type: 'api:config/plugins',
      payload: {
        method: 'POST',
        target: 'entry',
        directory: root,
        body: { scope: 'project', spec: 'plugin-restart' },
      },
    }, ctx, deps);

    expect(created?.success).toBe(true);
    expect(created?.data).toMatchObject({ success: true, requiresReload: false, reloadFailed: true });
    expect(created?.data?.warning).toContain('restart failed');
    expect(readJson(path.join(root, '.opencode', 'opencode.json')).plugin).toEqual(['plugin-restart']);
  });
});
