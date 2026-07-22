import { describe, expect, it, vi } from 'vitest';
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
