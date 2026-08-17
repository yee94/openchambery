import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';

import { registerOpenCodeRoutes } from './routes.js';
import { isOpenCode1xVersion } from './opencode2-pin.js';

const createDependencies = ({ formatSettingsResponse }) => ({
  crypto: {},
  clientReloadDelayMs: 0,
  getOpenCodeResolutionSnapshot: vi.fn(),
  formatSettingsResponse,
  readSettingsFromDisk: vi.fn(),
  readSettingsFromDiskMigrated: vi.fn(async () => ({ persisted: true })),
  persistSettings: vi.fn(),
  sanitizeProjects: vi.fn(() => []),
  validateDirectoryPath: vi.fn(),
  resolveProjectDirectory: vi.fn(),
  getProviderSources: vi.fn(),
  removeProviderConfig: vi.fn(),
  refreshOpenCodeAfterConfigChange: vi.fn(),
  buildOpenCodeUrl: vi.fn(),
  getOpenCodeAuthHeaders: vi.fn(() => ({})),
});

describe('settings route', () => {
  it('returns the full formatted response without the bootstrap query', async () => {
    const formatted = { themeId: 'default', summaryCustomAPIToken: 'response-secret-sentinel' };
    const formatSettingsResponse = vi.fn(() => formatted);
    const app = express();
    registerOpenCodeRoutes(app, createDependencies({ formatSettingsResponse }));

    const response = await request(app).get('/api/config/settings').expect(200);

    expect(response.body).toEqual(formatted);
    expect(formatSettingsResponse).toHaveBeenCalledWith({ persisted: true });
  });

  it('formats settings before projecting the bootstrap response', async () => {
    const formatted = { defaultModel: 'model', summaryCustomAPIToken: 'response-secret-sentinel' };
    const projected = { schemaVersion: 1, defaultModel: 'model' };
    const formatSettingsResponse = vi.fn(() => formatted);
    const app = express();
    registerOpenCodeRoutes(app, createDependencies({ formatSettingsResponse }));

    const response = await request(app).get('/api/config/settings?bootstrap=true').expect(200);

    expect(response.body).toEqual(projected);
    expect(formatSettingsResponse).toHaveBeenCalledWith({ persisted: true });
  });

  it('returns the version 1 bootstrap allowlist without secret sentinels', async () => {
    const formatted = {
      defaultModel: 'model',
      defaultVariant: 'variant',
      defaultAgent: 'agent',
      autoCreateWorktree: true,
      gitmojiEnabled: false,
      defaultFileViewerPreview: true,
      zenModel: 'zen-model',
      messageStreamTransport: 'sse',
      sttProvider: 'openai-compatible',
      sttServerUrl: 'https://stt.example.com/v1',
      sttModel: 'whisper-1',
      sttLocalModel: 'local-model',
      sttLanguage: 'en',
      responseStyleEnabled: true,
      responseStylePreset: 'concise',
      responseStyleCustomInstructions: 'Keep it brief.',
      summaryCustomAPIToken: 'response-secret-sentinel',
      managedRemoteTunnelToken: 'tunnel-secret-sentinel',
      themeId: 'default',
    };
    const formatSettingsResponse = vi.fn(() => formatted);
    const app = express();
    registerOpenCodeRoutes(app, createDependencies({ formatSettingsResponse }));

    const response = await request(app).get('/api/config/settings/bootstrap').expect(200);

    expect(response.body).toEqual({
      schemaVersion: 1,
      defaultModel: 'model',
      defaultVariant: 'variant',
      defaultAgent: 'agent',
      autoCreateWorktree: true,
      gitmojiEnabled: false,
      defaultFileViewerPreview: true,
      zenModel: 'zen-model',
      messageStreamTransport: 'sse',
      sttProvider: 'openai-compatible',
      sttServerUrl: 'https://stt.example.com/v1',
      sttModel: 'whisper-1',
      sttLocalModel: 'local-model',
      sttLanguage: 'en',
      responseStyleEnabled: true,
      responseStylePreset: 'concise',
      responseStyleCustomInstructions: 'Keep it brief.',
    });
    expect(JSON.stringify(response.body)).not.toContain('secret-sentinel');
    expect(formatSettingsResponse).toHaveBeenCalledWith({ persisted: true });
  });
});

describe('behavior AGENTS.md route', () => {
  it('maps a missing file to an authoritative empty response', async () => {
    const error = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const readFile = vi.spyOn(fs.promises, 'readFile').mockRejectedValueOnce(error);
    const app = express();
    registerOpenCodeRoutes(app, createDependencies({ formatSettingsResponse: vi.fn(() => ({})) }));

    const response = await request(app).get('/api/behavior/agents-md').expect(200);

    expect(response.body).toEqual({ content: '', exists: false });
    readFile.mockRestore();
  });

  it('keeps permission and I/O failures as server errors', async () => {
    const error = Object.assign(new Error('denied'), { code: 'EACCES' });
    const readFile = vi.spyOn(fs.promises, 'readFile').mockRejectedValueOnce(error);
    const app = express();
    registerOpenCodeRoutes(app, createDependencies({ formatSettingsResponse: vi.fn(() => ({})) }));

    const response = await request(app).get('/api/behavior/agents-md').expect(500);

    expect(response.body).toEqual({ error: 'Failed to read AGENTS.md' });
    readFile.mockRestore();
  });
});

describe('opencode2 upgrade pin (ticket 12)', () => {
  const createUpgradeApp = (overrides = {}) => {
    const app = express();
    app.use(express.json());
    const deps = {
      ...createDependencies({ formatSettingsResponse: vi.fn(() => ({})) }),
      getOpenCodeResolutionSnapshot: vi.fn(async () => ({ source: 'path' })),
      buildOpenCodeUrl: vi.fn((pathname) => `http://opencode.test${pathname}`),
      getOpenCodeAuthHeaders: vi.fn(() => ({ Authorization: 'Basic secret' })),
      refreshOpenCodeAfterConfigChange: vi.fn(async () => undefined),
      ...overrides,
    };
    registerOpenCodeRoutes(app, deps);
    return { app, deps };
  };

  it('rejects 1.x upgrade targets and never calls /global/upgrade', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { app } = createUpgradeApp();

    const response = await request(app)
      .post('/api/opencode/upgrade')
      .send({ target: '1.18.4' })
      .expect(400);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toMatch(/1\.x/);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('does not treat a 1.x latest string as an available upgrade', async () => {
    const fetchMock = vi.fn(async (url) => {
      const href = String(url);
      if (href.includes('/api/health')) {
        return {
          ok: true,
          json: async () => ({ version: '0.0.0-next-17444', healthy: true }),
        };
      }
      if (href.includes('registry.npmjs.org/opencode-ai') || href.includes('github.com/repos/anomalyco/opencode')) {
        return { ok: true, json: async () => ({ version: '1.18.18', tag_name: 'v1.18.18' }) };
      }
      throw new Error(`unexpected fetch ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { app } = createUpgradeApp();

    const response = await request(app).get('/api/opencode/upgrade-status').expect(200);

    expect(response.body.latestVersion).not.toMatch(/^v?1\./);
    expect(isOpenCode1xVersion(response.body.latestVersion)).toBe(false);
    expect(String(response.body.latestVersion || '')).not.toContain('1.18');
    vi.unstubAllGlobals();
  });
});
