import express from 'express';
import request from 'supertest';
import { expect, test, vi } from 'vitest';
import { registerContentSearchRoutes } from './routes.js';
import { createContentSearchService } from './service.js';
import { createContentSearchRuntime } from './runtime.js';

test('exposes durable initialization times through the existing status route', async () => {
  const app = express();
  const service = createContentSearchService({ dbPath: ':memory:' });
  const runtime = createContentSearchRuntime({ service, getRuntimeKey: () => 'host', now: () => 100,
    listSessions: async () => ({ data: [], cursor: {} }), listMessages: async () => { throw new Error('unexpected'); },
  });
  registerContentSearchRoutes(app, { contentSearch: { service, runtime, getRuntimeKey: () => 'host' } });
  try {
    const pending = await request(app).get('/api/openchamber/content-search');
    expect(pending.body.index).toMatchObject({ initializationRequired: true, indexStartedAt: null, indexCompletedAt: null });
    await runtime.sync();
    const ready = await request(app).get('/api/openchamber/content-search');
    expect(ready.body.index).toMatchObject({ initializationRequired: false, indexStartedAt: 100, indexCompletedAt: 100, verifiedAt: 100 });
    expect(ready.body.hits).toEqual([]);
  } finally {
    await runtime.stop();
    service.close();
  }
});

test('global route returns coverage and preserves hit directories without a selected-project filter', async () => {
  const app = express();
  const hit = { sessionID: 's', messageID: 'm', title: 'Other project', directory: '/other', snippet: 'needle' };
  const search = vi.fn(() => [hit]);
  registerContentSearchRoutes(app, { contentSearch: {
    service: { search }, getRuntimeKey: () => 'host', runtime: { status: () => ({ phase: 'ready', messages: 1 }) },
  } });
  const response = await request(app).get('/api/openchamber/content-search').query({ q: 'needle' });
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ hits: [hit], index: { phase: 'ready', messages: 1 } });
  expect(search).toHaveBeenCalledWith('host', 'needle', { limit: 30, directory: undefined });
  expect((await request(app).get('/api/openchamber/content-search').query({ limit: -1 })).status).toBe(400);
  search.mockImplementation(() => { throw new Error('database unavailable'); });
  expect((await request(app).get('/api/openchamber/content-search').query({ q: 'needle' })).status).toBe(500);
});
