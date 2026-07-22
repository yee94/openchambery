import { afterAll, describe, expect, mock, test } from 'bun:test';
import fs from 'node:fs';

const settingsHome = `/tmp/openchamber-vscode-settings-${process.pid}-${Date.now()}`;

let providerResponse;
const providers = mock(async () => providerResponse);
const createOpencodeClient = mock(() => ({
  config: { providers },
  command: { list: async () => ({ data: [] }) },
}));

mock.module('vscode', () => ({
  workspace: { workspaceFolders: [] },
  window: { activeColorTheme: { kind: 1 }, ColorThemeKind: { Light: 1, HighContrastLight: 4 } },
  ColorThemeKind: { Light: 1, HighContrastLight: 4 },
}));
mock.module('os', () => ({ homedir: () => settingsHome }));
mock.module('@opencode-ai/sdk/v2', () => ({ createOpencodeClient }));

const { fetchProviderCatalogFromApi, readSettings } = await import('./bridge-settings-runtime.ts');

afterAll(() => {
  fs.rmSync(settingsHome, { recursive: true, force: true });
});

describe('VS Code provider catalog SDK access', () => {
  test('returns token presence booleans without token values', () => {
    const settings = readSettings({
      context: {
        globalState: {
          get: () => ({
            managedRemoteTunnelToken: 'TUNNEL_SENTINEL',
            summaryCustomAPIToken: 'SUMMARY_SENTINEL',
          }),
        },
      },
    });

    expect(settings).toMatchObject({
      hasManagedRemoteTunnelToken: true,
      hasSummaryCustomAPIToken: true,
    });
    expect(settings).not.toHaveProperty('managedRemoteTunnelToken');
    expect(settings).not.toHaveProperty('summaryCustomAPIToken');
  });

  test('fails before projection when the SDK returns an error alongside data', async () => {
    providerResponse = {
      error: { message: 'upstream failure' },
      data: {
        providers: [{ id: 'provider', name: 'Provider', models: { model: { id: 'model', name: 'Model' } } }],
        default: { provider: 'model' },
      },
    };

    await expect(fetchProviderCatalogFromApi({
      manager: {
        getApiUrl: () => 'http://localhost:4096',
        getOpenCodeAuthHeaders: () => ({}),
      },
    }, '/workspace')).rejects.toThrow('OpenCode provider catalog request failed');
  });
});
