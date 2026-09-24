import express from 'express';
import request from 'supertest';
import { describe, expect, test } from 'vitest';

import { createBrowserProviderHost } from './host.js';
import { registerBrowserProviderRoutes } from './routes.js';

const createApp = (host = createBrowserProviderHost()) => {
  const app = express();
  registerBrowserProviderRoutes(app, { host });
  return { app, host };
};

describe('browser provider routes', () => {
  test('an empty catalog is an authoritative empty list, not a failure', async () => {
    const { app } = createApp();
    const response = await request(app).get('/api/browser-providers');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ providers: [], selectedId: null });
  });

  test('a catalog read failure is not an empty successful list', async () => {
    const host = createBrowserProviderHost({
      readInstalled: async () => {
        throw new Error('disk');
      },
    });
    const { app } = createApp(host);
    const response = await request(app).get('/api/browser-providers');
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('CATALOG_UNAVAILABLE');
    expect(response.body.providers).toBeUndefined();
  });

  test('selects a provider and sends one action to it', async () => {
    const { app, host } = createApp();
    host.install({
      id: 'server-chrome',
      name: 'Server Chrome',
      service: { provides: ['browser'] },
      answer: async (action) => ({
        ok: true,
        data: { echoed: action.action, selector: action.parameters.selector },
      }),
    });

    const selected = await request(app)
      .put('/api/browser-providers/selection')
      .send({ id: 'server-chrome' });
    expect(selected.status).toBe(200);
    expect(selected.body).toEqual({ selectedId: 'server-chrome' });

    const acted = await request(app)
      .post('/api/browser-providers/actions')
      .send({
        action: 'browser.click',
        parameters: { selector: '#save' },
        context: { directory: '/repo', sessionId: 'ses_1' },
      });
    expect(acted.status).toBe(200);
    expect(acted.body).toEqual({
      ok: true,
      providerId: 'server-chrome',
      data: { echoed: 'browser.click', selector: '#save' },
    });
  });

  test('no provider is an explicit refusal, not an empty success', async () => {
    const { app } = createApp();
    const response = await request(app)
      .post('/api/browser-providers/actions')
      .send({ action: 'browser.snapshot', parameters: {} });
    expect(response.status).toBe(409);
    expect(response.body.ok).toBe(false);
    expect(response.body.code).toBe('NO_PROVIDER');
    expect(response.body.data).toBeUndefined();
  });

  test('an unknown selection is not stored', async () => {
    const { app, host } = createApp();
    const response = await request(app)
      .put('/api/browser-providers/selection')
      .send({ id: 'missing' });
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('PROVIDER_NOT_FOUND');
    expect(host.selectedId()).toBeNull();
  });

  test('a provider rejection is not ok data', async () => {
    const { app, host } = createApp();
    host.install({
      id: 'server-chrome',
      name: 'Server Chrome',
      provides: ['browser'],
      answer: async () => ({ ok: false, error: 'No element matches #save' }),
    });
    await host.select('server-chrome');
    const response = await request(app)
      .post('/api/browser-providers/actions')
      .send({ action: 'browser.click', parameters: { selector: '#save' } });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      ok: false,
      code: 'PROVIDER_REJECTED',
      error: 'No element matches #save',
    });
  });

  test('invalid JSON is not sent and is not success', async () => {
    const { app } = createApp();
    const response = await request(app)
      .post('/api/browser-providers/actions')
      .set('content-type', 'application/json')
      .send('{');
    expect(response.status).toBe(400);
    expect(response.body.ok).toBe(false);
    expect(response.body.code).toBe('INVALID_ACTION');
    expect(response.body.data).toBeUndefined();
  });
});
