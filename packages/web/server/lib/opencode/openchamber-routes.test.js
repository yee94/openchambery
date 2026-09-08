import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerOpenChamberRoutes } from './openchamber-routes.js';
import { checkForUpdates } from '../package-manager.js';

vi.mock('../session-index/routes.js', () => ({ registerSessionIndexRoutes: vi.fn() }));
vi.mock('../transcript-cache/routes.js', () => ({ registerTranscriptCacheRoutes: vi.fn() }));
vi.mock('../config-sync/routes.js', () => ({ registerConfigSyncRoutes: vi.fn() }));
vi.mock('../package-manager.js', () => ({
  checkForUpdates: vi.fn(),
  getUpdateCommand: vi.fn(),
  detectPackageManagerDetails: vi.fn(),
}));

describe('remote update installation runtime boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkForUpdates).mockResolvedValue({ available: false });
  });

  const createApp = (versions) => {
    const app = express();
    registerOpenChamberRoutes(app, { express, process: { versions, env: {} } });
    return app;
  };

  it('rejects the web installer in an Electron-hosted server before any update work', async () => {
    const response = await request(createApp({ electron: '40.0.0' }))
      .post('/api/openchamber/update-install');
    expect(response.status).toBe(403);
    expect(response.body.error).toMatch(/desktop application/i);
    expect(checkForUpdates).not.toHaveBeenCalled();
  });

  it('preserves the standalone web server update path', async () => {
    const response = await request(createApp({ node: '24.0.0' }))
      .post('/api/openchamber/update-install');
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('No update available');
    expect(checkForUpdates).toHaveBeenCalledOnce();
  });
});
