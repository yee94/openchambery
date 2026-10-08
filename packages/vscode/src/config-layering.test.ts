import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfigFile } from '../../web/server/lib/opencode/config-files.js';

vi.mock('vscode', () => ({ workspace: { workspaceFolders: [] } }));
let root: string;
let directory: string;
let api: typeof import('./opencodeConfig');
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-config-parity-'));
  directory = path.join(root, 'xdg', 'opencode');
  fs.mkdirSync(directory, { recursive: true });
  vi.stubEnv('XDG_CONFIG_HOME', path.dirname(directory));
  vi.stubEnv('OPENCODE_CONFIG', '');
  vi.stubEnv('OPENCODE_CONFIG_DIR', '');
  vi.spyOn(os, 'homedir').mockReturnValue(root);
  vi.resetModules();
  api = await import('./opencodeConfig');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('VS Code physical config parity', () => {
  it('MCP updates and deletes the real source, while additions never copy other layers', () => {
    const json = path.join(directory, 'opencode.json');
    const jsonc = path.join(directory, 'opencode.jsonc');
    fs.writeFileSync(json, '{"mcp":{"lower":{"type":"local","command":["lower"]}},"model":"base"}');
    fs.writeFileSync(jsonc, '{ // keep comment\n"mcp":{"higher":{"type":"local","command":["higher"]}},"model":"winning",}');
    expect(api.listMcpConfigs().map((entry) => entry.name).sort()).toEqual(['higher', 'lower']);
    api.updateMcpConfig('lower', { enabled: false });
    expect(readConfigFile(json)).toMatchObject({ mcp: { lower: { enabled: false } } });
    api.updateMcpConfig('higher', { enabled: false });
    expect(fs.readFileSync(jsonc, 'utf8')).toContain('// keep comment');
    api.createMcpConfig('new', { type: 'local', command: ['new'] });
    expect((readConfigFile(jsonc).mcp as Record<string, unknown>).lower).toBeUndefined();
    api.deleteMcpConfig('higher');
    expect((readConfigFile(jsonc).mcp as Record<string, unknown>).higher).toBeUndefined();
    expect((readConfigFile(json).mcp as Record<string, unknown>).lower).toBeDefined();
  });

  it('agent source and scoped deletion use the physical global layer', () => {
    const json = path.join(directory, 'opencode.json');
    const jsonc = path.join(directory, 'opencode.jsonc');
    fs.writeFileSync(json, '{"agent":{"lower":{"description":"lower"}}}');
    fs.writeFileSync(jsonc, '{ // retained\n"agent":{"higher":{"description":"higher"}}}');
    expect(api.getAgentSources('lower').json).toMatchObject({ exists: true, path: json });
    expect(api.getAgentSources('higher').json).toMatchObject({ exists: true, path: jsonc });
    api.deleteAgent('lower', undefined, 'user');
    expect(readConfigFile(json).agent).toBeUndefined();
    expect(readConfigFile(jsonc).agent).toBeDefined();
  });

  it('provider deletion and plugin edits preserve physical provenance', () => {
    const json = path.join(directory, 'opencode.json');
    const jsonc = path.join(directory, 'opencode.jsonc');
    fs.writeFileSync(json, '{"provider":{"lower":{}},"plugin":["lower-plugin"]}');
    fs.writeFileSync(jsonc, '{ // retained\n"providers":{"higher":{}},"plugin":["higher-plugin"]}');
    expect(api.getProviderSources('lower').user.path).toBe(json);
    api.removeProviderConfig('lower');
    expect(readConfigFile(json).provider).toBeUndefined();
    const plugin = api.listPluginEntries().find((entry) => entry.spec === 'lower-plugin')!;
    api.updatePluginEntry(plugin.id, { spec: 'updated-plugin' });
    expect(readConfigFile(json).plugin).toEqual(['updated-plugin']);
    expect(readConfigFile(jsonc).plugin).toEqual(['higher-plugin']);
  });

  it('raw bridge picks winning JSONC, honors an explicit config and preserves backups', async () => {
    const { handleConfigBridgeMessage } = await import('./bridge-config-runtime');
    const json = path.join(directory, 'opencode.json');
    const jsonc = path.join(directory, 'opencode.jsonc');
    fs.writeFileSync(json, '{"model":"base"}');
    fs.writeFileSync(jsonc, '{"model":"winning"}');
    const deps = {} as Parameters<typeof handleConfigBridgeMessage>[2];
    const read = () => handleConfigBridgeMessage({ id: 'read', type: 'api:config/global:get', payload: { target: 'opencode' } }, undefined, deps);
    expect((await read())?.data).toMatchObject({ fileName: 'opencode.jsonc', content: '{"model":"winning"}' });
    const custom = path.join(root, 'explicit.jsonc');
    fs.writeFileSync(custom, '{"model":"explicit"}');
    vi.stubEnv('OPENCODE_CONFIG', custom);
    expect((await read())?.data).toMatchObject({ fileName: 'explicit.jsonc' });
    await handleConfigBridgeMessage({ id: 'save', type: 'api:config/global:save', payload: { target: 'opencode', content: '{ // saved\n"model":"new"}' } }, undefined, deps);
    expect(readConfigFile(custom)).toEqual({ model: 'new' });
    expect(readConfigFile(jsonc)).toEqual({ model: 'winning' });
    expect(fs.readFileSync(`${custom}.openchamber.backup`, 'utf8')).toBe('{"model":"explicit"}');
  });
});
