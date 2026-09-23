import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { createStaticRoutesRuntime } from './static-routes-runtime.js';

const createRuntime = () => createStaticRoutesRuntime({
  fs: { existsSync: () => false },
  path: { join: (...parts) => parts.join('/'), resolve: (value) => value, sep: '/' },
  process: { env: {} },
  __dirname: '/server',
  express,
  resolveProjectDirectory: () => '',
  buildOpenCodeUrl: () => '',
  getOpenCodeAuthHeaders: () => ({}),
  readSettingsFromDiskMigrated: async () => ({}),
  normalizePwaAppName: (value) => value,
  normalizePwaOrientation: (value) => value,
});

describe('static routes runtime', () => {
  it('returns API-only HTML fallback for browser UI routes', async () => {
    const app = express();
    createRuntime().registerApiOnlyFallbackRoutes(app);

    const response = await request(app).get('/sessions/abc').set('Accept', 'text/html');

    expect(response.status).toBe(200);
    expect(response.text).toContain('OpenChamber is running in headless mode');
    expect(response.text).toContain('Open it from the OpenChamber desktop or mobile app');
    expect(response.text).toContain('openchamber connect-url --help');
    expect(response.text).toContain('Copy command');
  });

  it('returns API-only info JSON for JSON clients', async () => {
    const app = express();
    createRuntime().registerApiOnlyFallbackRoutes(app);

    const response = await request(app).get('/sessions/abc').set('Accept', 'application/json');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      mode: 'api-only',
      message: 'OpenChamber is running in API-only mode',
    });
  });

  it('does not intercept API, auth, or health routes in API-only mode', async () => {
    const app = express();
    createRuntime().registerApiOnlyFallbackRoutes(app);

    const api = await request(app).get('/api/version');
    const auth = await request(app).get('/auth/session');
    const health = await request(app).get('/health');

    expect(api.body).not.toEqual({ ok: true, mode: 'api-only', message: 'OpenChamber is running in API-only mode' });
    expect(auth.body).not.toEqual({ ok: true, mode: 'api-only', message: 'OpenChamber is running in API-only mode' });
    expect(health.body).not.toEqual({ ok: true, mode: 'api-only', message: 'OpenChamber is running in API-only mode' });
  });

  it('serves index.html for deep links when dist lives under a dot directory', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-static-'));
    const distPath = path.join(root, '.bun', 'install', 'dist');
    fs.mkdirSync(distPath, { recursive: true });
    fs.writeFileSync(path.join(distPath, 'index.html'), '<!doctype html><title>OpenChamber</title>');
    try {
      const app = express();
      createStaticRoutesRuntime({
        fs,
        path,
        process: { env: { OPENCHAMBER_DIST_DIR: distPath } },
        __dirname: '/server',
        express,
        resolveProjectDirectory: () => '',
        buildOpenCodeUrl: () => '',
        getOpenCodeAuthHeaders: () => ({}),
        readSettingsFromDiskMigrated: async () => ({}),
        normalizePwaAppName: (value) => value,
        normalizePwaOrientation: (value) => value,
      }).registerStaticRoutes(app);

      const response = await request(app).get('/session/ses_abc');

      expect(response.status).toBe(200);
      expect(response.text).toContain('<title>OpenChamber</title>');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
