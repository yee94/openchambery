import { afterAll, describe, expect, mock, test } from 'bun:test';
import fs from 'node:fs';

const settingsHome = `/tmp/openchamber-vscode-settings-${process.pid}-${Date.now()}`;

let providerListImpl = async () => ({ data: [] });
let modelListImpl = async () => ({ data: [] });
let modelDefaultImpl = async () => ({ data: null });
const providerList = mock(async (...args) => providerListImpl(...args));
const modelList = mock(async (...args) => modelListImpl(...args));
const modelDefault = mock(async (...args) => modelDefaultImpl(...args));
const skillList = mock(async () => ({ data: [{ id: 'release', name: 'Git Release', path: '/repo/.opencode/skills/release/SKILL.md', description: 'Release notes' }] }));
const make = mock(() => ({
  provider: { list: providerList },
  model: { list: modelList, default: modelDefault },
  command: { list: async () => ({ data: [] }) },
  skill: { list: skillList },
}));

mock.module('vscode', () => ({
  workspace: { workspaceFolders: [] },
  window: { activeColorTheme: { kind: 1 }, ColorThemeKind: { Light: 1, HighContrastLight: 4 } },
  ColorThemeKind: { Light: 1, HighContrastLight: 4 },
}));
// Bun aliases `os` ↔ `node:os`. Real @opencode/client uses
// `import { homedir } from "node:os"`; opencodeConfig uses `import os from 'node:os'`.
const osMock = { homedir: () => settingsHome };
mock.module('os', () => ({ ...osMock, default: osMock }));
mock.module('node:os', () => ({ ...osMock, default: osMock }));
mock.module('@opencode/client', () => ({ OpenCode: { make } }));

const { fetchProviderCatalogFromApi, fetchOpenCodeSkillsFromApi, readSettings } = await import('./bridge-settings-runtime.ts');

afterAll(() => {
  fs.rmSync(settingsHome, { recursive: true, force: true });
});

describe('VS Code provider catalog SDK access', () => {
  test('projects V2 skill id/path and preserves directory scope', async () => {
    const skills = await fetchOpenCodeSkillsFromApi({ manager: {
      getApiUrl: () => 'http://opencode.test', getOpenCodeAuthHeaders: () => ({}),
    } }, '/repo');
    expect(skills).toEqual([expect.objectContaining({ name: 'release', path: '/repo/.opencode/skills/release/SKILL.md' })]);
    expect(skillList).toHaveBeenCalledWith({ location: { directory: '/repo' } }, { signal: expect.any(AbortSignal) });
  });

  test('returns token presence booleans without token values', () => {
    const settings = readSettings({
      context: {
        globalState: {
          get: () => ({
            summaryCustomAPIToken: 'SUMMARY_SENTINEL',
          }),
        },
      },
    });

    expect(settings).toMatchObject({
      hasSummaryCustomAPIToken: true,
    });
    expect(settings).not.toHaveProperty('summaryCustomAPIToken');
  });

  test('fails before projection when the SDK returns an error alongside data', async () => {
    providerListImpl = async () => {
      throw new Error('upstream failure');
    };

    await expect(fetchProviderCatalogFromApi({
      manager: {
        getApiUrl: () => 'http://localhost:4096',
        getOpenCodeAuthHeaders: () => ({}),
      },
    }, '/workspace')).rejects.toThrow('OpenCode provider catalog request failed');
  });

  test('projects v2 provider.list + model.list into the Host catalog contract', async () => {
    providerListImpl = async () => ({
      data: [{ id: 'provider', name: 'Provider' }],
    });
    modelListImpl = async () => ({
      data: [{ id: 'model', name: 'Model', providerID: 'provider' }],
    });
    modelDefaultImpl = async () => ({
      data: { id: 'model', providerID: 'provider' },
    });

    const catalog = await fetchProviderCatalogFromApi({
      manager: {
        getApiUrl: () => 'http://localhost:4096',
        getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test' }),
      },
    }, '/workspace');

    expect(make).toHaveBeenCalledWith({
      baseUrl: 'http://localhost:4096',
      headers: { Authorization: 'Bearer test' },
      fetch: expect.any(Function),
    });
    expect(providerList).toHaveBeenCalledWith(
      { location: { directory: '/workspace' } },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(catalog).toMatchObject({
      schemaVersion: 1,
      providers: [{ id: 'provider', name: 'Provider', models: { model: { id: 'model', name: 'Model' } } }],
      default: { provider: 'model' },
    });
  });
});
