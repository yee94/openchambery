import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';

import { registerOpenCodeRoutes } from './routes.js';

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

describe('opencode upgrade route', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const jsonResponse = (body, status = 200, statusText = '') =>
    new Response(JSON.stringify(body), {
      status,
      statusText,
      headers: { 'Content-Type': 'application/json' },
    });

  const createUpgradeApp = () => {
    const app = express();
    app.use(express.json());
    const deps = createDependencies({ formatSettingsResponse: vi.fn(() => ({})) });
    deps.getOpenCodeResolutionSnapshot.mockResolvedValue({ source: 'path' });
    deps.buildOpenCodeUrl.mockImplementation((pathname) => `http://opencode.test${pathname}`);
    deps.refreshOpenCodeAfterConfigChange.mockResolvedValue(undefined);
    registerOpenCodeRoutes(app, deps);
    return { app, deps };
  };

  it('forwards an explicit target to OpenCode /global/upgrade', async () => {
    const fetchMock = vi.fn(async (url, init) => {
      expect(String(url)).toBe('http://opencode.test/global/upgrade');
      expect(JSON.parse(init.body)).toEqual({ target: '1.18.26' });
      return jsonResponse({ success: true, version: '1.18.26' });
    });
    globalThis.fetch = fetchMock;
    const { app } = createUpgradeApp();

    const response = await request(app)
      .post('/api/opencode/upgrade')
      .send({ target: 'v1.18.26' })
      .expect(200);

    expect(response.body).toEqual({ success: true, version: '1.18.26', restarted: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an omitted target without calling OpenCode', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    const { app } = createUpgradeApp();

    const response = await request(app).post('/api/opencode/upgrade').send({}).expect(400);

    expect(response.body).toEqual({
      success: false,
      error: 'OpenCode upgrade requires a semantic version target',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces OpenCode schema BadRequest messages instead of statusText', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        { name: 'BadRequest', data: { message: 'Expected a semantic version', kind: 'Missing' } },
        400,
        'Bad Request',
      ),
    );
    globalThis.fetch = fetchMock;
    const { app } = createUpgradeApp();

    const response = await request(app)
      .post('/api/opencode/upgrade')
      .send({ target: 'latest' })
      .expect(400);

    expect(response.body).toEqual({ success: false, error: 'Expected a semantic version' });
  });
});
