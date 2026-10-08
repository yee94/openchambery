import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfigFile } from './config-files.js';

let root;
let directory;
let mcp;
let agents;
let providers;
let plugins;
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-entity-layers-'));
  directory = path.join(root, 'xdg', 'opencode');
  fs.mkdirSync(directory, { recursive: true });
  vi.stubEnv('XDG_CONFIG_HOME', path.dirname(directory));
  vi.stubEnv('OPENCODE_CONFIG', '');
  vi.stubEnv('OPENCODE_CONFIG_DIR', '');
  vi.spyOn(os, 'homedir').mockReturnValue(root);
  vi.resetModules();
  [mcp, agents, providers, plugins] = await Promise.all([import('./mcp.js'), import('./agents.js'), import('./providers.js'), import('./plugins.js')]);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Web/Electron entity physical provenance', () => {
  it('MCP CRUD edits only the source document and preserves comments', () => {
    const json = path.join(directory, 'opencode.json');
    const jsonc = path.join(directory, 'opencode.jsonc');
    fs.writeFileSync(json, '{"mcp":{"lower":{"type":"local","command":["lower"]}}}');
    fs.writeFileSync(jsonc, '{ // retained\n"mcp":{"higher":{"type":"local","command":["higher"]}}}');
    expect(mcp.listMcpConfigs().map((entry) => entry.name).sort()).toEqual(['higher', 'lower']);
    mcp.updateMcpConfig('lower', { enabled: false });
    expect(readConfigFile(json)).toMatchObject({ mcp: { lower: { enabled: false } } });
    mcp.createMcpConfig('new', { type: 'local', command: ['new'] });
    expect(readConfigFile(jsonc).mcp.lower).toBeUndefined();
    mcp.deleteMcpConfig('higher');
    expect(readConfigFile(jsonc).mcp.higher).toBeUndefined();
    expect(fs.readFileSync(jsonc, 'utf8')).toContain('// retained');
  });

  it('agent and provider metadata point to physical layers, including scoped deletion', () => {
    const json = path.join(directory, 'opencode.json');
    const jsonc = path.join(directory, 'opencode.jsonc');
    fs.writeFileSync(json, '{"agent":{"lower":{"description":"lower"}},"provider":{"lower":{}}}');
    fs.writeFileSync(jsonc, '{ // retained\n"agent":{"higher":{"description":"higher"}},"provider":{"higher":{}}}');
    expect(agents.getAgentSources('lower').json.path).toBe(json);
    expect(agents.getAgentSources('higher').json.path).toBe(jsonc);
    agents.deleteAgent('lower', undefined, 'user');
    expect(readConfigFile(json).agent).toBeUndefined();
    expect(readConfigFile(jsonc).agent.higher).toBeDefined();
    expect(providers.getProviderSources('lower').sources.user.path).toBe(json);
    providers.removeProviderConfig('lower');
    expect(readConfigFile(json).provider).toBeUndefined();
    expect(readConfigFile(jsonc).provider.higher).toBeDefined();
  });

  it('plugin edits locate the source containing the requested spec', () => {
    const json = path.join(directory, 'opencode.json');
    const jsonc = path.join(directory, 'opencode.jsonc');
    fs.writeFileSync(json, '{"plugin":["lower-plugin"]}');
    fs.writeFileSync(jsonc, '{ // retained\n"plugin":["higher-plugin"]}');
    const entry = plugins.listPluginEntries().find((item) => item.spec === 'lower-plugin');
    plugins.updatePluginEntry(entry.id, { spec: 'updated-plugin' });
    expect(readConfigFile(json).plugin).toEqual(['updated-plugin']);
    expect(readConfigFile(jsonc).plugin).toEqual(['higher-plugin']);
  });
});
